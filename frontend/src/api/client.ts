import { useUiStore } from '@/stores/ui';
import { API_PREFIX } from '@shared/ssot/api-paths';
import type { ApiEnvelope, ApiErrorEnvelope, ListMeta } from '@shared/ssot/envelope';
import { isUnknownRecord, type Decoder } from '@/api/decoders';

// Every backend route speaks the one shared envelope (shared/src/ssot/envelope.ts).
type UnknownEnvelope = ApiEnvelope<unknown> | ApiErrorEnvelope;

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}

function isListMeta(value: unknown): value is ListMeta {
  return isUnknownRecord(value)
    && typeof value.page === 'number'
    && typeof value.limit === 'number'
    && typeof value.total === 'number';
}

function parseEnvelope(value: unknown): UnknownEnvelope | null {
  if (!isUnknownRecord(value)) return null;
  if (value.success === true) {
    if (!('data' in value)) return null;
    if ('meta' in value && value.meta !== undefined && !isListMeta(value.meta)) return null;
    return { success: true, data: value.data, ...(isListMeta(value.meta) ? { meta: value.meta } : {}) };
  }
  if (value.success !== false || !isUnknownRecord(value.error)) {
    return null;
  }
  const error = value.error;
  if (typeof error.code !== 'string' || typeof error.message !== 'string') return null;
  if ('fields' in error && error.fields !== undefined && !isStringRecord(error.fields)) return null;
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(isStringRecord(error.fields) ? { fields: error.fields } : {}),
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

type RawApiResult =
  | { ok: true; status: number; data: unknown; meta?: ListMeta }
  | Extract<ApiResult<never>, { ok: false }>;

export interface ApiFetchOptions {
  // 'authenticated' (default): a 401 flags session-expired in the ui store.
  // 'entry': used for boot /auth/me and /auth/login — a 401 is a normal unauthenticated/bad-cred
  //          case and must NOT flag session-expired or push the expired toast.
  authMode?: 'authenticated' | 'entry';
  // Opt-in "Acción no permitida" toast on 403. Interactive mutations (button-triggered saves,
  // transitions, deletes) set it so the user gets feedback; background/probe reads stay silent.
  toastOnForbidden?: boolean;
}

async function performRawApiFetch(
  path: string,
  options: RequestInit = {},
  { authMode = 'authenticated', toastOnForbidden = false }: ApiFetchOptions = {},
): Promise<RawApiResult> {
  const ui = useUiStore();

  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

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
    return { ok: true, status: response.status, data: undefined };
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
    status: response.status,
    data: body.data,
    meta: 'meta' in body ? body.meta : undefined,
  };
}

const inFlightGets = new Map<string, Promise<RawApiResult>>();

export async function apiFetchDecoded<T>(
  decoder: Decoder<T>,
  path: string,
  options: RequestInit = {},
  apiOptions: ApiFetchOptions = {},
): Promise<ApiResult<T>> {
  const method = (options.method ?? 'GET').toUpperCase();
  const canShare = method === 'GET' && !options.signal && !options.body && !options.headers;
  let raw: RawApiResult;
  if (!canShare) {
    raw = await performRawApiFetch(path, options, apiOptions);
  } else {
    const key = `${apiOptions.authMode ?? 'authenticated'}|${apiOptions.toastOnForbidden ?? false}|${path}`;
    const existing = inFlightGets.get(key);
    if (existing) {
      raw = await existing;
    } else {
      const request = performRawApiFetch(path, options, apiOptions);
      inFlightGets.set(key, request);
      void request.finally(() => {
        if (inFlightGets.get(key) === request) inFlightGets.delete(key);
      });
      raw = await request;
    }
  }

  if (!raw.ok) return raw;
  if (!decoder(raw.data)) {
    return { ok: false, status: raw.status, code: 'bad_response', message: 'Unexpected response payload' };
  }
  return { ok: true, data: raw.data, meta: raw.meta };
}
