import {
  UserMessageComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

// Pi 1.4 exports the component, but has no public transcript-menu hook.
// Keep this version-sensitive adapter isolated; never change Pi's files.
type MouseHandler = (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

export default function messageEdit(pi: ExtensionAPI) {
  let active: ExtensionContext | undefined;
  let restore: (() => void) | undefined;
  let opening = false;
  let clickedIds: string[] | undefined;

  function candidates(ctx: ExtensionContext) {
    return ctx.sessionManager.getBranch().flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      const content = entry.message.content;
      let text: string;
      if (typeof content === "string") text = content;
      else text = content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      return [{ id: entry.id, text, timestamp: entry.timestamp,
        hasImages: typeof content !== "string" && content.some((part) => part.type === "image") }];
    });
  }

  function ready(ctx: ExtensionContext): boolean {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      ctx.ui.notify("请先结束当前任务并处理待发消息，再编辑分叉。", "warning");
      return false;
    }
    return true;
  }

  async function edit(args: string, ctx: ExtensionCommandContext) {
    if (ctx.mode !== "tui" || !ready(ctx)) return;
    const requested = args.trim();
    // Mouse routing never uses prompt text as a command argument.
    const ids = requested === "clicked" ? clickedIds : undefined;
    clickedIds = undefined;
    if (requested === "clicked" && !ids) return;
    let entries = candidates(ctx);
    if (ids) entries = entries.filter((entry) => ids.includes(entry.id));
    if (!entries.length) {
      ctx.ui.notify("没有可编辑的用户消息。", "warning");
      return;
    }
    let selected = entries.length === 1 && ids ? entries[0] : undefined;
    if (!selected) {
      // Equal text is deliberately disambiguated rather than guessing an entry ID.
      const options = entries.map((entry, index) =>
        `${index + 1}. ${entry.timestamp} · ${entry.text.replace(/\s+/g, " ").slice(0, 90)}`);
      const choice = await ctx.ui.select("选择消息：编辑并 fork", options);
      if (choice === undefined) return;
      selected = entries[options.indexOf(choice)];
    }
    if (!selected) return;
    const action = await ctx.ui.select("消息操作（不会回滚文件）", ["编辑并 fork", "取消"]);
    if (action !== "编辑并 fork") return;
    if (selected.hasImages && !await ctx.ui.confirm("附件提示", "原生 fork 只将文字放回输入框，图片需要重新附加。继续？")) return;
    if (ctx.ui.getEditorText().trim() && !await ctx.ui.confirm("输入框有草稿", "分叉会用原消息替换草稿，请先取消并暂存草稿，或确认替换。")) return;
    // Re-check after asynchronous dialogs, before any session mutation.
    if (!ready(ctx) || !ctx.sessionManager.getBranch().some((entry) => entry.id === selected.id)) return;
    // Native fork creates the new session and restores selectedText itself.
    // Its runtime replacement invalidates ctx: do not touch old state afterward.
    await ctx.fork(selected.id, { position: "before" });
  }

  pi.registerCommand("message-edit", {
    description: "编辑历史用户消息并原生 fork（保留原会话，不回滚文件）",
    handler: async (args, ctx) => {
      if (opening) return;
      opening = true;
      try { await edit(args, ctx); }
      finally { opening = false; }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    active = ctx;
    const prototype = UserMessageComponent.prototype;
    const own = Object.getOwnPropertyDescriptor(prototype, "handleMouse");
    const previous: MouseHandler | undefined = prototype.handleMouse;
    function handleMouse(this: UserMessageComponent, event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.type !== "press" || event.button !== "right" || !active) {
        return previous?.call(this, event);
      }
      if (opening) return { handled: true, render: false };
      if (!ready(active)) return { handled: true, render: false };
      // SAFETY: Pi 1.4 UserMessageComponent stores its rendered source in text.
      // Read as unknown and validate below; fail closed if Pi changes it.
      const text = (this as unknown as { text?: unknown }).text;
      if (typeof text !== "string") {
        active.ui.notify("当前 Pi 消息组件不兼容，请使用 /message-edit。", "warning");
        return { handled: true, render: false };
      }
      const matches = candidates(active).filter((entry) => entry.text === text);
      if (!matches.length) {
        active.ui.notify("无法可靠定位此消息（可能是技能展开），请使用 /message-edit。", "warning");
        return { handled: true, render: false };
      }
      clickedIds = matches.map((entry) => entry.id);
      // Dispatch through the command path to obtain a fresh command-capable
      // context; no forged context, no model request, no direct session writes.
      pi.sendUserMessage("/message-edit clicked", { expandPromptTemplates: true });
      return { handled: true, render: false };
    }
    prototype.handleMouse = handleMouse;
    restore = () => {
      if (prototype.handleMouse !== handleMouse) return;
      if (own) Object.defineProperty(prototype, "handleMouse", own);
      else Reflect.deleteProperty(prototype, "handleMouse");
    };
  });

  pi.on("session_shutdown", () => {
    restore?.();
    restore = undefined;
    active = undefined;
    clickedIds = undefined;
  });
}
