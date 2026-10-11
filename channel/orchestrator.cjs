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
  await sleep(1500);
  const ok = await probe(443);
  if (ok) fails.capture = 0; else fails.capture++;
  return ok;
}
async function ensureBridge() {
  if (await probe(8790)) { fails.bridge = 0; return true; }
  if (fails.bridge >= 3) return false;
  log('   桥未运行 → 隐藏拉起 (direct 引擎)');
  const b = spawn(process.execPath, [path.join(DIR, 'dsh-wb-bridge.cjs'), '--gw-port', '60622', '--port', '8790', '--engine', 'direct'], { cwd: DIR, detached: true, stdio: 'ignore', windowsHide: true });
  b.on('error', (e) => log('   [WARN] 桥启动失败：' + e.message));
  b.unref();
  PIDS.bridge = b.pid; savePids();
  for (let i = 0; i < 10; i++) { await sleep(1000); if (await probe(8790)) { fails.bridge = 0; return true; } }
  fails.bridge++;
  return false;
}

const DAEMON = false; // 按需模式：点击启动 → 服务拉起 → 编排器退出。无后台循环。

if (DAEMON) {
  // ---------- （已停用）常驻守护模式 ----------
  log('[warn] daemon 模式已停用：按需模式启动服务后即退出');
  setTimeout(() => process.exit(0), 500);
} else {
  // ---------- 按需模式：确保三服务就绪后退出 ----------
  (async () => {
    console.log('[1/3] CLI service (60622)...');
    if (!(await httpOk(60622, '/api/v1/status'))) {
      log('   starting codebuddy-code --serve (hidden)...');
      spawnDetached('cmd.exe', ['/c', 'codebuddy-code', '--serve', '--port', '60622', '--auth', 'none', '--permission-mode', 'bypassPermissions'], 'serve', { windowsHide: true });
      for (let i = 0; i < 20; i++) { await sleep(1500); if (await httpOk(60622, '/api/v1/status')) break; }
    }
    log((await httpOk(60622, '/api/v1/status')) ? '   [OK] CLI up' : '   [FAIL] CLI 未就绪：点「打开 CLI 登录窗口」完成 /login');

    console.log('[2/3] TLS capture proxy (443)...');
    if (await probe(443)) {
      log('   [OK] already listening');
    } else {
      spawnDetached(process.execPath, [path.join(DIR, 'mitm', 'tls-capture-443.cjs')], 'capture', { windowsHide: true });
      await sleep(1200);
      log((await probe(443)) ? '   [OK] capture proxy started' : '   [WARN] capture proxy did not start (检查 mitm 目录)');
    }

    console.log('[3/3] bridge (8790)...');
    if (await probe(8790)) {
      log('   [OK] bridge already running - keeping it');
    } else {
      log('   starting bridge (hidden, detached)...');
      const b = spawn(process.execPath, [path.join(DIR, 'dsh-wb-bridge.cjs'), '--gw-port', '60622', '--port', '8790', '--engine', 'direct'], { cwd: DIR, detached: true, stdio: 'ignore', windowsHide: true });
      b.on('error', (e) => log('   [WARN] 桥启动失败：' + e.message));
      b.unref();
      PIDS.bridge = b.pid; savePids();
      for (let i = 0; i < 10; i++) { await sleep(1000); if (await probe(8790)) break; }
      log((await probe(8790)) ? '   [OK] bridge started' : '   [FAIL] bridge did not start');
    }
    log('[done] 全部就绪。服务在后台隐藏运行；本窗口可关闭。');
    setTimeout(() => process.exit(0), 1500);
  })();
}
