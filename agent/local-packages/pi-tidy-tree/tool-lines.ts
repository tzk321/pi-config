/**
 * The two one-line views: the group summary (level 0) and a single tool row
 * (level 1). Pure string building — no component or pi state — so both are
 * cheap to render every frame and trivial to test.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { toolKindIcon } from "./icons.ts";
import type { ThemeLike } from "./theme-access.ts";
import type { JobState } from "./background-jobs.ts";
import type { GroupSummary } from "./tool-groups.ts";

export interface LineOptions {
  /** Prepend each tool's Nerd Font kind icon. */
  icons?: boolean;
  /** Cells the row may occupy, gutter excluded. Absent: a fixed argument budget. */
  width?: number;
  /** Group line only: the group is unfolded (`▾`) rather than folded (`▸`). */
  open?: boolean;
  /** Theme color for a thinking row (default `warning`). */
  thinkingColor?: string;
  /** The pointer is on this row: the glyph turns solid, a tool row gains a `›`. */
  hovered?: boolean;
  /** Group line: the glyph for running background jobs. Tool line: this job's.
   *  Thought line: replaces the brain while the run is still arriving. */
  spinner?: string;
  /** Tool line only: the background job this call started. */
  job?: JobState;
  /**
   * Tool line only: pad the metrics into columns so a group's rows line up
   * (`1 line` under `12 lines`, both durations ending at the same cell) and
   * the whole tail sits against the row's right edge.
   */
  align?: { note?: number; duration?: number };
}

const DEFAULT_MAX_ARG_CHARS = 60;
/**
 * Cells a row keeps for the command before the metrics give way. Below this the
 * numbers win nothing: `cd /tmp && gi…` says less than `51 lines · 1.6s` does.
 */
const MIN_ARG_CELLS = 12;

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

/** `▸ 4 calls ·  bash×3  read×1 · 1.2s` (`▾` while the group is open) */
export function formatGroupLine(summary: GroupSummary, theme: ThemeLike, options: LineOptions = {}): string {
  const { icons = true, open = false, hovered = false } = options;
  const glyph = open ? "▾" : hovered ? "▶" : "▸";
  const parts: string[] = [
    `${theme.fg("accent", glyph)} ${theme.fg("toolTitle", `${summary.count} ${summary.count === 1 ? "call" : "calls"}`)}`,
  ];

  const breakdown = summary.breakdown.map(({ name, count }) => {
    const icon = icons ? `${toolKindIcon(name)} ` : "";
    return theme.fg("muted", `${icon}${name}×${count}`);
  });
  if (breakdown.length > 0) parts.push(breakdown.join(theme.fg("muted", "  ")));

  // Folded, this is the *only* report that anything failed — no row hangs
  // below it — so it takes the red. Open, the rows below each carry their own
  // `✗` and the count goes quiet. No glyph of its own either way: `32 calls`
  // needs no cross beside it, the colour is the signal.
  if (summary.failed > 0) parts.push(theme.fg(open ? "muted" : "error", `${summary.failed} failed`));
  if (summary.thinking || summary.thoughts > 0) {
    // Folded, this is the only sign the reply did any thinking at all: the
    // carrier messages that hold it draw nothing until the group opens. While a
    // run is still arriving the entry says so — the frame set the job row spins
    // with, then the word, the way a running call reads — and the count comes
    // back once it stops. The spinner is the "still arriving" signal, so it does
    // not depend on Nerd Font icons; the static brain does.
    const live = summary.thinking;
    const glyph = live ? (options.spinner ?? "◐") : icons ? THOUGHT_ICON : "";
    const icon = glyph ? `${glyph} ` : "";
    parts.splice(
      parts.length - (summary.failed > 0 ? 1 : 0),
      0,
      theme.fg(options.thinkingColor ?? "warning", `${icon}${live ? "thinking" : plural(summary.thoughts, "thought")}`),
    );
  }
  if (summary.jobsRunning > 0) {
    parts.push(theme.fg("accent", `${options.spinner ?? "◐"} ${summary.jobsRunning} running`));
  }

  if (summary.running) {
    parts.push(theme.fg("warning", `running ${summary.running}`));
  } else if (summary.durationMs > 0) {
    parts.push(theme.fg("muted", formatDuration(summary.durationMs)));
  }

  return ` ${parts.join(theme.fg("muted", " · "))}`;
}

interface ToolLike {
  toolName: string;
  args?: unknown;
  isPartial: boolean;
  result?: { isError?: boolean; durationMs?: number; content?: unknown; details?: unknown };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The text blocks of a tool result, joined. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Lines of real output, pi's own notices excluded. */
function realLines(text: string): string[] {
  return text
    .split("\n")
    .filter(
      (line) =>
        line.trim() &&
        line.trim() !== "(no output)" &&
        !/^\[Showing /.test(line) &&
        !/^Command (exited with code|terminated)/.test(line),
    );
}

function outputLines(text: string, details: unknown): number {
  const total = (details as { truncation?: { truncated?: unknown; totalLines?: unknown } } | undefined)?.truncation;
  if (total?.truncated === true && typeof total.totalLines === "number") return total.totalLines;
  return realLines(text).length;
}

/**
 * A failure with nothing to read: the call exited non-zero and said nothing —
 * `sed` on a path that moved, a `test`, a probe. Those are mundane; a failure
 * whose output has actual text is where the red belongs. pi's own trailing
 * notices (`Command exited with code 1`, `(no output)`, the truncation line)
 * do not count as text, but a timeout or an abort does.
 */
export function isSilentFailure(result: ToolLike["result"]): boolean {
  if (!result || result.isError !== true) return false;
  return realLines(resultText(result.content)).length === 0;
}

/**
 * What a finished call produced, in a few words — the part of Claude Code's
 * `Read 120 lines` that makes a folded row worth reading. Built-in tools only;
 * anything else (MCP, extensions) gets no note rather than a wrong one.
 */
export function summarizeResult(toolName: string, result: ToolLike["result"]): string {
  if (!result) return "";
  const text = resultText(result.content);
  switch (toolName) {
    case "bash": {
      const code = /Command exited with code (\d+)/.exec(text)?.[1];
      if (result.isError) return code ? `exit ${code}` : "";
      const lines = outputLines(text, result.details);
      return lines > 0 ? plural(lines, "line") : "";
    }
    case "read":
      return result.isError ? "" : plural(outputLines(text, result.details), "line");
    case "grep":
      if (result.isError) return "";
      return text.trim() === "No matches found" ? "no matches" : plural(outputLines(text, result.details), "match", "matches");
    case "find":
      if (result.isError) return "";
      return /^No files found/.test(text.trim()) ? "no files" : plural(outputLines(text, result.details), "file");
    case "ls":
      if (result.isError) return "";
      return text.trim() === "(empty directory)" ? "empty" : plural(outputLines(text, result.details), "entry", "entries");
    default:
      return "";
  }
}

/**
 * The one-string description of a call's arguments, split: the first line of a
 * shell command (or a path / pattern / first stringish argument), and the
 * ` (+12 lines)` marker that rides behind it. Kept apart because a narrow row
 * has to decide what to spend cells on — the marker is the first thing to go.
 */
function argParts(args: unknown): { text: string; suffix: string } {
  if (!args || typeof args !== "object") return { text: "", suffix: "" };
  const record = args as Record<string, unknown>;

  const command = typeof record.command === "string" ? record.command : undefined;
  if (command) return oneLine(command);

  for (const key of ["path", "file_path", "filePath", "pattern", "url", "query"]) {
    const value = record[key];
    if (typeof value === "string" && value) return oneLine(value);
  }

  for (const value of Object.values(record)) {
    if (typeof value === "string" && value) return oneLine(value);
  }
  return { text: "", suffix: "" };
}

/**
 * One row means one line, for every argument — not just `command`.
 *
 * A row is a single string in the lines array the renderer hands back, so a
 * multi-line value (a script, a file body, anything an MCP tool takes) used to
 * come through with real newlines in it. The terminal then drew three physical
 * rows where pi's frame counted one, and every row below it — the status
 * spinner included — painted two rows off, leaving fragments of the previous
 * frame behind. A multi-line value keeps its first line and counts the rest.
 */
function oneLine(value: string): { text: string; suffix: string } {
  const [first, ...rest] = value.split("\n");
  return { text: first.trim(), suffix: rest.length > 0 ? ` (+${rest.length} lines)` : "" };
}

/**
 * The one-string description of a call's arguments: a shell command's first
 * line, a file's path, or the first stringish argument it can find.
 */
export function summarizeArgs(toolName: string, args: unknown, maxWidth = DEFAULT_MAX_ARG_CHARS): string {
  const { text, suffix } = argParts(args);
  return text ? `${truncateToWidth(text, maxWidth, "…")}${suffix}` : "";
}

/** `running 12s · READY matched` / `exited 0 · 20s` / `killed SIGTERM · 3s` */
export function describeJob(job: JobState, now = Date.now()): string {
  const end = job.status === "running" ? now : job.endTime;
  const took = job.startTime !== undefined && end !== undefined ? formatElapsed(end - job.startTime) : "";
  const parts: string[] = [];
  switch (job.status) {
    case "running":
      parts.push(took ? `running ${took}` : "running");
      break;
    case "done":
      parts.push(`exited ${job.exitCode ?? 0}`);
      break;
    case "failed":
      parts.push(typeof job.exitCode === "number" ? `exit ${job.exitCode}` : "failed");
      break;
    case "killed":
      parts.push(job.signal ? `killed ${job.signal}` : "killed");
      break;
    case "gone":
      return "not running";
  }
  if (job.status !== "running" && took) parts.push(took);
  if (job.note) parts.push(job.note);
  return parts.join(" · ");
}

/** Whole seconds, then minutes: `12s`, `3m05s`, `1h02m`. */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${(seconds % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60).toString().padStart(2, "0")}m`;
}

/** ` ✓ bash cd ~ && python3 - <<'PY' (+26 lines)  3 lines · 0.1s` */
export function formatToolLine(tool: ToolLike, theme: ThemeLike, options: LineOptions = {}): string {
  const { icons = true, job, width } = options;
  if (job) return formatJobLine(tool, job, theme, icons, options.spinner);
  const { isPartial } = tool;
  const isError = !isPartial && tool.result?.isError === true;
  // A silent failure keeps its red glyph and drops the rest to `dim`: it is
  // still visibly a failure, but it stops competing with the reply's text.
  const silent = isSilentFailure(tool.result);
  const body = silent ? "dim" : undefined;

  const status = isPartial
    ? theme.fg("muted", "⋯")
    : isError
      ? theme.fg("error", "✗")
      : theme.fg("success", "✓");

  const icon = icons ? `${toolKindIcon(tool.toolName)} ` : "";
  const head = ` ${status} ${theme.fg(body ?? "toolTitle", `${icon}${tool.toolName}`)}`;
  const { text, suffix } = argParts(tool.args);

  // `  12 lines · 0.3s` — what it produced, then how long it took.
  const note = isPartial ? "" : summarizeResult(tool.toolName, tool.result);
  const durationMs = tool.result?.durationMs;
  const duration = !isPartial && typeof durationMs === "number" && durationMs > 0 ? formatDuration(durationMs) : "";
  const paint = (value: string) => theme.fg(body ?? "muted", value);
  // Padding is outside the colour, so the columns line up whatever the theme
  // does to the text.
  const notePad = Math.max(0, (options.align?.note ?? 0) - visibleWidth(note));
  const durationPad = Math.max(0, (options.align?.duration ?? 0) - visibleWidth(duration));
  const tail = [
    note ? " ".repeat(notePad) + paint(note) : "",
    duration ? " ".repeat(durationPad) + paint(duration) : "",
  ].filter(Boolean);
  const hint = options.hovered ? theme.fg("muted", "  ›") : "";

  // Before the width was known the row took a fixed 60 cells of arguments and
  // let `truncateToWidth` cut the end off afterwards — which on a narrow
  // terminal meant the metrics went first and the command kept a ragged stub.
  if (typeof width !== "number") {
    const detail = text ? theme.fg(body ?? "toolOutput", ` ${summarizeArgs(tool.toolName, tool.args)}`) : "";
    const tailText = tail.length > 0 ? `  ${tail.join(theme.fg("muted", " · "))}` : "";
    return `${head}${detail}${tailText}${hint}`;
  }

  const fixed = visibleWidth(head) + 1 /* the space before the arguments */ + visibleWidth(hint);
  const tailText = tail.length > 0 ? `  ${tail.join(theme.fg("muted", " · "))}` : "";
  // The metrics only take what is left over, and step aside entirely when
  // paying for them would leave nothing readable of the command.
  const keepTail = tailText !== "" && width - fixed - visibleWidth(tailText) >= MIN_ARG_CELLS;
  let budget = width - fixed - (keepTail ? visibleWidth(tailText) : 0);
  let shownSuffix = suffix;
  if (budget - visibleWidth(suffix) < MIN_ARG_CELLS) {
    // `(+12 lines)` is a nicety; the command is not.
    shownSuffix = "";
    budget += visibleWidth(suffix);
  }
  const shown = text && budget > 1 ? truncateToWidth(text, budget - visibleWidth(shownSuffix), "…") : "";
  const detail = shown ? theme.fg(body ?? "toolOutput", ` ${shown}${shownSuffix}`) : "";
  if (!keepTail) return `${head}${detail}${hint}`;
  // Only a caller that asked for columns gets the right edge; a row rendered on
  // its own keeps the metrics where they belong, right after the arguments.
  const gap = options.align
    ? width - visibleWidth(head) - visibleWidth(detail) - visibleWidth(hint) - visibleWidth(tailText)
    : 0;
  return `${head}${detail}${gap > 0 ? " ".repeat(gap) : ""}${tailText}${hint}`;
}

/** The `│` that runs down the left of an open group, under its `▾`. */
export function groupGutter(theme: ThemeLike): string {
  return ` ${theme.fg("borderMuted", "│")}`;
}

/**
 * A thinking run as one line: the brain in the thinking colour, the label, then
 * as much of the text as fits. `previewText` does the measuring so the row
 * itself stays a pure string.
 */
export function formatThoughtLine(text: string, theme: ThemeLike, options: LineOptions = {}): string {
  const color = options.thinkingColor ?? "warning";
  // A thought row outside a group has no summary line above it to spin, so the
  // row carries the frame set itself: "still arriving" has to be visible
  // without opening anything. The spinner needs no Nerd Font; the brain does.
  const glyph = options.spinner ?? (options.icons === false ? "" : THOUGHT_ICON);
  const icon = glyph ? `${glyph} ` : "";
  const label = theme.fg(color, `${icon}thinking`);
  const body = theme.fg("thinkingText", text);
  const row = ` ${label}  ${body}`;
  return theme.italic ? theme.italic(row) : row;
}

/**
 * `nf-md-brain`. Not the emoji 🧠: it is absent from every monospace Nerd Font
 * and falls back to a two-cell colour glyph, which breaks the row's alignment.
 */
export const THOUGHT_ICON = "\u{f09d1}";

/** Cells the `🧠 thinking` label takes on a row: brain + space + the word + two spaces. */
export const THOUGHT_LABEL_CELLS = 2 + "thinking".length + 2;

/**
 * A thinking preview is a glance, not a paragraph. Past this many cells the row
 * stops being one item among the calls and starts reading as prose wedged into
 * the list — the whole row for a line of text the reader has to decide to skip.
 */
export const THOUGHT_PREVIEW_CELLS = 56;

/**
 * How often a live thinking row is allowed to change. pi repaints ~30x/s while
 * streaming, so a window recomputed every frame slides one cell per token and
 * the line never holds still; this turns it into a tick.
 */
export const THOUGHT_TICK_MS = 300;

/**
 * A thinking run squeezed onto one row. Measured in cells (`truncateToWidth`),
 * not in characters: a CJK run is two cells a glyph.
 */
export function previewText(text: string, maxWidth: number, tail = false): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // A run that is still arriving owns the row — it is the live feed. A settled
  // one is a glance and stays short.
  const budget = tail ? maxWidth : Math.min(maxWidth, THOUGHT_PREVIEW_CELLS);
  if (budget <= 1) return "";
  if (!tail) return truncateToWidth(flat, budget, "…");
  // A run that is still arriving reads as a sliding window over its tail: the
  // newest words are the interesting ones, and the row stays one line. The cut
  // lands on a word break, so the window does not shave half a word off — that
  // shaving is what made the line look like it was shaking.
  let out = flat;
  for (let i = 0; i < flat.length && visibleWidth(out) > budget - 1; i++) {
    out = out.slice(Math.max(1, Math.ceil(out.length / 8)));
  }
  if (out.length >= flat.length) return flat;
  const breakAt = out.indexOf(" ");
  if (breakAt > 0 && breakAt < out.length - 1) out = out.slice(breakAt + 1);
  return `…${truncateToWidth(out, budget - 1)}`;
}

/** Cells `groupGutter` takes. */
export const GUTTER_CELLS = 2;

/** A call that started a background job: the row tracks the job, not the call. */
export function formatJobLine(tool: ToolLike, job: JobState, theme: ThemeLike, icons: boolean, spinner = "◐"): string {
  const status =
    job.status === "running"
      ? theme.fg("accent", spinner)
      : job.status === "done"
        ? theme.fg("success", "✓")
        : job.status === "failed"
          ? theme.fg("error", "✗")
          : theme.fg("muted", "⊘");
  const icon = icons ? `${toolKindIcon(tool.toolName)} ` : "";
  const name = theme.fg("toolTitle", `${icon}${tool.toolName}`);
  const color = job.status === "failed" ? "error" : job.status === "running" ? "warning" : "muted";
  return ` ${status} ${name}${theme.fg("toolOutput", ` ${job.name.replace(/\s+/g, " ")}`)}  ${theme.fg(color, describeJob(job).replace(/\s+/g, " "))}`;
}

export { formatDuration };
