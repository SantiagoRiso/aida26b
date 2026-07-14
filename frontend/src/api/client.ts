import { useUiStore } from '@/stores/ui';
import { API_PREFIX } from '@shared/ssot/api-paths';
import type { ApiEnvelope, ApiErrorEnvelope, ListMeta } from '@shared/ssot/envelope';

// Every backend route speaks the one shared envelope (shared/src/ssot/envelope.ts).
type Envelope<T> = ApiEnvelope<T> | ApiErrorEnvelope;

export type ApiResult<T> =
  | { ok: true; data: T; meta?: ListMeta }
  | { ok: false; status: number; code: string; message: string; fields?: Record<string, string> };

export interface ApiFetchOptions {
  // 'authenticated' (default): a 401 flags session-expired in the ui store.
  // 'entry': used for boot /auth/me and /auth/login — a 401 is a normal unauthenticated/bad-cred
  //          case and must NOT flag session-expired or push the expired toast.
  authMode?: 'authenticated' | 'entry';
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  { authMode = 'authenticated' }: ApiFetchOptions = {},
): Promise<ApiResult<T>> {
  const ui = useUiStore();

  const headers: HeadersInit = options.body
    ? { 'Content-Type': 'application/json', ...(options.headers as Record<string, string> | undefined) }
    : (options.headers ?? {});

  // API responses carry live data and must never be served from the HTTP cache. A cached stale
  // response (e.g. an index.html served during a dev-proxy hiccup) otherwise poisons GETs.
  const response = await fetch(`${API_PREFIX}${path}`, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });

  if (response.status === 401) {
    if (authMode === 'authenticated') {
      // Session lapsed on a protected route — flag and block; redirect on next navigation.
      ui.flagSessionExpired();
    }
    // entry-mode 401 surfaces as a plain failure; the caller renders inline (login bad-creds,
    // boot /auth/me just leaves user null).
    return { ok: false, status: 401, code: 'unauthorized', message: 'Unauthorized' };
  }

  if (response.status === 204) {
    return { ok: true, data: undefined as T };
  }

  const body = (await response.json().catch(() => ({}))) as Envelope<T>;

  // A non-enveloped body (e.g. an HTML error page) has no `success` field — fail cleanly rather
  // than dereferencing body.error and throwing an opaque TypeError up through callers.
  if (typeof body !== 'object' || body === null || !('success' in body)) {
    if (response.status === 403) ui.toast('error', 'notPermitted');
    return { ok: false, status: response.status, code: 'bad_response', message: `Unexpected response (${response.status})` };
  }
  if (!body.success) {
    if (response.status === 403) ui.toast('error', 'notPermitted');
    return {
      ok: false,
      status: response.status,
      code: body.error.code,
      message: body.error.message,
      fields: body.error.fields,
    };
  }
  return {
    ok: true,
    data: body.data,
    meta: 'meta' in body ? body.meta : undefined,
  };
}
