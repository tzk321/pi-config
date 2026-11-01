/**
 * Access to pi's global theme singleton.
 *
 * The theme lives on globalThis (pi shares it across module loaders), but the
 * `theme` proxy itself is not part of the package's public exports — only the
 * `Theme` class is. Reading the well-known symbol is the supported-in-practice
 * way for an extension to reach the live instance outside a render callback.
 */

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
  /** Present on the live theme; every built-in theme implements it. */
  bg?(color: string, text: string): string;
  italic?(text: string): string;
}

export function getTheme(): ThemeLike | undefined {
  return (globalThis as Record<symbol, ThemeLike | undefined>)[THEME_KEY];
}
