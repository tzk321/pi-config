/**
 * Rounded transparent frames for the message boxes pi draws outside tool
 * calls: compaction / branch / skill summaries, extension custom messages and
 * (opt-in) user messages.
 *
 * Options live in global slots (see live.ts): every call updates them, and only
 * the first one installs the prototype patches, so a `/reload` with different
 * settings — including `frameMessages: false` — takes effect without a restart.
 */

import {
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  SkillInvocationMessageComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { drawFrame, sameLines, stripBackgroundFills, trimBlankEdges } from "./frame-draw.ts";
import { MESSAGE_ICONS } from "./icons.ts";
import { liveSlot, tidyEnabled } from "./live.ts";
import { getTheme } from "./theme-access.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Message boxes (compaction / branch summary)
// ═══════════════════════════════════════════════════════════════════════════

interface MessageBoxInternals {
  children: Array<{ render(width: number): string[] }>;
  expanded: boolean;
  render(width: number): string[];
  __msgFrameCache?: { width: number; sample: string; icons: boolean; lines: string[]; out: string[] };
}

interface MessageBoxOptions {
  enabled: boolean;
  borderColors: { compaction: string; branch: string; skill: string };
  icons: boolean;
}

const messageOptions = liveSlot<MessageBoxOptions | undefined>("message-box-options", undefined);

/**
 * Compaction, branch-summary, and skill-invocation boxes are plain `Box`es
 * with a filled `customMessageBg` background — ToolExecutionComponent never
 * sees them, so the tool frame patch leaves them in pi's default style. They
 * get the same rounded, transparent frame here, each drawn in its own color
 * from `borderColors` to keep them distinct from the tool state colors and
 * from each other. Children are rendered directly, skipping the Box's
 * background fill and padding, so the frame is the only chrome; on any
 * mismatch the original Box render runs.
 *
 * `enabled: false` turns installed patches into pass-throughs and installs
 * nothing new.
 */
export function patchMessageBoxes(
  borderColors: { compaction: string; branch: string; skill: string },
  icons = false,
  enabled = true,
): void {
  messageOptions.set({ enabled, borderColors, icons });
  if (!enabled) return;
  for (const [cls, kind] of [
    [CompactionSummaryMessageComponent, "compaction"],
    [BranchSummaryMessageComponent, "branch"],
    [SkillInvocationMessageComponent, "skill"],
  ] as const) {
    const proto = cls.prototype as unknown as MessageBoxInternals & { __toolboxFramed?: boolean };
    if (proto.__toolboxFramed) continue;
    proto.__toolboxFramed = true;

    const originalRender = proto.render;
    const icon = MESSAGE_ICONS[kind];

    proto.render = function (this: MessageBoxInternals, width: number): string[] {
      const options = messageOptions.get();
      const theme = getTheme();
      if (!theme || !options?.enabled || !tidyEnabled.get()) return originalRender.call(this, width);
      try {
        const { icons } = options;
        const borderColor = options.borderColors[kind];
        const w = Math.max(4, width);
        // Frame + one cell of horizontal padding on each side (+2 for the icon).
        const contentWidth = Math.max(1, icons ? w - 6 : w - 4);
        const content: string[] = [];
        for (const child of this.children) {
          for (const line of child.render(contentWidth)) {
            content.push(stripBackgroundFills(line));
          }
        }
        if (content.length === 0) return [];
        // The border color escape acts as a theme sample — a theme switch
        // with identical content must not hit the cache.
        const sample = theme.fg(borderColor, "·");
        const cache = this.__msgFrameCache;
        if (
          cache &&
          cache.width === w &&
          cache.sample === sample &&
          cache.icons === icons &&
          sameLines(cache.lines, content)
        )
          return cache.out;
        const padded = content.map((line, i) => (icons && i === 0 ? ` ${icon} ${line}` : ` ${line}`));
        const out = ["", ...drawFrame(padded, w, theme, borderColor)];
        this.__msgFrameCache = { width: w, sample, icons, lines: content, out };
        return out;
      } catch {
        return originalRender.call(this, width);
      }
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Container boxes (user messages / extension custom messages)
// ═══════════════════════════════════════════════════════════════════════════

// OSC 133 zone markers UserMessageComponent puts on its first/last line —
// terminals use them for prompt navigation, so the framed output keeps them
// in the same positions.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

interface ContainerBoxInternals {
  children: Array<{ render(width: number): string[] }>;
  /** CustomMessageComponent's default box; absent on UserMessageComponent. */
  box?: { render(width: number): string[] };
  /** Set when an extension renderer supplies its own styled component. */
  customComponent?: unknown;
  render(width: number): string[];
  __msgFrameCache?: { width: number; sample: string; lines: string[]; out: string[] };
}

/**
 * User and extension custom messages are `Container`s whose visible box is an
 * inner `Box` with a filled background. The frame replaces that chrome: the
 * inner box renders one frame-width narrower, its background fills and
 * vertical padding rows are stripped, and the rounded border takes over —
 * the box's own horizontal padding is kept as the insets.
 */
export interface ContainerBoxOptions {
  icons?: boolean;
  /**
   * Frame user messages too. Default false: pi-starline already restyles
   * UserMessageComponent.prototype.render, and two render patches on the
   * same prototype fight over the output. Enable only without pi-starline.
   * While false, UserMessageComponent is not patched at all.
   */
  includeUser?: boolean;
  /** False turns installed patches into pass-throughs and installs nothing new. */
  enabled?: boolean;
}

interface ResolvedContainerOptions {
  enabled: boolean;
  borderColors: { user: string; custom: string };
  icons: boolean;
  includeUser: boolean;
}

const containerOptions = liveSlot<ResolvedContainerOptions | undefined>("container-box-options", undefined);

export function patchContainerBoxes(
  borderColors: { user: string; custom: string },
  options: ContainerBoxOptions = {},
): void {
  const { icons = false, includeUser = false, enabled = true } = options;
  containerOptions.set({ enabled, borderColors, icons, includeUser });
  if (!enabled) return;

  const patch = (cls: { prototype: unknown }, kind: "user" | "custom") => {
    const proto = cls.prototype as ContainerBoxInternals & { __toolboxFramed?: boolean };
    if (proto.__toolboxFramed) return;
    proto.__toolboxFramed = true;

    const originalRender = proto.render;
    const icon = MESSAGE_ICONS[kind];
    const isUserMessage = kind === "user";

    proto.render = function (this: ContainerBoxInternals, width: number): string[] {
      const live = containerOptions.get();
      const theme = getTheme();
      if (!theme || !live?.enabled || !tidyEnabled.get() || (isUserMessage && !live.includeUser)) {
        return originalRender.call(this, width);
      }
      try {
        // An extension's custom renderer owns its styling — never frame it.
        if (this.customComponent) return originalRender.call(this, width);
        const box = this.box ?? this.children[0];
        if (!box) return originalRender.call(this, width);

        const { icons } = live;
        const borderColor = live.borderColors[kind];
        const w = Math.max(4, width);
        // Icons take two cells of the first row; rendering the box narrower
        // keeps every line lossless.
        const raw = box.render(icons ? w - 4 : w - 2).map(stripBackgroundFills);
        const content = trimBlankEdges(raw);
        if (content.length === 0) return [];
        if (icons) content[0] = ` ${icon} ${content[0].replace(/^ +/, "")}`;

        const sample = theme.fg(borderColor, "·");
        const cache = this.__msgFrameCache;
        if (cache && cache.width === w && cache.sample === sample && sameLines(cache.lines, content))
          return cache.out;

        const out = ["", ...drawFrame(content, w, theme, borderColor)];
        if (isUserMessage) {
          out[0] = OSC133_ZONE_START + out[0];
          out[out.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
        }
        this.__msgFrameCache = { width: w, sample, lines: content, out };
        return out;
      } catch {
        return originalRender.call(this, width);
      }
    };
  };

  if (includeUser) patch(UserMessageComponent, "user");
  patch(CustomMessageComponent, "custom");
}
