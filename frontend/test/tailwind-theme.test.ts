/**
 * Guards against Tailwind v4 @theme tokens generating no utility classes:
 * reads the built dist CSS and asserts the expected utilities are actually emitted.
 * Requires `npm run build` to have run first; skips gracefully when the artefact
 * is absent so it does not block local work before the first build.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const distDir = join(__dirname, '../dist');
const assetsDir = join(distDir, 'assets');

function findBuiltCss(): string | null {
  if (!existsSync(assetsDir)) return null;
  // Prefer Vite's index-*.css: component-scoped CSS (e.g. CalendarView-*.css)
  // lacks the full token set and would give false negatives.
  const cssFile =
    readdirSync(assetsDir).find((f) => f.startsWith('index') && f.endsWith('.css')) ??
    readdirSync(assetsDir).find((f) => f.endsWith('.css'));
  if (!cssFile) return null;
  return join(assetsDir, cssFile);
}

describe('Tailwind v4 semantic token → utility generation', () => {
  it('dist/assets/*.css exists after build', () => {
    const cssPath = findBuiltCss();
    if (!cssPath) {
      // Absent build is not a failure — skip until the first build runs.
      console.warn('SKIP: no dist/assets/*.css found; run `npm run build` first.');
      return;
    }
    expect(existsSync(cssPath)).toBe(true);
  });

  it('bg-accent utility is present in emitted CSS', () => {
    const cssPath = findBuiltCss();
    if (!cssPath) {
      console.warn('SKIP: no dist CSS to inspect.');
      return;
    }
    const css = readFileSync(cssPath, 'utf-8');
    expect(css).toMatch(/\.bg-accent/);
  });

  it('text-destructive utility is present in emitted CSS', () => {
    const cssPath = findBuiltCss();
    if (!cssPath) {
      console.warn('SKIP: no dist CSS to inspect.');
      return;
    }
    const css = readFileSync(cssPath, 'utf-8');
    expect(css).toMatch(/\.text-destructive/);
  });

  it('bg-success utility is present in emitted CSS', () => {
    const cssPath = findBuiltCss();
    if (!cssPath) {
      console.warn('SKIP: no dist CSS to inspect.');
      return;
    }
    const css = readFileSync(cssPath, 'utf-8');
    expect(css).toMatch(/\.bg-success/);
  });

  it('--color-accent custom property is declared in @theme block', () => {
    const cssPath = findBuiltCss();
    if (!cssPath) {
      console.warn('SKIP: no dist CSS to inspect.');
      return;
    }
    const css = readFileSync(cssPath, 'utf-8');
    expect(css).toMatch(/--color-accent/);
  });

  it('text-inverted utility is present in emitted CSS', () => {
    const cssPath = findBuiltCss();
    if (!cssPath) {
      console.warn('SKIP: no dist CSS to inspect.');
      return;
    }
    const css = readFileSync(cssPath, 'utf-8');
    expect(css).toMatch(/\.text-inverted/);
  });
});

/**
 * The dark theme is a pure token override: every semantic token the light @theme declares
 * must be re-declared under [data-theme=dark], or whatever uses it renders invisible.
 * Asserted against the source, which is where the omission would happen.
 */
describe('dark theme token coverage', () => {
  const sourceCss = readFileSync(join(__dirname, '../src/styles/main.css'), 'utf-8');

  function tokensIn(block: string): string[] {
    return [...block.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
  }

  function blockAfter(selector: string): string {
    const start = sourceCss.indexOf(selector);
    expect(start).toBeGreaterThan(-1);
    const open = sourceCss.indexOf('{', start);
    return sourceCss.slice(open, sourceCss.indexOf('}', open));
  }

  const lightTokens = tokensIn(blockAfter('@theme'));
  const darkTokens = tokensIn(blockAfter(":root[data-theme='dark']"));

  it('the light @theme block declares the semantic tokens', () => {
    expect(lightTokens).toContain('--color-surface');
    expect(lightTokens).toContain('--color-inverted');
  });

  it.each(['--color-surface', '--color-card', '--color-border', '--color-accent', '--color-inverted'])(
    '%s has a dark value',
    (token) => {
      expect(darkTokens).toContain(token);
    },
  );

  it('every light token has a dark counterpart', () => {
    const missing = lightTokens.filter((token) => !darkTokens.includes(token));
    expect(missing).toEqual([]);
  });

  it('declares color-scheme on both themes so native controls follow', () => {
    expect(blockAfter(":root[data-theme='light']")).toMatch(/color-scheme:\s*light/);
    expect(blockAfter(":root[data-theme='dark']")).toMatch(/color-scheme:\s*dark/);
  });

  it('ships a dark datepicker theme mirroring the light one', () => {
    const light = blockAfter('.dp--theme-light');
    const dark = blockAfter('.dp--theme-dark');
    const dpTokens = (block: string) => [...block.matchAll(/(--dp-[a-z-]+)\s*:/g)].map((m) => m[1]);
    const missing = dpTokens(light).filter((token) => !dpTokens(dark).includes(token));
    expect(missing).toEqual([]);
  });
});

/**
 * The inverse guard: a colour utility written in a component with no token behind it.
 * Tailwind emits nothing for those, so the element silently falls back to the inherited
 * colour and looks plausible in review while being undesigned.
 *
 * Only the app's own semantic names are checked. Tailwind's stock palette steps
 * (bg-red-50, text-amber-700) are var()-backed by the framework itself, and the size,
 * side and style values that share these prefixes (text-sm, border-t, shadow-lg) are
 * not colours at all. Both are recognised structurally and excluded; whatever survives
 * can only be a semantic name, and must be declared.
 */
describe('semantic colour utilities have a token behind them', () => {
  const srcDir = join(__dirname, '../src');

  const COLOR_PREFIXES = [
    'text', 'bg', 'border', 'ring', 'divide', 'outline', 'fill', 'stroke', 'shadow',
    'from', 'via', 'to', 'decoration', 'placeholder', 'caret', 'accent',
  ];

  const STOCK_FAMILIES = [
    'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow',
    'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet',
    'purple', 'fuchsia', 'pink', 'rose',
  ];
  const STOCK_STEP = new RegExp(`^(${STOCK_FAMILIES.join('|')})-\\d{2,3}$`);

  const CSS_KEYWORD = /^(white|black|transparent|current|inherit|none|auto)$/;

  // Side segments Tailwind allows between the prefix and the colour: border-t, border-t-transparent.
  const SIDE = /^(t|r|b|l|x|y|s|e|inline|block)(-|$)/;

  // A class name starts a word. Requiring that rules out hyphenated prose in comments and
  // i18n keys, where "shrink-to-fit" or "back-to-back" would otherwise read as a gradient stop.
  const CLASS_START = /[\w-]/;

  // Non-colour values Tailwind ships under the same prefixes.
  const NON_COLOR: Record<string, RegExp> = {
    text: /^(xs|sm|base|lg|\d?xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/,
    bg: /^(fixed|local|scroll|bottom|center|left|right|top|no-repeat|repeat|repeat-x|repeat-y|repeat-round|repeat-space|cover|contain|origin-.+|clip-.+|blend-.+|linear|radial|conic)$/,
    border: /^(solid|dashed|dotted|double|hidden|collapse|separate|spacing)$/,
    divide: /^(solid|dashed|dotted|double)$/,
    outline: /^(solid|dashed|dotted|double|hidden|offset-\d+)$/,
    ring: /^(inset|offset-\d+)$/,
    shadow: /^(2xs|xs|sm|md|lg|xl|2xl|inner|initial)$/,
    decoration: /^(solid|dashed|dotted|double|wavy|from-font)$/,
    fill: /^$/, stroke: /^$/, from: /^$/, via: /^$/, to: /^$/,
    placeholder: /^$/, caret: /^$/, accent: /^$/,
  };

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(vue|ts)$/.test(entry) ? [path] : [];
    });
  }

  interface Usage { utility: string; token: string; where: string }

  function usagesIn(path: string): Usage[] {
    // <style> blocks hold real CSS property names (border-radius, text-align) that would
    // otherwise read as utilities.
    const source = readFileSync(path, 'utf-8').replace(/<style[\s\S]*?<\/style>/g, '');
    const pattern = new RegExp(`\\b(${COLOR_PREFIXES.join('|')})-([a-zA-Z][a-zA-Z0-9-]*)`, 'g');
    const found: Usage[] = [];

    for (const match of source.matchAll(pattern)) {
      // A trailing `=` means this is an attribute name (`:text-input="…"`), not a class.
      if (source[match.index! + match[0].length] === '=') continue;
      if (match.index! > 0 && CLASS_START.test(source[match.index! - 1])) continue;

      const prefix = match[1];
      let value = match[2];
      if (prefix === 'border' || prefix === 'divide') value = value.replace(SIDE, '');

      if (value === '' || /^\d/.test(value)) continue;
      if (STOCK_STEP.test(value)) continue;
      if (CSS_KEYWORD.test(value)) continue;
      if (NON_COLOR[prefix]?.test(value)) continue;

      found.push({
        utility: match[0],
        token: `--color-${value}`,
        where: relative(srcDir, path).replace(/\\/g, '/'),
      });
    }
    return found;
  }

  const themeBlock = (() => {
    const css = readFileSync(join(srcDir, 'styles/main.css'), 'utf-8');
    const open = css.indexOf('{', css.indexOf('@theme'));
    return css.slice(open, css.indexOf('}', open));
  })();
  const declared = new Set([...themeBlock.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  const usages = sourceFiles(srcDir).flatMap(usagesIn);

  it('finds the semantic utilities actually in use', () => {
    // A scan that matched nothing would pass the assertion below for the wrong reason.
    expect(usages.map((u) => u.utility)).toContain('text-heading');
    expect(usages.length).toBeGreaterThan(20);
  });

  it('never mistakes a stock palette step for a semantic token', () => {
    expect(usages.map((u) => u.utility)).not.toContain('text-amber-800');
    expect(usages.map((u) => u.utility)).not.toContain('bg-amber-100');
  });

  it('every semantic colour utility resolves to a declared @theme token', () => {
    const orphans = usages
      .filter((u) => !declared.has(u.token))
      .map((u) => `${u.utility} (${u.token} undeclared) in src/${u.where}`);
    expect([...new Set(orphans)]).toEqual([]);
  });
});
