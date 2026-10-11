window.__ModuleLoader__.load({ id: "dsh-plugin-wbrelay", factory: (require) => {
	const react = require("react");
	const { Button, Tooltip, StateDot, IconGaugeOutlineRegular, IconCodeOutlineRegular,
		IconRefreshOutlineRegular, IconCloseOutlineRegular, IconPlayOutlineRegular,
		IconClockOutlineRegular, IconBranchOutlineRegular, IconLinkOutlineRegular } =
		require("@deepseek-ai/dsh-client-ui-primitives");
	const h = react.createElement;
	const { useState, useEffect, useRef } = react;
	const BRIDGE = "http://127.0.0.1:8790";
	const PLUGIN = "/dsh-plugin-wbrelay";
	const PLUGIN_VERSION = "1.0.3";
	// 更新检查走插件接口 /update：只取远端版本号做对比，不跳转外部页面。
	const POSITION_KEY = "dsh-plugin-wbrelay:dock-position:v1";
	const MARGIN = 12, BUTTON_WIDTH = 176, BUTTON_HEIGHT = 44, GAP = 8;
	const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
	const text = (value, fallback = "未提供") => typeof value === "string" && value ? value : fallback;
	const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
	const bool = (value) => typeof value === "boolean" ? value : null;
	const tone = (value) => value === true ? "done" : value === false ? "error" : "idle";
	const effortNames = { off: "关闭", minimal: "最低", low: "低",
		medium: "中", high: "高", xhigh: "超高", max: "最高" };
	const effortName = (value) => effortNames[value] || value;

	const CSS = `
	.wbr-dock{font-family:var(--dsw-font-family,system-ui,"Microsoft YaHei",sans-serif);font-size:13px;line-height:20px;letter-spacing:0;color:var(--dsw-alias-label-primary,#ececee);pointer-events:auto}
	.wbr-dock *{box-sizing:border-box;letter-spacing:0}
	.wbr-dock .wbr-trigger{position:fixed;z-index:100;display:flex;align-items:center;justify-content:space-between;gap:8px;height:44px;padding:0 12px;border:1px solid var(--dsw-alias-border-l3,#454548);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#232324);color:inherit;box-shadow:0 4px 16px #0002;touch-action:none;user-select:none;cursor:grab}
	.wbr-dock .wbr-trigger:active{cursor:grabbing}
	.wbr-dock .wbr-trigger[aria-expanded=true]{border-color:var(--dsw-alias-label-tertiary,#909094)}
	.wbr-dock .wbr-trigger-name{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;min-width:0}
	.wbr-dock .wbr-dots{display:flex;gap:3px;flex:none}
	.wbr-dock .wbr-panel{position:fixed;z-index:101;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l3,#454548);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1b1b1c);box-shadow:0 8px 28px #0003}
	.wbr-dock .wbr-header{display:flex;align-items:center;gap:8px;flex:none;min-height:52px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#363638)}
	.wbr-dock .wbr-title{margin:0;font-size:15px;line-height:22px;font-weight:600;flex:1;min-width:0}
	.wbr-dock .wbr-tools{display:flex;align-items:center;gap:2px;flex:none}
	.wbr-dock .wbr-icon-button{width:28px;min-width:28px;height:28px;padding:0;border-radius:4px;color:inherit}
	.wbr-dock button:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#ececee);outline-offset:2px}
	.wbr-dock .wbr-body{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain}
	.wbr-dock .wbr-section{padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#363638)}
	.wbr-dock .wbr-section:last-child{border-bottom:0}
	.wbr-dock .wbr-section-head{display:flex;align-items:center;gap:7px;margin-bottom:7px}
	.wbr-dock .wbr-section-head>svg{color:var(--dsw-alias-label-tertiary,#99999f);flex:none}
	.wbr-dock .wbr-section-title{margin:0;font-size:13px;line-height:20px;font-weight:600;flex:1;min-width:0}
	.wbr-dock .wbr-state{display:flex;align-items:center;gap:4px;flex:none;font-size:12px}
	.wbr-dock .wbr-row{display:grid;grid-template-columns:86px minmax(0,1fr);gap:12px;padding:3px 0;margin:0}
	.wbr-dock .wbr-row dt{color:var(--dsw-alias-label-tertiary,#99999f)}
	.wbr-dock .wbr-row dd{margin:0;text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;min-width:0}
	.wbr-dock .wbr-action{margin-top:8px;max-width:100%;color:inherit}
	.wbr-dock .wbr-models{list-style:none;margin:6px 0 0;padding:0;max-height:290px;overflow:auto}
	.wbr-dock .wbr-model{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 10px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#2e2e30);overflow-wrap:anywhere}
	.wbr-dock .wbr-model:last-child{border:0}
	.wbr-dock .wbr-model-id{font-family:var(--ds-font-family-code,Consolas,monospace);font-size:12px;min-width:0}
	.wbr-dock .wbr-model-capability{width:100%;font-size:12px;color:var(--dsw-alias-label-tertiary,#99999f);overflow-wrap:anywhere}
	.wbr-dock .wbr-muted{color:var(--dsw-alias-label-tertiary,#99999f);font-size:12px;overflow-wrap:anywhere}
	.wbr-dock .wbr-message{padding:8px 14px;font-size:12px;overflow-wrap:anywhere;border-bottom:1px solid var(--dsw-alias-border-l2,#363638)}
	.wbr-dock .wbr-error{color:var(--dsw-alias-state-error-primary,#f25a5a)}
	.wbr-dock .wbr-warning{color:var(--dsw-alias-state-warn-primary,#e3aa45)}
	.wbr-dock .wbr-success{color:var(--dsw-alias-state-success-primary,#4ed17e)}
	.wbr-dock .wbr-footer{padding:7px 14px;flex:none;border-top:1px solid var(--dsw-alias-border-l2,#363638);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#99999f)}
	`;

	function time(value, seconds = false) {
		if (value == null || value === "") return "未提供";
		const date = new Date(seconds ? value * 1000 : value);
		return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "未提供";
	}

	function duration(ms) {
		if (ms == null || ms < 0) return "未提供";
		const minutes = Math.floor(ms / 60000);
		return minutes >= 60 ? Math.floor(minutes / 60) + " 时 " + minutes % 60 + " 分" : minutes + " 分";
	}

	function tokenState(token) {
		if (token.present !== true) return { state: "idle", label: "未捕获" };
		const remaining = token.exp != null ? (token.exp * 1000 - Date.now()) / 86400000 : token.daysLeft;
		if (remaining == null) return { state: "warning", label: "有效期未知" };
		if (remaining <= 0) return { state: "error", label: "已过期" };
		if (remaining <= 2) return { state: "warning", label: "即将过期" };
		return { state: "done", label: "有效" };
	}

	// 证书状态：present=本机是否已有证书；ok=能否直接用于捕获（不过期、主机名覆盖、公私钥配对）
	function certState(certs) {
		if (!certs || certs.present == null) return { state: "idle", label: "未确认" };
		if (certs.ok !== true) return { state: "error", label: certs.present ? "需要重签" : "未生成" };
		const days = certs.srvDaysLeft;
		if (days != null && days <= 30) return { state: "warning", label: "即将过期" };
		return { state: "done", label: "有效" };
	}

	// 两个原有状态接口的字段不同，只在前端归一化，不改变路由或桥接协议。
	function normalizeStatus(raw, source) {
		if (!raw || typeof raw !== "object" || !raw.cli || !raw.bridge || !raw.token) {
			throw new Error("状态接口返回格式异常");
		}
		const b = raw.bridge, c = raw.cli, t = raw.token, stats = b.stats || {};
		return {
			version: text(raw.ver, PLUGIN_VERSION),
			bridge: { up: source === "bridge" ? true : bool(b.up), engine: text(b.engine),
				port: number(b.port) || 8790, uptimeMs: number(b.uptimeMs),
				stats: { total: number(stats.total), ok: number(stats.ok), fail: number(stats.fail),
					lastAt: stats.lastAt, lastModel: text(stats.lastModel, ""),
					lastOutcome: text(stats.lastOutcome, ""), lastSuccessAt: stats.lastSuccessAt,
					lastErrorAt: stats.lastErrorAt, lastError: text(stats.lastError, "") } },
			cli: { up: bool(c.serviceUp ?? c.up), busy: bool(c.busy), runStatus: text(c.runStatus, ""),
				gatewayAuth: bool(c.authOk), port: 60622 },
			token: { present: bool(t.present), capturedAt: t.capturedAt, iat: number(t.iat),
				exp: number(t.exp), daysLeft: number(t.daysLeft) },
			certs: { present: bool(raw.certs?.present), ok: bool(raw.certs?.ok),
				sans: Array.isArray(raw.certs?.sans) ? raw.certs.sans : [],
				srvNotAfter: raw.certs?.srvNotAfter || null, caNotAfter: raw.certs?.caNotAfter || null,
				srvDaysLeft: number(raw.certs?.srvDaysLeft), caDaysLeft: number(raw.certs?.caDaysLeft),
				fingerprint: text(raw.certs?.fingerprint, ""),
				issues: Array.isArray(raw.certs?.issues) ? raw.certs.issues : [] },
			capture: { up: bool(raw.mitm443?.up), hosts: bool(raw.hosts?.entry) },
		};
	}

	function readPosition() {
		try {
			const p = JSON.parse(localStorage.getItem(POSITION_KEY));
			if (number(p?.x) != null && number(p?.y) != null) {
				return { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
			}
		} catch { /* 存储被禁用时仍可拖动。 */ }
		return { x: 1, y: 1 };
	}

	function savePosition(p) {
		try { localStorage.setItem(POSITION_KEY, JSON.stringify(p)); } catch { /* ignore */ }
	}

	function geometry(position, viewport) {
		const width = Math.min(BUTTON_WIDTH, Math.max(0, viewport.width - MARGIN * 2));
		const rangeX = Math.max(0, viewport.width - MARGIN * 2 - width);
		const rangeY = Math.max(0, viewport.height - MARGIN * 2 - BUTTON_HEIGHT);
		const x = MARGIN + rangeX * position.x, y = MARGIN + rangeY * position.y;
		const panelWidth = Math.min(380, Math.max(0, viewport.width - MARGIN * 2));
		const above = Math.max(0, y - MARGIN - GAP);
		const below = Math.max(0, viewport.height - MARGIN - y - BUTTON_HEIGHT - GAP);
		const onTop = above >= below;
		const panelHeight = Math.min(640, onTop ? above : below);
		return { x, y, width, rangeX, rangeY, panelWidth, panelHeight,
			panelX: clamp(x + width - panelWidth, MARGIN, Math.max(MARGIN, viewport.width - MARGIN - panelWidth)),
			panelY: onTop ? y - GAP - panelHeight : y + BUTTON_HEIGHT + GAP };
	}

	async function requestJson(url, options, controller, timeoutMs = 4000) {
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(url, { cache: "no-store", ...options, signal: controller.signal });
			if (!response.ok) throw new Error("接口返回 HTTP " + response.status);
			const body = await response.json();
			if (body?.ok === false || body?.error) {
				throw new Error(text(typeof body.error === "string" ? body.error : body.error?.message, "操作未完成").slice(0, 160));
			}
			return body;
		} finally { clearTimeout(timer); }
	}

	function DotLabel({ state, children }) {
		return h("span", { className: "wbr-state" }, h(StateDot, { state }), children);
	}
	function Row({ label, value, className }) {
		return h("dl", { className: "wbr-row" }, h("dt", null, label),
			h("dd", { className }, value == null ? "未提供" : value));
	}
	function Section({ title, icon, state, label, action, children }) {
		return h("section", { className: "wbr-section", "aria-label": title },
			h("div", { className: "wbr-section-head" }, h(icon, { size: 15 }),
				h("h3", { className: "wbr-section-title" }, title),
				action || h(DotLabel, { state }, label)), children);
	}
	function IconButton({ label, icon, ...props }) {
		return h(Tooltip, { label, side: "bottom" },
			h(Button, { size: "sm", variant: "ghost", className: "wbr-icon-button", "aria-label": label, ...props },
				h(icon, { size: 16 })));
	}

	function DashboardButton() {
		const [open, setOpen] = useState(false);
		const [position, setPosition] = useState(readPosition);
		const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
		const [snapshot, setSnapshot] = useState({ data: null, source: null, at: null, error: "" });
		const [polling, setPolling] = useState(false);
		const [models, setModels] = useState({ items: [], at: null, error: "", loading: false, nativeState: "unknown" });
		const [action, setAction] = useState("");
		const [message, setMessage] = useState(null);
		const [update, setUpdate] = useState({ latest: "", upToDate: null, at: null, error: "" });
		const root = useRef(null), trigger = useRef(null), panel = useRef(null);
		const mounted = useRef(false), requests = useRef(new Set()), drag = useRef(null);
		const suppressClick = useRef(false), modelFlight = useRef(null), modelCacheAt = useRef(0);
		const refresh = useRef(() => {}), refreshModels = useRef(() => {});
		const actionLock = useRef(false);
		const layout = geometry(position, viewport);
		const data = snapshot.data;
		const stale = !!snapshot.error;
		const tk = data ? tokenState(data.token) : { state: "idle", label: "待检测" };
		const cstate = data ? certState(data.certs) : { state: "idle", label: "待检测" };
		const bridgeState = stale ? "idle" : tone(data?.bridge.up);
		const cliState = stale ? "idle" : tone(data?.cli.up);

		async function getJson(url, options = {}, timeoutMs = 4000) {
			const c = new AbortController();
			requests.current.add(c);
			try { return await requestJson(url, options, c, timeoutMs); }
			finally { requests.current.delete(c); }
		}

		useEffect(() => {
			mounted.current = true;
			let disposed = false, timer = null, flight = null;
			const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
			window.addEventListener("resize", resize);

			function poll() {
				if (disposed) return;
				if (flight) return flight;
				clearTimeout(timer);
				setPolling(true);
				flight = (async () => {
					let normalized, source;
					try {
						try {
							normalized = normalizeStatus(await getJson(BRIDGE + "/api/status"), "bridge");
							source = "bridge";
						} catch {
							if (disposed) return;
							normalized = normalizeStatus(await getJson(PLUGIN + "/status"), "plugin");
							source = "plugin";
						}
						if (!disposed) setSnapshot({ data: normalized, source, at: Date.now(), error: "" });
					} catch {
						if (!disposed) setSnapshot((previous) => ({ ...previous, source: null, error: "状态接口暂不可达" }));
					} finally {
						flight = null;
						if (!disposed) {
							setPolling(false);
							timer = setTimeout(poll, 5000);
						}
					}
				})();
				return flight;
			}

			function pullModels(force = false) {
				if (disposed) return;
				if (modelFlight.current) return modelFlight.current;
				if (!force && Date.now() - modelCacheAt.current < 60000) return;
				setModels((previous) => ({ ...previous, loading: true }));
				modelFlight.current = (async () => {
					try {
						let raw, nativeState = "unknown", nativeError = "";
						try {
							raw = await getJson(PLUGIN + (force ? "/models/refresh" : "/models"), force ? {
								method: "POST", headers: { "content-type": "application/json" },
								body: JSON.stringify({ force: true }),
							} : {}, 30000);
							nativeState = text(raw.nativeReasoning?.state, "unknown");
							if (!["synced", "unchanged"].includes(nativeState)) {
								nativeError = "原生推理等级同步未确认";
							}
						} catch {
							if (disposed) return;
							raw = await getJson(BRIDGE + "/v1/models", {}, 30000);
							nativeError = "原生推理等级同步暂不可用";
						}
						if (!Array.isArray(raw?.data)) throw new Error("模型接口返回格式异常");
						const seen = new Set();
						const items = raw.data.flatMap((item) => {
							const id = text(item?.id, "");
							if (!id || seen.has(id)) return [];
							seen.add(id);
							const r = item.reasoning || {};
							const efforts = Array.isArray(r.efforts) ? [...new Set(r.efforts.filter((value) =>
								["minimal", "low", "medium", "high", "xhigh", "max"].includes(value)))] : [];
							return [{ id, name: text(item.name, ""), reasoning: {
								supported: bool(r.supported), efforts, canDisable: bool(r.canDisable),
								source: text(r.source, "unknown"),
							} }];
						});
						if (!disposed) {
							modelCacheAt.current = Date.now();
							setModels({ items, at: modelCacheAt.current,
								error: [nativeError, text(raw.capabilities?.error, "")].filter(Boolean).join(" · "),
								loading: false, nativeState });
						}
					} catch (error) {
						if (!disposed) setModels((previous) => ({ ...previous, loading: false,
							nativeState: "unknown", error: error.name === "AbortError" ? "模型拉取超时" : "模型拉取失败" }));
					} finally { modelFlight.current = null; }
				})();
				return modelFlight.current;
			}

			refresh.current = poll;
			refreshModels.current = pullModels;
			poll();
			return () => {
				disposed = true;
				mounted.current = false;
				clearTimeout(timer);
				window.removeEventListener("resize", resize);
				for (const c of requests.current) c.abort();
				requests.current.clear();
				refresh.current = () => {};
				refreshModels.current = () => {};
			};
		}, []);

		useEffect(() => {
			if (!open) return;
			setMessage(null);
			refreshModels.current();
			panel.current?.querySelector("button")?.focus({ preventScroll: true });
			const outside = (event) => {
				if (!root.current?.contains(event.target)) setOpen(false);
			};
			const escape = (event) => {
				const dockFocused = root.current?.contains(event.target) || event.target === document.body;
				if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented && dockFocused) {
					event.preventDefault();
					event.stopPropagation();
					setOpen(false);
					trigger.current?.focus({ preventScroll: true });
				}
			};
			document.addEventListener("pointerdown", outside);
			document.addEventListener("keydown", escape);
			return () => {
				document.removeEventListener("pointerdown", outside);
				document.removeEventListener("keydown", escape);
			};
		}, [open]);

		async function runAction(kind) {
			if (actionLock.current) return;
			actionLock.current = true;
			setAction(kind);
			setMessage(null);
			// POST 不自动重试，避免一次点击唤醒多个 CLI 窗口。
			const endpoint = kind === "login"
				? snapshot.source === "bridge" ? BRIDGE + "/dsh-open-cli" : PLUGIN + "/open-cli"
				: kind === "capture" ? PLUGIN + "/fix-hosts"
					: kind === "certs" ? PLUGIN + "/certs/generate"
						: kind === "token" ? PLUGIN + "/capture-token" : PLUGIN + "/start";
			// 证书已有效时点按钮＝主动重签（换设备、换目录、怀疑私钥外泄）；未就绪时只补齐缺失项。
			const options = kind === "certs"
				? { method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ force: snapshot.data?.certs?.ok === true }) }
				: { method: "POST" };
			try {
				const result = await getJson(endpoint, options,
					kind === "capture" ? 120000 : kind === "certs" ? 60000 : kind === "token" ? 90000 : 4000);
				if (result?.ok !== true) throw new Error("操作接口未确认成功");
				if (mounted.current) {
					setMessage({ ok: true, text: kind === "login" ? "CLI 登录窗口已唤醒"
						: kind === "capture" ? result.enabled === true ? "hosts 捕获已启用"
							: "捕获启用请求已提交，等待 hosts 状态更新"
							: kind === "certs" ? result.generated === true
								? "设备证书已" + (result.forced === true ? "重新生成" : "生成")
								: "设备证书已是可用状态"
								: kind === "token" ? "上游 token 已捕获" : "启动请求已提交" });
					refresh.current();
				}
			} catch (error) {
				if (mounted.current) setMessage({ ok: false,
					text: error.name === "AbortError" ? "操作超时，请检查状态后重试" : text(error.message, "操作失败") });
			} finally {
				actionLock.current = false;
				if (mounted.current) setAction("");
			}
		}

		function pointerDown(event) {
			if (!event.isPrimary || event.button !== 0) return;
			suppressClick.current = false;
			drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY,
				x: layout.x, y: layout.y, position, next: position, moved: false };
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		function pointerMove(event) {
			const d = drag.current;
			if (!d || d.id !== event.pointerId) return;
			const dx = event.clientX - d.startX, dy = event.clientY - d.startY;
			if (!d.moved && Math.hypot(dx, dy) < 6) return;
			d.moved = true;
			d.next = {
				x: layout.rangeX ? clamp((d.x + dx - MARGIN) / layout.rangeX, 0, 1) : 0,
				y: layout.rangeY ? clamp((d.y + dy - MARGIN) / layout.rangeY, 0, 1) : 0,
			};
			setPosition(d.next);
		}
		function endDrag(event, cancelled) {
			const d = drag.current;
			if (!d || d.id !== event.pointerId) return;
			drag.current = null;
			suppressClick.current = d.moved || cancelled;
			if (cancelled) setPosition(d.position);
			else if (d.moved) savePosition(d.next);
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
		}
		function toggle(event) {
			if (suppressClick.current && event.detail !== 0) {
				suppressClick.current = false;
				return;
			}
			setOpen((previous) => {
				if (!previous) setMessage(null);
				return !previous;
			});
		}
		async function getUpdate() {
			// 只取远端版本号做对比，不跳转外部页面
			if (actionLock.current) return;
			actionLock.current = true;
			setAction("update");
			setMessage(null);
			try {
				const result = await getJson(PLUGIN + "/update", {}, 10000);
				if (!mounted.current) return;
				const latest = text(result.latest, ""), current = text(result.current, PLUGIN_VERSION);
				setUpdate({ latest, upToDate: bool(result.upToDate), at: Date.now(), error: "" });
				setMessage({ ok: true, text: latest
					? result.upToDate === true ? "已是最新版本 " + current
						: "发现新版本 " + latest + "（本地 " + current + "）"
					: "远端未返回版本号（来源：" + text(result.source) + "）" });
			} catch (error) {
				if (mounted.current) {
					setUpdate({ latest: "", upToDate: null, at: Date.now(), error: text(error.message, "检查失败") });
					setMessage({ ok: false, text: "检查版本失败：" + text(error.message, "网络不可用") });
				}
			} finally {
				actionLock.current = false;
				if (mounted.current) setAction("");
			}
		}
		function moveByKey(event) {
			if (!event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
			event.preventDefault();
			const step = event.shiftKey ? 40 : 10;
			const next = {
				x: clamp(position.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0) / (layout.rangeX || 1), 0, 1),
				y: clamp(position.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) / (layout.rangeY || 1), 0, 1),
			};
			setPosition(next);
			savePosition(next);
		}

		const bridgeLabel = !data ? "待检测" : stale || data.bridge.up == null ? "未确认" : data.bridge.up ? "在线" : "离线";
		const cliLabel = !data ? "待检测" : stale || data.cli.up == null ? "未确认" : data.cli.up ? "在线" : "离线";
		const running = data?.cli.up == null ? "未确认" : !data.cli.up ? "未运行" : data.cli.busy === true ? "执行中"
			: data.cli.busy === false ? "空闲" : text(data.cli.runStatus, "未确认");
		const stats = data?.bridge.stats;
		// Token 已捕获后，桥保留的历史缺 Token 错误不再代表当前状态。
		const errorAt = Date.parse(stats?.lastErrorAt || "");
		const successAt = Date.parse(stats?.lastSuccessAt || "");
		const errorIsCurrent = stats?.lastOutcome === "error"
			|| (stats?.lastOutcome !== "ok" && Number.isFinite(errorAt)
				&& (!Number.isFinite(successAt) || errorAt >= successAt));
		const bridgeError = !errorIsCurrent || (data?.token.present === true
			&& /^未捕获到上游\s*token(?:[:：]|$)/i.test(stats?.lastError || ""))
			? "" : stats?.lastError;
		const remaining = data?.token.exp != null
			? (data.token.exp * 1000 - Date.now()) / 86400000 : data?.token.daysLeft;

		return h("div", { className: "wbr-dock", ref: root },
			h("style", null, CSS),
			h(Button, { ref: trigger, className: "wbr-trigger", "aria-label": "wbrelay 看板",
				"aria-expanded": open, "aria-controls": open ? "wbr-dashboard" : undefined, "aria-haspopup": "dialog",
				title: "桥 " + bridgeLabel + " · CLI " + cliLabel + " · Token " + (stale ? "未确认" : tk.label),
				style: { left: layout.x, top: layout.y, width: layout.width },
				onPointerDown: pointerDown, onPointerMove: pointerMove,
				onPointerUp: (event) => endDrag(event, false), onPointerCancel: (event) => endDrag(event, true),
				onLostPointerCapture: (event) => endDrag(event, true),
				onClick: toggle, onKeyDown: moveByKey },
				h("span", { className: "wbr-trigger-name" }, h(IconGaugeOutlineRegular, { size: 18 }), "wbrelay"),
				h("span", { className: "wbr-dots" },
					h(StateDot, { state: bridgeState }), h(StateDot, { state: cliState }),
					h(StateDot, { state: stale ? "idle" : tk.state }))),
			open && h("div", { id: "wbr-dashboard", ref: panel, role: "dialog", "aria-labelledby": "wbr-title",
				className: "wbr-panel", style: { left: layout.panelX, top: layout.panelY,
					width: layout.panelWidth, height: layout.panelHeight } },
				h("div", { className: "wbr-header" }, h(IconGaugeOutlineRegular, { size: 18 }),
					h("h2", { id: "wbr-title", className: "wbr-title" }, "wbrelay"),
					h("div", { className: "wbr-tools" },
						h(IconButton, { label: "刷新状态", icon: IconRefreshOutlineRegular, disabled: polling,
							onClick: () => { refresh.current(); refreshModels.current(true); } }),
						h(IconButton, { label: "收起看板", icon: IconCloseOutlineRegular,
							onClick: () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); } }))),
				h("div", { className: "wbr-body" },
					snapshot.error && h("div", { className: "wbr-message wbr-warning", role: "status" },
						snapshot.error + (data ? "，下方为上次状态" : "")),
					message && h("div", { className: "wbr-message " + (message.ok ? "wbr-success" : "wbr-error"),
						role: message.ok ? "status" : "alert" }, message.text),
					h(Section, { title: "CodeBuddy CLI", icon: IconCodeOutlineRegular, state: cliState, label: cliLabel },
						h(Row, { label: "服务", value: "127.0.0.1:" + (data?.cli.port || 60622) }),
						h(Row, { label: "运行状态", value: data ? running : "待检测" }),
						h(Row, { label: "网关认证", value: data?.cli.up && data.cli.gatewayAuth === true ? "已授权" : "未确认" }),
						h(Button, { size: "sm", variant: "outline", className: "wbr-action",
							disabled: !!action, onClick: () => runAction("login"),
							icon: h(IconCodeOutlineRegular, { size: 14 }) },
							action === "login" ? "正在唤醒" : "CLI 登录")),
					h(Section, { title: "捕获证书", icon: IconLinkOutlineRegular,
						state: stale ? "idle" : cstate.state, label: stale ? "未确认" : cstate.label },
						data?.certs.present === false && h("div", { className: "wbr-muted wbr-warning" },
							"本机还没有捕获证书：启动通道或点下方按钮会自动生成，不需要手工 openssl"),
						h(Row, { label: "签发主机", value: data?.certs.sans.length ? data.certs.sans.join(", ") : null }),
						h(Row, { label: "证书到期", value: time(data?.certs.srvNotAfter) }),
						h(Row, { label: "剩余有效期", value: data?.certs.srvDaysLeft == null ? "未知"
							: data.certs.srvDaysLeft <= 0 ? "已过期" : data.certs.srvDaysLeft + " 天",
							className: cstate.state === "error" ? "wbr-error" : undefined }),
						h(Row, { label: "CA 剩余", value: data?.certs.caDaysLeft == null ? "未知" : data.certs.caDaysLeft + " 天" }),
						h(Row, { label: "指纹", value: data?.certs.fingerprint ? data.certs.fingerprint.slice(0, 23) + "…" : null }),
						!stale && data?.certs.issues.length > 0 && h("div", { className: "wbr-muted wbr-warning", role: "status" },
							data.certs.issues.join("；")),
						h(Tooltip, { label: "证书只在本机有效；换设备、换目录或怀疑私钥外泄时重新生成",
							side: "top" },
							h(Button, { size: "sm", variant: "outline", className: "wbr-action",
								disabled: !!action, onClick: () => runAction("certs"),
								icon: h(IconRefreshOutlineRegular, { size: 14 }) },
								action === "certs" ? "正在处理" : data?.certs.ok === true ? "重新生成证书" : "生成证书"))),
					h(Section, { title: "Token 时间戳", icon: IconClockOutlineRegular,
						state: stale ? "idle" : tk.state, label: stale ? "未确认" : tk.label },
						data?.token.present === false && h("div", { className: "wbr-muted wbr-warning" },
							data.capture.hosts === false ? "hosts 捕获未启用，尚无 Token 时间戳"
								: "尚未捕获上游 Token，暂无时间戳"),
						h(Row, { label: "签发时间", value: time(data?.token.iat, true) }),
						h(Row, { label: "过期时间", value: time(data?.token.exp, true) }),
						h(Row, { label: "最近捕获", value: time(data?.token.capturedAt) }),
						h(Row, { label: "剩余有效期", value: remaining == null ? "未知" : remaining <= 0 ? "已过期"
							: remaining < 1 ? Math.ceil(remaining * 24) + " 小时" : remaining.toFixed(1) + " 天",
							className: tk.state === "error" ? "wbr-error" : undefined }),
						h(Button, { size: "sm", variant: "outline", className: "wbr-action",
							disabled: !!action, onClick: () => runAction("token"),
							icon: h(IconRefreshOutlineRegular, { size: 14 }) },
							action === "token" ? "正在捕获" : "捕获 token"),
						!stale && data?.capture.hosts === false && h(Tooltip, { label: "请求管理员权限启用 hosts Token 捕获", side: "top" },
							h(Button, { size: "sm", variant: "outline", className: "wbr-action",
								disabled: !!action, onClick: () => runAction("capture"),
								icon: h(IconPlayOutlineRegular, { size: 14 }) },
								action === "capture" ? "正在启用" : "启用捕获"))),
					h(Section, { title: "路由模型", icon: IconBranchOutlineRegular,
						action: h(IconButton, { label: "拉取路由模型", icon: IconRefreshOutlineRegular,
							disabled: models.loading, onClick: () => refreshModels.current(true) }) },
						h("div", { className: "wbr-muted" }, "/v1/models · " + models.items.length + " 个"),
						h(Row, { label: "原生推理等级", value: ["synced", "unchanged"].includes(models.nativeState) ? "已同步" : "未确认" }),
						models.error && h("div", { className: "wbr-muted wbr-warning", role: "status" },
							models.error + (models.at ? "，保留上次列表" : "")),
						!models.items.length && h("div", { className: "wbr-muted" },
							models.loading ? "正在拉取" : models.at ? "接口未返回模型" : "尚未拉取"),
						h("ul", { className: "wbr-models" }, models.items.map((item) =>
							h("li", { key: item.id, className: "wbr-model" },
								h("span", { className: "wbr-model-id" }, item.id),
								item.name && item.name !== item.id && h("span", { className: "wbr-muted" }, item.name),
								h("div", { className: "wbr-model-capability" }, item.reasoning.supported === false
									? "不支持深度思考" : item.reasoning.efforts.length
										? "思考 " + item.reasoning.efforts.map((value) => effortName(value) + " " + value).join(" · ")
											+ (item.reasoning.canDisable === false ? " · 必须开启" : item.reasoning.canDisable === true ? " · 可关闭" : "")
										: item.id === "auto" ? "动态路由 · 思考能力随模型确定" : "思考能力未确认"),
								item.reasoning.source === "route-config" && h("span", { className: "wbr-muted" }, "路由声明 · 等待 CLI 确认")))),
						h("div", { className: "wbr-muted" }, "拉取时间 " + time(models.at))),
					h(Section, { title: "桥接状态", icon: IconLinkOutlineRegular, state: bridgeState, label: bridgeLabel },
						h(Row, { label: "引擎", value: data?.bridge.engine }),
						h(Row, { label: "监听端口", value: data?.bridge.port || 8790 }),
						h(Row, { label: "捕获代理", value: data?.capture.up == null ? "未确认"
							: data.capture.up ? "在线" : "离线" }),
						h(Row, { label: "hosts 捕获", value: data?.capture.hosts == null ? "未确认"
							: data.capture.hosts ? "已启用" : "未启用" }),
						h(Row, { label: "运行时长", value: duration(data?.bridge.uptimeMs) }),
						h(Row, { label: "总计 / 成功 / 失败",
							value: stats ? [stats.total, stats.ok, stats.fail].map((n) => n ?? "未知").join(" / ") : "待检测" }),
						h(Row, { label: "最近请求", value: time(stats?.lastAt) }),
						stats?.lastModel && h(Row, { label: "最近模型", value: stats.lastModel }),
						bridgeError && h("div", { className: "wbr-muted wbr-error" }, bridgeError),
						data?.bridge.up === false && h(Button, { size: "sm", variant: "outline", className: "wbr-action",
							disabled: !!action, onClick: () => runAction("start"),
							icon: h(IconPlayOutlineRegular, { size: 14 }) },
							action === "start" ? "正在提交" : "启动通道"))),
					h(Section, { title: "版本信息", icon: IconGaugeOutlineRegular, state: "idle", label: "" },
						h(Row, { label: "插件版本", value: data?.version || PLUGIN_VERSION }),
						h(Row, { label: "最新版本", value: update.error ? "检查失败"
							: update.latest ? update.latest + (update.upToDate === true ? "（已是最新）"
								: update.upToDate === false ? "（可更新）" : "")
								: update.at ? "未获取到版本号" : "未检查" }),
						h(Row, { label: "更新通道", value: "GitHub Releases" }),
						h(Button, { size: "sm", variant: "outline", className: "wbr-action",
							disabled: action === "update", onClick: getUpdate,
							icon: h(IconRefreshOutlineRegular, { size: 14 }) },
							action === "update" ? "检查中" : "检查最新版本")),
				h("div", { className: "wbr-footer" },
					h("span", null, polling ? "正在更新" : snapshot.at ? "更新 " + time(snapshot.at) : "等待状态"),
					h("span", null, snapshot.source === "plugin" ? "插件状态" : snapshot.source === "bridge" ? "桥状态" : "未连接"))));
	}

	return {
		name: "dsh-plugin-wbrelay",
		inject: ["slots"],
		apply(ctx) {
			return ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay", id: "dsh-plugin-wbrelay-dock", order: 60,
			}, () => h(DashboardButton)));
		},
	};
} });
