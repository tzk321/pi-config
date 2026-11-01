/**
 * ttft-status — 状态栏显示"每次模型请求"的首字用时（TTFT）。
 *
 * 口径：pi 的 turn 是一次模型请求（turn_start -> 一次 assistant 响应 + 其工具调用）。
 * 因此工具调用之后的下一次请求会重新计时，而不是整个用户消息只算一次。
 * 计时起点是 turn_start（请求发出前），终点是第一个 message_update（首个 token/delta）。
 *
 * 与 pi-token-speed 分工：那边用 display:"tps" 只管 TPS，这边只管 TTFT。
 * 用 /ttft 切换显示。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "ttft";

function formatMs(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms)}ms`;
}

export default function (pi: ExtensionAPI) {
	/** 当前请求的计时起点；null 表示没有进行中的请求。 */
	let turnStart: number | null = null;
	/** 本轮是否已经拿到首字。 */
	let measured = false;
	/** 最近一次测得的 TTFT，用于在等待期间保留旧数字。 */
	let lastMs: number | null = null;
	let enabled = true;

	function paint(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const value = !measured && turnStart !== null
			? theme.fg("dim", "…")
			: theme.fg("accent", lastMs === null ? "--" : formatMs(lastMs));
		ctx.ui.setStatus(STATUS_KEY, `${theme.fg("dim", "TTFT")} ${value}`);
	}

	pi.on("turn_start", (_event, ctx) => {
		turnStart = performance.now();
		measured = false;
		paint(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		if (measured || turnStart === null) return;
		if (event.message.role !== "assistant") return;
		lastMs = performance.now() - turnStart;
		measured = true;
		paint(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		// 没拿到任何 delta 就结束了（报错/中止），别把状态卡在 "…" 上。
		if (measured) return;
		measured = true;
		paint(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		turnStart = null;
		measured = true;
		paint(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (enabled) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("ttft", {
		description: "Toggle the TTFT status item",
		handler: async (_args: string, ctx: ExtensionContext) => {
			enabled = !enabled;
			paint(ctx);
			ctx.ui.notify(`TTFT status ${enabled ? "on" : "off"}`, "info");
		},
	});
}
