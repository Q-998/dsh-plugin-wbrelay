// TLS 直捕代理（长期运行版）
// 原理：hosts 把 copilot.tencent.com 指到 127.0.0.1，本服务用自签证书终结 TLS，
// 捕获每个请求的 Authorization 头写入 captured-token.json（桥直连时读取），
// 然后转发到真实 IP 并流式回传响应。支持 keep-alive 串行多请求。
//
// 证书：不再依赖「预先存在的证书文件」。启动时用 certgen.cjs 自检并自动生成
// 设备专用 CA 与服务证书（缺失/过期/主机名不覆盖/公私钥不配对都会重签），
// 因此新用户克隆插件后直接启动即可，无需手工 openssl。
//
// 参数（都可省略，默认值即生产用法）：
//   --port 443           监听端口（默认 443，可用环境变量 WB_CAPTURE_PORT 覆盖）
//   --hosts a.com,b.com  允许捕获/需要签进 SAN 的主机名（默认 copilot.tencent.com）
//   --cert-dir <path>    证书目录（默认本脚本目录）
//   --upstream host:port 覆盖上游地址（调试/自建上游用；默认按 DNS 解析真实 IP）
//   --upstream-ca <pem>  自定义上游 CA（配合 --upstream 指向自签上游时使用）
//   --ip 1.2.3.4,5.6.7.8 静态兜底 IP（DNS 解析失败时用）
const https = require('https');
const tls = require('tls');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const { ensureDeviceCerts } = require('./certgen.cjs');

const ARGS = process.argv.slice(2);
const argOf = (name, def) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : def;
};

const PORT = Number(argOf('--port', process.env.WB_CAPTURE_PORT || 443));
const HOSTS = String(argOf('--hosts', process.env.WB_CAPTURE_HOSTS || 'copilot.tencent.com'))
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const CERT_DIR = path.resolve(argOf('--cert-dir', __dirname));
const UPSTREAM_SPEC = String(argOf('--upstream', '')).trim();
const UPSTREAM_CA = argOf('--upstream-ca', '');
const FALLBACK_IPS = String(argOf('--ip', '112.28.173.82,112.28.174.102'))
  .split(',').map((s) => s.trim()).filter(Boolean);
const CAPTURE = path.join(__dirname, 'captured-token.json');

/* ---------- 证书：确保可用后才开始监听 ---------- */
function loadServerCredentials() {
  const ensured = ensureDeviceCerts(CERT_DIR, { sans: ARGS.includes('--hosts') ? HOSTS : undefined });
  if (!ensured.ok) {
    console.error('[证书] 无法就绪：' + (ensured.error || ensured.issues.join('；')));
    console.error('[证书] 手工生成：node "' + path.join(__dirname, 'certgen.cjs') + '" --force');
    process.exit(1);
  }
  const srvOpts = {
    key: fs.readFileSync(path.join(CERT_DIR, 'srv.key')),
    cert: fs.readFileSync(path.join(CERT_DIR, 'srv.pem')),
  };
  const c = ensured.status;
  console.log('[证书] ' + (ensured.generated ? '已生成' : '有效')
    + ' · 到期 ' + (c.srvNotAfter || '?') + '（剩余 ' + c.srvDaysLeft + ' 天）'
    + ' · 指纹 ' + String(c.fingerprint || '').slice(0, 29) + '…');
  if (ensured.generated && ensured.issues.length) console.log('[证书] 重签原因：' + ensured.issues.join('；'));
  return srvOpts;
}
const srvOpts = loadServerCredentials();

/* ---------- 上游地址 ---------- */
const UPSTREAM = (() => {
  if (!UPSTREAM_SPEC) return null;
  const idx = UPSTREAM_SPEC.lastIndexOf(':');
  if (idx < 0) return { host: UPSTREAM_SPEC, port: 443 };
  return { host: UPSTREAM_SPEC.slice(0, idx), port: Number(UPSTREAM_SPEC.slice(idx + 1)) || 443 };
})();
const upstreamCa = UPSTREAM_CA && fs.existsSync(UPSTREAM_CA) ? fs.readFileSync(UPSTREAM_CA) : undefined;

let realIPs = FALLBACK_IPS.slice(); // 兜底硬编码；resolve4 成功后动态覆盖
let ipIdx = 0;
async function refreshIPs() {
  if (UPSTREAM) { realIPs = [UPSTREAM.host]; console.log('[ips] 上游覆盖为', UPSTREAM.host + ':' + UPSTREAM.port); return; }
  try {
    // resolve4 走 DNS 服务器，绕过 hosts 文件（回调形式，兼容性最稳）
    for (const h of HOSTS) {
      const addrs = await new Promise((res, rej) => dns.resolve4(h, (e, a) => e ? rej(e) : res(a)));
      if (addrs && addrs.length) { realIPs = addrs; break; }
    }
    console.log('[ips] 真实 IP:', realIPs.join(', '));
  } catch (e) { console.log('[ips] 使用兜底 IP:', realIPs.join(', '), '（', e.message.slice(0, 50), '）'); }
}
refreshIPs();
setInterval(refreshIPs, 10 * 60 * 1000);

function recordCapture({ host, method, url, auth, contentType, body }) {
  try {
    fs.writeFileSync(CAPTURE, JSON.stringify({
      time: new Date().toISOString(), host, method, url,
      authorization: auth,
      contentType,
      bodyPreview: body.toString('utf8').slice(0, 500),
    }, null, 2));
  } catch { /* ignore */ }
}

const server = tls.createServer(srvOpts, (tlsSocket) => {
  let buf = Buffer.alloc(0);
  let active = false; // 是否有未完成的转发请求

  function tryRequest() {
    if (active) return;
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const headerText = buf.slice(0, headerEnd).toString('utf8');
    const lines = headerText.split('\r\n');
    const [method, url] = lines[0].split(' ');
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i].indexOf(':');
      if (idx > 0) headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
    }
    const host = (headers['host'] || HOSTS[0]).split(':')[0];
    const auth = headers['authorization'] || headers['x-api-key'] || '';
    const noteCapture = (body) => {
      if (auth) {
        recordCapture({ host, method, url, auth, contentType: headers['content-type'] || '', body });
        console.log('[捕获]', method, url, 'auth=', auth.slice(0, 28) + '... len=' + auth.length);
      } else {
        console.log('[无认证头]', method, url);
      }
    };

    // 请求体分帧：只支持带 content-length 的请求（CLI 的 JSON 请求都是这种）。
    // chunked 请求体：token 捕获不依赖请求体，先记录认证头，再明确回错而不是让客户端一直等。
    if (headers['transfer-encoding'] && !headers['content-length']) {
      noteCapture(Buffer.alloc(0));
      console.log('[不支持] chunked 请求体', method, url);
      try { tlsSocket.end('HTTP/1.1 411 Length Required\r\ncontent-length: 0\r\nconnection: close\r\n\r\n'); } catch {}
      return;
    }
    const contentLen = parseInt(headers['content-length'] || '0', 10);
    if (buf.length < headerEnd + 4 + contentLen) return; // 体未齐
    const body = buf.slice(headerEnd + 4, headerEnd + 4 + contentLen);
    buf = buf.slice(headerEnd + 4 + contentLen);

    noteCapture(body);

    active = true;
    const writeOut = (data) => { try { tlsSocket.write(data); } catch { /* 客户端已断开 */ } };
    const fail502 = () => {
      console.log('[上游不可用]', method, url);
      try { tlsSocket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n'); } catch {}
      active = false;
    };
    if (!realIPs.length) { fail502(); return; }
    const ip = realIPs[ipIdx++ % realIPs.length];
    const upstreamHost = UPSTREAM ? UPSTREAM.host : host;
    const upstreamPort = UPSTREAM ? UPSTREAM.port : 443;
    const upReq = https.request({
      host: upstreamHost, servername: host, port: upstreamPort, method, path: url,
      headers: { ...headers, host },
      ...(UPSTREAM ? {} : { lookup: (_h, o, cb) => cb(null, ip, 4) }), // 绕过 hosts，直连真实 IP
      ...(upstreamCa ? { ca: upstreamCa } : {}),
    }, (upRes) => {
      // 响应分帧必须自洽：上游 Node ≥19 默认 keep-alive，响应体多为 chunked。
      // 只丢 transfer-encoding 而不补 content-length，会让客户端一直等响应体结束（请求卡死），
      // 所以这里保留 chunked 并自己重新分帧（流式 SSE 也只能这么做）。
      const chunked = String(upRes.headers['transfer-encoding'] || '').toLowerCase().includes('chunked');
      const closeDelimited = !chunked && upRes.headers['content-length'] == null; // 靠连接关闭分界
      let head = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ''}\r\n`;
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (k === 'transfer-encoding' || k === 'connection' || k === 'keep-alive') continue; // hop-by-hop
        head += `${k}: ${v}\r\n`;
      }
      if (chunked) head += 'transfer-encoding: chunked\r\n';
      head += closeDelimited ? 'connection: close\r\n\r\n' : 'connection: keep-alive\r\n\r\n';
      writeOut(head);
      upRes.on('data', (d) => {
        if (chunked) writeOut(Buffer.concat([Buffer.from(d.length.toString(16) + '\r\n'), d, Buffer.from('\r\n')]));
        else writeOut(d);
      });
      upRes.on('end', () => {
        if (chunked) writeOut('0\r\n\r\n');
        if (closeDelimited || headers['connection'] === 'close') { try { tlsSocket.end(); } catch {} }
        active = false;
        setImmediate(tryRequest); // keep-alive：处理同一连接上的下一个请求
      });
    });
    upReq.on('error', (e) => {
      console.log('[上游错误]', e.message.slice(0, 100));
      fail502();
    });
    if (body.length) upReq.write(body);
    upReq.end();
  }

  tlsSocket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); tryRequest(); });
  tlsSocket.on('error', (e) => console.log('[tls]', e.message.slice(0, 60)));
  tlsSocket.on('close', () => {});
});

server.on('error', (e) => {
  if (e.code === 'EACCES') {
    console.error('[失败] 无法监听 127.0.0.1:' + PORT + '：端口被占用或权限不足。');
    console.error('       关闭占用该端口的程序，或用 --port 换端口（记住同步 hosts/看板设置）。');
  } else {
    console.error('[失败] 监听失败：' + e.message);
  }
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`TLS 直捕代理就绪 127.0.0.1:${PORT}（捕获 ${HOSTS.join(', ')}）`));
