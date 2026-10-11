'use strict';
/*
 * certgen.cjs — 设备证书生成器（零外部依赖，只用 node:crypto）
 *
 * 为什么需要它：
 *   捕获代理要用自签证书在本机终结 copilot.tencent.com 的 TLS，CLI 要信任这张
 *   CA（NODE_EXTRA_CA_CERTS=mitm/ca.pem）。证书是「设备专用材料」，不进 Git，
 *   所以新用户克隆下来时 mitm 目录里没有证书 —— 没有证书 → 443 代理起不来
 *   → 捕获不到 token → 桥接发不出请求。本文件把「生成证书」这件事变成插件自己的
 *   能力：谁拿到插件都能在本机一键生成，不需要手工 openssl，也不需要向作者索取。
 *
 * 生命周期：
 *   CA 自签 10 年；服务证书 10 年带 SAN（与 README/CERT.md 的手工 openssl 流程同参数）。每次确保时
 *   自检（能否互验、主机名是否覆盖、是否临近过期、公私钥是否配对），不满足就重签；证书有效则不动。
 *
 * 两个引擎（结果等价，任选）：
 *   node    （默认）纯 node:crypto 现场签 X.509，不需要任何外部程序；
 *   openssl 调用 openssl 执行 CERT.md 里那三条命令（req -x509 / req / x509 -req）。
 *
 * 用法：
 *   node certgen.cjs                      确保证书存在且有效（缺失/过期/不匹配则生成）
 *   node certgen.cjs --status             只打印状态，不写文件
 *   node certgen.cjs --json               以 JSON 输出状态
 *   node certgen.cjs --force              强制重签（换设备、换目录、怀疑私钥泄漏时用）
 *   node certgen.cjs --engine openssl     改用 openssl 流程生成（默认 node 内置）
 *   node certgen.cjs --days 3650          指定服务证书有效天数（CA 默认 3650 天）
 *   node certgen.cjs --sans a.com,b.com   覆盖 SAN 列表（默认读同目录 san.cnf）
 *   node certgen.cjs --dir <path>         指定输出目录（默认脚本所在目录）
 *   node certgen.cjs --install-trust      把 CA 装进「当前用户」受信任根（可选，弹确认框）
 *   node certgen.cjs --remove-trust       从当前用户受信任根移除本 CA（卸载清理用）
 *
 * 作为模块（供捕获代理/编排器/插件路由调用）：
 *   const { ensureDeviceCerts, inspectDeviceCerts } = require('./certgen.cjs');
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_SANS = ['copilot.tencent.com', 'tencent.sso.codebuddy.cn', 'codebuddy.cn'];
const CA_CN = 'dsh-mitm-ca';
const CA_DAYS = 3650;
const SRV_DAYS = 3650;
const RENEW_BEFORE_DAYS = 30; // 服务证书剩余不足 30 天 → 重签
const CA_RENEW_BEFORE_DAYS = 365; // CA 剩余不足 1 年 → 整链重签
const NAMES = { caKey: 'ca.key', caPem: 'ca.pem', srvKey: 'srv.key', srvPem: 'srv.pem' };

/* ------------------------------------------------------------------ *
 * 极简 DER 编码（X.509 需要的那一小部分）
 * ------------------------------------------------------------------ */

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...parts) => tlv(0x30, parts);
const set = (...parts) => tlv(0x31, parts);
const octet = (buf) => tlv(0x04, buf);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const nullDer = () => tlv(0x05, Buffer.alloc(0));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bitString = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const ctxTag = (n, content, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, content);

function intFromBuffer(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i += 1;
  let body = buf.subarray(i);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function intFromNumber(n) {
  const bytes = [];
  let v = BigInt(n);
  if (v === 0n) bytes.push(0);
  while (v > 0n) { bytes.unshift(Number(v & 0xffn)); v >>= 8n; }
  let body = Buffer.from(bytes);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const enc = [];
    let v = part;
    do { enc.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    for (let i = 0; i < enc.length - 1; i += 1) enc[i] |= 0x80;
    bytes.push(...enc);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function derTime(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const y = date.getUTCFullYear();
  const body = p(date.getUTCMonth() + 1) + p(date.getUTCDate()) + p(date.getUTCHours())
    + p(date.getUTCMinutes()) + p(date.getUTCSeconds());
  if (y >= 1950 && y <= 2049) return tlv(0x17, Buffer.from(p(y % 100) + body + 'Z', 'ascii'));
  return tlv(0x18, Buffer.from(p(y, 4) + body + 'Z', 'ascii'));
}

// 只读一层 TLV，用来从 SPKI 里取 BIT STRING 内容（算 SKI 用）
function readTlv(buf, offset) {
  const tag = buf[offset];
  let len = buf[offset + 1];
  let headerLen = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i += 1) len = (len << 8) | buf[offset + 2 + i];
    headerLen = 2 + n;
  }
  return { tag, length: len, headerLen, contentStart: offset + headerLen, contentEnd: offset + headerLen + len };
}

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest(); }

// SubjectPublicKeyInfo DER → { der, ski }
function keyInfoOf(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const outer = readTlv(der, 0);
  const alg = readTlv(der, outer.contentStart);
  const bits = readTlv(der, alg.contentEnd);
  const keyBits = der.subarray(bits.contentStart + 1, bits.contentEnd); // 跳过 unused-bits 字节
  return { der, ski: sha1(keyBits) };
}

const OID = {
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyIdentifier: '2.5.29.14',
  authorityKeyIdentifier: '2.5.29.35',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const rdn = (oidStr, value) => set(seq(oid(oidStr), utf8(value)));
const nameDer = (commonName, organization) => seq(rdn(OID.commonName, commonName), rdn(OID.organization, organization));

function extension(oidStr, critical, value) {
  return seq(oid(oidStr), ...(critical ? [bool(true)] : []), octet(value));
}

function signAlgorithm() { return seq(oid(OID.sha256WithRsa), nullDer()); }

function makeCertificate(options) {
  const {
    serial, issuer, subject, notBefore, notAfter, spki, ski, akid, extensions, signKey,
  } = options;
  const tbs = seq(
    ctxTag(0, intFromNumber(2)), // version v3
    intFromBuffer(serial),
    signAlgorithm(),
    issuer,
    seq(derTime(notBefore), derTime(notAfter)),
    subject,
    spki,
    ctxTag(3, seq(...extensionList(ski, akid, extensions))),
  );
  const signature = crypto.sign('sha256', tbs, signKey);
  return seq(tbs, signAlgorithm(), bitString(signature));
}

// v3 扩展拼装：SKI / AKI 统一放置，其余按语义给
function extensionList(ski, akid, extra) {
  const list = [extension(OID.subjectKeyIdentifier, false, octet(ski))];
  if (akid) list.push(extension(OID.authorityKeyIdentifier, false, seq(ctxTag(0, akid, false))));
  return list.concat(extra);
}

/* ------------------------------------------------------------------ *
 * 证书生成
 * ------------------------------------------------------------------ */

function newSerial() {
  const buf = crypto.randomBytes(8);
  buf[0] &= 0x7f;
  if (buf.readUInt32BE(0) === 0) buf.writeUInt32BE(1, 0);
  return buf;
}

function generateKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/**
 * 生成设备 CA + 服务证书，写入 dir。
 * @param {string} dir 输出目录（默认脚本所在目录）
 * @returns {{caPemPath:string,srvPemPath:string,sans:string[],caNotAfter:string,srvNotAfter:string,fingerprint:string}}
 */
function generateDeviceCerts(dir, options = {}) {
  const engine = String(options.engine || process.env.WB_CERT_ENGINE || 'node').toLowerCase();
  if (engine === 'openssl' || engine === 'ossl') return opensslGenerate(dir, options);
  const sans = normalizeSans(options.sans || readSanConfig(dir));
  const caDays = Number(options.caDays || CA_DAYS);
  const srvDays = Number(options.srvDays || SRV_DAYS);
  const now = new Date();
  const backdate = new Date(now.getTime() - 24 * 3600 * 1000); // 回拨 1 天，避开客户端时钟误差

  // 只换服务证书时沿用现有 CA：运行中的 CLI 进程是启动时读取 NODE_EXTRA_CA_CERTS 的，
  // 换 CA 会让它继续用旧信任链，必须重开登录窗口；能不动 CA 就不动。
  const reuse = options.force === true ? null : loadUsableCa(dir);
  const caKeys = reuse
    ? { privateKey: reuse.keyPem, publicKey: crypto.createPublicKey(reuse.key).export({ type: 'spki', format: 'pem' }) }
    : generateKeyPair();
  const caInfo = keyInfoOf(caKeys.publicKey);
  const caSubject = reuse ? tbsField(reuse.der, 3) : nameDer(CA_CN, 'dsh-plugin-wbrelay');
  const caNotAfter = reuse ? new Date(reuse.cert.validTo) : new Date(backdate.getTime() + caDays * 86400000);
  const caDer = reuse ? reuse.der : makeCertificate({
    serial: newSerial(),
    issuer: caSubject,
    subject: caSubject,
    notBefore: backdate,
    notAfter: caNotAfter,
    spki: caInfo.der,
    ski: caInfo.ski,
    extensions: [
      extension(OID.basicConstraints, true, seq(bool(true))),
      extension(OID.keyUsage, true, bitString(Buffer.from([0x06]))), // keyCertSign(5) + cRLSign(6)
    ],
    signKey: caKeys.privateKey,
  });

  const srvKeys = generateKeyPair();
  const srvInfo = keyInfoOf(srvKeys.publicKey);
  const srvNotAfter = new Date(backdate.getTime() + srvDays * 86400000);
  const sanList = seq(...sans.map((name) => tlv(0x82, Buffer.from(name, 'ascii'))));
  const srvDer = makeCertificate({
    serial: newSerial(),
    issuer: caSubject,
    subject: nameDer(sans[0], 'dsh-plugin-wbrelay'),
    notBefore: backdate,
    notAfter: srvNotAfter,
    spki: srvInfo.der,
    ski: srvInfo.ski,
    akid: caInfo.ski,
    extensions: [
      extension(OID.basicConstraints, true, seq(bool(false))),
      extension(OID.keyUsage, true, bitString(Buffer.from([0xa0]))), // digitalSignature(0) + keyEncipherment(2)
      extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      extension(OID.subjectAltName, false, sanList),
    ],
    signKey: caKeys.privateKey,
  });

  // 先自检再落盘：签出来的东西必须能被 node:crypto 验通，否则宁可失败也不写坏文件
  const caPem = reuse ? reuse.pem : toPem('CERTIFICATE', caDer);
  const srvPem = toPem('CERTIFICATE', srvDer);
  const caX509 = new crypto.X509Certificate(caPem);
  const srvX509 = new crypto.X509Certificate(srvPem);
  if (!caX509.ca) throw new Error('生成的 CA 缺少 CA:TRUE 扩展');
  if (!srvX509.verify(caX509.publicKey)) throw new Error('生成的服务证书无法用 CA 公钥验证');
  for (const name of sans) {
    if (!srvX509.checkHost(name)) throw new Error('生成的服务证书未覆盖主机名 ' + name);
  }

  fs.mkdirSync(dir, { recursive: true });
  if (!reuse) {
    writeFileAtomic(path.join(dir, NAMES.caKey), caKeys.privateKey);
    writeFileAtomic(path.join(dir, NAMES.caPem), caPem);
  }
  writeFileAtomic(path.join(dir, NAMES.srvKey), srvKeys.privateKey);
  writeFileAtomic(path.join(dir, NAMES.srvPem), srvPem);

  return {
    ok: true,
    dir,
    engine: 'node',
    caReused: !!reuse,
    sans,
    caPemPath: path.join(dir, NAMES.caPem),
    srvPemPath: path.join(dir, NAMES.srvPem),
    caNotAfter: caNotAfter.toISOString(),
    srvNotAfter: srvNotAfter.toISOString(),
    days: srvDays,
    fingerprint: srvX509.fingerprint256 || srvX509.fingerprint,
    caFingerprint: caX509.fingerprint256 || caX509.fingerprint,
  };
}

function toPem(label, der) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function writeFileAtomic(target, content) {
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
}

function normalizeSans(list) {
  const cleaned = [...new Set((list || []).map((s) => String(s).trim().toLowerCase())
    .filter((s) => /^[a-z0-9.-]+$/.test(s)))];
  return cleaned.length ? cleaned : DEFAULT_SANS.slice();
}

/* ------------------------------------------------------------------ *
 * openssl 引擎：等价于 CERT.md 里手工执行的三条命令
 *   openssl req -x509 -newkey rsa:2048 -nodes -days <CA> -keyout ca.key -out ca.pem -subj "/CN=dsh-mitm-ca"
 *   openssl req -newkey rsa:2048 -nodes -keyout srv.key -out srv.csr -subj "/CN=<首个 SAN>"
 *   openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out srv.pem \
 *                -days <SRV> -extfile san.cnf
 * 装 Git for Windows 即自带 openssl；没有 openssl 时请用默认的 node 内置引擎。
 * ------------------------------------------------------------------ */

function resolveOpenssl() {
  const candidates = [
    process.env.WB_OPENSSL,
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
      .map((dir) => path.join(dir, 'openssl.exe')),
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\OpenSSL-Win32\\bin\\openssl.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  try {
    require('child_process').execFileSync('openssl', ['version'], { stdio: 'ignore', timeout: 10000 });
    return 'openssl';
  } catch { return null; }
}

function writeTempExtFile(dir, sans) {
  const name = 'srv-ext.cnf';
  fs.writeFileSync(path.join(dir, name),
    'subjectAltName=' + sans.map((s) => 'DNS:' + s).join(',') + '\nextendedKeyUsage=serverAuth\n', 'utf8');
  return name;
}

function opensslGenerate(dir, options = {}) {
  const openssl = resolveOpenssl();
  if (!openssl) throw new Error('未找到 openssl：安装 Git for Windows 即自带，或改用内置引擎（默认）');
  const { execFileSync } = require('child_process');
  const sans = normalizeSans(options.sans || readSanConfig(dir));
  const caDays = Number(options.caDays || CA_DAYS);
  const srvDays = Number(options.srvDays || SRV_DAYS);
  fs.mkdirSync(dir, { recursive: true });
  const run = (args) => execFileSync(openssl, args, {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, encoding: 'utf8',
  });
  const hasSanFile = fs.existsSync(path.join(dir, 'san.cnf'));
  const extFile = hasSanFile ? 'san.cnf' : writeTempExtFile(dir, sans);
  // 与内置引擎一致：只换服务证书时沿用现有 CA，避免运行中的 CLI 需要重开才认新信任链。
  const reuse = options.force === true ? null : loadUsableCa(dir);
  try {
    if (!reuse) {
      run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(caDays),
        '-keyout', NAMES.caKey, '-out', NAMES.caPem, '-subj', '/CN=' + CA_CN]);
    }
    run(['req', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', NAMES.srvKey, '-out', 'srv.csr', '-subj', '/CN=' + sans[0]]);
    run(['x509', '-req', '-in', 'srv.csr', '-CA', NAMES.caPem, '-CAkey', NAMES.caKey,
      '-CAcreateserial', '-out', NAMES.srvPem, '-days', String(srvDays), '-extfile', extFile]);
  } finally {
    // 文档里提到的一次性中间产物：签发完成后清理
    for (const leftover of ['srv.csr', 'ca.srl']) {
      try { fs.rmSync(path.join(dir, leftover), { force: true }); } catch { /* ignore */ }
    }
    if (!hasSanFile) { try { fs.rmSync(path.join(dir, extFile), { force: true }); } catch { /* ignore */ } }
  }
  assertUsable(dir, sans);
  const ca = new crypto.X509Certificate(fs.readFileSync(path.join(dir, NAMES.caPem)));
  const srv = new crypto.X509Certificate(fs.readFileSync(path.join(dir, NAMES.srvPem)));
  return {
    ok: true,
    dir,
    engine: 'openssl',
    openssl,
    caReused: !!reuse,
    sans,
    caPemPath: path.join(dir, NAMES.caPem),
    srvPemPath: path.join(dir, NAMES.srvPem),
    caNotAfter: new Date(ca.validTo).toISOString(),
    srvNotAfter: new Date(srv.validTo).toISOString(),
    days: srvDays,
    fingerprint: srv.fingerprint256 || srv.fingerprint,
    caFingerprint: ca.fingerprint256 || ca.fingerprint,
  };
}

/** 生成后统一自检：链能验通、主机名覆盖、私钥与证书配对；不合格直接抛错，不留下坏证书。 */
function assertUsable(dir, sans) {
  const ca = new crypto.X509Certificate(fs.readFileSync(path.join(dir, NAMES.caPem)));
  const srv = new crypto.X509Certificate(fs.readFileSync(path.join(dir, NAMES.srvPem)));
  if (!ca.ca) throw new Error('生成的 CA 缺少 CA:TRUE 扩展');
  if (!srv.verify(ca.publicKey)) throw new Error('生成的服务证书无法用 CA 公钥验证');
  const key = crypto.createPrivateKey(fs.readFileSync(path.join(dir, NAMES.srvKey)));
  const keyPub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
  const certPub = srv.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  if (keyPub !== certPub) throw new Error('生成的服务证书与私钥不配对');
  for (const name of normalizeSans(sans)) {
    if (!srv.checkHost(name)) throw new Error('生成的服务证书未覆盖主机名 ' + name);
  }
  return true;
}

/** 读取同目录 san.cnf 的 subjectAltName=DNS:a,DNS:b，缺失时回落内置默认值 */
function readSanConfig(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'san.cnf'), 'utf8');
    const line = text.split(/\r?\n/).find((l) => /^\s*subjectAltName\s*=/.test(l));
    if (!line) return DEFAULT_SANS.slice();
    const names = [...line.split('=').slice(1).join('=').matchAll(/DNS:([^,\s]+)/g)].map((m) => m[1]);
    return names.length ? names : DEFAULT_SANS.slice();
  } catch { return DEFAULT_SANS.slice(); }
}

/* ------------------------------------------------------------------ *
 * 自检 / 确保
 * ------------------------------------------------------------------ */

const daysLeft = (date) => (date.getTime() - Date.now()) / 86400000;

// 从证书 DER 里取 tbsCertificate 的第 n 个字段（0=[0]version,1=serial,2=sigAlg,3=issuer,4=validity,5=subject）
function tbsField(certDer, ordinal) {
  const outer = readTlv(certDer, 0);
  const tbs = readTlv(certDer, outer.contentStart);
  let offset = tbs.contentStart;
  for (let i = 0; i <= ordinal; i += 1) {
    const element = readTlv(certDer, offset);
    if (i === ordinal) return certDer.subarray(offset, element.contentEnd);
    offset = element.contentEnd;
  }
  throw new Error('证书结构异常：找不到 tbsCertificate 字段 ' + ordinal);
}

function readPair(dir, keyName, pemName) {
  const keyPath = path.join(dir, keyName);
  const pemPath = path.join(dir, pemName);
  if (!fs.existsSync(keyPath) || !fs.existsSync(pemPath)) return null;
  try {
    const keyPem = fs.readFileSync(keyPath, 'utf8');
    const pem = fs.readFileSync(pemPath, 'utf8');
    const key = crypto.createPrivateKey(keyPem);
    const cert = new crypto.X509Certificate(pem);
    return { keyPem, pem, key, cert, der: cert.raw, keyPath, pemPath };
  } catch (error) {
    return { broken: true, reason: String(error.message || error), keyPath, pemPath };
  }
}

/** 现有 CA 是否还能继续用（可解析、是 CA、公私钥配对、未临近过期）。 */
function loadUsableCa(dir) {
  const ca = readPair(dir, NAMES.caKey, NAMES.caPem);
  if (!ca || ca.broken) return null;
  try {
    if (!ca.cert.ca) return null;
    const keyPub = crypto.createPublicKey(ca.key).export({ type: 'spki', format: 'der' }).toString('base64');
    const certPub = ca.cert.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    if (keyPub !== certPub) return null;
    if (daysLeft(new Date(ca.cert.validTo)) < CA_RENEW_BEFORE_DAYS) return null;
    return ca;
  } catch { return null; }
}

/**
 * 检查证书状态，不写文件。
 * @returns {{dir:string,present:boolean,ok:boolean,issues:string[],sans:string[],
 *   caPath:string,srvPath:string,caNotAfter:string|null,srvNotAfter:string|null,
 *   caDaysLeft:number|null,srvDaysLeft:number|null,fingerprint:string|null}}
 */
function inspectDeviceCerts(dir, options = {}) {
  const target = dir || __dirname;
  const required = normalizeSans(options.sans || readSanConfig(target));
  const renewBefore = Number(options.renewBeforeDays || RENEW_BEFORE_DAYS);
  const issues = [];
  const ca = readPair(target, NAMES.caKey, NAMES.caPem);
  const srv = readPair(target, NAMES.srvKey, NAMES.srvPem);

  if (!ca) issues.push('缺少 CA（' + NAMES.caKey + ' / ' + NAMES.caPem + '）');
  else if (ca.broken) issues.push('CA 文件无法解析：' + ca.reason);
  if (!srv) issues.push('缺少服务证书（' + NAMES.srvKey + ' / ' + NAMES.srvPem + '）');
  else if (srv.broken) issues.push('服务证书文件无法解析：' + srv.reason);

  if (ca && !ca.broken) {
    if (!ca.cert.ca) issues.push('CA 缺少 CA:TRUE 扩展');
    if (daysLeft(new Date(ca.cert.validTo)) <= 0) issues.push('CA 已过期');
    else if (CA_RENEW_BEFORE_DAYS && daysLeft(new Date(ca.cert.validTo)) < CA_RENEW_BEFORE_DAYS) {
      issues.push('CA 剩余 ' + Math.round(daysLeft(new Date(ca.cert.validTo))) + ' 天，需要重签整链');
    }
  }
  if (srv && !srv.broken) {
    if (ca && !ca.broken) {
      if (!srv.cert.verify(ca.cert.publicKey)) issues.push('服务证书与 CA 不匹配（链断裂）');
    }
    const srvPub = crypto.createPublicKey(srv.key).export({ type: 'spki', format: 'der' }).toString('base64');
    const certPub = srv.cert.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    if (srvPub !== certPub) issues.push('服务证书与私钥不配对');
    if (daysLeft(new Date(srv.cert.validTo)) <= 0) issues.push('服务证书已过期');
    else if (daysLeft(new Date(srv.cert.validTo)) < renewBefore) {
      issues.push('服务证书剩余 ' + Math.round(daysLeft(new Date(srv.cert.validTo))) + ' 天，临近过期');
    }
    for (const name of required) {
      if (!srv.cert.checkHost(name)) issues.push('服务证书未覆盖主机名 ' + name);
    }
  }

  const present = !!(ca && srv && !ca.broken && !srv.broken);
  return {
    dir: target,
    present,
    ok: present && issues.length === 0,
    issues,
    sans: required,
    caPath: path.join(target, NAMES.caPem),
    srvPath: path.join(target, NAMES.srvPem),
    caNotAfter: ca && !ca.broken ? new Date(ca.cert.validTo).toISOString() : null,
    srvNotAfter: srv && !srv.broken ? new Date(srv.cert.validTo).toISOString() : null,
    caDaysLeft: ca && !ca.broken ? Math.round(daysLeft(new Date(ca.cert.validTo)) * 10) / 10 : null,
    srvDaysLeft: srv && !srv.broken ? Math.round(daysLeft(new Date(srv.cert.validTo)) * 10) / 10 : null,
    fingerprint: srv && !srv.broken ? (srv.cert.fingerprint256 || srv.cert.fingerprint) : null,
    caFingerprint: ca && !ca.broken ? (ca.cert.fingerprint256 || ca.cert.fingerprint) : null,
  };
}

/**
 * 确保证书可用：有效就不动，缺失/不合格/临近过期则重签。
 * @returns {{ok:boolean,generated:boolean,issues:string[],status:object,error?:string}}
 */
function ensureDeviceCerts(dir, options = {}) {
  const target = dir || (options.dir || __dirname);
  const before = inspectDeviceCerts(target, options);
  const force = options.force === true;
  if (before.ok && !force) {
    return { ok: true, generated: false, issues: [], status: before, note: '证书有效，未改动' };
  }
  try {
    const created = generateDeviceCerts(target, options);
    const after = inspectDeviceCerts(target, options);
    return {
      ok: after.ok, generated: true, issues: before.issues, status: after, created,
      note: force ? '已按 --force 重新生成' : '已自动生成（原因：' + before.issues.join('；') + '）',
    };
  } catch (error) {
    return { ok: false, generated: false, issues: before.issues, status: before, error: String(error.message || error) };
  }
}

/* ------------------------------------------------------------------ *
 * 可选的系统信任安装（默认不做，需要显式 --install-trust）
 * ------------------------------------------------------------------ */

function trustStore(action, dir) {
  const caPath = path.join(dir || __dirname, NAMES.caPem);
  if (!fs.existsSync(caPath)) return { ok: false, error: '缺少 ' + caPath };
  const { execFileSync } = require('child_process');
  const args = action === 'add'
    ? ['-user', '-f', '-addstore', 'Root', caPath]
    : ['-user', '-delstore', 'Root', CA_CN];
  try {
    const out = execFileSync('certutil.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, encoding: 'utf8' });
    return { ok: true, action, output: String(out).trim().split(/\r?\n/).slice(0, 6).join('\n') };
  } catch (error) {
    return { ok: false, action, error: String((error.stderr || error.message || error)).slice(0, 400) };
  }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { dir: __dirname, force: false, status: false, json: false, days: null, sans: null, trust: null, engine: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force' || arg === '-f') out.force = true;
    else if (arg === '--status') out.status = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--quiet' || arg === '-q') out.quiet = true;
    else if (arg === '--dir') out.dir = argv[++i] || out.dir;
    else if (arg === '--days') out.days = Number(argv[++i]);
    else if (arg === '--engine') out.engine = String(argv[++i] || '').toLowerCase();
    else if (arg === '--sans') out.sans = String(argv[++i] || '').split(',').filter(Boolean);
    else if (arg === '--install-trust') out.trust = 'add';
    else if (arg === '--remove-trust') out.trust = 'remove';
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log([
    '设备证书生成器（dsh-plugin-wbrelay）',
    '',
    '  node certgen.cjs                 确保证书存在且有效（缺失/过期/不匹配时自动生成）',
    '  node certgen.cjs --status        只检查，不写文件',
    '  node certgen.cjs --json          以 JSON 输出（供脚本/看板调用）',
    '  node certgen.cjs --force         强制重新生成（换设备、换目录时用）',
    '  node certgen.cjs --engine openssl 用 openssl 执行 CERT.md 里的三条命令（默认用内置生成器）',
    '  node certgen.cjs --days 3650     服务证书有效天数（CA 同样默认 3650 天）',
    '  node certgen.cjs --sans a,b      指定 SAN 域名（默认读 san.cnf）',
    '  node certgen.cjs --dir <path>    指定输出目录（默认本脚本目录）',
    '  node certgen.cjs --install-trust 可选：把 CA 装进当前用户受信任根证书',
    '  node certgen.cjs --remove-trust  可选：从当前用户受信任根移除本 CA',
    '',
    '输出：ca.key / ca.pem（本机 CA）、srv.key / srv.pem（目标域名证书，含 SAN）',
    '说明：证书只在本机有意义，不进版本控制；换设备或换目录请重新生成。',
  ].join('\n'));
}

function humanStatus(status) {
  const lines = [];
  lines.push('[证书] ' + status.dir);
  lines.push('  状态      : ' + (status.ok ? '有效' : status.present ? '异常' : '未生成'));
  lines.push('  主机名    : ' + status.sans.join(', '));
  if (status.fingerprint) lines.push('  指纹      : ' + status.fingerprint);
  if (status.srvNotAfter) {
    lines.push('  服务证书  : 到期 ' + status.srvNotAfter + '（剩余 ' + status.srvDaysLeft + ' 天）');
    lines.push('  CA        : 到期 ' + status.caNotAfter + '（剩余 ' + status.caDaysLeft + ' 天）');
  }
  if (status.issues.length) lines.push('  待处理    : ' + status.issues.join('；'));
  return lines.join('\n');
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return 0; }
  const options = {
    dir: args.dir,
    force: args.force,
    sans: args.sans || undefined,
    engine: args.engine || undefined,
    srvDays: Number.isFinite(args.days) && args.days > 0 ? args.days : undefined,
  };

  if (args.trust) {
    const result = trustStore(args.trust, args.dir);
    console.log(JSON.stringify({ ok: result.ok, action: args.trust, detail: result }, null, 2));
    return result.ok ? 0 : 1;
  }

  let result;
  if (args.status) {
    const status = inspectDeviceCerts(args.dir, options);
    result = { ok: status.ok, generated: false, status, issues: status.issues };
  } else {
    result = ensureDeviceCerts(args.dir, options);
  }

  if (args.json) {
    console.log(JSON.stringify({
      ok: result.ok, generated: !!result.generated, note: result.note || null,
      engine: (result.created && result.created.engine) || 'node',
      error: result.error || null, issues: result.issues || [], certs: result.status,
    }, null, 2));
    return result.ok ? 0 : 1;
  }

  if (!args.quiet) {
    console.log(humanStatus(result.status));
    if (result.generated) console.log('  → 已' + (result.note || '生成证书'));
    if (result.error) console.log('  → 生成失败：' + result.error);
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  ensureDeviceCerts,
  inspectDeviceCerts,
  generateDeviceCerts,
  opensslGenerate,
  resolveOpenssl,
  assertUsable,
  readSanConfig,
  trustStore,
  NAMES,
  DEFAULT_SANS,
  RENEW_BEFORE_DAYS,
  CA_RENEW_BEFORE_DAYS,
  CA_DAYS,
  SRV_DAYS,
};
