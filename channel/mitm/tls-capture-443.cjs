// TLS 直捕代理（长期运行版）
// 原理：hosts 把 copilot.tencent.com 指到 127.0.0.1，本服务用自签证书终结 TLS，
// 捕获每个请求的 Authorization 头写入 captured-token.json（桥直连时读取），
// 然后转发到真实 IP 并流式回传响应。支持 keep-alive 串行多请求。
const https = require('https');
const tls = require('tls');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

const PORT = 443;
const HOSTS = ['copilot.tencent.com'];
const CAPTURE = path.join(__dirname, 'captured-token.json');
const srvOpts = {
  key: fs.readFileSync(path.join(__dirname, 'srv.key')),
  cert: fs.readFileSync(path.join(__dirname, 'srv.pem')),
};

let realIPs = ['112.28.173.82', '112.28.174.102']; // 兜底硬编码；resolve4 成功后动态覆盖
let ipIdx = 0;
async function refreshIPs() {
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
    if (headers['transfer-encoding']) { console.log('[警告] chunked 请求体未支持'); return; }
    const contentLen = parseInt(headers['content-length'] || '0', 10);
    if (buf.length < headerEnd + 4 + contentLen) return; // 体未齐
    const body = buf.slice(headerEnd + 4, headerEnd + 4 + contentLen);
    buf = buf.slice(headerEnd + 4 + contentLen);

    const host = (headers['host'] || HOSTS[0]).split(':')[0];
    const auth = headers['authorization'] || headers['x-api-key'] || '';
    if (auth) {
      try {
        fs.writeFileSync(CAPTURE, JSON.stringify({
          time: new Date().toISOString(), host, method, url,
          authorization: auth,
          contentType: headers['content-type'] || '',
          bodyPreview: body.toString('utf8').slice(0, 500),
        }, null, 2));
      } catch {}
      console.log('[捕获]', method, url, 'auth=', auth.slice(0, 28) + '... len=' + auth.length);
    } else {
      console.log('[无认证头]', method, url);
    }

    active = true;
    if (!realIPs.length) { try { tlsSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {} active = false; return; }
    const ip = realIPs[ipIdx++ % realIPs.length];
    const upReq = https.request({
      host, servername: host, port: 443, method, path: url,
      headers: { ...headers, host },
      lookup: (_h, o, cb) => cb(null, ip, 4), // 绕过 hosts，直连真实 IP
    }, (upRes) => {
      let head = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ''}\r\n`;
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (k === 'transfer-encoding') continue; // Node 会用 content-length 或连接关闭分界
        head += `${k}: ${v}\r\n`;
      }
      head += '\r\n';
      try { tlsSocket.write(head); } catch {}
      upRes.on('data', (d) => { try { tlsSocket.write(d); } catch {} });
      upRes.on('end', () => {
        try { if (headers['connection'] === 'close') tlsSocket.end(); } catch {}
        active = false;
        setImmediate(tryRequest); // keep-alive：处理同一连接上的下一个请求
      });
    });
    upReq.on('error', (e) => {
      console.log('[上游错误]', e.message.slice(0, 100));
      try { tlsSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
      active = false;
    });
    if (body.length) upReq.write(body);
    upReq.end();
  }

  tlsSocket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); tryRequest(); });
  tlsSocket.on('error', (e) => console.log('[tls]', e.message.slice(0, 60)));
  tlsSocket.on('close', () => {});
});

server.listen(PORT, '127.0.0.1', () => console.log(`TLS 直捕代理就绪 127.0.0.1:${PORT}`));
