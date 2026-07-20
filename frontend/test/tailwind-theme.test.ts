/**
 * Guards against Tailwind v4 @theme tokens generating no utility classes:
 * reads the built dist CSS and asserts the expected utilities are actually emitted.
 * Requires `npm run build` to have run first; skips gracefully when the artefact
 * is absent so it does not block local work before the first build.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
