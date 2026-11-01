/**
 * Presentation-only ls/find/grep views, inspired by pi-pretty's renderTree,
 * renderFindResults and renderGrepResults (MIT, huynhgiabuu).
 * Reference: heyhuynhgiabuu/pi-pretty@db4661e832a46626e543b75d54d2aa69e324e717.
 * Reuses Tidy icons and Pi's public renderer API; never changes execution/results.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { fileIcon, TOOL_ICONS } from "./icons.ts";

export type TreeTool = "ls" | "find" | "grep";
export interface TreeOptions {
  icons: boolean;
  expanded: boolean;
  previewLines: number;
  args: Record<string, unknown>;
}
export interface TreeView { lines: string[]; summary: string }
const TREE_TOOLS = new Set(["ls", "find", "grep"]);

// Only known SDK truncation notices, not arbitrary bracketed filenames.
const NOTICE = /^\[(?:\d+ (?:entries|results|matches) limit reached|\d+(?:\.\d+)?(?:B|KB|MB|GB) limit reached|Some lines truncated to \d+ chars)[^\r\n]*\]$/;
export function splitNotices(text: string): { rows: string[]; notices: string[] } {
  const rows = text.replace(/\r\n/g, "\n").split("\n");
  const notices: string[] = [];
  // SDK notices are separated from the actual body by a blank line.
  while (rows.length && rows.at(-1) === "") rows.pop();
  const last = rows.at(-1);
  if (last !== undefined && rows.length > 1 && rows.at(-2) === "" && NOTICE.test(last)) {
    notices.push(last);
    rows.splice(-2);
  }
  return { rows: rows.filter((line) => line !== ""), notices };
}

function iconName(name: string, directory: boolean, theme: Theme, icons: boolean): string {
  const icon = directory ? theme.fg("accent", TOOL_ICONS.ls) : fileIcon(name);
  const label = directory ? theme.fg("accent", theme.bold(name)) : name;
  return `${icons ? `${icon} ` : ""}${label}`;
}

interface Node { name: string; directory: boolean; children: Map<string, Node> }
function pathTree(paths: string[], theme: Theme, icons: boolean): string[] {
  const root: Node = { name: "", directory: true, children: new Map() };
  for (const path of paths) {
    // Preserve spaces, dotfiles and relative/absolute path identity.
    const clean = path.startsWith("./") ? path.slice(2) : path;
    const parts = clean.split("/").filter(Boolean);
    if (clean.startsWith("/")) parts.unshift("/");
    let parent = root;
    parts.forEach((name, index) => {
      const directory = index < parts.length - 1 || path.endsWith("/");
      let node = parent.children.get(name);
      if (!node) {
        node = { name, directory, children: new Map() };
        parent.children.set(name, node);
      }
      if (directory) node.directory = true;
      parent = node;
    });
  }
  const order = (node: Node) => [...node.children.values()].sort((a, b) =>
    Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  const stack = order(root).toReversed().map((node, index) => ({ node, prefix: "", last: index === 0 }));
  const out: string[] = [];
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    const { node, prefix, last } = item;
    const label = node.directory && node.name !== "/" ? `${node.name}/` : node.name;
    out.push(theme.fg("dim", `${prefix}${last ? "└── " : "├── "}`) + iconName(label, node.directory, theme, icons));
    const children = order(node);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], prefix: prefix + (last ? "    " : "│   "), last: i === children.length - 1 });
    }
  }
  return out;
}

/** No JS regex execution on arbitrary Rust/PCRE patterns (avoids ReDoS and fake matches).
 * Highlight literals and simple literal alternatives only; leave complex regexes unchanged.
 */
function highlight(content: string, args: Record<string, unknown>, theme: Theme): string {
  if (typeof args.pattern !== "string" || !args.pattern) return content;
  const words = args.literal === true ? [args.pattern] : args.pattern.split("|");
  if (args.literal !== true && words.some((word) => !/^[\p{L}\p{N}_ .:/-]+$/u.test(word))) return content;
  const normalized = (s: string) => args.ignoreCase === true ? s.toLowerCase() : s;
  const source = normalized(content);
  // Some Unicode case folds change string length; keep source text intact.
  if (source.length !== content.length || words.some((word) => normalized(word).length !== word.length)) return content;
  let offset = 0;
  let out = "";
  while (offset < content.length) {
    let found = -1;
    let length = 0;
    for (const word of words) {
      if (!word) continue;
      const index = source.indexOf(normalized(word), offset);
      if (index >= 0 && (found === -1 || index < found || (index === found && word.length > length))) {
        found = index;
        length = word.length;
      }
    }
    if (found === -1) break;
    out += content.slice(offset, found) + theme.fg("warning", theme.bold(content.slice(found, found + length)));
    offset = found + length;
  }
  return out + content.slice(offset);
}

function grepView(rows: string[], args: Record<string, unknown>, theme: Theme, icons: boolean): TreeView | undefined {
  const groups = new Map<string, Array<{ line: string; text: string; match: boolean }>>();
  let matches = 0;
  for (const row of rows) {
    // SDK context rows use path-N- text; match rows use path:N: text.
    const parsed = /^(.*?):(\d+): (.*)$/.exec(row) ?? /^(.*?)-(\d+)- (.*)$/.exec(row);
    if (!parsed) return undefined; // Unknown format: don't corrupt or hide output.
    const [, path, line, text] = parsed;
    const match = row === `${path}:${line}: ${text}`;
    if (match) matches++;
    const group = groups.get(path) ?? [];
    group.push({ line, text, match });
    groups.set(path, group);
  }
  const lines: string[] = [];
  for (const [path, entries] of groups) {
    if (lines.length) lines.push("");
    lines.push(iconName(path, false, theme, icons));
    const digits = Math.max(3, ...entries.map((entry) => entry.line.length));
    for (const entry of entries) {
      const text = entry.match ? highlight(entry.text, args, theme) : entry.text;
      lines.push(`  ${theme.fg("dim", entry.line.padStart(digits))} ${theme.fg("dim", "│")} ${text}`);
    }
  }
  return { lines, summary: `${matches} matches · ${groups.size} files` };
}

export function buildTreeView(tool: TreeTool, text: string, theme: Theme, options: TreeOptions): TreeView | undefined {
  const { rows, notices } = splitNotices(text);
  const empty = (tool === "ls" && text === "(empty directory)") ||
    (tool === "find" && text === "No files found matching pattern") ||
    (tool === "grep" && text === "No matches found");
  let view: TreeView;
  if (empty || rows.length === 0) {
    view = { lines: [theme.fg("dim", text || "(empty result)")], summary: "0 results" };
  } else if (tool === "grep") {
    const grep = grepView(rows, options.args, theme, options.icons);
    if (!grep) return undefined;
    view = grep;
  } else if (tool === "ls") {
    // ls is one directory level, not paths: a slash can only mark a directory.
    if (rows.some((row) => row.replace(/\/$/, "").includes("/"))) return undefined;
    view = {
      summary: `${rows.length} entries`,
      lines: rows.map((row, index) => theme.fg("dim", index === rows.length - 1 ? "└── " : "├── ") +
        iconName(row, row.endsWith("/"), theme, options.icons)),
    };
  } else {
    view = { lines: pathTree(rows, theme, options.icons), summary: `${rows.length} files` };
  }
  const budget = options.expanded ? view.lines.length : options.previewLines;
  const shown = view.lines.slice(0, budget);
  if (view.lines.length > budget) shown.push(theme.fg("dim", `… ${view.lines.length - budget} more rows (ctrl+o to expand)`));
  return { summary: view.summary, lines: [theme.fg("dim", view.summary), ...shown, ...notices.map((n) => theme.fg("warning", n))] };
}

class TreeComponent implements Component {
  private width?: number;
  private rendered?: string[];
  constructor(private lines: string[]) {}
  update(lines: string[]): void { this.lines = lines; this.invalidate(); }
  invalidate(): void { this.width = undefined; this.rendered = undefined; }
  render(width: number): string[] {
    if (this.width !== width || !this.rendered) {
      this.width = width;
      this.rendered = this.lines.map((line) => truncateToWidth(line, Math.max(0, width), "…"));
    }
    return this.rendered;
  }
}

export function registerTreeResults(pi: ExtensionAPI, icons: boolean, previewLines: number): void {
  pi.registerToolRenderer((name, next) => {
    const downstream = next();
    if (!TREE_TOOLS.has(name) || !downstream?.renderResult) return downstream;
    const fallback = downstream.renderResult;
    return {
      ...downstream,
      renderResult(result, options, theme, ctx) {
        // Downstream may expect its own Text component, not our cached tree.
        const fallbackContext = ctx.lastComponent instanceof TreeComponent ? { ...ctx, lastComponent: undefined } : ctx;
        // Errors, custom structured/image output and in-flight partials keep their own renderer.
        if (ctx.isError || options.isPartial || result.content.some((part) => part.type !== "text")) {
          return fallback(result, options, theme, fallbackContext);
        }
        const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        const view = buildTreeView(name as TreeTool, text, theme, {
          icons, previewLines, expanded: options.expanded, args: ctx.args ?? {},
        });
        if (!view) return fallback(result, options, theme, fallbackContext);
        // Some providers put truncation only in details, not in the textual body.
        const details = result.details as {
          entryLimitReached?: number; resultLimitReached?: number; matchLimitReached?: number;
          linesTruncated?: boolean; truncation?: { truncated?: boolean; maxBytes?: number };
        } | undefined;
        if (splitNotices(text).notices.length === 0 && details) {
          const warnings: string[] = [];
          if (details.entryLimitReached) warnings.push(`${details.entryLimitReached} entries limit`);
          if (details.resultLimitReached) warnings.push(`${details.resultLimitReached} results limit`);
          if (details.matchLimitReached) warnings.push(`${details.matchLimitReached} matches limit`);
          if (details.linesTruncated) warnings.push("long lines truncated");
          if (details.truncation?.truncated) warnings.push("byte limit reached");
          if (warnings.length) view.lines.push(theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`));
        }
        const state = ctx.state as { tidyTreeResult?: TreeComponent };
        const component = state.tidyTreeResult ?? new TreeComponent(view.lines);
        state.tidyTreeResult = component;
        component.update(view.lines);
        return component;
      },
    };
  });
  pi.registerCommand("tidy-tree", {
    description: "Show tree renderer availability (does not activate tools)",
    handler: async (_args, ctx) => {
      const active = new Set(pi.getActiveTools());
      const missing = [...TREE_TOOLS].filter((name) => !active.has(name));
      ctx.ui.notify(missing.length ? `Tidy tree ready; tools not active: ${missing.join(", ")}. Bash output is unchanged.` : "Tidy tree ready: ls, find, grep active.", "info");
    },
  });
}
