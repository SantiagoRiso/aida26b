import { useUiStore } from '@/stores/ui';

// Backend uses two distinct response shapes (verified in server.ts + status_messages.ts):
//   /api/auth/* and /api/admin/users*  → raw JSON: { user } | { error: string }, HTTP status is verdict
//   All other routes                   → enveloped: { success, data, meta? } | { success:false, error:{code,message,fields?} }
const RAW_JSON_PREFIXES = ['/auth/', '/admin/users'];

function isRawRoute(path: string): boolean {
  return RAW_JSON_PREFIXES.some((p) => path.startsWith(p));
}

type Envelope<T> =
  | { success: true; data: T; meta?: { page: number; limit: number; total: number } }
  | { success: false; error: { code: string; message: string; fields?: Record<string, string> } };

export type ApiResult<T> =
  | { ok: true; data: T; meta?: { page: number; limit: number; total: number } }
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

  const response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' });

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

  const body = await response.json().catch(() => ({} as Record<string, unknown>));

  if (response.status === 403) {
    ui.toast('error', 'notPermitted');
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: typeof body['error'] === 'string' ? body['error'] : 'Forbidden',
    };
  }

  if (isRawRoute(path)) {
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: 'error',
        message: typeof body['error'] === 'string' ? body['error'] : `Error ${response.status}`,
      };
    }
    return { ok: true, data: body as T };
  }

  const envelope = body as Envelope<T>;
  if (!envelope.success) {
    return {
      ok: false,
      status: response.status,
      code: envelope.error.code,
      message: envelope.error.message,
      fields: envelope.error.fields,
    };
  }
  return {
    ok: true,
    data: envelope.data,
    meta: 'meta' in envelope ? envelope.meta : undefined,
  };
}
