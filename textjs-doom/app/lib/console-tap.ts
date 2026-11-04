export type CssMode = "full" | "nofont" | "min" | "bare";

export interface TapStats {
  calls: number;
  bytes: number;
  bytesSaved: number;
}

const MAX_CACHE = 4096;
const cache = new Map<string, string>();

function cacheKey(mode: CssMode, css: string): string {
  return mode + "\u0000" + css;
}

function keepDeclaration(
  prop: string,
  value: string,
  mode: Exclude<CssMode, "full">
): boolean {
  if (mode === "bare") {
    switch (prop) {
      case "color":
      case "background-color":
      case "font-weight":
      case "font-style":
      case "text-decoration-line":
        return true;
      case "margin-top":
        return value.trim().toLowerCase().endsWith("vh");
      default:
        return false;
    }
  }

  if (prop === "font-family" || prop === "font-variant-ligatures") {
    return false;
  }

  if (mode === "min" && prop === "font-size") {
    return false;
  }

  return true;
}

function rewriteCssUncached(
  css: string,
  mode: Exclude<CssMode, "full">
): string {
  const parts = css.split(";");
  let trailingSemicolon = false;

  if (parts.length > 0 && parts[parts.length - 1].trim() === "") {
    parts.pop();
    trailingSemicolon = true;
  }

  const kept: string[] = [];

  for (const part of parts) {
    if (part.trim() === "") {
      continue;
    }

    const colon = part.indexOf(":");
    if (colon === -1) {
      // Not a declaration; preserve it.
      kept.push(part);
      continue;
    }

    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1);

    if (keepDeclaration(prop, value, mode)) {
      kept.push(part);
    }
  }

  if (kept.length === 0) {
    return "";
  }

  return kept.join(";") + (trailingSemicolon ? ";" : "");
}

export function rewriteCss(css: string, mode: CssMode): string {
  if (mode === "full" || css === "") {
    return css;
  }

  const key = cacheKey(mode, css);
  const cached = cache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const rewritten = rewriteCssUncached(css, mode);

  if (cache.size >= MAX_CACHE) {
    cache.clear();
  }

  cache.set(key, rewritten);
  return rewritten;
}

let installed = false;
let currentMode: CssMode = "full";

const stats: TapStats = {
  calls: 0,
  bytes: 0,
  bytesSaved: 0,
};

export function installConsoleTap(mode: CssMode): TapStats {
  if (typeof console === "undefined" || typeof console.log !== "function") {
    return { calls: 0, bytes: 0, bytesSaved: 0 };
  }

  currentMode = mode;

  if (installed) {
    return stats;
  }

  const originalLog = console.log.bind(console);

  console.log = function (...args: unknown[]): void {
    const format = args[0];
    const isCssCall = typeof format === "string" && format.includes("%c");

    let addedBytes = 0;
    let savedBytes = 0;

    if (isCssCall) {
      addedBytes += (format as string).length;
    }

    const modeNow = currentMode;

    for (let i = 1; i < args.length; i++) {
      const arg = args[i];

      if (typeof arg !== "string") {
        continue;
      }

      let value = arg;

      if (isCssCall && modeNow !== "full") {
        const rewritten = rewriteCss(arg, modeNow);

        if (rewritten !== arg) {
          savedBytes += arg.length - rewritten.length;
          args[i] = rewritten;
        }

        value = rewritten;
      }

      if (isCssCall) {
        addedBytes += value.length;
      }
    }

    if (isCssCall) {
      stats.calls += 1;
      stats.bytes += addedBytes;
      stats.bytesSaved += savedBytes;
    }

    originalLog(...args);
  };

  installed = true;
  return stats;
}
