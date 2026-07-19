import { useUiStore } from '@/stores/ui';
import { API_PREFIX } from '@shared/ssot/api-paths';
import type { ApiEnvelope, ApiErrorEnvelope, ListMeta } from '@shared/ssot/envelope';

// Every backend route speaks the one shared envelope (shared/src/ssot/envelope.ts).
type UnknownEnvelope = ApiEnvelope<unknown> | ApiErrorEnvelope;

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}

function isListMeta(value: unknown): value is ListMeta {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return typeof meta.page === 'number' && typeof meta.limit === 'number' && typeof meta.total === 'number';
}

function parseEnvelope(value: unknown): UnknownEnvelope | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.success === true) {
    if (!('data' in envelope)) return null;
    if ('meta' in envelope && envelope.meta !== undefined && !isListMeta(envelope.meta)) return null;
    return { success: true, data: envelope.data, ...('meta' in envelope ? { meta: envelope.meta as ListMeta } : {}) };
  }
  if (envelope.success !== false || envelope.error === null || typeof envelope.error !== 'object' || Array.isArray(envelope.error)) {
    return null;
  }
  const error = envelope.error as Record<string, unknown>;
  if (typeof error.code !== 'string' || typeof error.message !== 'string') return null;
  if ('fields' in error && error.fields !== undefined && !isStringRecord(error.fields)) return null;
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...('fields' in error ? { fields: error.fields as Record<string, string> } : {}),
    },
  };
}

let mutationGeneration = 0;

export function getApiMutationGeneration(): number {
  return mutationGeneration;
}

export type ApiResult<T> =
  | { ok: true; data: T; meta?: ListMeta }
  | { ok: false; status: number; code: string; message: string; fields?: Record<string, string> };

export interface ApiFetchOptions {
  // 'authenticated' (default): a 401 flags session-expired in the ui store.
  // 'entry': used for boot /auth/me and /auth/login — a 401 is a normal unauthenticated/bad-cred
  //          case and must NOT flag session-expired or push the expired toast.
  authMode?: 'authenticated' | 'entry';
  // Opt-in "Acción no permitida" toast on 403. Interactive mutations (button-triggered saves,
  // transitions, deletes) set it so the user gets feedback; background/probe reads stay silent.
  toastOnForbidden?: boolean;
}

async function performApiFetch<T>(
  path: string,
  options: RequestInit = {},
  { authMode = 'authenticated', toastOnForbidden = false }: ApiFetchOptions = {},
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
    if ((options.method ?? 'GET').toUpperCase() !== 'GET') mutationGeneration += 1;
    return { ok: true, data: undefined as T };
  }

  const body = parseEnvelope(await response.json().catch(() => null));

  // A non-enveloped body (e.g. an HTML error page) has no `success` field — fail cleanly rather
  // than dereferencing body.error and throwing an opaque TypeError up through callers.
  if (body === null) {
    if (response.status === 403 && toastOnForbidden) ui.toast('error', 'notPermitted');
    return { ok: false, status: response.status, code: 'bad_response', message: `Unexpected response (${response.status})` };
  }
  if (!body.success) {
    if (response.status === 403 && toastOnForbidden) ui.toast('error', 'notPermitted');
    return {
      ok: false,
      status: response.status,
      code: body.error.code,
      message: body.error.message,
      fields: body.error.fields,
    };
  }
  if ((options.method ?? 'GET').toUpperCase() !== 'GET') mutationGeneration += 1;
  return {
    ok: true,
    // Endpoint modules own the payload contract; the shared envelope itself has been validated.
    data: body.data as T,
    meta: 'meta' in body ? body.meta : undefined,
  };
}

const inFlightGets = new Map<string, Promise<ApiResult<unknown>>>();

export function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  apiOptions: ApiFetchOptions = {},
): Promise<ApiResult<T>> {
  const method = (options.method ?? 'GET').toUpperCase();
  const canShare = method === 'GET' && !options.signal && !options.body && !options.headers;
  if (!canShare) return performApiFetch<T>(path, options, apiOptions);

  const key = `${apiOptions.authMode ?? 'authenticated'}|${apiOptions.toastOnForbidden ?? false}|${path}`;
  const existing = inFlightGets.get(key);
  if (existing) return existing as Promise<ApiResult<T>>;

  const request = performApiFetch<T>(path, options, apiOptions);
  inFlightGets.set(key, request);
  void request.finally(() => {
    if (inFlightGets.get(key) === request) inFlightGets.delete(key);
  });
  return request;
}
