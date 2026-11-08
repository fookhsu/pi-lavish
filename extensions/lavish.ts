/**
 * pi-lavish — 让 Lavish Editor（lavish-axi）的反馈直接唤醒 pi 的新回合。
 *
 * 解决的问题：lavish-axi 的反馈只能通过 `lavish-axi poll` 长轮询取回。
 * 手动跑 poll 会独占 pi 的整个 turn（人可能要在浏览器里磨五分钟）。
 *
 * 这个扩展把 poll 从「agent 的前台 bash」搬到「扩展的后台监听」：
 *   1. 看到 agent 跑 `lavish-axi <file>` 打开会话 → 自动开始监听该文件；
 *   2. 用户点 Send → 扩展收到反馈 → `pi.sendUserMessage()` 唤醒 agent 新回合；
 *   3. 交付后暂停监听，等本轮结束（agent_settled）再自动续上，
 *      避免用户连续发送时把几条反馈拆成多个回合。
 *
 * 只走 HTTP API（GET /api/poll?file=…），不解析 CLI 的 TOON 输出，
 * 版本升级时字段变化更容易暴露而不是静默出错。
 */

import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 4387;
/** lavished 的子命令；出现在 `lavish-axi` 之后第一个非 flag 位置时视为子命令。 */
const SUBCOMMANDS = new Set([
	"poll",
	"reply",
	"end",
	"stop",
	"playbook",
	"design",
	"setup",
	"server",
	"export",
	"share",
	"libraries",
	"help",
]);

/** 这些子命令会创建/恢复一个 review 会话，值得开始监听。 */
const OPEN_LIKE = new Set(["open"]);

const MAX_PROMPT_CHARS = 2400;
/** 交付后等这一轮结束的上限；超时就继续监听，免得卡死。 */
const SETTLE_TIMEOUT_MS = 10 * 60_000;

function port(): number {
	const raw = Number(process.env.LAVISH_AXI_PORT);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PORT;
}

function baseUrl(): string {
	return `http://127.0.0.1:${port()}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((done) => {
		if (signal.aborted) return done();
		const timer = setTimeout(finish, ms);
		function finish() {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			done();
		}
		signal.addEventListener("abort", finish, { once: true });
	});
}

/** 粗糙但够用的 shell 分词：只处理引号与反斜杠转义。 */
function tokenize(command: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += command[++i];
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current) out.push(current);
	return out;
}

interface LavishInvocation {
	sub: string;
	file?: string;
}

/** 从一条 bash 命令里认出 lavish-axi 调用。认不出返回 null。 */
function parseInvocation(command: string): LavishInvocation | null {
	if (!/lavish-axi/.test(command)) return null;
	const tokens = tokenize(command);
	const index = tokens.findIndex((token) => /(^|[\\/])lavish-axi$/.test(token));
	if (index === -1) return null;

	const rest = tokens.slice(index + 1);
	const positional = rest.filter((token) => !token.startsWith("-"));
	const flags = rest.filter((token) => token.startsWith("-"));
	if (positional.length === 0) {
		if (flags.includes("--help") || flags.includes("-h")) return { sub: "help" };
		return null;
	}

	const [first, ...others] = positional;
	if (SUBCOMMANDS.has(first)) {
		return { sub: first, file: others[0] };
	}
	// `lavish-axi <html-file>` = 打开/恢复会话
	return { sub: "open", file: first };
}

function absolutize(file: string, cwd: string): string {
	return resolve(cwd, file);
}

// ---------------------------------------------------------------------------
// 监听状态
// ---------------------------------------------------------------------------

type Phase = "polling" | "waiting-for-turn" | "ended";

interface Watcher {
	file: string;
	phase: Phase;
	/** 服务端确认 listener 已挂上（响应头 lavish-poll-state: listening）。 */
	connected: boolean;
	/** 已经取回但还没交到模型手上的文本。 */
	pending?: string;
	controller: AbortController;
	retries: number;
	lastError?: string;
	deliveredRounds: number;
}

// ---------------------------------------------------------------------------
// 扩展主体
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const watchers = new Map<string, Watcher>();
	/** agent 空闲时给的 ExtensionContext，用于判断该立即发还是排队发。 */
	let lastCtx: ExtensionContext | undefined;
	/** agent_settled 的等待者。 */
	const settleWaiters = new Set<() => void>();

	function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info") {
		ctx?.ui.notify(message, level);
	}

	function statusLine(): string {
		if (watchers.size === 0) return "lavish: 未监听";
		const parts = [...watchers.values()].map((w) => {
			const state = w.connected ? "已连接" : "连接中";
			return `${w.file} (${state}, ${w.phase})`;
		});
		return `lavish: ${parts.join(" · ")}`;
	}

	function refreshStatus(ctx: ExtensionContext | undefined) {
		ctx?.ui.setStatus("pi-lavish", watchers.size > 0 ? statusLine() : undefined);
	}

	// -- 反馈投递 ------------------------------------------------------------

	function flushPending(w: Watcher, ctx?: ExtensionContext) {
		const text = w.pending;
		if (!text) return;
		try {
			// 空闲时立即起新回合；正在跑就排到本轮工具跑完之后，避免打断手上的编辑。
			if (ctx?.isIdle() ?? true) {
				pi.sendUserMessage(text);
			} else {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			}
			w.pending = undefined;
		} catch {
			// 保持 pending，等下一个 agent_settled 再试。
		}
	}

	function formatPrompts(file: string, body: Record<string, unknown>): string {
		const prompts = Array.isArray(body.prompts) ? (body.prompts as Array<Record<string, unknown>>) : [];
		const lines: string[] = [];
		lines.push(`[lavish] 用户在 Lavish 里发来 ${prompts.length} 条反馈（${file}）。`);
		lines.push("");
		prompts.forEach((prompt, index) => {
			const tag = String(prompt.tag ?? "chat");
			const selector = String(prompt.selector ?? "").trim();
			const text = String(prompt.text ?? "").replace(/\r/g, "").trim();
			const head = selector ? `[${tag}] ${selector}` : `[${tag}]`;
			lines.push(`${index + 1}) ${head}`);
			if (text) {
				const clipped =
					text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}\n…（已截断）` : text;
				lines.push(
					clipped
						.split("\n")
						.map((line) => `   ${line}`)
						.join("\n"),
				);
			}
			// 白板反馈带本地文件，指出来即可，不要内联进来。
			for (const key of ["scenePath", "previewPath"]) {
				const value = prompt[key];
				if (typeof value === "string" && value.trim()) lines.push(`   ${key}: ${value}`);
			}
		});

		const failures = Array.isArray(body.artifact_failures) ? body.artifact_failures : [];
		if (failures.length > 0) {
			lines.push("");
			lines.push(`⚠ artifact_failures（review 面本身可能打不开）：${JSON.stringify(failures).slice(0, 1200)}`);
		}

		lines.push("");
		lines.push("下一步：直接改这个 HTML 文件；改完提交回执——");
		lines.push(`  npx -y lavish-axi reply ${JSON.stringify(file)} --agent-reply "一句话说明改了什么"`);
		lines.push("不要手动跑 poll：监听由 pi-lavish 扩展接管，提交回执后会自动续上。");
		return lines.join("\n");
	}

	async function handlePollBody(w: Watcher, body: Record<string, unknown>, ctx: ExtensionContext | undefined) {
		const status = String(body.status ?? "");
		const ended = Boolean(body.session_ended) || status === "ended";

		if (status === "feedback") {
			w.deliveredRounds += 1;
			w.pending = formatPrompts(w.file, body);
			flushPending(w, ctx);

			if (ended) {
				w.phase = "ended";
				notify(ctx, `lavish: ${w.file} 会话已结束（${String(body.ended_by ?? "user")}）`);
			} else {
				w.phase = "waiting-for-turn";
			}
			refreshStatus(ctx);
			return;
		}

		if (status === "browser_disconnected") {
			w.pending =
				`[lavish] ${w.file} 的 review 页面已被关闭/断开（超过重连宽限期）。会话仍可恢复：` +
				`询问用户是重新打开（npx -y lavish-axi ${JSON.stringify(w.file)}）还是结束会话，不要擅自决定。`;
			flushPending(w, ctx);
			w.phase = "waiting-for-turn";
			refreshStatus(ctx);
			return;
		}

		if (status === "ended") {
			w.phase = "ended";
			notify(ctx, `lavish: ${w.file} 会话已结束`);
			refreshStatus(ctx);
			return;
		}

		if (status === "missing") {
			// 会话还没被 CLI 创建（用户可能关掉了）——退避重试，不报错打扰人。
			w.lastError = "会话不存在（尚未 lavish-axi <file> 打开）";
			return;
		}

		// status === "waiting" / 未知：没有反馈，继续等。
	}

	// -- 轮询循环 ------------------------------------------------------------

	async function pollOnce(file: string, signal: AbortSignal) {
		const url = `${baseUrl()}/api/poll?file=${encodeURIComponent(file)}`;
		const response = await fetch(url, {
			headers: {
				// 服务端的入队/轮询都做同源校验；这里显式声明来源。
				origin: baseUrl(),
				accept: "application/json",
			},
			signal,
		});
		const listening = response.headers.get("lavish-poll-state") === "listening";
		const body = (await response.json()) as Record<string, unknown>;
		return { listening, body };
	}

	async function runLoop(w: Watcher) {
		const { signal } = w.controller;
		while (!signal.aborted) {
			try {
				const { listening, body } = await pollOnce(w.file, signal);
				if (listening) {
					w.connected = true;
					w.retries = 0;
					w.lastError = undefined;
					refreshStatus(lastCtx);
				}

				if (body.status === "error") {
					const code = String(body.code ?? "");
					if (code === "LISTENER_ACTIVE") {
						// 别人（例如 agent 手跑的 poll）已经占着 listener。退让，不抢。
						w.connected = false;
						refreshStatus(lastCtx);
						await sleep(5000, signal);
						continue;
					}
					if (code === "LISTENER_REPLACED") {
						notify(lastCtx, `lavish: ${w.file} 的监听被另一处 poll 接管，停止监听`, "warning");
						w.phase = "ended";
						return;
					}
					w.lastError = `${code}: ${String(body.error ?? "")}`;
					await sleep(3000, signal);
					continue;
				}

				await handlePollBody(w, body, lastCtx);
				if (w.phase === "ended") return;

				// 交付完先停手，等这一轮改完（agent_settled）再续上，
				// 这样用户连发几条反馈不会拆成好几个回合；超时兜底，不会永久停摆。
				await new Promise<void>((done) => {
					const waiter = () => {
						settleWaiters.delete(waiter);
						clearTimeout(timer);
						done();
					};
					const timer = setTimeout(waiter, SETTLE_TIMEOUT_MS);
					settleWaiters.add(waiter);
					signal.addEventListener("abort", waiter, { once: true });
				});
				if (signal.aborted) return;
				w.phase = "polling";
				refreshStatus(lastCtx);
			} catch (error) {
				if (signal.aborted) return;
				w.connected = false;
				w.lastError = error instanceof Error ? error.message : String(error);
				refreshStatus(lastCtx);
				const backoff = Math.min(30_000, 1000 * 2 ** Math.min(w.retries, 5));
				w.retries += 1;
				await sleep(backoff, signal);
			}
		}
	}

	// -- 监听生命周期 --------------------------------------------------------

	function ensureWatcher(file: string, ctx?: ExtensionContext): Watcher {
		const existing = watchers.get(file);
		if (existing && existing.phase !== "ended") return existing;
		if (existing) {
			// 上一个会话结束了（用户 Send & End 或主动 end），重新打开时换一个新监听。
			existing.controller.abort();
			watchers.delete(file);
		}
		const watcher: Watcher = {
			file,
			phase: "polling",
			connected: false,
			controller: new AbortController(),
			retries: 0,
			deliveredRounds: 0,
		};
		watchers.set(file, watcher);
		void runLoop(watcher);
		refreshStatus(ctx);
		return watcher;
	}

	function stopWatcher(file: string, ctx?: ExtensionContext) {
		const watcher = watchers.get(file);
		if (!watcher) return false;
		watcher.controller.abort();
		watchers.delete(file);
		refreshStatus(ctx);
		return true;
	}

	function stopAll() {
		for (const watcher of watchers.values()) watcher.controller.abort();
		watchers.clear();
	}

	/** 这个文件的 poll 是否已由本扩展接管（决定要不要拦住 agent 手跑的 poll）。 */
	function ownedWatcher(file: string): Watcher | undefined {
		const watcher = watchers.get(file);
		return watcher && watcher.phase !== "ended" ? watcher : undefined;
	}

	// -- 事件接线 ------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		refreshStatus(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		for (const waiter of [...settleWaiters]) waiter();
		for (const watcher of watchers.values()) flushPending(watcher, ctx);
		refreshStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopAll();
		settleWaiters.clear();
	});

	/** 1) 拦住手动 poll：一个文件只能有一个 listener，扩展在监听时不必也不该手跑。 */
	pi.on("tool_call", async (event, ctx) => {
		lastCtx = ctx;
		if (!isToolCallEventType("bash", event)) return;
		const invocation = parseInvocation(event.input.command);
		if (!invocation?.file || invocation.sub !== "poll") return;

		const file = absolutize(invocation.file, ctx.cwd);
		// 还没接管就先接管，再拦：一个文件只能有一个 listener。
		const watcher = ownedWatcher(file) ?? ensureWatcher(file, ctx);
		const state = watcher.connected ? "已连接" : `连接中${watcher.lastError ? `（最近错误：${watcher.lastError}）` : ""}`;
		return {
			block: true,
			reason:
				`pi-lavish 扩展正在监听 ${file}（${state}），不要手动 poll —— ` +
				`同一文件只能有一个 listener，手跑会拿到 LISTENER_ACTIVE 或把对方的 poll 顶掉。\n` +
				`现在直接结束本回合即可：用户点 Send 时，反馈会自动作为新消息唤醒你。\n` +
				`改完产物用 \`npx -y lavish-axi reply ${file} --agent-reply "..."\` 提交回执，监听会自动续上。\n` +
				`确实需要前台阻塞轮询时，先让别人执行 /lavish-stop ${file} 停掉扩展监听，再重跑 poll。`,
		};
	});

	/** 2) 看到 agent 打开了会话 → 自动开始监听。 */
	pi.on("tool_result", async (event, ctx) => {
		lastCtx = ctx;
		if (!isBashToolResult(event)) return;
		if (event.isError) return;
		if (typeof event.input?.command !== "string") return;

		const invocation = parseInvocation(event.input.command);
		if (!invocation?.file || !OPEN_LIKE.has(invocation.sub)) return;

		// 只在 CLI 真的报出了会话时接管（`status: opened` 或恢复成功）。
		const output = event.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (!/lavish|lavish-axi/i.test(output)) return;
		if (!/"(opened|resumed)"/.test(output) && !/status:\s*(opened|resumed)/.test(output)) return;

		const file = absolutize(invocation.file, ctx.cwd);
		ensureWatcher(file, ctx);
		notify(ctx, `lavish: 已接管 ${file} 的反馈监听（用户点 Send 时自动唤醒）`);
	});

	/** 3) 提交回执（reply / poll --agent-reply）后立刻续上监听。 */
	pi.on("tool_result", async (event, ctx) => {
		lastCtx = ctx;
		if (!isBashToolResult(event)) return;
		if (event.isError) return;
		if (typeof event.input?.command !== "string") return;
		const invocation = parseInvocation(event.input.command);
		if (!invocation?.file) return;
		if (invocation.sub !== "reply" && invocation.sub !== "end") return;

		const file = absolutize(invocation.file, ctx.cwd);
		if (invocation.sub === "end") {
			stopWatcher(file, ctx);
			return;
		}
		const watcher = watchers.get(file);
		if (watcher && watcher.phase === "waiting-for-turn") {
			// 立即让等待者返回，不必等 agent_settled。
			for (const waiter of [...settleWaiters]) waiter();
		}
		refreshStatus(ctx);
	});

	// -- 命令与工具 ----------------------------------------------------------

	pi.registerCommand("lavish-status", {
		description: "显示 pi-lavish 正在监听哪些 Lavish 会话",
		handler: async (_args, ctx) => {
			if (watchers.size === 0) {
				ctx.ui.notify("pi-lavish: 当前没有在监听任何会话", "info");
				return;
			}
			const rows = [...watchers.values()].map((w) => {
				const bits = [w.connected ? "已连接" : "连接中", w.phase, `已交付 ${w.deliveredRounds} 轮`];
				if (w.lastError) bits.push(`err=${w.lastError}`);
				return `${w.file} — ${bits.join(", ")}`;
			});
			ctx.ui.notify(`pi-lavish:\n${rows.join("\n")}`, "info");
		},
	});

	pi.registerCommand("lavish-watch", {
		description: "手动开始监听某个 HTML 产物的 Lavish 反馈：/lavish-watch <file>",
		handler: async (args, ctx) => {
			const file = absolutize(args.trim(), ctx.cwd);
			if (!file) {
				ctx.ui.notify("用法：/lavish-watch <html-file>", "warning");
				return;
			}
			ensureWatcher(file, ctx);
			ctx.ui.notify(`pi-lavish: 开始监听 ${file}`, "info");
		},
	});

	pi.registerCommand("lavish-stop", {
		description: "停止监听：/lavish-stop [file]（省略则全部停止）",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) {
				const count = watchers.size;
				stopAll();
				refreshStatus(ctx);
				ctx.ui.notify(`pi-lavish: 已停止 ${count} 个监听`, "info");
				return;
			}
			const file = absolutize(raw, ctx.cwd);
			const stopped = stopWatcher(file, ctx);
			ctx.ui.notify(stopped ? `pi-lavish: 已停止监听 ${file}` : `pi-lavish: 没有在监听 ${file}`, "info");
		},
	});

	pi.registerTool({
		name: "lavish_watch",
		label: "Lavish watch",
		description:
			"管理 pi-lavish 对某个 HTML 产物的反馈监听。start: 开始后台长轮询（用户点 Send 时自动唤醒新回合）；" +
			"stop: 停止；status: 查看状态。用 `lavish-axi <file>` 打开会话后会自动监听，通常不需要手动调用。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("status")], {
				description: "start / stop / status",
			}),
			file: Type.Optional(Type.String({ description: "HTML 产物路径（start/stop 必填）" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action;
			if (action === "status") {
				if (watchers.size === 0) return { content: [{ type: "text", text: "pi-lavish: 未监听任何会话" }], details: {} };
				const rows = [...watchers.values()].map(
					(w) =>
						`${w.file} | ${w.connected ? "连接中" : "未连接"} | ${w.phase} | rounds=${w.deliveredRounds}${
							w.lastError ? ` | err=${w.lastError}` : ""
						}`,
				);
				return { content: [{ type: "text", text: rows.join("\n") }], details: {} };
			}

			const raw = params.file?.trim();
			if (!raw) {
				return {
					content: [{ type: "text", text: `lavish_watch ${action} 需要 file 参数` }],
					isError: true,
					details: {},
				};
			}
			const file = absolutize(raw, ctx.cwd);

			if (action === "start") {
				const watcher = ensureWatcher(file, ctx);
				return {
					content: [
						{
							type: "text",
							text:
								`已开始监听 ${file}（${watcher.connected ? "已连接" : "连接中"}）。` +
								"不要手动 poll；用户点 Send 时反馈会作为新消息唤醒你。",
						},
					],
					details: {},
				};
			}

			const stopped = stopWatcher(file, ctx);
			return {
				content: [{ type: "text", text: stopped ? `已停止监听 ${file}` : `没有在监听 ${file}` }],
				details: {},
			};
		},
	});
}
