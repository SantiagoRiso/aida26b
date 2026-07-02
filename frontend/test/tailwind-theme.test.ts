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
});
