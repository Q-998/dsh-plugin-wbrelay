import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';

const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PROVIDER = 'wbrelay';
const BRIDGE_PORT = 8790;

export function fetchBridgeModels(force, signal) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: BRIDGE_PORT, method: 'GET',
      path: '/v1/models' + (force ? '?refresh=1' : ''),
      headers: { 'x-codebuddy-request': '1' }, signal, timeout: 120000,
    }, (response) => {
      let body = '', bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          request.destroy(new Error('Bridge model catalog is too large'));
          return;
        }
        body += chunk;
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error('Bridge model catalog is unavailable'));
          return;
        }
        try {
          const catalog = JSON.parse(body);
          if (!Array.isArray(catalog.data) || !catalog.data.length) throw new Error();
          resolve(catalog);
        } catch {
          reject(new Error('Bridge returned an invalid model catalog'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Bridge model catalog timed out')));
    request.on('error', reject);
    request.end();
  });
}

function ownsLocalBridge(route) {
  if (route?.api !== 'openai-completions') return false;
  try {
    const url = new URL(route.baseURL);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      Number(url.port) === BRIDGE_PORT && url.pathname.replace(/\/+$/, '') === '/v1' &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function capabilityEfforts(model) {
  const capability = model?.reasoning;
  if (capability?.available !== true) return undefined;
  if (capability.supported === false &&
      ['cli-model', 'cli-acp'].includes(capability.source)) return false;
  if (capability.source !== 'cli-acp' || capability.supported !== true ||
      !Array.isArray(capability.efforts)) return undefined;
  const levels = LEVELS.filter((level) => capability.efforts.includes(level));
  if (!levels.length) return undefined;
  return {
    ...(capability.canDisable === true ? { off: 'off' } : {}),
    ...Object.fromEntries(levels.map((level) => [level, level])),
  };
}

export function reasoningEdits(models, catalog, path = ['providers', PROVIDER]) {
  if (!Array.isArray(models)) return [];
  const capabilities = new Map();
  for (const entry of catalog.data) {
    if (typeof entry?.id !== 'string' || capabilities.has(entry.id)) continue;
    capabilities.set(entry.id, capabilityEfforts(entry));
  }
  return models.flatMap((model, index) => {
    const efforts = capabilities.get(model?.id);
    if (efforts === undefined || isDeepStrictEqual(model.reasoningEfforts, efforts)) return [];
    return [{
      model: model.id,
      edit: { op: 'set', path: [...path, 'models', String(index), 'reasoningEfforts'], value: efforts },
    }];
  });
}

function isConflict(error) {
  return error?.name === 'SettingsConflictError' || error?.code === 'settings/conflict' ||
    (error?.expectedRevision !== undefined && error?.actualRevision !== undefined);
}

export function createNativeReasoningSync(ctx, {
  loadModels = fetchBridgeModels, intervalMs = 30000,
} = {}) {
  let closed = false, timer, inflight, controller, lastCatalog;
  let state = { state: 'unavailable', provider: PROVIDER, updatedModels: [], checkedAt: null };
  const status = () => ({ ...state, updatedModels: [...state.updatedModels] });
  const fail = (message, nextState = 'error') => {
    state = { state: nextState, provider: PROVIDER, updatedModels: [],
      checkedAt: new Date().toISOString(), error: message };
    return { ok: false, ...(lastCatalog || {}), nativeReasoning: status(), error: message };
  };
  const synchronize = async (catalog) => {
    if (catalog.capabilities?.error) return fail('CLI 模型能力暂不可达，已保留原生菜单设置', 'unavailable');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (closed) return fail('原生模型同步已结束', 'unavailable');
      const address = ctx.llm.listConfigurableProviders().find((entry) => entry.provider === PROVIDER);
      if (!address || address.settingsPath?.join('.') !== 'providers.wbrelay') {
        return fail('dsh 尚未注册 wbrelay 模型配置', 'unavailable');
      }
      const descriptor = ctx.settings.describe().find((entry) => entry.ns === address.settingsNs);
      const route = descriptor?.value?.providers?.[PROVIDER];
      if (!descriptor || !ownsLocalBridge(route) || !Array.isArray(route.models)) {
        return fail('wbrelay 原生模型配置未指向本机桥接服务', 'unavailable');
      }
      const edits = reasoningEdits(route.models, catalog, address.settingsPath);
      if (!edits.length) {
        const known = catalog.data.some((model) =>
          route.models.some((entry) => entry.id === model.id) && capabilityEfforts(model) !== undefined);
        state = { state: known ? 'unchanged' : 'unavailable', provider: PROVIDER, updatedModels: [],
          checkedAt: new Date().toISOString(),
          ...known ? {} : { error: 'CLI 尚未提供已配置模型的思考能力' } };
        return { ok: known, ...catalog, nativeReasoning: status() };
      }
      try {
        // Revision checking keeps model indices valid if the user edits the catalog concurrently.
        await ctx.settings.mutate(address.settingsNs, edits.map((entry) => entry.edit), descriptor.revision);
        state = { state: 'synced', provider: PROVIDER, updatedModels: edits.map((entry) => entry.model),
          checkedAt: new Date().toISOString() };
        return { ok: true, ...catalog, nativeReasoning: status() };
      } catch (error) {
        if (attempt === 0 && isConflict(error)) continue;
        return fail('dsh 原生思考能力同步失败，已保留现有模型配置');
      }
    }
  };
  const refresh = (force = false) => {
    if (closed) return Promise.resolve(fail('原生模型同步已结束', 'unavailable'));
    if (inflight) return inflight;
    controller = new AbortController();
    inflight = (async () => {
      try {
        const catalog = await loadModels(force, controller.signal);
        if (!Array.isArray(catalog?.data) || !catalog.data.length) return fail('桥接模型清单无效');
        if (closed) return fail('原生模型同步已结束', 'unavailable');
        lastCatalog = catalog;
        return await synchronize(catalog);
      } catch {
        return fail('桥接模型能力暂不可达，已保留原生菜单设置', 'unavailable');
      } finally {
        controller = undefined;
        inflight = undefined;
      }
    })();
    return inflight;
  };
  return {
    status, refresh,
    async models() {
      if (lastCatalog) {
        const nativeReasoning = status();
        const ok = nativeReasoning.state === 'synced' || nativeReasoning.state === 'unchanged';
        return {
          ok,
          ...lastCatalog,
          nativeReasoning,
          ...(ok ? {} : { error: nativeReasoning.error || 'dsh 原生思考能力同步未确认' }),
        };
      }
      return refresh(false);
    },
    start() {
      if (closed || timer) return;
      void refresh(false);
      timer = setInterval(() => { void refresh(false); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      closed = true;
      clearInterval(timer);
      controller?.abort();
    },
  };
}
