/**
 * image-paste-preview — 粘贴图片的内联预览（kitty / iTerm2 图形协议）。
 *
 * 背景：往 pi 里粘贴图片时，pi 只会把剪贴板内容存成 /tmp/pi-clipboard-*.png 并把路径
 * 以纯文本插进编辑器，终端上看不到图。
 *
 * 本扩展做两件事：
 *  1. 输入阶段：编辑器里出现图片路径（粘贴或手打）时，在输入框上方实时预览，清空即消失；
 *  2. 发送之后：在该条用户消息下面追加一张图片卡片，滚屏/重启会话后仍在。
 *     卡片是 custom entry，只做渲染、不参与 LLM 上下文（appendEntry 不发给模型）。
 *
 * 终端不支持图形协议时全部退化为不动状；单张限制宽 40 列 / 高 12 行，一次最多 3 张。
 * 限制：路径里不能有空格（纯文本扫描，不做 shell 转义解析）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { convertToPng, keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, getCapabilities, Image, Text, type TUI } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "image-paste-preview";
const WIDGET_KEY = "image-paste-preview";
const MAX_PREVIEWS = 3;
const MAX_WIDTH_CELLS = 40;
const MAX_HEIGHT_CELLS = 12;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEBOUNCE_MS = 60;

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
};

/** 编辑器文本里的候选 token：排除空白与引号、括号、分隔符等包裹字符。 */
const TOKEN_RE = /[^\s'"`<>|()[\]{},;]+/g;

type UiTheme = ExtensionContext["ui"]["theme"];

interface PreparedImage {
	/** base64 编码的图片数据（PNG，或转码失败时的原始格式）。 */
	data: string;
	mimeType: string;
	label: string;
}

interface ImageCardData {
	paths: string[];
}

/** 已解码/转码的图片缓存：渲染器是同步的，未命中时才回落到同步读 PNG。 */
const preparedImages = new Map<string, PreparedImage>();

function formatBytes(size: number): string {
	if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
	if (size >= 1024) return `${Math.round(size / 1024)} KB`;
	return `${size} B`;
}

/** 从文本里挑出真实存在的图片文件（绝对路径、去重、最多 MAX_PREVIEWS 个）。 */
function findImagePaths(text: string, cwd: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(TOKEN_RE)) {
		const token = match[0].startsWith("file://") ? match[0].slice("file://".length) : match[0];
		if (!MIME_BY_EXT[extname(token).toLowerCase()]) continue;
		const absPath = isAbsolute(token) ? token : resolve(cwd, token);
		if (!existsSync(absPath)) continue;
		if (!found.includes(absPath)) found.push(absPath);
		if (found.length >= MAX_PREVIEWS) break;
	}
	return found;
}

/** 读文件并按需要转成 PNG（kitty 协议只吃 PNG）。转码失败时返回原数据，交给 Image 退化为文本。 */
async function prepareImage(absPath: string): Promise<PreparedImage | null> {
	const mimeType = MIME_BY_EXT[extname(absPath).toLowerCase()];
	if (!mimeType) return null;

	const info = await stat(absPath).catch(() => null);
	if (!info?.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return null;

	const bytes = await readFile(absPath).catch(() => null);
	if (!bytes) return null;

	const data = bytes.toString("base64");
	const label = `${basename(absPath)} · ${formatBytes(info.size)}`;
	let prepared: PreparedImage = { data, mimeType, label };
	if (mimeType !== "image/png") {
		const converted = await convertToPng(data, mimeType).catch(() => null);
		if (converted) prepared = { data: converted.data, mimeType: converted.mimeType, label };
	}
	preparedImages.set(absPath, prepared);
	return prepared;
}

/** 渲染器里用：先查缓存，未命中（例如重启会话后重放历史）就同步同步读 PNG。 */
function getPreparedSync(absPath: string): PreparedImage | null {
	const cached = preparedImages.get(absPath);
	if (cached) return cached;

	const mimeType = MIME_BY_EXT[extname(absPath).toLowerCase()];
	if (mimeType !== "image/png") return null;
	try {
		const info = statSync(absPath);
		if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return null;
		const prepared: PreparedImage = {
			data: readFileSync(absPath).toString("base64"),
			mimeType,
			label: `${basename(absPath)} · ${formatBytes(info.size)}`,
		};
		preparedImages.set(absPath, prepared);
		return prepared;
	} catch {
		return null;
	}
}

function imageThemeOf(theme: UiTheme) {
	return { fallbackColor: (text: string) => theme.fg("muted", text) };
}

function previewWidget(previews: PreparedImage[], theme: UiTheme): Container {
	const container = new Container();
	const imageTheme = imageThemeOf(theme);
	for (const preview of previews) {
		container.addChild(new Text(theme.fg("muted", `🖼  ${preview.label}`), 1, 0));
		container.addChild(
			new Image(preview.data, preview.mimeType, imageTheme, {
				maxWidthCells: MAX_WIDTH_CELLS,
				maxHeightCells: MAX_HEIGHT_CELLS,
				filename: preview.label,
			}),
		);
	}
	return container;
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** 当前已渲染的路径集合，避免重复重建组件。 */
	let lastSignature = "";
	/** 递增标记，用来丢弃过期的异步渲染结果。 */
	let renderToken = 0;
	/** 已提交、等本轮 turn 开始时落卡的图片路径。 */
	let pendingCardPaths: string[] = [];

	function cancelPending(): void {
		if (!timer) return;
		clearTimeout(timer);
		timer = null;
	}

	function clearWidget(): void {
		renderToken += 1;
		lastSignature = "";
		ctx?.ui.setWidget(WIDGET_KEY, undefined);
	}

	async function syncWidget(): Promise<void> {
		const active = ctx;
		if (!active) return;
		if (!getCapabilities().images) return;

		const paths = findImagePaths(active.ui.getEditorText() ?? "", active.cwd);
		const signature = paths.join("\n");
		if (signature === lastSignature) return;
		lastSignature = signature;

		if (paths.length === 0) {
			clearWidget();
			return;
		}

		const token = ++renderToken;
		const previews = (await Promise.all(paths.map(prepareImage))).filter(
			(preview): preview is PreparedImage => preview !== null,
		);
		if (token !== renderToken || !ctx) return;
		if (previews.length === 0) {
			clearWidget();
			return;
		}

		ctx.ui.setWidget(WIDGET_KEY, (_tui: TUI, theme: UiTheme) => previewWidget(previews, theme), {
			placement: "aboveEditor",
		});
	}

	function schedule(): void {
		cancelPending();
		timer = setTimeout(() => {
			timer = null;
			void syncWidget();
		}, DEBOUNCE_MS);
	}

	function appendImageCard(paths: string[]): void {
		if (!getCapabilities().images) return;
		pi.appendEntry<ImageCardData>(ENTRY_TYPE, { paths });
	}

	// 发出去之后的图片卡片：custom entry 只渲染、不进 LLM 上下文。
	pi.registerEntryRenderer<ImageCardData>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const paths = entry.data?.paths ?? [];
		if (paths.length === 0) return new Text(theme.fg("muted", "🖼  （无图片）"), 0, 0);

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const imageTheme = imageThemeOf(theme);
		for (const absPath of paths) {
			const prepared = getPreparedSync(absPath);
			if (!prepared) {
				box.addChild(new Text(theme.fg("muted", `🖼  ${basename(absPath)} · 文件已不存在，无法预览`), 0, 0));
				if (expanded) box.addChild(new Text(theme.fg("dim", absPath), 0, 0));
				continue;
			}
			box.addChild(new Text(`🖼  ${prepared.label}`, 0, 0));
			if (expanded) box.addChild(new Text(theme.fg("dim", absPath), 0, 0));
			box.addChild(
				new Image(prepared.data, prepared.mimeType, imageTheme, {
					maxWidthCells: MAX_WIDTH_CELLS,
					maxHeightCells: MAX_HEIGHT_CELLS,
					filename: prepared.label,
				}),
			);
		}
		if (!expanded) box.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", "查看路径")), 0, 0));
		return box;
	});

	pi.on("session_start", (_event, context) => {
		ctx = context;
		pendingCardPaths = [];
		clearWidget();
		cancelPending();
		// 输入监听是同步钩子，这里只做去抖，不消费输入。
		context.ui.onTerminalInput(() => {
			schedule();
			return undefined;
		});
	});

	pi.on("session_shutdown", () => {
		cancelPending();
		clearWidget();
		pendingCardPaths = [];
		ctx = null;
	});

	pi.on("input", (event, context) => {
		// 提交后编辑器被清空，实时预览收起；图片则等用户消息落库后再落卡。
		cancelPending();
		clearWidget();
		// 流式期间的输入会排队，排队消息同样会触发 message_end，统一在那里落卡
		pendingCardPaths = findImagePaths(event.text ?? "", context.cwd);
	});

	// message_end 在 session 落库之前派发，推到下一个宏任务再写，卡片才会落在用户消息下方。
	pi.on("message_end", (event) => {
		if (event.message?.role !== "user") return;
		if (pendingCardPaths.length === 0) return;
		const paths = pendingCardPaths;
		pendingCardPaths = [];
		setTimeout(() => appendImageCard(paths), 0);
	});
}
