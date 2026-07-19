import type { ListMeta } from '@shared/ssot/envelope';

export type ApiResult<T> =
  | { ok: true; data: T; meta?: ListMeta }
  | { ok: false; status: number; code: string; message: string; fields?: Record<string, string>; diagnostic?: string };
