// Syntax highlighting for code the agent writes and shows: Shiki with its
// JavaScript regex engine (the default WASM one is blocked by the page's
// CSP), grammars loaded on first use, and tokens (never HTML) for React to
// draw as spans.
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
  type ThemedToken,
  type ThemeRegistration,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

/** The grammars strive loads, by the name a fence uses (aliases included). */
const GRAMMARS = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
} satisfies Record<string, Grammar>;

type GrammarName = keyof typeof GRAMMARS;

const ALIASES = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  py: "python",
  yml: "yaml",
  md: "markdown",
  jsonc: "json",
} satisfies Record<string, GrammarName>;

const isGrammar = (name: string): name is GrammarName => Object.hasOwn(GRAMMARS, name);

const isAlias = (name: string): name is keyof typeof ALIASES => Object.hasOwn(ALIASES, name);

/** The grammar for a fence's language or a file's extension, if strive has one. */
export function grammarFor(name: string): GrammarName | undefined {
  const n = name.trim().toLowerCase();

  if (isAlias(n)) return ALIASES[n];

  return isGrammar(n) ? n : undefined;
}

/** strive's dark theme, in TextMate scopes: the app's own colours for code. */
const THEME: ThemeRegistration = {
  name: "strive-dark",
  type: "dark",
  colors: { "editor.background": "#0d0d0f", "editor.foreground": "#e8e8ea" },
  tokenColors: [
    { settings: { foreground: "#e8e8ea" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#85858a", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "keyword.operator.new"], settings: { foreground: "#a99bfa" } },
    { scope: ["string", "string.quoted", "string.template", "markup.inline.raw"], settings: { foreground: "#6ee7b7" } },
    { scope: ["constant.numeric", "constant.language", "constant.character"], settings: { foreground: "#facc15" } },
    {
      scope: ["entity.name.type", "support.type", "entity.name.class", "support.class"],
      settings: { foreground: "#c4a5fd" },
    },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#7cb8fb" } },
    {
      scope: ["variable.other.property", "support.type.property-name", "entity.name.tag"],
      settings: { foreground: "#f49ac1" },
    },
    { scope: ["entity.other.attribute-name", "meta.attribute"], settings: { foreground: "#5eead4" } },
    { scope: ["punctuation", "meta.brace", "keyword.operator"], settings: { foreground: "#a1a1aa" } },
    { scope: ["markup.inserted", "meta.diff.header.to-file"], settings: { foreground: "#6ee7b7" } },
    { scope: ["markup.deleted", "meta.diff.header.from-file"], settings: { foreground: "#fb8f8f" } },
    { scope: ["markup.heading", "markup.bold"], settings: { foreground: "#f4f4f5", fontStyle: "bold" } },
  ],
};

let highlighter: Promise<HighlighterCore> | undefined;

const loaded = new Map<string, Promise<void>>();

/** Recent results, so a block drawn again (a re-render, a scroll) isn't re-tokenized. */
const cache = new Map<string, ThemedToken[][]>();

const CACHE_SIZE = 200;

/** Code past this many characters is shown plain: highlighting it would stall the window. */
const MAX_CODE = 200_000;

function core(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine() });

  return highlighter;
}

/** `code` as lines of coloured tokens, or undefined when the language isn't one strive knows. */
export async function tokens(code: string, language: string): Promise<ThemedToken[][] | undefined> {
  const grammar = grammarFor(language);

  if (!grammar || code.length > MAX_CODE) return undefined;

  const key = `${grammar}\u0000${code}`;
  const hit = cache.get(key);

  if (hit) return hit;

  const h = await core();
  let loading = loaded.get(grammar);

  if (!loading) {
    loading = GRAMMARS[grammar]().then((m) => h.loadLanguage(m.default));
    loaded.set(grammar, loading);
  }

  await loading;
  const lines = h.codeToTokens(code, { lang: grammar, theme: THEME.name ?? "strive-dark" }).tokens;

  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, lines);

  return lines;
}
