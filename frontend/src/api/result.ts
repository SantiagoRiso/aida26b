import type { ErrorDetail, ListMeta } from '@shared/ssot/envelope';

// `message`/`fields` are the server's English prose (diagnostics, logs). Anything shown to a
// user goes through detail/fieldDetails, or the code, so it can be translated.
export type ApiResult<T> =
  | { ok: true; data: T; meta?: ListMeta }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      detail?: ErrorDetail;
      fields?: Record<string, string>;
      fieldDetails?: Record<string, ErrorDetail>;
      diagnostic?: string;
    };
