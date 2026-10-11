#!/usr/bin/env node
/*
 * dsh-wb-bridge.js —— 把 WorkBuddy 桌面版自带的本地网关（CodeBuddy Gateway）
 * 包成 dsh 能直接用的 OpenAI / Responses 接口。
 *
 * 为什么要这么绕？
 *   relay 那条路（自己拉 CLI）走不通：CLI 的登录态只在桌面版进程树里。
 *   但桌面版自己跑了一个本地 HTTP 网关（Express，Bearer 鉴权）：
 *     POST /api/v1/runs              启动一次 agent run
 *     GET  /api/v1/runs/:id/stream   SSE 取结果
 *     GET  /api/v1/status            忙闲状态
 *   它的凭据（SERVER__PORT / CODEBUDDY_GATEWAY_PASSWORD）只存在于桌面版注入的
 *   环境变量里，不落盘。所以这个桥要“由桌面版拉起”：
 *     - 作为 MCP 服务被桌面版 spawn（--mcp）时，能直接读到那两个环境变量；
 *     - 它把凭据写到临时文件，并确保有一个常驻的 HTTP 桥在监听；
 *     - 常驻桥每次请求都重读凭据，于是桌面版重启后凭据会自动刷新。
 *
 * 两种运行方式：
 *   node dsh-wb-bridge.js --mcp                    被桌面版当 MCP 服务拉起（推荐）
 *   node dsh-wb-bridge.js --password <pw> [--gw-port 56198] [--port 8790]
 *                                                  手动跑（用自己的密码）
 *
 * 对 dsh 暴露：
 *   GET  /v1/models
 *   POST /v1/chat/completions   （stream: true/false）
 *   POST /v1/responses          （stream: true/false，事件序列按官方）
 *   GET  /health
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ARGS = process.argv.slice(2);
const argOf = (name, def) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : def;
};
const MCP_MODE = ARGS.includes('--mcp');
const LISTEN_PORT = Number(argOf('--port', 8790));
const CRED_FILE = path.join(os.tmpdir(), 'dsh-wb-bridge-cred.json');
const EVENT_LOG = path.join(os.tmpdir(), 'dsh-wb-bridge-events.log');

/* ---------------- 凭据 ---------------- */

let cred = {
  gwPort: Number(argOf('--gw-port', process.env.SERVER__PORT || 0)) || 0,
  password: argOf('--password', process.env.CODEBBUDDY_GATEWAY_PASSWORD || ''),
  updatedAt: Date.now(),
  source: ARGS.includes('--password') || process.env.CODEBBUDDY_GATEWAY_PASSWORD ? 'startup' : '',
};

// 手动指定 --gw-port 时锁定凭据：不跟随 cred 文件刷新。
// 用于直连「独立 CLI 的 Remote Control 服务」（如用户自己登录的 codebuddy-code，端口 60622），
// 那种服务只需 x-codebuddy-request 头、不需要 Bearer。
const LOCKED = ARGS.includes('--gw-port');

// 引擎：acp = 走 ACP 通道（真流式：逐字增量 + 工具事件 + 多轮会话保持）；runs = 旧的一次性网关路径。
const ENGINE = argOf('--engine', 'acp');

const REASONING_MODEL = 'deepseek-v4.1-flash';
const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const THOUGHT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const REASONING_FILE = process.env.DSH_BRIDGE_SETTINGS_FILE || path.join(__dirname, 'reasoning-settings.json');
const DEFAULT_EFFORT = REASONING_LEVELS.includes(process.env.DSH_BRIDGE_EFFORT) ? process.env.DSH_BRIDGE_EFFORT : 'high';
const reasoningOverrides = Object.create(null);
const reasoningCapabilities = new Map();
let reasoningDiscoveryFlight = null;
try {
  const settings = JSON.parse(fs.readFileSync(REASONING_FILE, 'utf8'));
  for (const [model, effort] of Object.entries(settings.models || {})) {
    if (effort === 'auto' || REASONING_LEVELS.includes(effort)) reasoningOverrides[model] = effort;
  }
} catch (error) {
  if (error.code !== 'ENOENT') log('[reasoning] 本机强度设置无法读取，使用会话设置');
}

function staticReasoningCapability(model) {
  // 这是路由配置中的声明能力；CLI ACP 探测成功后会覆盖它。
  if (model === REASONING_MODEL) {
    return { supported: true, efforts: ['high'], canDisable: null, source: 'route-config' };
  }
  return { supported: null, efforts: [], canDisable: null, source: 'unknown' };
}

function reasoningCapability(model) {
  const dynamic = reasoningCapabilities.get(String(model));
  const declared = staticReasoningCapability(String(model));
  const cap = dynamic || declared;
  const efforts = [...new Set((cap.efforts || []).filter((value) => THOUGHT_LEVELS.includes(value)))];
  const supported = cap.supported === false ? false : efforts.length ? true : cap.supported ?? null;
  const defaultEffort = efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT
    : efforts.includes('high') ? 'high' : efforts.at(-1) || null;
  return {
    supported, efforts, canDisable: cap.canDisable ?? null, defaultEffort,
    source: cap.source || 'unknown', available: cap.available ?? null,
  };
}

function reasoningModelInfo(model) {
  const id = String(model || 'auto');
  const cap = reasoningCapability(id);
  const effort = reasoningOverrides[id] || 'auto';
  return {
    model: id,
    supported: cap.supported,
    efforts: cap.efforts,
    canDisable: cap.canDisable,
    effort,
    defaultEffort: cap.defaultEffort || (cap.supported === false ? 'off' : DEFAULT_EFFORT),
    source: cap.source,
    available: cap.available,
  };
}

function reasoningSettings(model = REASONING_MODEL) {
  const selected = reasoningModelInfo(model);
  return {
    ...selected,
    supported: ENGINE === 'direct' || ENGINE === 'acp',
    levels: selected.efforts,
    models: routeModelEntries().map(({ id }) => reasoningModelInfo(id)),
  };
}

function saveReasoningSetting(model, effort) {
  const id = String(model || '');
  const cap = reasoningCapability(id);
  const allowed = effort === 'auto' || effort === 'off' || THOUGHT_LEVELS.includes(effort);
  if (!routeModelEntries().some((entry) => entry.id === id) || !allowed ||
      (effort !== 'auto' && cap.source !== 'cli-acp') ||
      (effort !== 'auto' && effort !== 'off' && cap.supported !== true) ||
      (effort === 'off' && cap.canDisable === false)) {
    throw Object.assign(new Error('模型或思考强度无效'), { statusCode: 400 });
  }
  if (effort !== 'auto' && effort !== 'off' && cap.efforts.length && !cap.efforts.includes(effort)) {
    throw Object.assign(new Error(`模型 ${id} 不支持 ${effort} 思考强度`), { statusCode: 400 });
  }
  const next = { ...reasoningOverrides };
  if (effort === 'auto') delete next[id];
  else next[id] = effort;
  const settings = { version: 2, models: next };
  const temporary = REASONING_FILE + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, REASONING_FILE);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw new Error('思考强度保存失败');
  }
  if (effort === 'auto') delete reasoningOverrides[id];
  else reasoningOverrides[id] = effort;
  return reasoningSettings(id);
}

function resolveReasoningEffort(body, model) {
  const id = String(model || 'auto');
  const cap = reasoningCapability(id);
  const saved = reasoningOverrides[id];
  // Native dsh selections take precedence; dashboard settings only supply a default.
  const requested = body.thinking?.type === 'disabled' ? 'off' : body.reasoning_effort ?? body.reasoning?.effort;
  const effort = requested ?? (saved && saved !== 'auto' ? saved : undefined);
  if (['none', 'off', 'disabled'].includes(effort)) {
    if (cap.canDisable === false) {
      throw Object.assign(new Error(`模型 ${id} 不支持关闭思考`), { statusCode: 400 });
    }
    return 'off';
  }
  if (effort == null || effort === 'enabled') {
    if (cap.supported === false) return 'enabled';
    return cap.defaultEffort || (id === REASONING_MODEL ? DEFAULT_EFFORT : 'enabled');
  }
  if (!REASONING_LEVELS.includes(effort)) {
    throw Object.assign(new Error('思考强度无效：请选择 minimal、low、medium、high、xhigh、max 或关闭'), { statusCode: 400 });
  }
  if (effort !== 'off' && cap.supported === false) {
    throw Object.assign(new Error(`模型 ${id} 不支持思考强度`), { statusCode: 400 });
  }
  if (effort !== 'off' && cap.source === 'cli-acp' && cap.efforts.length && !cap.efforts.includes(effort)) {
    throw Object.assign(new Error(`模型 ${id} 不支持 ${effort} 思考强度`), { statusCode: 400 });
  }
  return effort;
}

function saveCred() {
  try { fs.writeFileSync(CRED_FILE, JSON.stringify(cred), 'utf8'); } catch {}
}
function reloadCred() {
  if (LOCKED) return; // 手动指定端口：不跟随 cred 文件刷新
  try {
    const j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    if (j && j.password) {
      const changed = j.password !== cred.password || j.gwPort !== cred.gwPort;
      cred = { ...cred, ...j };
      if (changed) log(`[cred] 已刷新（gwPort=${cred.gwPort}，来源=${cred.source || 'file'}）`);
    }
  } catch {}
}
function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

/* ---------------- 网关调用 ---------------- */

function gwRequest(method, p, body, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: cred.gwPort, path: p, method,
      headers: Object.assign(
        { 'x-codebuddy-request': '1' },
        cred.password ? { authorization: 'Bearer ' + cred.password } : {},
        payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('gateway timeout')));
    req.end(payload);
  });
}

// 起一个 run，返回 runId
async function startRun(text, conversationId) {
  const body = {
    version: '1.0',
    id: 'dsh-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    type: 'text',
    source: {
      platform: 'generic',
      sender: { id: 'dsh' },
      conversation: { id: conversationId || 'dsh-default', type: 'direct' },
    },
    payload: { text },
  };
  const r = await gwRequest('POST', '/api/v1/runs', body);
  if (r.status !== 200 && r.status !== 202) {
    throw new Error(`网关拒绝（HTTP ${r.status}）：${r.body.slice(0, 200)}`);
  }
  let runId = null;
  try { runId = JSON.parse(r.body).data.runId; } catch {}
  if (!runId) throw new Error('网关没有返回 runId：' + r.body.slice(0, 200));
  return runId;
}

// 读 run 的 SSE 流；把每个事件原样回传（onEvent），并兜底提取正文（onText）
function streamRun(runId, { onEvent, onText, onDone, timeoutMs = 900000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: cred.gwPort, path: `/api/v1/runs/${runId}/stream`, method: 'GET',
      headers: Object.assign(
        { 'x-codebuddy-request': '1', accept: 'text/event-stream' },
        cred.password ? { authorization: 'Bearer ' + cred.password } : {},
      ),
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => reject(new Error(`stream HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`)));
        return;
      }
      let buf = '';
      let textSent = 0;
      let lastText = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          try { fs.appendFileSync(EVENT_LOG, line.slice(0, 2000) + '\n'); } catch {}
          if (!line.startsWith('data:')) { if (onEvent) onEvent({ raw: line }); continue; }
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') continue;
          let obj = null;
          try { obj = JSON.parse(raw); } catch {}
          if (onEvent) onEvent(obj || { raw });
          // 从网关事件里抽正文。实测形状（2026-10-09）：
          //   event: message
          //   data: {"version":"1.0","replyTo":"...","status":"completed",
          //          "content":{"markdown":"..."},"agent":{"sessionId":"...","toolCalls":[]}}
          //   event: done
          //   data: {}
          // 也就是「整段返回、不带增量」，所以这里按整段处理。
          if (obj) {
            const cand = [];
            const push = (v) => {
              if (typeof v === 'string') { if (v) cand.push(v); return; }
              if (v && typeof v === 'object') {
                for (const k of ['markdown', 'text', 'content', 'value', 'delta']) {
                  if (typeof v[k] === 'string' && v[k]) cand.push(v[k]);
                }
              }
            };
            const d = obj.data || obj.payload || obj;
            push(d.delta); push(d.text); push(d.content); push(d.result); push(d.output_text);
            if (d.message) push(d.message.content);
            if (typeof obj.content !== 'undefined') push(obj.content);
            for (const t of cand) {
              // 整段式返回：只发一次，且不重复发同一段
              if (t && t !== lastText) {
                if (t.length > textSent) { const add = t.slice(textSent); textSent = t.length; if (onText) onText(add); }
                lastText = t;
              }
            }
          }
        }
      });
      res.on('end', () => { if (onDone) onDone(); resolve(); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('run stream timeout')); });
    req.end();
  });
}

/* ---------------- ACP 引擎（真流式） ---------------- */

// ACP 会话的工作目录（与 CLI 会话一致；usage 从该 cwd 对应的项目 jsonl 读取）
const ACP_CWD = process.env.DSH_BRIDGE_CWD || os.homedir();

// conv → ACP sessionId 映射：让 dsh 的多轮对话复用同一个 CLI 会话（上下文连续）。
const acpSessions = new Map();

// CLI 可用模型列表（由 session/new | session/load 的 result.models 提供），用于校验 dsh 请求的模型名。
let acpModelIds = null;
let acpModels = [];
function cacheModelList(models) {
  if (!models || !Array.isArray(models.availableModels)) return;
  acpModels = models.availableModels.flatMap((m) => {
    const id = m.modelId || m.id;
    if (typeof id !== 'string' || !id) return [];
    const supported = typeof m._meta?.supportsReasoning === 'boolean' ? m._meta.supportsReasoning : null;
    const previous = reasoningCapabilities.get(id);
    reasoningCapabilities.set(id, { ...previous, supported, available: true,
      source: previous?.source === 'cli-acp' ? 'cli-acp' : 'cli-model' });
    return [{ id, name: m.name || id }];
  });
  const ids = acpModels.map((m) => m.id);
  if (ids.length) acpModelIds = new Set(ids);
}

function cacheThoughtOptions(model, result) {
  if (!acpModelIds?.has(model)) return;
  const option = result?.configOptions?.find((item) => item.id === 'thought_level');
  if (!option || !Array.isArray(option.options)) return;
  const values = option.options.map((item) => item.value);
  const previous = reasoningCapabilities.get(model) || {};
  reasoningCapabilities.set(model, {
    ...previous,
    efforts: previous.supported === false ? [] : values.filter((value) => THOUGHT_LEVELS.includes(value)),
    canDisable: values.includes('disabled'),
    source: 'cli-acp',
  });
}

function routeModelEntries() {
  return acpModels.length ? [{ id: 'auto', name: 'CodeBuddy Auto' }, ...acpModels]
    : MODELS.map(([id, name]) => ({ id, name }));
}

function routeModelData() {
  return routeModelEntries().map(({ id, name }) => {
    const reasoning = reasoningModelInfo(id);
    return { id, name, object: 'model', created: 0, owned_by: 'codebuddy-bridge',
      supports_reasoning: reasoning.supported,
      reasoningEfforts: Object.fromEntries(reasoning.efforts.map((value) => [value, value])),
      reasoning: { ...reasoning,
        configurable: ['direct', 'acp'].includes(ENGINE) && reasoning.source === 'cli-acp' &&
          reasoning.supported === true && reasoning.efforts.length > 0 } };
  });
}

let capabilityCheckedAt = 0;
let capabilityError = '';
let capabilitySession = null;
async function discoverReasoningCapabilities() {
  reloadCred();
  if (!cred.gwPort) throw new Error('CLI 服务未配置');
  if (!capabilitySession) {
    const connection = await gwRequest('POST', '/api/v1/acp/connect', {}, { timeoutMs: 5000 });
    if (connection.status !== 200) throw new Error('CLI 能力连接失败');
    const connId = JSON.parse(connection.body).connectionId;
    if (!connId) throw new Error('CLI 未返回能力连接');
    const init = await acpCall(connId, { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'wbrelay-capabilities', version: '1.0' } } }, 5000);
    if (!init.result || init.error) throw new Error('CLI 能力初始化失败');
    capabilitySession = { connId };
  }
  const { connId } = capabilitySession;
  const session = await acpCall(connId, { jsonrpc: '2.0', id: 2, method: 'session/new',
    params: { cwd: process.env.DSH_BRIDGE_CAPABILITY_CWD || os.tmpdir(), mcpServers: [] } }, 10000);
  if (!session.sessionId || session.error) throw new Error('CLI 能力会话创建失败');
  cacheModelList(session.result.models);
  cacheThoughtOptions(session.result.models?.currentModelId, session.result);
  const sessionId = session.sessionId;
  for (const { id } of acpModels) {
    const changed = await acpCall(connId, { jsonrpc: '2.0', id: 21, method: 'session/set_config_option',
      params: { sessionId, configId: 'model', value: id } }, 5000);
    if (changed.error || !changed.result) throw new Error('CLI 模型能力查询失败');
    cacheThoughtOptions(id, changed.result);
  }
  capabilityError = '';
}

async function ensureReasoningCapabilities(force = false) {
  if (!['direct', 'acp'].includes(ENGINE)) return;
  if (reasoningDiscoveryFlight) return reasoningDiscoveryFlight;
  if (!force && Date.now() - capabilityCheckedAt < (capabilityError ? 30000 : 300000)) return;
  reasoningDiscoveryFlight = queueAcp(async () => {
    try {
      await discoverReasoningCapabilities();
    } catch (error) {
      capabilitySession = null;
      capabilityError = 'CLI 能力暂不可达，保留已知能力';
      log('[reasoning] ' + capabilityError);
    } finally {
      capabilityCheckedAt = Date.now();
    }
  }).finally(() => { reasoningDiscoveryFlight = null; });
  return reasoningDiscoveryFlight;
}

// ---- usage：CLI 把每轮的精确 token 用量写进 ~/.codebuddy/projects/<cwd-slug>/<sessionId>.jsonl，
//      桥在每轮结束后读最后一条 "usage":{...} 并映射为 Responses 协议结构。 ----
function sessionJsonlPath(sessionId, cwd) {
  const slug = String(cwd).replace(/^([A-Za-z]):/, (m, c) => c.toLowerCase()).replace(/[\\/]+/g, '-');
  return path.join(os.homedir(), '.codebuddy', 'projects', slug, sessionId + '.jsonl');
}

function toResponsesUsage(u) {
  if (!u) return null;
  const cached = u.cache_read_input_tokens ?? u.cached_tokens ?? 0;
  const input = u.input_tokens ?? u.inputTokens ?? 0;
  const output = u.output_tokens ?? u.outputTokens ?? 0;
  const total = u.total_tokens ?? u.totalTokens ?? (input + output);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: u.cache_write_tokens || 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: u.reasoning_tokens || 0 },
    total_tokens: total,
  };
}

async function readUsageFromJsonl(sessionId, cwd, { retries = 8, intervalMs = 250 } = {}) {
  if (!sessionId) return null;
  const f = sessionJsonlPath(sessionId, cwd);
  for (let i = 0; i < retries; i++) {
    try {
      const s = fs.readFileSync(f, 'utf8');
      const idx = s.lastIndexOf('"usage":{');
      if (idx >= 0) {
        const seg = s.slice(idx + 8);
        let depth = 0, end = -1;
        for (let k = 0; k < seg.length; k++) {
          if (seg[k] === '{') depth++;
          else if (seg[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
        }
        if (end > 0) {
          try {
            const u = JSON.parse(seg.slice(0, end + 1));
            if (typeof u.input_tokens === 'number' || typeof u.inputTokens === 'number') {
              return toResponsesUsage(u);
            }
          } catch {}
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// 一次 ACP JSON-RPC 调用（读完整 SSE，取 id 匹配的 result）。用于 initialize / session-new / load / set_config_option。
function acpCall(connId, msg, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(msg);
    const req = http.request({
      host: '127.0.0.1', port: cred.gwPort, path: '/api/v1/acp', method: 'POST', timeout: timeoutMs,
      headers: Object.assign(
        { 'x-codebuddy-request': '1', accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'acp-connection-id': connId },
        cred.password ? { authorization: 'Bearer ' + cred.password } : {},
      ),
    }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('acp call interrupted')));
      res.on('data', (c) => { buf += c.toString('utf8'); });
      res.on('end', () => {
        const out = { result: null, error: null, sessionId: null };
        if (res.statusCode !== 200) return reject(new Error(`acp call HTTP ${res.statusCode}`));
        if (!buf.trim().startsWith('data:') && buf.trim().startsWith('{')) buf = 'data: ' + buf;
        for (const block of buf.split(/\r?\n\r?\n/)) {
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let j = null;
            try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (j && msg.id !== undefined && j.id === msg.id) {
              if (j.result !== undefined) out.result = j.result;
              if (j.error !== undefined) out.error = j.error;
              if (j.result && j.result.sessionId) out.sessionId = j.result.sessionId;
            }
          }
        }
        if (out.result == null && out.error == null) return reject(new Error('acp call missing result'));
        resolve(out);
      });
    });
    req.on('timeout', () => req.destroy(new Error('acp call timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

// 发送 prompt 并持续读取通知流：agent_message_chunk → onDelta（正文增量），agent_thought_chunk → onThought，tool_call* → onTool。
// idleTimeoutMs：超过该时长没有任何事件 → 判定卡死并失败（dsh 会收到 response.failed）。
function acpPromptStream(connId, sessionId, text, { onDelta, onThought, onTool, idleTimeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const msg = { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } };
    const payload = JSON.stringify(msg);
    let settled = false;
    let idleTimer = null;
    let req = null;
    const settle = (fn, arg) => { if (settled) return; settled = true; if (idleTimer) clearTimeout(idleTimer); fn(arg); };
    const armIdle = () => {
      if (settled) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        settle(reject, new Error(`acp prompt 空闲超时（${Math.round(idleTimeoutMs / 1000)}s 无任何事件，agent 可能已卡住）`));
        try { if (req) req.destroy(); } catch {}
      }, idleTimeoutMs);
    };
    req = http.request({
      host: '127.0.0.1', port: cred.gwPort, path: '/api/v1/acp', method: 'POST',
      headers: Object.assign(
        { 'x-codebuddy-request': '1', accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'acp-connection-id': connId },
        cred.password ? { authorization: 'Bearer ' + cred.password } : {},
      ),
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => settle(reject, new Error(`acp prompt HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`)));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      armIdle();
      res.on('data', (c) => {
        armIdle();
        buf += c.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          let j = null;
          try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (!j) continue;
          if (j.method === 'session/update' && j.params && j.params.update) {
            const u = j.params.update;
            if (u.sessionUpdate === 'agent_message_chunk') {
              const t = u.content && u.content.text;
              if (t && onDelta) onDelta(t);
            } else if (u.sessionUpdate === 'agent_thought_chunk') {
              const t = u.content && u.content.text;
              if (t && onThought) onThought(t);
            } else if (typeof u.sessionUpdate === 'string' && u.sessionUpdate.startsWith('tool_call') && onTool) {
              onTool(u);
            }
          } else if (j.id === 3 && !settled) {
            if (j.error) settle(reject, new Error('acp prompt error: ' + JSON.stringify(j.error).slice(0, 200)));
            else settle(resolve, j.result || {});
          }
        }
      });
      res.on('end', () => settle(resolve, {}));
      res.on('error', (e) => settle(reject, e));
      res.on('aborted', () => settle(reject, new Error('acp prompt interrupted')));
    });
    req.on('error', (e) => settle(reject, e));
    req.end(payload);
  });
}

// 完整一轮 ACP：connect → initialize → (session/load | session/new) → bypassPermissions → 模型 → prompt（流式）
// systemPrompt：dsh 的系统提示词，仅在新建会话时注入（CLI 无原生 meta-prompt 入口，用消息注入等效实现）。
async function acpTurn(text, conv, handlers = {}, model, systemPrompt, effort) {
  const connRes = await gwRequest('POST', '/api/v1/acp/connect', {});
  if (connRes.status !== 200) throw new Error(`acp connect HTTP ${connRes.status}: ${connRes.body.slice(0, 150)}`);
  let connId = null;
  try { connId = JSON.parse(connRes.body).connectionId; } catch {}
  if (!connId) throw new Error('acp connect 没有返回 connectionId');

  const init = await acpCall(connId, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-wb-bridge', version: '1.0' } } });
  if (init.error) throw new Error('acp initialize 失败: ' + JSON.stringify(init.error).slice(0, 150));

  const cwd = ACP_CWD;
  let sessionId = acpSessions.get(conv) || null;
  let isNewSession = false;
  if (sessionId) {
    const ld = await acpCall(connId, { jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId, cwd, mcpServers: [] } });
    if (ld.error) {
      log(`[acp] load ${sessionId} 失败（${JSON.stringify(ld.error).slice(0, 100)}），改为新建会话`);
      sessionId = null;
    } else if (ld.sessionId) {
      sessionId = ld.sessionId;
    }
    if (ld.result) {
      cacheModelList(ld.result.models);
      cacheThoughtOptions(ld.result.models?.currentModelId, ld.result);
    }
  }
  if (!sessionId) {
    const nw = await acpCall(connId, { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
    if (nw.error || !nw.sessionId) throw new Error('acp session/new 失败: ' + JSON.stringify(nw.error || {}).slice(0, 150));
    sessionId = nw.sessionId;
    acpSessions.set(conv, sessionId);
    isNewSession = true;
    if (nw.result) {
      cacheModelList(nw.result.models);
      cacheThoughtOptions(nw.result.models?.currentModelId, nw.result);
    }
  }

  // 权限模式：bypassPermissions（不弹审批；否则 agent 用工具时会永久等待客户端批准）
  await acpCall(connId, { jsonrpc: '2.0', id: 20, method: 'session/set_config_option', params: { sessionId, configId: 'mode', value: 'bypassPermissions' } });

  // 模型选择：把 dsh 指定的模型同步给 CLI 会话（'auto'/空 = 用 CLI 默认，不设置）。
  // CLI 不校验模型名，所以桥先用缓存的可用列表自查；失败时显式报错（避免"以为在用所选模型"的隐性错误）。
  if (model && !/^(auto|default)$/i.test(String(model))) {
    if (acpModelIds && !acpModelIds.has(String(model))) {
      const sample = [...acpModelIds].slice(0, 8).join(', ');
      log(`[acp] 模型 ${model} 不在可用列表（共 ${acpModelIds.size} 个）`);
      throw new Error(`模型 ${model} 不在 CLI 可用列表中（可用示例：${sample} …）`);
    }
    const mr = await acpCall(connId, { jsonrpc: '2.0', id: 21, method: 'session/set_config_option', params: { sessionId, configId: 'model', value: String(model) } });
    if (mr.error) {
      const detail = JSON.stringify(mr.error).slice(0, 150);
      log(`[acp] 设置模型 ${model} 失败：${detail}`);
      throw new Error(`无法切换到模型 ${model}：${detail}`);
    }
    cacheThoughtOptions(String(model), mr.result);
    log(`[acp] 模型已设为 ${model}`);
  }

  if (reasoningCapability(model).supported !== false) {
    const thoughtLevel = effort === 'off' ? 'disabled' : effort;
    const tr = await acpCall(connId, { jsonrpc: '2.0', id: 22, method: 'session/set_config_option',
      params: { sessionId, configId: 'thought_level', value: thoughtLevel } });
    if (tr.error) {
      throw new Error(`无法设置思考强度 ${thoughtLevel}：${JSON.stringify(tr.error).slice(0, 150)}`);
    }
    log(`[acp] thought_level 已设为 ${thoughtLevel}`);
  }

  // 新会话首轮：注入上游系统提示词（CLI 无原生入口，用消息注入）
  let promptText = text;
  if (isNewSession && systemPrompt) {
    promptText = wrapSystemPrompt(systemPrompt, text);
    log(`[acp] 已注入上游系统提示词（${systemPrompt.length} 字符）到新会话 ${sessionId}`);
  }

  const result = await acpPromptStream(connId, sessionId, promptText, handlers);
  return { sessionId, result };
}

// 全局轮次队列：CLI 是单 agent，同一时刻只能执行一轮。dsh 会并发发来
// 主对话请求 + 会话标题请求（aux-title）；两者同时进入 CLI 时，标题轮会
// 抢占/丢弃主轮（主轮零输出、流上无任何事件），dsh 端表现为"一直在思考"。
// 这里把所有 ACP 轮次串行化：前一轮完成（或失败）后才启动下一轮。
let turnChain = Promise.resolve();
function queueAcp(task) {
  const run = turnChain.then(task);
  turnChain = run.then(() => undefined, () => undefined);
  return run;
}
function queuedAcpTurn(text, conv, handlers, model, systemPrompt, effort) {
  return queueAcp(() => acpTurn(text, conv, handlers, model, systemPrompt, effort));
}

/* ---------------- HTTP 桥（给 dsh 用） ---------------- */

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});
const sendJson = (res, code, obj) => {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(s);
};

const MODELS = [
  ['auto', 'CodeBuddy Auto'],
  ['deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash'],
  ['deepseek-v4-pro', 'DeepSeek-V4-Pro'],
  ['glm-5.3', 'GLM-5.3'],
  ['kimi-k2.7', 'Kimi-K2.7-Code'],
];

// 剥掉 <system-reminder>...</system-reminder> 块（dsh 的 harness 会往消息里注入这类提醒）
function stripReminders(s) {
  return String(s).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
}

// 提取 dsh 发来的系统提示词（system/developer 消息），用于在新会话首轮注入给 CLI agent。
function systemText(body) {
  const parts = [];
  const push = (t) => { if (typeof t === 'string' && t.trim()) parts.push(t.trim()); };
  const takeMsg = (m) => {
    if (!m || (m.role !== 'system' && m.role !== 'developer')) return;
    if (typeof m.content === 'string') push(m.content);
    else if (Array.isArray(m.content)) push(m.content.map((p) => (typeof p === 'string' ? p : p.text || '')).join(''));
  };
  if (Array.isArray(body.input)) for (const it of body.input) takeMsg(it);
  if (Array.isArray(body.messages)) for (const m of body.messages) takeMsg(m);
  return parts.join('\n\n');
}

// 注入上游系统提示词原文（仅新会话首轮）：不做任何改写/包装，仅用分隔线与其后的用户消息区分。
function wrapSystemPrompt(sys, userText) {
  return sys + '\n\n---\n\n' + userText;
}

function lastUserText(body) {
  // 收集所有 user 文本（按出现顺序），再从后往前挑「剥掉 reminder 后仍有内容」的那条。
  // dsh（agent harness）会把自己注入的 <system-reminder>（技能列表等）作为最后一条 user 消息发出，
  // 直接取最后一条会拿到提醒而不是用户输入（2026-10-09 实锤）。
  const candidates = [];
  const push = (t) => { if (typeof t === 'string' && t.trim()) candidates.push(t); };

  if (typeof body.input === 'string') push(body.input);
  if (Array.isArray(body.input)) {
    for (const it of body.input) {
      if (typeof it === 'string') { push(it); continue; }
      if (it && it.role === 'user') {
        if (typeof it.content === 'string') push(it.content);
        else if (Array.isArray(it.content)) push(it.content.map((p) => (typeof p === 'string' ? p : p.text || '')).join(''));
      }
    }
  }
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (m.role === 'user') {
      const c = m.content;
      if (typeof c === 'string') push(c);
      else if (Array.isArray(c)) push(c.map((p) => (typeof p === 'string' ? p : p.text || '')).join(''));
    }
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    const stripped = stripReminders(candidates[i]);
    if (stripped) return stripped;
  }
  // 全都是纯 reminder（或只有 reminder）：退回最后一个候选，保留原样（总比空好）
  return candidates.length ? candidates[candidates.length - 1] : '';
}
// 会话标签：修改此值可强制 dsh 侧开启全新会话（清空 CLI 侧上下文）。
// v2 = 清理「技能列表 + 标题生成」污染后的干净版本（2026-10-09）。
const SESSION_TAG = 'v2';

const convOf = (req, body) =>
  (req.headers['x-wb-session'] || body.user || body.metadata?.user_id || 'dsh-default') + '-' + SESSION_TAG;

// dsh 的辅助任务（自动生成会话标题等）：隔离到一次性独立会话，避免污染主对话历史。
function auxSessionId(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; }
  return 'aux-title-' + (h >>> 0).toString(36);
}
const isAuxTask = (text) => /Generate the session title/i.test(text);

/* ---------------- direct 引擎：dsh → copilot.tencent.com 纯透传 ----------------
 * dsh 侧 wbrelay 配 api: openai-completions。系统提示词以 system 角色原生
 * 直达模型，无 CodeBuddy agent 包装。token 来自 MITM 捕获文件（CLI 的每次
 * 上游请求都会刷新该文件，token 轮换自动跟进）。上游强制 stream:true。 */

const DIRECT_PATH = '/v2/chat/completions';
const DIRECT_IPS = ['112.28.173.82', '112.28.174.102'];
const DIRECT_HOST = 'copilot.tencent.com';
const BRIDGE_VERSION = '1.0.0';
const SYSTEM_INSTRUCTION_MODELS = new Set([REASONING_MODEL, 'glm-5.3-flash']);
let directIpIdx = 0;

// ---- 面板统计
const directStats = {
  startedAt: Date.now(), total: 0, ok: 0, fail: 0,
  lastAt: null, lastModel: null, lastOutcome: null,
  lastSuccessAt: null, lastErrorAt: null, lastError: null, byModel: {},
};
function markDirectSuccess() {
  directStats.ok++;
  directStats.lastOutcome = 'ok';
  directStats.lastSuccessAt = new Date().toISOString();
  directStats.lastError = null;
  directStats.lastErrorAt = null;
}

function readCapturedTokenInfo() {
  try {
    const p = path.join(__dirname, 'mitm', 'captured-token.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    let exp = null, iat = null, sub = null;
    try {
      const payload = JSON.parse(Buffer.from(j.authorization.split('.')[1], 'base64url').toString('utf8'));
      exp = payload.exp || null; iat = payload.iat || null; sub = payload.sub || null;
    } catch {}
    return {
      present: true, authorization: j.authorization,
      capturedAt: j.time || null, capturedSource: j.url || null,
      fileMtime: fs.statSync(p).mtime.toISOString(),
      exp, iat, sub,
      daysLeft: exp ? Math.round((exp * 1000 - Date.now()) / 86400000 * 10) / 10 : null,
    };
  } catch { return { present: false }; }
}

const net = require('net');
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

function hostsHasEntry() {
  try {
    return fs.readFileSync('C:\\Windows\\System32\\drivers\\etc\\hosts', 'utf8').includes(DIRECT_HOST);
  } catch { return null; }
}

let upstreamProbeCache = { at: null, ok: null, status: null, ms: null };
function probeUpstream() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const token = directToken();
    if (!token) { resolve({ ok: false, reason: '无 token' }); return; }
    const payload = JSON.stringify({ model: 'glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const r = https.request({
      host: DIRECT_IPS[0], port: 443, path: DIRECT_PATH, method: 'POST', servername: DIRECT_HOST,
      headers: { 'content-type': 'application/json', authorization: token, 'content-length': Buffer.byteLength(payload), host: DIRECT_HOST },
      timeout: 6000,
    }, (res) => {
      res.resume();
      res.on('end', () => {
        upstreamProbeCache = { at: new Date().toISOString(), ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - t0 };
        resolve(upstreamProbeCache);
      });
    });
    r.on('timeout', () => { r.destroy(); upstreamProbeCache = { at: new Date().toISOString(), ok: false, status: 'timeout', ms: Date.now() - t0 }; resolve(upstreamProbeCache); });
    r.on('error', (e) => { upstreamProbeCache = { at: new Date().toISOString(), ok: false, status: String(e.message).slice(0, 60), ms: Date.now() - t0 }; resolve(upstreamProbeCache); });
    r.end(payload);
  });
}

function pluginStatus() {
  const profile = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
    const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    const junctionOk = fs.existsSync(path.join(profile, 'node_modules', 'dsh-plugin-wbrelay', 'cordis.patch.yml'));
    return { registered: bundles.includes('dsh-plugin-wbrelay'), junctionOk, bundles };
  } catch { return { registered: false, junctionOk: false, bundles: [] }; }
}

function pluginModels() {
  return routeModelEntries().map((model) => model.id);
}

// ---------- 新手引导 ----------
let cliInstallCache = { at: 0, ok: false };
function codebuddyInstalled() {
  // 缓存 5 分钟。检测方式用文件存在性（npm 全局 shim），不依赖子进程——
  // 某些受限环境会杀掉 cmd 子进程导致 where 误报。
  if (Date.now() - cliInstallCache.at < 300000) return cliInstallCache.ok;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = [
    path.join(appData, 'npm', 'codebuddy-code.cmd'),
    path.join(appData, 'npm', 'codebuddy-code'),
    'C:\\Program Files\\nodejs\\codebuddy-code.cmd',
  ];
  const ok = candidates.some((c) => { try { return fs.existsSync(c); } catch { return false; } });
  cliInstallCache = { at: Date.now(), ok };
  return ok;
}

function buildOnboarding(st) {
  const installed = st.cliInstalled;
  const steps = [];
  steps.push({
    id: 'cli-install', ok: installed,
    title: installed ? 'CodeBuddy CLI 已安装' : '安装 CodeBuddy CLI',
    action: installed ? '' : 'cmd 里执行：npm i -g @tencent-ai/codebuddy-code',
  });
  const loginKnown = (st.cliUp && st.cliAuthOk) || st.tokenPresent; // token 存在即证明登录过
  steps.push({
    id: 'cli-login', ok: loginKnown,
    title: loginKnown ? 'CLI 已登录' : (installed ? '登录 CodeBuddy CLI' : '安装 CLI 后再登录'),
    action: loginKnown ? '' : (installed ? '点「打开 CLI 登录窗口」，在窗口里输入 /login 完成登录' : '先完成上一步'),
  });
  steps.push({
    id: 'hosts', ok: st.hostsEntry === true,
    title: st.hostsEntry === true ? 'hosts 拦截已生效' : '设置 hosts 拦截（需管理员，一次性）',
    action: st.hostsEntry === true ? '' : '面板右下「以管理员修复（UAC 确认）」，或管理员 cmd 运行 mitm\\mitm-on.cmd',
  });
  steps.push({
    id: 'channel', ok: st.bridgeUp,
    title: st.bridgeUp ? '通道运行中' : '启动通道',
    action: st.bridgeUp ? '' : 'dsh 右下角点「启动 wbrelay 通道」，或运行 channel\\dsh-channel.cmd',
  });
  steps.push({
    id: 'token', ok: st.tokenPresent,
    title: st.tokenPresent ? 'token 已自动捕获（剩余 ' + (st.tokenDaysLeft ?? '?') + ' 天）' : '等待 token 自动捕获',
    action: st.tokenPresent ? '' : '通道跑起来后 CLI 首次请求会自动完成，稍等几秒刷新',
  });
  return steps;
}

// ---------- 引导动作（面板按钮调用，桥自己执行） ----------
const { execSync } = require('node:child_process');
function killPortListeners(port) {
  try {
    const out = execSync(`netstat -ano | findstr ":${port} " | findstr "LISTENING"`, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }).toString();
    const pids = [...new Set(out.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((p) => /^\d+$/.test(p)))];
    for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', timeout: 5000 }); } catch { /* ignore */ } }
    return pids.length;
  } catch { return 0; } // 无监听者
}
function spawnVisibleCmd(args, env) {
  const child = spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', ...args], { detached: true, stdio: 'ignore', windowsHide: false, env });
  child.unref();
}

async function buildStatus(probe) {
  const [cli443, cliServe, mitm443] = await Promise.all([tcpProbe(443), tcpProbe(60622), Promise.resolve(null)]);
  const cliStatus = cliServe ? await httpProbeJson(60622, '/api/v1/status') : null;
  const cliAuth = cliServe ? await httpProbeJson(60622, '/api/v1/auth/status') : null;
  if (probe) await probeUpstream();
  const tokenNow = readCapturedTokenInfo();
  const st = {
    cliInstalled: codebuddyInstalled(),
    cliUp: cliServe, cliAuthOk: !!(cliAuth && cliAuth.authenticated),
    hostsEntry: hostsHasEntry(),
    bridgeUp: true, // 本状态由桥自己提供，桥必然在运行
    tokenPresent: tokenNow.present,
    tokenDaysLeft: tokenNow.daysLeft,
  };
  return {
    ver: BRIDGE_VERSION,
    time: new Date().toISOString(),
    onboarding: buildOnboarding(st),
    bridge: {
      engine: ENGINE, port: LISTEN_PORT, directHost: DIRECT_HOST,
      uptimeMs: Date.now() - directStats.startedAt,
      stats: directStats,
    },
    reasoning: reasoningSettings(),
    token: (() => { const t = readCapturedTokenInfo(); delete t.authorization; return t; })(),
    cli: {
      serviceUp: cliServe, authOk: !!(cliAuth && cliAuth.authenticated),
      authEnabled: cliAuth ? cliAuth.authEnabled : null,
      busy: cliStatus ? cliStatus.data?.busy ?? null : null,
      runStatus: cliStatus ? cliStatus.data?.runStatus ?? null : null,
      activeSessionId: cliStatus ? cliStatus.data?.activeSessionId ?? null : null,
    },
    mitm443: { up: cli443 },
    hosts: { entry: hostsHasEntry(), domain: DIRECT_HOST },
    upstream: upstreamProbeCache,
    plugin: pluginStatus(),
    models: pluginModels(),
  };
}
const directToken = () => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'mitm', 'captured-token.json'), 'utf8')).authorization || null; }
  catch { return null; }
};

// Responses 请求 → chat.completions 请求（最小转换：文本/工具调用/工具结果）
function responsesToChatBody(body, system) {
  const messages = [];
  const sys = body.instructions || system || '';
  if (sys) messages.push({ role: 'system', content: sys });
  const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p.text || '')).join('') : '');
  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const it of input) {
      if (typeof it === 'string') { messages.push({ role: 'user', content: it }); continue; }
      if (it.type === 'function_call') {
        messages.push({ role: 'assistant', content: '', tool_calls: [{ id: it.call_id || it.id || 'call_0', type: 'function', function: { name: it.name, arguments: it.arguments || '{}' } }] });
      } else if (it.type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: it.call_id, content: typeof it.output === 'string' ? it.output : JSON.stringify(it.output) });
      } else if (it.role) {
        messages.push({ role: it.role === 'assistant' ? 'assistant' : 'user', content: textOf(it.content) });
      }
    }
  }
  const chat = { model: body.model, stream: true, messages };
  if (body.temperature != null) chat.temperature = body.temperature;
  if (body.top_p != null) chat.top_p = body.top_p;
  if (body.max_output_tokens != null) chat.max_tokens = body.max_output_tokens;
  if (body.reasoning?.effort !== undefined) chat.reasoning_effort = body.reasoning.effort;
  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = body.tools.filter((t) => t.type === 'function' && t.name).map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }));
    if (body.tool_choice) chat.tool_choice = body.tool_choice;
  }
  return chat;
}

// chat 请求白名单清洗：上游对未知字段会 400
function sanitizeChatBody(b) {
  const keep = ['model', 'messages', 'tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens', 'stop', 'presence_penalty', 'frequency_penalty', 'user', 'reasoning_effort'];
  const out = {};
  for (const k of keep) if (b[k] !== undefined) out[k] = b[k];
  out.stream = true; // 上游只接受流式
  return out;
}

function applyDirectModelCompat(chat, body) {
  // This route rejects developer instructions; preserve their content as system messages.
  if (SYSTEM_INSTRUCTION_MODELS.has(chat.model) && Array.isArray(chat.messages)) {
    chat.messages = chat.messages.map((message) => message?.role === 'developer' ? { ...message, role: 'system' } : message);
  }
  const effort = resolveReasoningEffort(body, chat.model);
  // Explicitly disable thinking; an omitted effort alone may retain the upstream default.
  if (effort === 'off') {
    delete chat.reasoning_effort;
    chat.thinking = { type: 'disabled' };
  } else if (effort !== 'enabled') {
    chat.reasoning_effort = effort;
  } else {
    delete chat.reasoning_effort;
  }
}

function reasoningDelta(delta) {
  for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    if (typeof delta?.[field] === 'string' && delta[field]) return delta[field];
  }
  return '';
}

function completedReasoningItem(id, text) {
  return { id, type: 'reasoning', status: 'completed', summary: [], content: [{ type: 'reasoning_text', text }] };
}

function upstreamHttpError(status, body, token) {
  let payload = {};
  try { payload = JSON.parse(body); } catch {}
  const detail = payload?.error || payload || {};
  const rawCode = detail.code;
  const code = typeof rawCode === 'number' && Number.isFinite(rawCode) ? rawCode
    : typeof rawCode === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(rawCode) ? rawCode : undefined;
  const rawId = payload?.requestId ?? detail.requestId;
  const requestId = typeof rawId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(rawId) ? rawId : undefined;
  const safeText = (value) => {
    if (typeof value !== 'string') return '';
    const withoutToken = token ? value.split(token).join('[redacted]') : value;
    return withoutToken.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
      .replace(/[\r\n\t]+/g, ' ').slice(0, 240);
  };
  const message = String(code) === '11128'
    ? '请求被拦截：上游渠道校验失败，请检查请求格式或使用已获授权的调用渠道'
    : safeText(detail.displayMsg?.zh || detail.message || detail.msg) || '上游拒绝请求';
  const upstream = { status, ...(code !== undefined ? { code } : {}), ...(requestId ? { requestId } : {}) };
  const errorType = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error'
    : status === 429 ? 'rate_limit_error' : status >= 400 && status < 500 ? 'invalid_request_error' : 'server_error';
  return Object.assign(new Error(`上游 HTTP ${status}${code !== undefined ? ` [${code}]` : ''}：${message}${requestId ? `（请求 ID：${requestId}）` : ''}`), {
    statusCode: status >= 400 && status < 500 ? status : 502, errorType, upstream,
    ...(code !== undefined ? { code: String(code) } : {}),
  });
}

async function upstreamChat(chatBody) {
  const token = directToken();
  if (!token) {
    const hint = hostsHasEntry() === true
      ? 'hosts 已启用，请通过「CLI 登录」重新打开带捕获证书的 CLI 窗口并发起一次请求'
      : '请先启用 hosts 捕获，并通过「CLI 登录」窗口发起一次请求';
    throw Object.assign(new Error('未捕获到上游 Token：' + hint), {
      statusCode: 503, code: 'missing_upstream_token',
    });
  }
  const payload = JSON.stringify(chatBody);
  const ip = DIRECT_IPS[directIpIdx++ % DIRECT_IPS.length];
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: ip, port: 443, path: DIRECT_PATH, method: 'POST',
      servername: DIRECT_HOST,
      headers: { 'content-type': 'application/json', authorization: token, 'content-length': Buffer.byteLength(payload), host: DIRECT_HOST, accept: 'text/event-stream' },
    }, (response) => {
      if (response.statusCode === 200) { req.setTimeout(0); resolve(response); return; }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body = (body + chunk).slice(0, 65536); });
      finishUpstream(response, () => reject(upstreamHttpError(response.statusCode, body, token)), reject);
    });
    req.once('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('upstream timeout')));
    req.end(payload);
  });
}

// aborted/error/close 可能连续触发；一次请求只结算一次，提前断流不能记为成功。
function finishUpstream(stream, onEnd, onError) {
  let settled = false;
  const settle = (callback, error) => {
    if (settled) return;
    settled = true;
    callback(error);
  };
  stream.once('end', () => settle(onEnd));
  stream.once('error', (error) => settle(onError, error));
  stream.once('aborted', () => settle(onError, new Error('上游流中断')));
  stream.once('close', () => {
    if (!stream.readableEnded) settle(onError, new Error('上游连接提前关闭'));
  });
}

// 解析上游 SSE：data:{json} → onEvent(obj)；data:[DONE] → onEvent(null)
function sseParse(stream, onEvent) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') { onEvent(null); continue; }
      try { onEvent(JSON.parse(d)); } catch {}
    }
  });
}

async function handleChatDirect(req, res, isResponses, body) {
  await ensureReasoningCapabilities();
  const system = systemText(body);
  const chatBody = isResponses ? responsesToChatBody(body, system) : sanitizeChatBody(body);
  try { applyDirectModelCompat(chatBody, body); }
  catch (error) {
    return sendJson(res, error.statusCode || 500, { error: { message: error.message, type: 'invalid_request_error' } });
  }
  const wantStream = body.stream === true;
  const model = chatBody.model || 'unknown';
  const t0 = Date.now();
  directStats.total++;
  directStats.lastAt = new Date().toISOString();
  directStats.lastModel = model;
  directStats.byModel[model] = (directStats.byModel[model] || 0) + 1;
  log(`[direct] ${req.url} 模型=${model} 流式=${wantStream} 消息数=${(chatBody.messages || []).length}`);

  const failure = (error) => {
    directStats.fail++;
    directStats.lastOutcome = 'error';
    directStats.lastErrorAt = new Date().toISOString();
    directStats.lastError = String(error.message).slice(0, 400);
    log(`[direct] 请求失败：${directStats.lastError}`);
    return { message: error.message, type: error.errorType || 'server_error',
      ...(error.code ? { code: error.code } : {}), ...(error.upstream ? { upstream: error.upstream } : {}) };
  };
  let up;
  try {
    up = await upstreamChat(chatBody);
  } catch (error) {
    return sendJson(res, error.statusCode || 502, { error: failure(error) });
  }

  // ---- 非流式：上游强制流式，聚合后返回
  if (!wantStream) {
    let content = '', reasoning = '', usage = null, finish = '';
    try {
      await new Promise((resolve, reject) => {
        finishUpstream(up, resolve, reject);
        sseParse(up, (j) => {
          if (!j) return;
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (d) { if (d.content) content += d.content; reasoning += reasoningDelta(d); }
          if (j.usage) usage = j.usage;
          const fr = j.choices && j.choices[0] && j.choices[0].finish_reason;
          if (fr) finish = fr;
        });
      });
    } catch (error) {
      return sendJson(res, 502, { error: failure(error) });
    }
    markDirectSuccess();
    log(`[direct] 完成 长度=${content.length} 用时=${Date.now() - t0}ms`);
    if (isResponses) {
      const out = [];
      if (reasoning) out.push(completedReasoningItem('rs_' + Math.random().toString(36).slice(2, 10), reasoning));
      out.push({ id: 'msg_' + Math.random().toString(36).slice(2, 10), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: content, annotations: [] }] });
      return sendJson(res, 200, { id: 'resp_' + Math.random().toString(36).slice(2, 10), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, output: out, output_text: content, usage: usage || undefined, error: null });
    }
    return sendJson(res, 200, { id: 'chatcmpl-' + Math.random().toString(36).slice(2, 10), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: finish || 'stop' }], usage: usage || undefined });
  }

  // ---- 流式
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();

  if (!isResponses) {
    // chat 纯透传：上游本来就是 OpenAI chat SSE，1:1 直通（usage 保留）
    let n = 0;
    up.on('data', () => { n++; });
    finishUpstream(up, () => {
      markDirectSuccess();
      log(`[direct] 流完成 块数=${n} 用时=${Date.now() - t0}ms`);
    }, (error) => {
      const detail = failure(error);
      up.unpipe(res);
      if (!res.destroyed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: detail })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
    });
    up.pipe(res);
    return;
  }

  // responses 流式：chat chunk → responses 事件
  const rid = () => Math.random().toString(36).slice(2, 10);
  const respId = 'resp_' + rid();
  const rsId = 'rs_' + rid();
  const msgId = 'msg_' + rid();
  let seq = 0;
  const sse = (type, payload) => { if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`); };
  sse('response.created', { response: { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model, output: [] } });
  let msgAdded = false, rsAdded = false, acc = '', reasoning = '', usage = null;
  let messageIndex = 0, reasoningIndex = 0, nextIndex = 0;
  sseParse(up, (j) => {
    if (!j) return;
    const ch = j.choices && j.choices[0];
    const d = ch && ch.delta;
    if (d) {
      const thought = reasoningDelta(d);
      if (thought) {
        if (!rsAdded) {
          rsAdded = true;
          reasoningIndex = nextIndex++;
          sse('response.output_item.added', { output_index: reasoningIndex, item: { id: rsId, type: 'reasoning', status: 'in_progress', summary: [] } });
        }
        reasoning += thought;
        sse('response.reasoning_text.delta', { output_index: reasoningIndex, item_id: rsId, content_index: 0, delta: thought });
      }
      if (d.content) {
        if (!msgAdded) {
          msgAdded = true;
          messageIndex = nextIndex++;
          sse('response.output_item.added', { output_index: messageIndex, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
        }
        acc += d.content;
        sse('response.output_text.delta', { output_index: messageIndex, item_id: msgId, content_index: 0, delta: d.content });
      }
    }
    if (j.usage) usage = j.usage;
  });
  finishUpstream(up, () => {
    const output = [];
    if (rsAdded) {
      const item = completedReasoningItem(rsId, reasoning);
      output[reasoningIndex] = item;
      sse('response.output_item.done', { output_index: reasoningIndex, item });
    }
    if (msgAdded) {
      const item = { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: acc, annotations: [] }] };
      output[messageIndex] = item;
      sse('response.output_item.done', { output_index: messageIndex, item });
    }
    sse('response.completed', { response: { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, output, output_text: acc, ...(usage ? { usage } : {}) } });
    markDirectSuccess();
    log(`[direct] 流完成 长度=${acc.length} 用时=${Date.now() - t0}ms`);
    res.end();
  }, (error) => {
    const detail = failure(error);
    if (!res.destroyed && !res.writableEnded) {
      sse('response.failed', { response: { id: respId, object: 'response', status: 'failed', model, output: [],
        error: { ...detail, code: detail.code || 'server_error' } } });
      res.end();
    }
  });
}


async function handleChat(req, res, isResponses) {
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: { message: 'bad json' } }); }
  if (ENGINE === 'direct') return handleChatDirect(req, res, isResponses, body);
  // 诊断：把原始请求 dump 到事件日志（截断 40000 字符）
  try { fs.appendFileSync(EVENT_LOG, `\n[REQ ${new Date().toISOString()}] path=${req.url} body=` + JSON.stringify(body).slice(0, 40000) + '\n'); } catch {}
  const text = lastUserText(body);
  if (!text) return sendJson(res, 400, { error: { message: '没有可用的 user 文本' } });
  const model = body.model || 'auto';
  const wantStream = body.stream === true;
  // 辅助任务（标题生成等）→ 一次性独立会话；正常对话 → 主会话
  const conv = isAuxTask(text) ? auxSessionId(text) : convOf(req, body);
  const system = systemText(body);
  reloadCred();

  if (ENGINE === 'acp') {
    await ensureReasoningCapabilities();
    let effort;
    try { effort = resolveReasoningEffort(body, model); }
    catch (error) {
      return sendJson(res, error.statusCode || 500, { error: { message: error.message, type: 'invalid_request_error' } });
    }
    return handleChatAcp(req, res, isResponses, { text, model, wantStream, conv, system, effort });
  }

  let runId;
  try { runId = await startRun(text, conv); } catch (e) {
    log(`[run] 启动失败：${e.message}`);
    return sendJson(res, 502, { error: { message: e.message, type: 'server_error' } });
  }
  log(`[run] ${runId} 会话=${conv} 模型=${model} 流式=${wantStream}`);

  const rid = () => Math.random().toString(36).slice(2, 10);
  const respId = 'resp_' + rid();
  const msgId = 'msg_' + rid();
  const created = Math.floor(Date.now() / 1000);

  if (!wantStream) {
    let out = '';
    try {
      await streamRun(runId, { onText: (t) => { out += t; } });
    } catch (e) {
      return sendJson(res, 502, isResponses
        ? { id: respId, object: 'response', status: 'failed', error: { code: 'server_error', message: e.message }, output: [] }
        : { error: { message: e.message, type: 'server_error' } });
    }
    if (isResponses) {
      return sendJson(res, 200, {
        id: respId, object: 'response', created_at: created, status: 'completed', model,
        output: [{ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: out, annotations: [] }] }],
        output_text: out, error: null, incomplete_details: null,
      });
    }
    return sendJson(res, 200, {
      id: 'chatcmpl-' + rid(), object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: out }, finish_reason: 'stop' }],
    });
  }

  // 流式
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  if (res.socket) res.socket.setNoDelay(true);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let seq = 0;
  const sse = (type, payload) => {
    if (res.writableEnded) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
  };
  const chunk = (delta, finish = null) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-' + runId.slice(0, 8), object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };

  if (isResponses) {
    sse('response.created', { response: { id: respId, object: 'response', created_at: created, status: 'in_progress', model, output: [] } });
    sse('response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
  } else {
    chunk({ role: 'assistant', content: '' });
  }

  const hb = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  let acc = '';
  try {
    await streamRun(runId, {
      onText: (t) => {
        acc += t;
        if (isResponses) sse('response.output_text.delta', { output_index: 0, item_id: msgId, content_index: 0, delta: t });
        else chunk({ content: t });
      },
    });
    if (isResponses) {
      sse('response.output_item.done', { output_index: 0, item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: acc, annotations: [] }] } });
      sse('response.completed', { response: { id: respId, object: 'response', created_at: created, status: 'completed', model, output: [{ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: acc, annotations: [] }] }], output_text: acc } });
    } else {
      chunk({}, 'stop');
      res.write('data: [DONE]\n\n');
    }
  } catch (e) {
    log(`[run] 流失败：${e.message}`);
    if (isResponses) sse('response.failed', { response: { id: respId, object: 'response', status: 'failed', model, output: [], error: { code: 'server_error', message: e.message } } });
    else { chunk({}, 'stop'); res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'server_error' } })}\n\n`); res.write('data: [DONE]\n\n'); }
  } finally {
    clearInterval(hb);
    if (!res.writableEnded) res.end();
  }
}

/* ---------------- ACP 版 handleChat（真流式） ---------------- */

async function handleChatAcp(req, res, isResponses, { text, model, wantStream, conv, system, effort }) {
  const rid = () => Math.random().toString(36).slice(2, 10);
  const respId = 'resp_' + rid();
  const msgId = 'msg_' + rid();
  const created = Math.floor(Date.now() / 1000);
  const preview = JSON.stringify(text.slice(0, 60));

  if (!wantStream) {
    let out = '', reasoning = '';
    let sessionId = null;
    const t0 = Date.now();
    try {
      const r = await queuedAcpTurn(text, conv, {
        onDelta: (t) => { out += t; }, onThought: (t) => { reasoning += t; },
      }, model, system, effort);
      sessionId = r.sessionId;
    } catch (e) {
      log(`[acp] 失败：${e.message}`);
      return sendJson(res, 502, isResponses
        ? { id: respId, object: 'response', status: 'failed', error: { code: 'server_error', message: e.message }, output: [] }
        : { error: { message: e.message, type: 'server_error' } });
    }
    const usage = await readUsageFromJsonl(sessionId, ACP_CWD);
    log(`[acp] 完成 会话=${conv} session=${sessionId} 输入=${preview} 长度=${out.length} 用时=${Date.now() - t0}ms usage=${usage ? JSON.stringify(usage) : 'null'}`);
    if (isResponses) {
      return sendJson(res, 200, {
        id: respId, object: 'response', created_at: created, status: 'completed', model,
        output: [...(reasoning ? [completedReasoningItem('rs_' + rid(), reasoning)] : []),
          { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: out, annotations: [] }] }],
        output_text: out, usage: usage || undefined, error: null, incomplete_details: null,
      });
    }
    return sendJson(res, 200, {
      id: 'chatcmpl-' + rid(), object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: out, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: 'stop' }],
    });
  }

  // 流式
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  if (res.socket) res.socket.setNoDelay(true);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let seq = 0;
  const sse = (type, payload) => {
    if (res.writableEnded) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
  };
  const chunk = (delta, finish = null) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-' + respId.slice(5, 13), object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };

  // 输出项按需创建：思考（reasoning）可能先于正文（message）出现，各自占一个 output_index。
  const rsId = 'rs_' + rid();
  let reasoningAdded = false;
  let messageAdded = false;
  let messageIndex = 0, reasoningIndex = 0, nextIndex = 0;
  const ensureReasoning = () => {
    if (reasoningAdded || !isResponses) return;
    reasoningAdded = true;
    reasoningIndex = nextIndex++;
    sse('response.output_item.added', { output_index: reasoningIndex, item: { id: rsId, type: 'reasoning', status: 'in_progress', summary: [] } });
  };
  const ensureMessage = () => {
    if (messageAdded) return;
    messageAdded = true;
    messageIndex = nextIndex++;
    if (isResponses) {
      sse('response.output_item.added', { output_index: messageIndex, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    }
  };

  if (isResponses) {
    sse('response.created', { response: { id: respId, object: 'response', created_at: created, status: 'in_progress', model, output: [] } });
  } else {
    chunk({ role: 'assistant', content: '' });
  }

  const hb = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  let acc = '', reasoning = '';
  const t0 = Date.now();
  let firstAt = 0;
  let toolCount = 0;
  let thinkCount = 0;
  try {
    const r = await queuedAcpTurn(text, conv, {
      onDelta: (t) => {
        if (!firstAt) firstAt = Date.now();
        acc += t;
        ensureMessage();
        if (isResponses) sse('response.output_text.delta', { output_index: messageIndex, item_id: msgId, content_index: 0, delta: t });
        else chunk({ content: t });
      },
      onThought: (t) => {
        thinkCount++;
        reasoning += t;
        if (!isResponses) return chunk({ reasoning_content: t });
        ensureReasoning();
        sse('response.reasoning_text.delta', { output_index: reasoningIndex, item_id: rsId, content_index: 0, delta: t });
      },
      onTool: () => { toolCount++; },
    }, model, system, effort);
    const usage = await readUsageFromJsonl(r.sessionId, ACP_CWD);
    log(`[acp] 流完成 会话=${conv} session=${r.sessionId} 输入=${preview} 首字=${firstAt ? firstAt - t0 : '-'}ms 总长=${acc.length} 思考块=${thinkCount} 工具事件=${toolCount} 用时=${Date.now() - t0}ms usage=${usage ? JSON.stringify(usage) : 'null'}`);
    if (isResponses) {
      const outputItems = [];
      if (reasoningAdded) {
        const item = completedReasoningItem(rsId, reasoning);
        outputItems[reasoningIndex] = item;
        sse('response.output_item.done', { output_index: reasoningIndex, item });
      }
      if (messageAdded) {
        outputItems[messageIndex] = { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: acc, annotations: [] }] };
        sse('response.output_item.done', { output_index: messageIndex, item: outputItems[messageIndex] });
      }
      sse('response.completed', { response: { id: respId, object: 'response', created_at: created, status: 'completed', model, output: outputItems, output_text: acc, ...(usage ? { usage } : {}) } });
    } else {
      chunk({}, 'stop');
      res.write('data: [DONE]\n\n');
    }
  } catch (e) {
    log(`[acp] 流失败：${e.message}`);
    if (isResponses) sse('response.failed', { response: { id: respId, object: 'response', status: 'failed', model, output: [], error: { code: 'server_error', message: e.message } } });
    else { chunk({}, 'stop'); res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'server_error' } })}\n\n`); res.write('data: [DONE]\n\n'); }
  } finally {
    clearInterval(hb);
    if (!res.writableEnded) res.end();
  }
}

function serveHttp() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/reasoning') {
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, reasoning: reasoningSettings() });
      const origin = req.headers.origin;
      if (origin) {
        let allowed = false;
        try {
          const parsed = new URL(origin);
          allowed = ['http:', 'https:'].includes(parsed.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
        } catch {}
        if (!allowed) return sendJson(res, 403, { error: { message: '只允许本机界面修改思考强度' } });
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': origin || '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type',
          vary: 'Origin' });
        return res.end();
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: { message: '使用 GET 或 POST' } });
      if (!reasoningSettings().supported) return sendJson(res, 409, { error: { message: '当前引擎不支持思考强度设置' } });
      readBody(req).then(async (body) => {
        await ensureReasoningCapabilities();
        const reasoning = saveReasoningSetting(body.model, body.effort);
        sendJson(res, 200, { ok: true, reasoning });
      }).catch((error) => sendJson(res, error.statusCode || (error instanceof SyntaxError ? 400 : 500),
        { error: { message: error.message } }));
      return;
    }
    if (url === '/health') return sendJson(res, 200, { status: 'ok', gwPort: cred.gwPort, hasPassword: !!cred.password, locked: LOCKED, credUpdatedAt: cred.updatedAt });
    if (url === '/dashboard') {
      try {
        const html = fs.readFileSync(path.join(__dirname, 'dsh-dashboard.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return void res.end(html);
      } catch { return sendJson(res, 404, { error: { message: 'dsh-dashboard.html 不在桥目录下' } }); }
    }
    if (url === '/dsh-install-cli' && req.method === 'POST') {
      spawnVisibleCmd(['npm', 'i', '-g', '@tencent-ai/codebuddy-code']);
      return sendJson(res, 200, { ok: true, note: '已打开安装窗口，完成后等 30 秒引导自动刷新' });
    }
    if (url === '/dsh-open-cli' && req.method === 'POST') {
      if (!codebuddyInstalled()) return sendJson(res, 200, { ok: false, error: '请先完成上一步：安装 CodeBuddy CLI' });
      const ca = path.join(__dirname, 'mitm', 'ca.pem');
      if (!fs.existsSync(ca)) return sendJson(res, 200, { ok: false, error: '找不到 Token 捕获证书：' + ca });
      const env = { ...process.env, NODE_EXTRA_CA_CERTS: ca, NO_PROXY: '127.0.0.1,localhost' };
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key];
      delete env.NODE_TLS_REJECT_UNAUTHORIZED;
      spawnVisibleCmd(['codebuddy-code'], env);
      return sendJson(res, 200, { ok: true, note: 'CLI 窗口已打开：输入 /login 完成登录，然后点「启动/重启通道」' });
    }
    if (url === '/dsh-fix-hosts' && req.method === 'POST') {
      const mitmOn = path.join(__dirname, 'mitm', 'mitm-on.cmd');
      if (!fs.existsSync(mitmOn)) return sendJson(res, 200, { ok: false, error: '找不到 ' + mitmOn });
      const ps = `Start-Process cmd -ArgumentList '/c "${mitmOn}"' -Verb RunAs`;
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return sendJson(res, 200, { ok: true, note: '已弹出 UAC 确认窗口，点「是」完成 hosts 修改' });
    }
    if (url === '/dsh-restart' && req.method === 'POST') {
      const launcher = path.join(__dirname, 'wbrelay-window.cmd');
      if (!fs.existsSync(launcher)) return sendJson(res, 200, { ok: false, error: '找不到 wbrelay-window.cmd' });
      // 1) 按 runtimes.json 精确停掉旧服务实例（隐藏运行的进程没有窗口标题可匹配）
      try {
        const rt = JSON.parse(fs.readFileSync(path.join(__dirname, 'runtimes.json'), 'utf8'));
        for (const k of ['bridge', 'capture', 'serve']) {
          const pid = rt.pids && rt.pids[k];
          if (pid) { try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', timeout: 4000 }); } catch { /* ignore */ } }
        }
      } catch { /* 无 runtimes.json：兼容旧实例，靠窗口标题兜底 */ }
      try { execSync('taskkill /FI "WINDOWTITLE eq codebuddy-code serve*" /F', { stdio: 'ignore', timeout: 4000 }); } catch { /* ignore */ }
      // 2) 隐藏拉起新编排器（启动器自带 2 秒缓冲），3) 本桥退出释放 8790
      try {
        const c = spawn('cmd.exe', ['/c', launcher], { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true });
        c.unref();
      } catch { /* ignore */ }
      sendJson(res, 200, { ok: true, note: '重启中：后台无窗口操作，约 20-30 秒后变绿' });
      setTimeout(() => { try { process.exit(0); } catch { /* ignore */ } }, 900);
    }
    if (url === '/api/status') {
      const probe = req.url.includes('probe=1');
      buildStatus(probe).then((s) => sendJson(res, 200, s)).catch((e) => sendJson(res, 500, { error: { message: String(e.message) } }));
      return;
    }
    if (url === '/v1/models') {
      ensureReasoningCapabilities(req.url.includes('refresh=1')).then(() => {
        sendJson(res, 200, { object: 'list', data: routeModelData(),
          capabilities: { source: acpModels.length ? 'cli-acp' : 'route-config',
            checkedAt: capabilityCheckedAt ? new Date(capabilityCheckedAt).toISOString() : null, error: capabilityError } });
      }).catch(() => sendJson(res, 503, { error: { message: '模型能力查询失败' } }));
      return;
    }
    if (url === '/v1/chat/completions' && req.method === 'POST') { handleChat(req, res, false).catch((e) => sendJson(res, 500, { error: { message: String(e.message) } })); return; }
    if (url === '/v1/responses' && req.method === 'POST') { handleChat(req, res, true).catch((e) => sendJson(res, 500, { error: { message: String(e.message) } })); return; }
    sendJson(res, 404, { error: { message: '未知路径：' + url, type: 'not_found' } });
  });
  server.on('error', (e) => log(`[http] 绑定失败：${e.message}（可能已有实例在跑）`));
  server.listen(LISTEN_PORT, '127.0.0.1', () => log(`[http] 桥已监听 http://127.0.0.1:${LISTEN_PORT}（网关 127.0.0.1:${cred.gwPort}）`));
  return server;
}

/* ---------------- MCP 模式（由桌面版拉起） ---------------- */

function serveMcp() {
  // 凭据来自桌面版注入的环境变量；写盘后由常驻桥自动刷新
  saveCred();
  log(`[mcp] 被拉起：gwPort=${cred.gwPort} password=${cred.password ? '已获得' : '缺失'}`);
  if (!cred.gwPort || !cred.password) {
    log('[mcp] 环境里没有 SERVER__PORT / CODEBUDDY_GATEWAY_PASSWORD，桥可能无法工作');
  }
  // 一个最小可用的 MCP stdio 服务：只提供 initialize / tools/list，不暴露任何工具
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
      if (msg.method === 'initialize') {
        reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dsh-wb-bridge', version: '1.0.0' } });
      } else if (msg.method === 'tools/list') {
        reply({ tools: [] });
      } else if (msg.id !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }) + '\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

/* ---------------- 入口 ---------------- */

if (MCP_MODE) {
  serveMcp();
  // 顺便确保常驻桥在跑（端口被占说明已经有实例）
  const probe = http.request({ host: '127.0.0.1', port: LISTEN_PORT, path: '/health', method: 'GET' }, (r) => { r.resume(); log('[mcp] 已有常驻桥在跑，不重复启动'); });
  probe.on('error', () => {
    log('[mcp] 没有常驻桥，作为独立进程拉起一个');
    const child = spawn(process.execPath, [__filename, '--port', String(LISTEN_PORT)], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  });
  probe.end();
} else {
  reloadCred();
  if (!cred.gwPort && ENGINE !== 'direct') {
    log('缺少 gwPort：用 --gw-port 指定（独立 CLI 服务如 60622），或让桌面版拉起（--mcp）');
    process.exit(1);
  }
  if (ENGINE === 'direct') {
    log(`[direct] 直连引擎：${DIRECT_HOST}（token 来自 mitm/captured-token.json）`);
  } else if (LOCKED) {
    log(`[cred] 锁定模式：直连 127.0.0.1:${cred.gwPort}${cred.password ? '（带 Bearer）' : '（仅 x-codebuddy-request）'}`);
  } else {
    saveCred();
    setInterval(reloadCred, 5000); // 桌面版重启后凭据自动刷新
  }
  serveHttp();
}
