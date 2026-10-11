// dsh-plugin-wbrelay: cordis bundle entry.
// 职责：
//   1) 注册 webServer 路由：通道状态、模型能力刷新、后台启动及 CLI 登录操作
//   2) 将 CLI 模型思考能力写入 dsh 原生模型配置，默认提供方由 cordis.patch.yml 提供
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createNativeReasoningSync } from './native-reasoning.js';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lib/ 的上一级 = 插件根目录
const PLUGIN_ROOT = path.resolve(__dirname, '..');
// 通道目录解析：优先插件自带的 channel/（自包含模式），
// 兼容旧布局（插件装在通道目录里，向上找），两种都失效则回落 bundled 可诊断
function findChannelDir() {
  const bundled = path.join(PLUGIN_ROOT, 'channel');
  try { if (fs.existsSync(path.join(bundled, 'dsh-channel.cmd'))) return bundled; } catch { /* ignore */ }
  for (const c of [path.resolve(PLUGIN_ROOT, '..'), path.resolve(fs.realpathSync(PLUGIN_ROOT), '..')]) {
    try { if (fs.existsSync(path.join(c, 'dsh-channel.cmd'))) return c; } catch { /* ignore */ }
  }
  return bundled;
}
const CHANNEL_DIR = findChannelDir();
const SCRIPT = path.join(CHANNEL_DIR, 'dsh-channel.cmd');
const WINDOW_CMD = path.join(CHANNEL_DIR, 'wbrelay-window.cmd');
const MITM_DIR = path.join(CHANNEL_DIR, 'mitm');
const CERTGEN = path.join(MITM_DIR, 'certgen.cjs');
const CA_FILE = path.join(MITM_DIR, 'ca.pem');
const TOKEN_FILE = path.join(MITM_DIR, 'captured-token.json');
const PLUGIN_PATCH = path.join(PLUGIN_ROOT, 'cordis.patch.yml');
const DIRECT_HOST = 'copilot.tencent.com';
const DIRECT_IPS = ['112.28.173.82', '112.28.174.102'];
const BRIDGE_PORT = 8790;
const CLI_PORT = 60622;
const PLUGIN_VERSION = '1.0.2';

let lastStartAt = 0;
let hostsFlight = null;

// 当前 dsh profile 目录：优先环境变量，其次用户目录下的默认 profile
function profileDir() {
  return process.env.DSH_PROFILE_DIR
    || path.join(os.homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE || 'desktop');
}

// ---------- 设备证书 ----------
// 捕获代理要用本机自签 CA 终结 TLS，CLI 用 NODE_EXTRA_CA_CERTS 信任它。证书是设备专用
// 材料、被 .gitignore 排除，所以克隆下来的插件里没有证书：这里按需生成，新用户零手工。
let certgenModule = null;
function certgen() {
  if (!certgenModule) certgenModule = require(CERTGEN);
  return certgenModule;
}

function ensureCerts(options = {}) {
  try { return certgen().ensureDeviceCerts(MITM_DIR, options); }
  catch (e) {
    return { ok: false, generated: false, issues: [], status: null, error: String((e && e.message) || e) };
  }
}

function certsStatus() {
  try { return certgen().inspectDeviceCerts(MITM_DIR); }
  catch (e) {
    return {
      dir: MITM_DIR, present: false, ok: false, sans: [],
      issues: ['证书模块不可用：' + String((e && e.message) || e)],
      caPath: CA_FILE, srvPath: path.join(MITM_DIR, 'srv.pem'),
      caNotAfter: null, srvNotAfter: null, caDaysLeft: null, srvDaysLeft: null,
      fingerprint: null, caFingerprint: null,
    };
  }
}

// ---------- 基础探测 ----------
function tcpProbe(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function httpProbeJson(port, urlPath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { 'x-codebuddy-request': '1' }, timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.on('error', () => resolve(null));
    r.end();
  });
}

function tokenInfo() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    let exp = null, iat = null;
    try {
      const payload = JSON.parse(Buffer.from(j.authorization.split('.')[1], 'base64url').toString('utf8'));
      exp = payload.exp || null; iat = payload.iat || null;
    } catch { /* token 非 JWT */ }
    return {
      present: true, capturedAt: j.time || null, capturedSource: j.url || null,
      exp, iat, daysLeft: exp ? Math.round((exp * 1000 - Date.now()) / 86400000 * 10) / 10 : null,
    };
  } catch { return { present: false }; }
}

function hostsHasEntry() {
  try { return fs.readFileSync('C:\\Windows\\System32\\drivers\\etc\\hosts', 'utf8').includes(DIRECT_HOST); }
  catch { return null; }
}

function upstreamProbe() {
  return new Promise((resolve) => {
    let token = null;
    try { token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).authorization || null; } catch { /* 无 token */ }
    if (!token) { resolve({ ok: false, status: 'no-token', ms: null, at: new Date().toISOString() }); return; }
    const t0 = Date.now();
    const payload = JSON.stringify({ model: 'glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const r = https.request({
      host: DIRECT_IPS[0], port: 443, path: '/v2/chat/completions', method: 'POST', servername: DIRECT_HOST,
      headers: { 'content-type': 'application/json', authorization: token, 'content-length': Buffer.byteLength(payload), host: DIRECT_HOST },
      timeout: 8000,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - t0, at: new Date().toISOString() }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, status: 'timeout', ms: Date.now() - t0, at: new Date().toISOString() }); });
    r.on('error', (e) => resolve({ ok: false, status: String(e.message).slice(0, 60), ms: Date.now() - t0, at: new Date().toISOString() }));
    r.end(payload);
  });
}

function modelsFromPatch() {
  // 模型清单可能来自两处：用户 patch（llm-pi-ai.providers.wbrelay，覆盖语义下优先生效）
  // 或本插件 patch（全新用户无用户条目时生效）。用户优先，插件兜底。
  const extract = (file) => {
    try {
      const s = fs.readFileSync(file, 'utf8');
      const idx = s.indexOf('wbrelay:');
      if (idx < 0) return [];
      const seg = s.slice(s.indexOf('models:', idx));
      return [...new Set([...seg.matchAll(/^\s+- id:\s*([\w.\-]+)\s*$/gm)].map((m) => m[1]))];
    } catch { return []; }
  };
  const userProfile = path.join(profileDir(), 'cordis.patch.yml');
  return extract(userProfile).length ? extract(userProfile) : extract(PLUGIN_PATCH);
}

// ---------- 新手引导 ----------
function codebuddyInstalled() {
  try {
    execSync('where codebuddy-code', { stdio: 'pipe', timeout: 4000 });
    return true;
  } catch { return false; }
}

function buildOnboarding(st) {
  const steps = [];
  const installed = codebuddyInstalled();
  steps.push({
    id: 'cli-install', ok: installed,
    title: installed ? 'CodeBuddy CLI 已安装' : '安装 CodeBuddy CLI',
    action: installed ? '' : 'cmd 里执行：npm i -g @tencent-ai/codebuddy-code',
  });
  const loginKnown = st.cli.up && st.cli.authOk;
  steps.push({
    id: 'cli-login',
    ok: loginKnown,
    title: loginKnown ? 'CLI 已登录' : (installed ? '登录 CodeBuddy CLI' : '安装 CLI 后再登录'),
    action: loginKnown ? '' : (installed ? '点「打开 CLI 登录窗口」，在窗口里输入 /login 完成登录' : '先完成上一步'),
  });
  const certs = st.certs || {};
  const certNote = certs.srvDaysLeft != null ? '（剩余 ' + certs.srvDaysLeft + ' 天）' : '';
  steps.push({
    id: 'certs',
    ok: certs.ok === true,
    title: certs.ok === true ? '设备证书已就绪' + certNote
      : certs.present === true ? '设备证书异常，需要重签' : '生成设备证书（本机专用，首次自动生成）',
    action: certs.ok === true ? '' : '点「生成/更新证书」，或在 cmd 里运行 channel\\mitm\\gen-certs.cmd',
  });
  steps.push({
    id: 'hosts', ok: st.hosts.entry === true,
    title: st.hosts.entry === true ? 'hosts 拦截已生效' : '设置 hosts 拦截（需管理员，一次性）',
    action: st.hosts.entry === true ? '' : '点「以管理员修复（UAC 确认）」或在管理员 cmd 运行 channel\\mitm\\mitm-on.cmd',
  });
  steps.push({
    id: 'channel', ok: st.bridge.up,
    title: st.bridge.up ? '通道运行中' : '启动通道',
    action: st.bridge.up ? '' : '点「启动 wbrelay 通道」（会弹出新窗口跑启动脚本）',
  });
  steps.push({
    id: 'token', ok: st.token.present === true,
    title: st.token.present ? 'token 已自动捕获（剩余 ' + (st.token.daysLeft ?? '?') + ' 天）' : '等待 token 自动捕获',
    action: st.token.present ? '' : '通道跑起来后 CLI 首次请求会自动完成，稍等几秒刷新',
  });
  return steps;
}

async function gatherStatus(probe) {
  const [bridgeUp, cliUp, mitmUp] = await Promise.all([tcpProbe(BRIDGE_PORT), tcpProbe(CLI_PORT), tcpProbe(443)]);
  const cliStatus = cliUp ? await httpProbeJson(CLI_PORT, '/api/v1/status') : null;
  const cliAuth = cliUp ? await httpProbeJson(CLI_PORT, '/api/v1/auth/status') : null;
  let upstream = null;
  if (probe) upstream = await upstreamProbe();
  let bundles = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir(), 'package.json'), 'utf8'));
    bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  } catch { /* profile 不可读 */ }
  const certs = certsStatus();
  const onboarding = buildOnboarding({
    bridge: { up: bridgeUp },
    cli: { up: cliUp, authOk: !!(cliAuth && cliAuth.authenticated) },
    hosts: { entry: hostsHasEntry() },
    token: tokenInfo(),
    certs,
  });
  return {
    time: new Date().toISOString(),
    onboarding,
    bridge: { up: bridgeUp, port: BRIDGE_PORT },
    cli: {
      up: cliUp, authOk: !!(cliAuth && cliAuth.authenticated),
      busy: cliStatus ? cliStatus.data?.busy ?? null : null,
      runStatus: cliStatus ? cliStatus.data?.runStatus ?? null : null,
    },
    mitm443: { up: mitmUp },
    hosts: { entry: hostsHasEntry(), domain: DIRECT_HOST },
    token: tokenInfo(),
    certs,
    upstream,
    plugin: { registered: bundles.includes('dsh-plugin-wbrelay'), scriptExists: fs.existsSync(SCRIPT) },
    models: modelsFromPatch(),
    lastStartAt: lastStartAt ? new Date(lastStartAt).toISOString() : null,
  };
}

// ---------- 引导动作 ----------
function fixHostsElevated() {
  const mitmOn = path.join(CHANNEL_DIR, 'mitm', 'mitm-on.cmd');
  if (!fs.existsSync(mitmOn)) return { ok: false, error: '找不到 ' + mitmOn };
  if (hostsHasEntry() === true) return { ok: true, enabled: true, already: true, note: 'hosts 捕获已启用' };
  if (hostsFlight) return hostsFlight;
  // EncodedCommand 保留中文路径；等待执行结果，不能把创建进程当成提权成功。
  const ps = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
  $script = '${mitmOn.replace(/'/g, "''")}'
  $arguments = '/d /s /c ""' + $script + '" --no-pause"'
  $process = Start-Process -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    @{ ok = $false; code = 'hosts_command_failed'; error = ('hosts 脚本执行失败，退出码 ' + $process.ExitCode) } | ConvertTo-Json -Compress
    exit 1
  }
  @{ ok = $true } | ConvertTo-Json -Compress
} catch {
  $code = 'elevation_failed'
  $message = '管理员启动失败：' + $_.Exception.Message
  $exception = $_.Exception
  while ($null -ne $exception) {
    if ($exception.NativeErrorCode -eq 1223) {
      $code = 'elevation_cancelled'
      $message = '管理员授权已取消，hosts 未启用'
      break
    }
    $exception = $exception.InnerException
  }
  @{ ok = $false; code = $code; error = $message } | ConvertTo-Json -Compress
  exit 1
}`;
  hostsFlight = new Promise((resolve) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand',
      Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostic = '', settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, code: 'elevation_timeout', error: '管理员操作等待超时，请检查 hosts 状态后重试' });
      child.kill();
    }, 90000);
    child.stdout.on('data', (chunk) => { output = (output + chunk.toString('utf8')).slice(0, 8192); });
    child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(0, 8192); });
    child.once('error', (error) => finish({ ok: false, code: 'elevation_start_failed',
      error: '无法启动管理员授权程序：' + error.message }));
    child.once('close', (code) => {
      let result;
      try { result = JSON.parse(output.trim()); } catch { /* 启动器未返回有效结果。 */ }
      if (code !== 0 || result?.ok !== true) {
        finish({ ok: false, code: result?.code || 'elevation_failed',
          error: result?.error || (diagnostic.trim() ? '管理员启动失败：' + diagnostic.trim().slice(0, 300)
            : '管理员启动未完成，hosts 未启用') });
      } else if (hostsHasEntry() !== true) {
        finish({ ok: false, code: 'hosts_not_enabled', error: '管理员脚本已退出，但 hosts 捕获未生效' });
      } else {
        finish({ ok: true, enabled: true, note: 'hosts 捕获已启用' });
      }
    });
  }).finally(() => { hostsFlight = null; });
  return hostsFlight;
}

function openCliLogin() {
  if (!codebuddyInstalled()) return { ok: false, error: '未安装 CodeBuddy CLI：cmd 里执行 npm i -g @tencent-ai/codebuddy-code' };
  // Node 只在启动时读取额外 CA，所以先把证书准备到就绪，再把路径注入登录窗口环境。
  const ensured = ensureCerts();
  if (!ensured.ok || !ensured.status) {
    return { ok: false, error: '捕获证书未能就绪：' + (ensured.error || ensured.issues.join('；')) };
  }
  const ca = ensured.status.caPath;
  // 登录窗口必须继承与通道启动器一致的环境。
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: ca, NO_PROXY: '127.0.0.1,localhost' };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key];
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  // 不带 start 标题参数（引号会被 Node 转义破坏），直接 start cmd /k
  const child = spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', 'codebuddy-code'], {
    detached: true, stdio: 'ignore', windowsHide: false, env,
  });
  child.unref();
  return { ok: true, note: '已打开 CLI 窗口：在窗口输入 /login 完成登录后回到 dsh' };
}

// ---------- 启动通道 ----------
function killTracked() {
  // 按 runtimes.json 精确停掉上一轮实例（隐藏进程无窗口标题可匹配）。
  // CLI 是通过 cmd.exe 包装拉起的，所以必须 /T 连子进程一起结束，否则真正的
  // codebuddy-code --serve 会变成孤儿继续占着 60622。
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(CHANNEL_DIR, 'runtimes.json'), 'utf8'));
    for (const k of ['bridge', 'capture', 'serve']) {
      const pid = rt.pids && rt.pids[k];
      if (pid) {
        try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 5000 }); }
        catch { /* 已退出 */ }
      }
    }
  } catch { /* 无 runtimes.json：兼容旧实例 */ }
  try { execSync('taskkill /FI "WINDOWTITLE eq codebuddy-code serve*" /T /F', { stdio: 'ignore', timeout: 5000 }); } catch { /* ignore */ }
}

function startChannel(restart = false) {
  const launcher = path.join(CHANNEL_DIR, 'wbrelay-window.cmd');
  if (!fs.existsSync(launcher)) return { ok: false, error: '找不到 ' + launcher };
  if (Date.now() - lastStartAt < 8000) return { ok: true, already: true, note: '8 秒内已启动过，避免重复' };
  lastStartAt = Date.now();
  if (restart) killTracked();
  // 隐藏窗口运行：各服务全部后台化，状态与引导见面板
  const child = spawn('cmd.exe', ['/c', launcher], {
    cwd: CHANNEL_DIR, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  return { ok: true, note: restart ? '通道重启中（后台无窗口），约 20-30 秒后恢复' : '通道已在后台启动（无窗口），状态见 dsh 右下角按钮或面板' };
}

// ---------- 斜杠命令：/wbrelay start | status | hosts | delete ----------
// dsh 的 commands 服务（由 dsh-base 组成）允许插件注册 /命令；子命令从 rawInput 里解析，
// 所以 /wbrelay start 与 /wbrelay delete 都是 name=wbrelay 的一次执行。

const COMMAND_USAGE = [
  'wbrelay 用法：/wbrelay <子命令> [参数]',
  '',
  '  start        一键启动通道：确保证书 → 拉起 CLI / 443 捕获 / 8790 桥接 → 复查结果',
  '  status       查看证书、桥接、CLI、捕获、hosts、token 与引导进度（别名 st）',
  '  hosts        启用 hosts 捕获（弹出 UAC 确认）',
  '  delete       卸载插件：停服务 → 恢复 hosts → 从 profile 注销 → 清理运行数据',
  '  help         显示本说明（直接发 /wbrelay 等同）',
  '',
  'delete 参数：',
  '  --dry-run    只列出将要执行的动作，不做任何修改',
  '  --purge      连插件源码目录一起删除（先备份到同级目录）',
  '  --keep-data  保留运行数据与证书，只做注销',
  '  --keep-hosts 保留 hosts 设置（不弹 UAC）',
  '  --no-install 跳过 pnpm install，直接删除 node_modules 链接',
].join('\n');

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 运行期文件按真实落点分目录：证书与 token 在 channel\mitm\，服务状态与日志在 channel\
const RUNTIME_FILES = [
  { dir: 'mitm', names: ['captured-token.json', 'captured-token.json.tmp'] },
  { dir: 'channel', names: ['runtimes.json', 'reasoning-settings.json', 'reasoning-settings.json.tmp', 'channel-run.log'] },
];
const RUNTIME_FILE_LABEL = 'captured-token.json（mitm）与 runtimes.json / reasoning-settings.json / channel-run.log（channel）';
const CERT_FILES = ['ca.key', 'ca.pem', 'srv.key', 'srv.pem'];

function commandStatusText(st) {
  const c = st.certs || {};
  const lines = [
    '设备证书：' + (c.ok === true ? '有效' : c.present === true ? '需要重签' : '未生成')
      + (c.srvDaysLeft != null ? '（剩余 ' + c.srvDaysLeft + ' 天）' : ''),
    '桥接 8790：' + (st.bridge.up ? '在线' : '离线'),
    'CLI 60622：' + (st.cli.up ? (st.cli.authOk ? '在线 · 已登录' : '在线 · 未登录') : '离线'),
    '捕获 443：' + (st.mitm443.up ? '在线' : '离线'),
    'hosts 捕获：' + (st.hosts.entry === true ? '已启用' : st.hosts.entry === false ? '未启用' : '未确认'),
    'token：' + (st.token.present ? '已捕获（剩余 ' + (st.token.daysLeft ?? '?') + ' 天）' : '未捕获'),
  ];
  const pending = st.onboarding.filter((s) => s.ok !== true);
  if (pending.length) lines.push('待完成：' + pending.map((s) => s.title).join('；'));
  else lines.push('全部就绪：在 dsh 模型列表里选 wbrelay 提供方的模型即可');
  return lines.join('\n');
}

// 一键启动：确保证书 → 拉起通道 → 等桥接就绪 → 把还缺什么直接告诉用户
async function commandStart() {
  const ensured = ensureCerts();
  if (ensured.ok !== true) {
    return {
      kind: 'error',
      text: '设备证书未能就绪：' + (ensured.error || (ensured.issues || []).join('；'))
        + '\n可手工重试：channel\\mitm\\gen-certs.cmd --force',
    };
  }
  const started = startChannel(false);
  if (started.ok !== true) return { kind: 'error', text: '启动失败：' + (started.error || '未知原因') };
  const deadline = Date.now() + 30000;
  let st = await gatherStatus(false);
  while (st.bridge.up !== true && Date.now() < deadline) {
    await sleepMs(1500);
    st = await gatherStatus(false);
  }
  const hints = [];
  if (st.hosts.entry !== true) hints.push('· hosts 捕获未启用 → /wbrelay hosts（需 UAC 确认）');
  if (st.cli.up !== true || st.cli.authOk !== true) hints.push('· CLI 未登录 → 看板「CLI 登录」窗口里输入 /login');
  if (st.token.present !== true) hints.push('· 登录后在 CLI 里发一条消息，token 会自动捕获');
  return {
    kind: 'success',
    text: [st.bridge.up === true ? '✅ 通道已就绪（桥接 8790 在线）' : '⏳ 启动请求已提交，但桥接尚未就绪',
      commandStatusText(st), hints.length ? '还差几步：\n' + hints.join('\n') : '无需其他操作'].join('\n\n'),
  };
}

// 恢复 hosts：复用 mitm-off.cmd，通过 UAC 提权执行（脚本支持 --no-pause，不会卡在 pause 上）
function removeHostsElevated() {
  if (hostsHasEntry() !== true) return Promise.resolve({ ok: true, already: true, note: 'hosts 里没有捕获条目' });
  const script = path.join(CHANNEL_DIR, 'mitm', 'mitm-off.cmd');
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, error: '找不到 ' + script });
  const ps = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
  $script = '${script.replace(/'/g, "''")}'
  $arguments = '/d /s /c ""' + $script + '" --no-pause"'
  $process = Start-Process -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    @{ ok = $false; code = 'hosts_command_failed'; error = ('hosts 脚本执行失败，退出码 ' + $process.ExitCode) } | ConvertTo-Json -Compress
    exit 1
  }
  @{ ok = $true } | ConvertTo-Json -Compress
} catch {
  $code = 'elevation_failed'
  $message = '管理员启动失败：' + $_.Exception.Message
  $exception = $_.Exception
  while ($null -ne $exception) {
    if ($exception.NativeErrorCode -eq 1223) {
      $code = 'elevation_cancelled'
      $message = '管理员授权已取消，hosts 未恢复'
      break
    }
    $exception = $exception.InnerException
  }
  @{ ok = $false; code = $code; error = $message } | ConvertTo-Json -Compress
  exit 1
}`;
  return new Promise((resolve) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand',
      Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostic = '', settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: '恢复 hosts 等待超时，请手动运行 channel\\mitm\\mitm-off.cmd' });
      child.kill();
    }, 90000);
    child.stdout.on('data', (c) => { output = (output + c.toString('utf8')).slice(-8192); });
    child.stderr.on('data', (c) => { diagnostic = (diagnostic + c.toString('utf8')).slice(-8192); });
    child.once('error', (e) => finish({ ok: false, error: '无法启动管理员授权程序：' + e.message }));
    child.once('close', (code) => {
      let parsed;
      try { parsed = JSON.parse(output.trim()); } catch { /* 启动器未返回有效结果 */ }
      if (code === 0 && parsed?.ok === true && hostsHasEntry() !== true) finish({ ok: true });
      else if (hostsHasEntry() !== true) finish({ ok: true, note: 'hosts 条目已移除' });
      else finish({ ok: false, code: parsed?.code || 'hosts_not_removed',
        error: parsed?.error || (diagnostic.trim() ? diagnostic.trim().slice(0, 300) : 'hosts 条目仍然存在') });
    });
  });
}

// 从 profile 注销：删除依赖与 bundle 条目（先备份 package.json）
function unregisterFromProfile(dir, dryRun) {
  const pkgPath = path.join(dir, 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  const deps = pkg.dependencies || {};
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  const hadDep = Object.prototype.hasOwnProperty.call(deps, 'dsh-plugin-wbrelay');
  const hadBundle = bundles.includes('dsh-plugin-wbrelay');
  if (!hadDep && !hadBundle) return { changed: false, note: 'profile 里已无 dsh-plugin-wbrelay 条目' };
  if (dryRun) return { changed: false, note: '将移除依赖条目与 bundle 条目（已存在）' };
  const backup = pkgPath + '.bak-uninstall-' + stamp();
  fs.copyFileSync(pkgPath, backup);
  if (hadDep) delete deps['dsh-plugin-wbrelay'];
  if (pkg.dsh && pkg.dsh.profile) {
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== 'dsh-plugin-wbrelay');
  }
  const tmp = pkgPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, pkgPath);
  return { changed: true, backup };
}

// 解除 node_modules 链接：pnpm install 通常自己会做，这里兜底（只删链接，不动链接目标）
function removeLink(linkPath) {
  let stat;
  try { stat = fs.lstatSync(linkPath); } catch { return { removed: false, note: '链接不存在' }; }
  if (stat.isSymbolicLink()) {
    execSync(`cmd /d /s /c rmdir "${linkPath}"`, { stdio: 'ignore', timeout: 15000 });
    return { removed: true, note: '已删除目录链接（未触碰链接目标）' };
  }
  fs.rmSync(linkPath, { recursive: true, force: true });
  return { removed: true, note: '已删除 node_modules 中的插件副本' };
}

function runPnpmInstall(dir) {
  const local = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const global = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', local) : '';
  const bin = global && fs.existsSync(global) ? global : local;
  const out = execSync(`"${bin}" install --config.confirmModulesPurge=false`, {
    cwd: dir, timeout: 240000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return String(out).trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' / ');
}

/** 卸载插件：先算计划（dry-run 直接返回），再逐步执行，单步失败只记警告不中断。 */
async function uninstallPlugin(options = {}) {
  const dryRun = options.dryRun === true;
  const dir = options.profileDir || profileDir();
  const linkPath = path.join(dir, 'node_modules', 'dsh-plugin-wbrelay');
  const plan = ['停止通道服务（bridge / capture / CLI serve，按 runtimes.json 精确结束）'];
  if (options.keepHosts !== true) plan.push('恢复 hosts：移除 copilot.tencent.com 条目（需要 UAC 确认）');
  plan.push('从 ' + path.join(dir, 'package.json') + ' 移除依赖与 bundle 条目（先备份为 .bak-uninstall-*）');
  if (options.skipInstall !== true) plan.push('在 profile 目录执行 pnpm install，解除 node_modules 链接');
  else plan.push('跳过 pnpm install，改为直接删除 node_modules 链接');
  if (options.keepData !== true) plan.push('清理运行数据：' + RUNTIME_FILE_LABEL);
  if (options.purgeSource === true) plan.push('备份并删除插件源码目录 ' + PLUGIN_ROOT);
  else plan.push('保留插件源码目录 ' + PLUGIN_ROOT);
  if (dryRun) return { ok: true, steps: plan, warnings: ['--dry-run：以上仅为计划，未做任何修改'] };

  const steps = [];
  const warnings = [];

  // 1) 停服务
  try { killTracked(); steps.push('已停止通道服务'); }
  catch (e) { warnings.push('停止服务失败：' + String((e && e.message) || e)); }

  // 2) 恢复 hosts
  if (options.keepHosts !== true) {
    const hosts = await removeHostsElevated();
    if (hosts.ok) steps.push(hosts.already ? 'hosts 无需恢复' : '已恢复 hosts（移除捕获条目）');
    else warnings.push('hosts 未恢复：' + (hosts.error || '未知原因') + '（可手动运行 channel\\mitm\\mitm-off.cmd）');
  }

  // 3) profile 注销
  let backup = null;
  try {
    const result = unregisterFromProfile(dir, false);
    backup = result.backup || null;
    steps.push(result.changed ? '已从 profile 注销（备份 ' + path.basename(backup) + '）' : 'profile 无需改动');
  } catch (e) { warnings.push('profile 注销失败：' + String((e && e.message) || e)); }

  // 4) 解除链接
  try {
    if (options.skipInstall === true) {
      const removed = removeLink(linkPath);
      steps.push('链接处理：' + removed.note);
    } else {
      const summary = runPnpmInstall(dir);
      steps.push('pnpm install 完成' + (summary ? '（' + summary.slice(0, 160) + '）' : ''));
      if (fs.existsSync(linkPath)) steps.push('链接处理：' + removeLink(linkPath).note);
    }
  } catch (e) {
    warnings.push('pnpm install 失败：' + String((e && e.message) || e)
      + '；已直接删除 node_modules 链接，profile 依赖条目也已移除，重启 dsh 后即不再加载插件');
    try { steps.push('链接处理：' + removeLink(linkPath).note); } catch { /* ignore */ }
  }

  // 5) 运行数据（按真实落点分目录查找，别只看 mitm）
  if (options.keepData !== true) {
    const removed = [];
    for (const group of RUNTIME_FILES) {
      const base = group.dir === 'mitm' ? MITM_DIR : CHANNEL_DIR;
      for (const name of group.names) {
        const file = path.join(base, name);
        try {
          if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); removed.push(group.dir + '/' + name); }
        } catch { /* 占用中则跳过，不中断卸载 */ }
      }
    }
    steps.push(removed.length ? '已清理运行数据：' + removed.join('、') : '运行数据已干净');
  } else {
    steps.push('按要求保留运行数据与证书');
  }

  // 6) 可选：连源码目录一起删除
  if (options.purgeSource === true) {
    const backupDir = path.join(path.dirname(PLUGIN_ROOT),
      path.basename(PLUGIN_ROOT) + '-uninstall-backup-' + stamp());
    try {
      fs.cpSync(PLUGIN_ROOT, backupDir, {
        recursive: true,
        filter: (src) => !/[\\/](node_modules|\.git)$/.test(src),
      });
      fs.rmSync(PLUGIN_ROOT, { recursive: true, force: true });
      steps.push('已删除插件源码目录（备份：' + backupDir + '）');
    } catch (e) {
      warnings.push('删除源码目录失败：' + String((e && e.message) || e) + '（备份在 ' + backupDir + '）');
    }
  } else if (options.purgeSource !== true && options.keepData !== true) {
    // 证书默认保留：重建成本低但没必要，用户可用 --purge 一并清除
    steps.push('证书保留在 ' + MITM_DIR + '（如需清除：/wbrelay delete --purge）');
  }

  if (backup) steps.push('需要回滚：把 ' + path.basename(backup) + ' 覆盖回 package.json，并重新 link 安装');
  steps.push('重启 dsh 后彻底生效（当前进程仍持有已加载的插件代码）');
  return { ok: true, steps, warnings };
}

/** /wbrelay 命令入口：解析子命令并返回 dsh 直接渲染的结果。 */
async function runWbrelayCommand(rawInput) {
  const parts = String(rawInput || '').trim().split(/\s+/).filter(Boolean);
  const verbRaw = parts[0] || '';
  const verb = verbRaw.toLowerCase();
  const has = (flag) => parts.slice(1).includes(flag);
  if (!verb || verb === 'help' || verb === '-h' || verb === '--help') {
    return { kind: 'success', text: COMMAND_USAGE };
  }
  if (verb === 'status' || verb === 'st') {
    return { kind: 'success', text: commandStatusText(await gatherStatus(false)) };
  }
  if (verb === 'start') return commandStart();
  if (verb === 'hosts') {
    const result = await fixHostsElevated();
    return result.ok === true
      ? { kind: 'success', text: 'hosts 捕获已启用（' + DIRECT_HOST + ' → 127.0.0.1）。' }
      : { kind: 'error', text: '启用 hosts 失败：' + (result.error || '未知原因') };
  }
  if (verb === 'delete' || verb === 'uninstall' || verb === 'remove') {
    const result = await uninstallPlugin({
      dryRun: has('--dry-run') || has('-n'),
      purgeSource: has('--purge'),
      keepData: has('--keep-data'),
      keepHosts: has('--keep-hosts'),
      skipInstall: has('--no-install'),
    });
    const lines = [result.ok === true ? '✅ 卸载流程完成' : '⚠️ 卸载流程未完成'];
    for (const step of result.steps) lines.push('· ' + step);
    for (const warning of result.warnings) lines.push('！' + warning);
    return { kind: result.ok === true ? 'success' : 'error', text: lines.join('\n') };
  }
  return { kind: 'error', text: '未知子命令 "' + verbRaw + '"。\n' + COMMAND_USAGE };
}

function registerCommands(host) {
  return host.effect(() => {
    const dispose = host.commands.register({
      definitionId: 'dsh-plugin-wbrelay',
      name: 'wbrelay',
      description: 'wbrelay 桥接插件：start 启动通道 / delete 卸载插件 / status 查看状态',
      input: { hint: 'start | status | hosts | delete | help  [delete: --dry-run|--purge|--keep-data|--keep-hosts|--no-install]' },
      handler: (invocation) => runWbrelayCommand(invocation && invocation.rawInput),
    });
    return () => { try { dispose(); } catch { /* ignore */ } };
  }, 'dsh-plugin-wbrelay: slash command');
}

// ---------- 同源防护（照抄 dsh-purge 的 CSRF 思路） ----------
function headerOf(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
function sameOriginOk(req, res) {
  const deny = () => { try { res.writeHead(403); res.end(); } catch { /* ignore */ } return false; };
  const origin = headerOf(req, 'origin');
  if (!origin) return true; // 同源 GET 常无 Origin
  let originHost = '';
  try { originHost = new URL(origin).host; } catch { return deny(); }
  const host = String(headerOf(req, 'host') || '').trim();
  if (!host || originHost.toLowerCase() !== host.toLowerCase()) return deny();
  return true;
}
function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(s);
}

// ---------- 远端版本检查（只取版本号做对比，不跳转外部页面） ----------
const UPDATE_REPO = 'Q-998/dsh-plugin-wbrelay';
const UPDATE_TTL_MS = 10 * 60 * 1000;
let updateCache = null;

function parseVersion(value) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/u.exec(String(value || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareVersion(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
// 一次性 GET：用 node:https + agent:false，不留 keep-alive 句柄（fetch 的全局调度器会留句柄）
function fetchRemoteJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      agent: false, timeout: timeoutMs,
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-wbrelay/' + PLUGIN_VERSION },
    }, (response) => {
      const status = response.statusCode || 0;
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 512 * 1024) request.destroy(new Error('响应内容过大'));
      });
      response.on('end', () => {
        if (status < 200 || status >= 300) { reject(new Error('HTTP ' + status)); return; }
        try { resolve(JSON.parse(body)); } catch { reject(new Error('返回内容不是 JSON')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', (error) => reject(error));
  });
}

/** 归一化标签：v1.0.2 / 1.0.2 都取 1.0.2 */
function normalizeVersion(value) {
  const cleaned = String(value || '').trim().replace(/^v/iu, '');
  return cleaned || null;
}
/** 把未知错误渲染成一行可读文本 */
function describeError(error) {
  return String((error && error.message) || error);
}

/**
 * 查询远端最新版本号，按三级源依次尝试：
 *   1) releases/latest —— 常规路径，附带发布时间与页面地址；
 *   2) tags             —— 仓库还没发 Release 时取标签里的最大版本号；
 *   3) raw package.json —— 最后兜底（raw 有 5 分钟 CDN 缓存，可能短暂读到旧值）。
 * 结果缓存 10 分钟，force=1 强制刷新；只返回版本对比，不返回跳转动作。
 */
async function checkLatestVersion(force = false) {
  if (!force && updateCache && Date.now() - updateCache.checkedAt < UPDATE_TTL_MS) return updateCache;
  const result = { ok: true, current: PLUGIN_VERSION, latest: null, upToDate: null,
    url: 'https://github.com/' + UPDATE_REPO + '/releases', publishedAt: null,
    source: 'release', checkedAt: Date.now(), error: '' };
  const api = 'https://api.github.com/repos/' + UPDATE_REPO;
  try {
    const release = await fetchRemoteJson(api + '/releases/latest');
    result.latest = normalizeVersion(release.tag_name || release.name);
    if (release.html_url) result.url = String(release.html_url);
    if (release.published_at) result.publishedAt = String(release.published_at);
  } catch (releaseError) {
    result.source = 'tags';
    try {
      const tags = await fetchRemoteJson(api + '/tags');
      const names = Array.isArray(tags) ? tags.map((tag) => tag && tag.name).filter(Boolean) : [];
      let best = null;
      for (const name of names) {
        const candidate = normalizeVersion(name);
        if (candidate && (best === null || compareVersion(candidate, best) === 1)) best = candidate;
      }
      result.latest = best;
      if (best) result.url = 'https://github.com/' + UPDATE_REPO + '/releases/tag/v' + best;
    } catch (tagError) {
      result.source = 'package.json';
      try {
        const pkg = await fetchRemoteJson('https://raw.githubusercontent.com/' + UPDATE_REPO + '/main/package.json');
        result.latest = pkg && pkg.version ? String(pkg.version) : null;
      } catch (rawError) {
        result.ok = false;
        result.error = '无法获取远端版本号：Release ' + describeError(releaseError)
          + '；标签 ' + describeError(tagError) + '；package.json ' + describeError(rawError);
      }
    }
  }
  if (result.latest) {
    const cmp = compareVersion(result.latest, PLUGIN_VERSION);
    result.upToDate = cmp === null ? null : cmp <= 0;
  }
  updateCache = result;
  return result;
}

// ---------- cordis 入口 ----------
export function apply(ctx) {
  let nativeReasoning;
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm', 'settings'], (host) => {
      host.effect(() => {
        const sync = createNativeReasoningSync(host);
        nativeReasoning = sync;
        sync.start();
        return () => {
          sync.stop();
          if (nativeReasoning === sync) nativeReasoning = undefined;
        };
      }, 'dsh-plugin-wbrelay: native model reasoning');
    });
  }
  // 斜杠命令：/wbrelay start | status | hosts | delete
  if (typeof ctx.inject === 'function') ctx.inject(['commands'], (host) => registerCommands(host));
  const install = (host) => {
    host.effect(() => {
      const reg = (spec, label) => host.webServer.register({
        ...spec,
        handler: async (request, response) => {
          if (!sameOriginOk(request, response)) return;
          return spec.handler(request, response);
        },
      }, label);

      reg({
        kind: 'exact', path: '/dsh-plugin-wbrelay/status',
        handler: async (request, response) => {
          if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
          try {
            const url = new URL(request.url, 'http://127.0.0.1');
            const probe = url.searchParams.get('probe') === '1';
            const st = await gatherStatus(probe);
            st.nativeReasoning = nativeReasoning?.status() || { state: 'unavailable', provider: 'wbrelay',
              updatedModels: [], checkedAt: null, error: 'dsh 模型配置服务尚未就绪' };
            // 面板地址由服务端按请求 Host 计算，客户端无需自行拼接（避免 origin 判断错误跳错地址）
            const host = String(headerOf(request, 'host') || '127.0.0.1');
            st.dashboardUrl = 'http://' + host + '/dsh-plugin-wbrelay/dashboard';
            st.ver = PLUGIN_VERSION;
            sendJson(response, 200, st);
          } catch (e) { sendJson(response, 500, { ok: false, error: String(e) }); }
        },
      }, 'dsh-plugin-wbrelay: status');

      reg({
        kind: 'exact', path: '/dsh-plugin-wbrelay/models',
        handler: async (request, response) => {
          if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
          if (!nativeReasoning) {
            sendJson(response, 503, { ok: false, error: 'dsh 模型配置服务尚未就绪' });
            return;
          }
          const result = await nativeReasoning.models();
          sendJson(response, result.ok ? 200 : 503, result);
        },
      }, 'dsh-plugin-wbrelay: native models');

      reg({
        kind: 'exact', path: '/dsh-plugin-wbrelay/models/refresh',
        handler: async (request, response) => {
          if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
          if (!nativeReasoning) {
            sendJson(response, 503, { ok: false, error: 'dsh 模型配置服务尚未就绪' });
            return;
          }
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 4096) {
              sendJson(response, 413, { ok: false, error: '请求内容过长' });
              return;
            }
          }
          let force = true;
          if (body.trim()) {
            try {
              const input = JSON.parse(body);
              if (typeof input?.force !== 'boolean') throw new Error();
              force = input.force;
            } catch {
              sendJson(response, 400, { ok: false, error: 'force 必须是布尔值' });
              return;
            }
          }
          const result = await nativeReasoning.refresh(force);
          sendJson(response, result.ok ? 200 : 503, result);
        },
      }, 'dsh-plugin-wbrelay: refresh native models');

      reg({
        kind: 'exact', path: '/dsh-plugin-wbrelay/start',
        handler: async (request, response) => {
          if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
          try { sendJson(response, 200, startChannel(false)); }
          catch (e) { sendJson(response, 500, { ok: false, error: String(e) }); }
        },
      }, 'dsh-plugin-wbrelay: start');

      reg({
        kind: 'exact', path: '/dsh-plugin-wbrelay/restart',
        handler: async (request, response) => {
          if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
          try { sendJson(response, 200, startChannel(true)); }
          catch (e) { sendJson(response, 500, { ok: false, error: String(e) }); }
        },
      }, 'dsh-plugin-wbrelay: restart');

      reg({
        kind: 'exact', path: '/dsh-plugin-wbrelay/dashboard',
        handler: async (request, response) => {
          if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
          try {
            const html = fs.readFileSync(path.join(CHANNEL_DIR, 'dsh-dashboard.html'), 'utf8');
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(html);
          } catch (e) { response.writeHead(404); response.end('dashboard html missing'); }
        },
      }, 'dsh-plugin-wbrelay: dashboard');

      reg({
        kind: 'exact', path: '/dsh-plugin-wbrelay/fix-hosts',
        handler: async (request, response) => {
          if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
          try { sendJson(response, 200, await fixHostsElevated()); }
          catch (e) { sendJson(response, 500, { ok: false, error: String(e) }); }
        },
      }, 'dsh-plugin-wbrelay: fix-hosts');

      reg({
        kind: 'exact', path: '/dsh-plugin-wbrelay/open-cli',
        handler: async (request, response) => {
          if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
          try { sendJson(response, 200, openCliLogin()); }
          catch (e) { sendJson(response, 500, { ok: false, error: String(e) }); }
        },
      }, 'dsh-plugin-wbrelay: open-cli');

      reg({
        kind: 'exact', path: '/dsh-plugin-wbrelay/certs',
        handler: async (request, response) => {
          if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
          try {
            const status = certsStatus();
            sendJson(response, 200, {
              ok: status.ok, certs: status,
              command: 'node "' + CERTGEN + '" --force',
            });
          } catch (e) { sendJson(response, 500, { ok: false, error: String(e) }); }
        },
      }, 'dsh-plugin-wbrelay: certs');

      reg({
        kind: 'exact', path: '/dsh-plugin-wbrelay/certs/generate',
        handler: async (request, response) => {
          if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return; }
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 4096) {
              sendJson(response, 413, { ok: false, error: '请求内容过长' });
              return;
            }
          }
          let force = false;
          if (body.trim()) {
            try {
              const input = JSON.parse(body);
              if (typeof input?.force !== 'boolean') throw new Error();
              force = input.force;
            } catch {
              sendJson(response, 400, { ok: false, error: 'force 必须是布尔值' });
              return;
            }
          }
          try {
            const result = ensureCerts({ force });
            sendJson(response, result.ok ? 200 : 500, {
              ok: result.ok, generated: !!result.generated, forced: force,
              note: result.note || null, error: result.error || null,
              issues: result.issues || [], certs: result.status,
            });
          } catch (e) { sendJson(response, 500, { ok: false, error: String(e) }); }
        },
      }, 'dsh-plugin-wbrelay: generate certs');

      reg({
        kind: 'exact', path: '/dsh-plugin-wbrelay/update',
        handler: async (request, response) => {
          if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
          try {
            const url = new URL(request.url, 'http://127.0.0.1');
            const result = await checkLatestVersion(url.searchParams.get('force') === '1');
            sendJson(response, result.ok ? 200 : 502, result);
          } catch (e) { sendJson(response, 502, { ok: false, error: String(e) }); }
        },
      }, 'dsh-plugin-wbrelay: update check');
    }, 'dsh-plugin-wbrelay: routes');
  };

  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], install);
  else if (ctx.webServer) install({ webServer: ctx.webServer, effect: (fn) => fn() });
}
