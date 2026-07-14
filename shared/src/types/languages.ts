// Runtime source of the supported language set. Lives outside types.ts because types.ts is
// type-only (no runtime values) — this is the one file allowed to carry the const, and types.ts
// re-exports just the derived TYPE.
export const LANGUAGES = ['es', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
