import type { CodeHighlighterPlugin, HighlightOptions, HighlightResult, ThemeInput } from '@streamdown/code';
import type { BundledLanguage } from 'shiki';

/**
 * A code-highlighter plugin for Streamdown backed by one shared Shiki instance.
 *
 * The stock @streamdown/code plugin builds a separate highlighter per language and
 * pulls grammars out of Shiki's full bundle, so a thread mixing bash, python, and
 * json spun up three highlighters and fetched three chunks. This keeps a single
 * instance over a preset grammar set (see highlighterGrammars.ts), loaded once.
 */

const THEME_NAMES: [string, string] = ['github-light', 'github-dark'];
const PLAIN_TEXT = 'text';

const ALIASES: Record<string, string> = {
  cs: 'csharp',
  dockerfile: 'docker',
  htm: 'html',
  js: 'javascript',
  jsx: 'tsx',
  kt: 'kotlin',
  makefile: 'make',
  md: 'markdown',
  mjs: 'javascript',
  cjs: 'javascript',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
};

const SUPPORTED = new Set([
  'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'docker', 'go', 'graphql', 'html',
  'ini', 'java', 'javascript', 'json', 'jsonc', 'kotlin', 'lua', 'make', 'markdown',
  'php', 'powershell', 'python', 'ruby', 'rust', 'sql', 'swift', 'toml', 'tsx',
  'typescript', 'xml', 'yaml',
]);

function normalizeLanguage(language: string): string {
  const trimmed = language.trim().toLowerCase();
  const resolved = ALIASES[trimmed] ?? trimmed;
  return SUPPORTED.has(resolved) ? resolved : PLAIN_TEXT;
}

type CoreHighlighter = {
  codeToTokens: (code: string, options: {
    lang: string;
    themes: { light: string; dark: string };
  }) => HighlightResult;
};

let highlighterPromise: Promise<CoreHighlighter> | null = null;

function loadHighlighter(): Promise<CoreHighlighter> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, bundle] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('./highlighterGrammars'),
    ]);
    return await createHighlighterCore({
      themes: bundle.themes,
      langs: bundle.grammars,
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    }) as unknown as CoreHighlighter;
  })();
  return highlighterPromise;
}

/** Keyed on the ends of the snippet so streaming updates miss the cache as they grow. */
function cacheKey(code: string, language: string): string {
  const head = code.slice(0, 100);
  const tail = code.length > 100 ? code.slice(-100) : '';
  return `${language}:${code.length}:${head}:${tail}`;
}

const tokens = new Map<string, HighlightResult>();
const waiting = new Map<string, Set<(result: HighlightResult) => void>>();

export const codeHighlighter: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',

  getThemes: () => THEME_NAMES as [ThemeInput, ThemeInput],

  getSupportedLanguages: () => Array.from(SUPPORTED) as BundledLanguage[],

  supportsLanguage: (language) => normalizeLanguage(language) !== PLAIN_TEXT,

  highlight({ code, language }: HighlightOptions, callback?: (result: HighlightResult) => void) {
    const resolved = normalizeLanguage(language);
    const key = cacheKey(code, resolved);

    const cached = tokens.get(key);
    if (cached) return cached;

    if (callback) {
      const listeners = waiting.get(key) ?? new Set();
      listeners.add(callback);
      waiting.set(key, listeners);
    }

    void loadHighlighter()
      .then((highlighter) => {
        const result = highlighter.codeToTokens(code, {
          lang: resolved,
          themes: { light: THEME_NAMES[0], dark: THEME_NAMES[1] },
        });
        tokens.set(key, result);
        const listeners = waiting.get(key);
        if (!listeners) return;
        waiting.delete(key);
        for (const listener of listeners) listener(result);
      })
      .catch((error) => {
        console.error('[Olympus] Failed to highlight code:', error);
        waiting.delete(key);
      });

    return null;
  },
};
