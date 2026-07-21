/**
 * Guards against Tailwind v4 @theme tokens generating no utility classes:
 * reads the built dist CSS and asserts the expected utilities are actually emitted.
 * Tailwind's JIT tree-shakes anything unused, so only the built artefact can answer
 * this. Requires `npm run build` to have run first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const distDir = join(__dirname, '../dist');
const assetsDir = join(distDir, 'assets');

/* A missing build must fail rather than skip: these assertions passing while reading
   nothing is indistinguishable from the tokens being fine. */
function readBuiltCss(): string {
  const NEEDS_BUILD =
    'No built CSS in frontend/dist/assets. Run `npm run build` before this suite.';
  if (!existsSync(assetsDir)) throw new Error(NEEDS_BUILD);
  // Prefer Vite's index-*.css: component-scoped CSS (e.g. CalendarView-*.css)
  // lacks the full token set and would give false negatives.
  const entries = readdirSync(assetsDir);
  const cssFile =
    entries.find((f) => f.startsWith('index') && f.endsWith('.css')) ??
    entries.find((f) => f.endsWith('.css'));
  if (!cssFile) throw new Error(NEEDS_BUILD);
  return readFileSync(join(assetsDir, cssFile), 'utf-8');
}

describe('Tailwind v4 semantic token → utility generation', () => {
  it('the root text colour rule survives the build', () => {
    const css = readBuiltCss();
    expect(css).toMatch(/html\s*\{[^}]*color:\s*var\(--color-body\)/);
    expect(css).toMatch(/--color-body:\s*#334155/i);
    expect(css).toMatch(/--color-body:\s*#cbd5e1/i);
  });

  it('the status tint utilities are present in emitted CSS', () => {
    const css = readBuiltCss();
    for (const utility of [
      'bg-success-tint', 'text-success-strong', 'bg-destructive-tint', 'text-destructive-strong',
      'bg-warning-tint', 'text-warning-strong', 'bg-info-tint', 'text-info-strong',
      'bg-accent-tint', 'text-accent-strong',
      'bg-neutral-tint', 'border-warning-tint-border',
    ]) {
      expect(css, `${utility} generated no rule`).toMatch(new RegExp(`\\.${utility}[\\s,{:]`));
    }
  });

  /* The dark theme patched Tailwind's own palette to keep tinted screens in step; the role
     tokens replaced that, and a returning remap would mean a component slipped back. */
  it('no longer remaps Tailwind stock palette steps', () => {
    const css = readBuiltCss();
    const darkBlock = css.slice(css.indexOf("[data-theme=dark]"));
    const remaps = [
      ...darkBlock.slice(0, darkBlock.indexOf('}')).matchAll(
        /--color-(slate|gray|zinc|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/g,
      ),
    ].map((m) => m[0]);
    expect([...new Set(remaps)]).toEqual([]);
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

  const valueOf = (block: string, token: string) =>
    block.match(new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6})`))?.[1];

  // WCAG relative luminance.
  const lum = (hex: string) =>
    [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((acc, v, i) => acc + [0.2126, 0.7152, 0.0722][i] * v, 0);

  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('finds the tokens each block actually declares', () => {
    // A scan that matched nothing would pass the coverage assertion below for the wrong reason.
    expect(lightTokens).toContain('--color-body');
    expect(lightTokens.length).toBeGreaterThan(20);
    expect(darkTokens.length).toBeGreaterThan(20);
  });

  it.each([
    '--color-surface',
    '--color-card',
    '--color-border',
    '--color-accent',
    '--color-inverted',
    '--color-body',
  ])(
    '%s has a dark value',
    (token) => {
      expect(darkTokens).toContain(token);
    },
  );

  it('every light token has a dark counterpart', () => {
    const missing = lightTokens.filter((token) => !darkTokens.includes(token));
    expect(missing).toEqual([]);
  });

  it('keeps the body step between heading and neutral in both themes', () => {
    const light = blockAfter('@theme');
    const dark = blockAfter(":root[data-theme='dark']");

    for (const [block, darkTheme] of [
      [light, false],
      [dark, true],
    ] as const) {
      const heading = lum(valueOf(block, '--color-heading')!);
      const body = lum(valueOf(block, '--color-body')!);
      const neutral = lum(valueOf(block, '--color-neutral')!);
      // On dark the steps run the other way: heading is the lightest, neutral the dimmest.
      expect(darkTheme ? heading > body && body > neutral : heading < body && body < neutral).toBe(
        true,
      );
    }
  });

  /*
   * Status tints only work if the paired text step stays readable on them. The pairing is the
   * whole reason both tokens exist, so it is asserted rather than left to review.
   */
  it('every tint / foreground pair clears 4.5:1 in both themes', () => {
    const PAIRS: [background: string, foreground: string][] = [
      ['--color-success-tint', '--color-success-strong'],
      ['--color-destructive-tint', '--color-destructive-strong'],
      ['--color-warning-tint', '--color-warning-strong'],
      ['--color-info-tint', '--color-info-strong'],
      ['--color-accent-tint', '--color-accent-strong'],
      ['--color-neutral-tint', '--color-body'],
    ];

    const light = blockAfter('@theme');
    const dark = blockAfter(":root[data-theme='dark']");

    const failures: string[] = [];
    for (const [theme, block] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      for (const [bg, fg] of PAIRS) {
        const bgHex = valueOf(block, bg);
        const fgHex = valueOf(block, fg);
        expect(bgHex, `${bg} missing from the ${theme} block`).toBeDefined();
        expect(fgHex, `${fg} missing from the ${theme} block`).toBeDefined();
        const ratio = contrast(bgHex!, fgHex!);
        if (ratio < 4.5) failures.push(`${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('the foreground steps also clear 4.5:1 on the card they may sit on', () => {
    const STEPS = [
      '--color-success-strong',
      '--color-destructive-strong',
      '--color-warning-strong',
      '--color-info-strong',
    ];

    const failures: string[] = [];
    for (const [theme, block] of [
      ['light', blockAfter('@theme')],
      ['dark', blockAfter(":root[data-theme='dark']")],
    ] as const) {
      const card = valueOf(block, '--color-card')!;
      for (const step of STEPS) {
        const ratio = contrast(card, valueOf(block, step)!);
        if (ratio < 4.5) failures.push(`${theme}: ${step} on the card is ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
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
    expect(STOCK_STEP.test('amber-800')).toBe(true);
    expect(STOCK_STEP.test('warning-tint')).toBe(false);
    // Assembled rather than written out: Tailwind scans this file too, and a literal
    // utility string here would make the build emit the very rule under test.
    expect(usages.map((u) => u.utility)).not.toContain(['text', 'amber', '800'].join('-'));
  });

  /*
   * A stock step renders from Tailwind's own palette, so it survives review looking fine while
   * ignoring the theme: the dark override has to patch the framework's variable to keep up.
   * Status colour belongs to a role token instead.
   */
  it('no component reaches past the tokens into the stock palette', () => {
    const stockUtility = new RegExp(
      `\\b(${COLOR_PREFIXES.join('|')})-(${STOCK_FAMILIES.join('|')})-\\d{2,3}\\b`,
      'g',
    );
    const offenders = sourceFiles(srcDir).flatMap((path) =>
      [...readFileSync(path, 'utf-8').matchAll(stockUtility)].map(
        (m) => `${m[0]} in src/${relative(srcDir, path).replace(/\\/g, '/')}`,
      ),
    );
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('every semantic colour utility resolves to a declared @theme token', () => {
    const orphans = usages
      .filter((u) => !declared.has(u.token))
      .map((u) => `${u.utility} (${u.token} undeclared) in src/${u.where}`);
    expect([...new Set(orphans)]).toEqual([]);
  });
});
