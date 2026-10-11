// wbrelay 通道编排器：node orchestrator.cjs [--daemon]
// --daemon：常驻守护（每 10 秒自检，服务挂了自动隐藏拉起，带回退）
// 默认（无参）：转交后台守护进程后退出（供 cmd 包装器/插件路由调用）
const { spawn, execSync } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const LOG = path.join(DIR, 'channel-run.log');
function log(s) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* ignore */ }
}

// 清代理环境变量（GUI 应用注入的 HTTP_PROXY 会弄崩 CLI axios）
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';

// 设备证书：不进 Git 的本机材料。这里自愈式确保存在且有效（缺失/过期/不覆盖主机名都会重签），
// 新用户克隆插件后无需手工 openssl；CLI 只有在 ca.pem 存在时才注入 NODE_EXTRA_CA_CERTS。
const MITM_DIR = path.join(DIR, 'mitm');
const CA_FILE = path.join(MITM_DIR, 'ca.pem');
try {
  const { ensureDeviceCerts } = require(path.join(MITM_DIR, 'certgen.cjs'));
  const ensured = ensureDeviceCerts(MITM_DIR);
  if (ensured.ok) {
    const c = ensured.status;
    log('   设备证书 ' + (ensured.generated ? '已生成' : '有效') + '：到期 ' + c.srvNotAfter
      + '（剩余 ' + c.srvDaysLeft + ' 天），主机名 ' + c.sans.join(','));
    process.env.NODE_EXTRA_CA_CERTS = CA_FILE;
  } else {
    log('   [WARN] 设备证书未就绪：' + (ensured.error || ensured.issues.join('；')));
    log('   [WARN] 手工生成：node "' + path.join(MITM_DIR, 'certgen.cjs') + '" --force');
  }
} catch (e) {
  log('   [WARN] 证书生成器不可用：' + e.message);
}
if (!process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(CA_FILE)) process.env.NODE_EXTRA_CA_CERTS = CA_FILE;
if (process.env.NODE_EXTRA_CA_CERTS) log('   NODE_EXTRA_CA_CERTS = ' + process.env.NODE_EXTRA_CA_CERTS);

function probe(port, ms = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { try { s.destroy(); } catch { /* ignore */ } resolve(false); }, ms);
  });
}
function httpOk(port, p) {
  return new Promise((resolve) => {
    const q = http.get({ host: '127.0.0.1', port, path: p, headers: { 'x-codebuddy-request': '1' }, timeout: 2500 }, (res) => { res.resume(); resolve(true); });
    q.on('timeout', () => { q.destroy(); resolve(false); });
    q.on('error', () => resolve(false));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function argOf(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// PID 管理：加载旧表（用于杀旧守护），本进程写新表
const RT_FILE = path.join(DIR, 'runtimes.json');
let PIDS = {};
try { PIDS = JSON.parse(fs.readFileSync(RT_FILE, 'utf8')).pids || {}; } catch { /* 无旧表 */ }
function savePids() {
  try { fs.writeFileSync(RT_FILE, JSON.stringify({ pids: PIDS, at: new Date().toISOString() }, null, 2)); } catch { /* ignore */ }
}
function killOldWatchdog() {
  if (PIDS.watchdog && PIDS.watchdog !== process.pid) {
    try { execSync(`taskkill /PID ${PIDS.watchdog} /F`, { stdio: 'ignore', timeout: 4000 }); log('   已停止旧守护进程 PID ' + PIDS.watchdog); } catch { /* ignore */ }
  }
}
function spawnDetached(cmd, args, key, opts = {}) {
  const c = spawn(cmd, args, { cwd: DIR, detached: true, stdio: 'ignore', windowsHide: opts.windowsHide !== false });
  c.on('error', (e) => log('   [WARN] 启动失败 ' + cmd + '：' + e.message));
  c.unref();
  if (key) { PIDS[key] = c.pid; savePids(); }
  return c;
}

const fails = { serve: 0, capture: 0, bridge: 0 };

/** hosts 是否把捕获主机指向本机代理（true/false，读不到返回 null）。 */
function hostsHasEntry() {
  try {
    const file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
    return /^\s*127\.0\.0\.1\s+copilot\.tencent\.com\s*$/mi.test(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

/** 已捕获 token 的状态：是否存在、是否过期（解析 JWT 的 exp；非 JWT 视为未过期）。 */
function tokenState() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(MITM_DIR, 'captured-token.json'), 'utf8'));
    const authorization = String(raw.authorization || '');
    const payload = authorization.split('.')[1];
    let exp = null;
    if (payload) {
      try { exp = Number(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp) * 1000; } catch { /* 非 JWT */ }
    }
    return { present: true, expired: exp !== null && exp <= Date.now(), exp };
  } catch { return { present: false, expired: false, exp: null }; }
}

async function ensureServe() {
  if (await httpOk(60622, '/api/v1/status')) { fails.serve = 0; return true; }
  if (fails.serve >= 3) return false; // 连续 3 轮拉起失败：退避（每 10 秒一轮，≈30 秒后重试）
  log('   CLI 未运行 → 隐藏拉起 codebuddy-code --serve');
  spawnDetached('cmd.exe', ['/c', 'codebuddy-code', '--serve', '--port', '60622', '--auth', 'none', '--permission-mode', 'bypassPermissions'], 'serve', { windowsHide: true });
  for (let i = 0; i < 20; i++) { await sleep(1500); if (await httpOk(60622, '/api/v1/status')) { fails.serve = 0; return true; } }
  fails.serve++;
  return false;
}
async function ensureCapture() {
  if (await probe(443)) { fails.capture = 0; return true; }
  if (fails.capture >= 3) return false;
  log('   443 捕获代理未运行 → 隐藏拉起');
  spawnDetached(process.execPath, [path.join(DIR, 'mitm', 'tls-capture-443.cjs')], 'capture', { windowsHide: true });
  // 必须等到真正在监听：CLI 只有在代理已就绪时才会把上游解析到本机，否则直连上游、抓不到 token。
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    if (await probe(443)) { fails.capture = 0; return true; }
  }
  fails.capture++;
  return false;
}
async function ensureBridge() {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (await probe(8790)) { fails.bridge = 0; return true; }
    if (fails.bridge >= 3) return false;
    log('   桥未运行 → 隐藏拉起 (direct 引擎)' + (attempt > 1 ? '（第 ' + attempt + ' 次尝试）' : ''));
    const b = spawn(process.execPath, [path.join(DIR, 'dsh-wb-bridge.cjs'), '--gw-port', '60622', '--port', '8790', '--engine', 'direct'], { cwd: DIR, detached: true, stdio: 'ignore', windowsHide: true });
    b.on('error', (e) => log('   [WARN] 桥启动失败：' + e.message));
    b.unref();
    PIDS.bridge = b.pid; savePids();
    for (let i = 0; i < 10; i++) { await sleep(1000); if (await probe(8790)) { fails.bridge = 0; return true; } }
    // 刚结束的上一个实例可能还占着 8790：等一下再来一次（桥自身也会重试绑定）
    if (attempt === 1) { log('   桥未就绪（端口可能仍在释放），3 秒后重试'); await sleep(3000); }
  }
  fails.bridge++;
  return false;
}

// ---------- token 捕获：让 CLI 产生一次上游请求（/v3/config）----------
// 代理就绪后才启动的 CLI 会自己完成这一步；这里兜底处理「60622 上已有更早启动的实例」
// （桌面版自己拉起的 CLI 不会重新解析上游）：起一个临时实例取一次 token，然后结束它。
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.on('error', () => resolve(60699));
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function tokenExpiry(state) {
  return state.exp ? '（到期 ' + new Date(state.exp).toLocaleString('zh-CN', { hour12: false }) + '）' : '';
}

async function harvestToken(timeoutMs = 30000) {
  const before = tokenState();
  if (before.present && !before.expired) {
    log('   token 仍在有效期内' + tokenExpiry(before) + '，无需重取');
    return { ok: true, harvested: false };
  }
  const port = await freePort();
  log('   捕获 token：起临时 CLI 实例（端口 ' + port + '）请求一次上游配置');
  const child = spawnDetached('cmd.exe',
    ['/c', 'codebuddy-code', '--serve', '--port', String(port), '--auth', 'none', '--permission-mode', 'bypassPermissions'],
    null, { windowsHide: true });
  let state = before;
  for (let i = 0; i < Math.ceil(timeoutMs / 1500); i += 1) {
    await sleep(1500);
    state = tokenState();
    if (state.present && !state.expired) break;
  }
  if (child.pid) {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', timeout: 6000 }); } catch { /* 已退出 */ }
  }
  if (state.present && !state.expired) {
    log('   [OK] token 已捕获' + tokenExpiry(state));
    return { ok: true, harvested: true };
  }
  log('   [WARN] token 未捕获：确认 hosts 指向本机代理，并让 CLI 产生一次上游请求');
  return { ok: false, harvested: false };
}

const DAEMON = false; // 按需模式：点击启动 → 服务拉起 → 编排器退出。无后台循环。
const TOKEN_ONLY = process.argv.includes('--token-only');

if (TOKEN_ONLY) {
  // ---------- 只捕获 token（面板 / 看板的「捕获 token」按钮调用）----------
  (async () => {
    if (hostsHasEntry() !== true) log('   [WARN] hosts 未指向本机代理：上游请求不会经过捕获代理');
    if (!(await ensureCapture())) log('   [FAIL] 443 捕获代理未就绪');
    const timeout = Number(argOf('--timeout', '30000')) || 30000;
    const token = await harvestToken(timeout);
    log(token.ok ? '[done] token 就绪。' : '[done] token 未捕获。');
    setTimeout(() => process.exit(token.ok ? 0 : 1), 300);
  })();
} else if (DAEMON) {
  // ---------- （已停用）常驻守护模式 ----------
  log('[warn] daemon 模式已停用：按需模式启动服务后即退出');
  setTimeout(() => process.exit(0), 500);
} else {
  // ---------- 按需模式：hosts → 443 代理 → CLI → 桥，这个顺序是硬约束 ----------
  // CLI 只有在 443 代理已经在监听时才会把 copilot.tencent.com 解析到本机代理；否则它会直连上游，
  // token 永远抓不到（旧版本表现为「/wbrelay start 之后必须手动打开 CLI 发一条消息」）。
  (async () => {
    console.log('[1/4] 捕获前置检查（hosts / 设备证书）...');
    const hosts = hostsHasEntry();
    if (hosts === true) log('   [OK] hosts 已指向本机捕获代理');
    else if (hosts === false) log('   [WARN] hosts 无捕获条目：上游不经过代理，token 抓不到（点「启用 hosts 捕获」并确认 UAC）');
    else log('   [WARN] hosts 读取失败，跳过检查');

    console.log('[2/4] TLS capture proxy (443)...');
    log((await ensureCapture()) ? '   [OK] capture proxy listening' : '   [FAIL] 捕获代理未就绪（检查 channel/mitm）');

    console.log('[3/4] CLI service (60622)...');
    log((await ensureServe()) ? '   [OK] CLI up' : '   [FAIL] CLI 未就绪：点「打开 CLI 登录窗口」完成 /login');

    console.log('[4/4] bridge (8790)...');
    log((await ensureBridge()) ? '   [OK] bridge up' : '   [FAIL] 桥未就绪');

    const token = await harvestToken();
    log(token.ok
      ? (token.harvested ? '[done] token 已自动捕获，通道可直接使用。' : '[done] 通道就绪，token 仍在有效期内。')
      : '[done] 通道已就绪，但 token 未捕获：让 CLI 发一次上游请求即可（打开 CLI 登录窗口随便发一条消息）。');
    log('[done] 服务在后台隐藏运行；本窗口可关闭。');
    setTimeout(() => process.exit(0), 1500);
  })();
}
