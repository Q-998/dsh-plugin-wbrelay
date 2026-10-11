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
import { fileURLToPath } from 'node:url';
import { createNativeReasoningSync } from './native-reasoning.js';

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
const TOKEN_FILE = path.join(CHANNEL_DIR, 'mitm', 'captured-token.json');
const PLUGIN_PATCH = path.join(PLUGIN_ROOT, 'cordis.patch.yml');
const DIRECT_HOST = 'copilot.tencent.com';
const DIRECT_IPS = ['112.28.173.82', '112.28.174.102'];
const BRIDGE_PORT = 8790;
const CLI_PORT = 60622;
const PLUGIN_VERSION = '1.0.0';

let lastStartAt = 0;
let hostsFlight = null;

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
  const userProfile = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
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
    const pkg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'package.json'), 'utf8'));
    bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  } catch { /* profile 不可读 */ }
  const onboarding = buildOnboarding({
    bridge: { up: bridgeUp },
    cli: { up: cliUp, authOk: !!(cliAuth && cliAuth.authenticated) },
    hosts: { entry: hostsHasEntry() },
    token: tokenInfo(),
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
  const ca = path.join(CHANNEL_DIR, 'mitm', 'ca.pem');
  if (!fs.existsSync(ca)) return { ok: false, error: '找不到 Token 捕获证书：' + ca };
  // Node 只在启动时读取额外 CA；登录窗口必须继承与通道启动器一致的环境。
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
  // 按 runtimes.json 精确停掉上一轮实例（隐藏进程无窗口标题可匹配）
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(CHANNEL_DIR, 'runtimes.json'), 'utf8'));
    for (const k of ['bridge', 'capture', 'serve']) {
      const pid = rt.pids && rt.pids[k];
      if (pid) { try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', timeout: 4000 }); } catch { /* ignore */ } }
    }
  } catch { /* 无 runtimes.json：兼容旧实例 */ }
  try { execSync('taskkill /FI "WINDOWTITLE eq codebuddy-code serve*" /F', { stdio: 'ignore', timeout: 4000 }); } catch { /* ignore */ }
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
    }, 'dsh-plugin-wbrelay: routes');
  };

  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], install);
  else if (ctx.webServer) install({ webServer: ctx.webServer, effect: (fn) => fn() });
}
