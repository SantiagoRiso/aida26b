import { useUiStore } from '@/stores/ui';
import { API_PREFIX } from '@shared/ssot/api-paths';
import type { ListMeta } from '@shared/ssot/envelope';
import type { Decoder } from '@/api/decoders';
import { parseEnvelope } from '@/api/envelope-parser';
import { recordApiMutation } from '@/api/mutation-generation';
import { validateResponseContract } from '@/api/contract-validation';
import type { ApiResult } from '@/api/result';

export type { ApiResult } from '@/api/result';

type RawApiResult =
  // eslint-disable-next-line no-restricted-syntax -- Data remains untrusted until the endpoint decoder accepts it.
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
  successStatuses?: readonly number[];
}

// A response must arrive within this bound; past it the request is abandoned and reported as a
// failure, so a hung socket can never leave a view stuck in `loading` forever. Generous enough
// that a slow-but-live request still completes.
const REQUEST_TIMEOUT_MS = 20_000;

async function performRawApiFetch(
  path: string,
  options: RequestInit = {},
  { authMode = 'authenticated', toastOnForbidden = false }: ApiFetchOptions = {},
): Promise<RawApiResult> {
  const ui = useUiStore();

  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  // Own the abort so a slow request can be timed out; chain the caller's signal in so a caller
  // replacing its own request still cancels the fetch. `timedOut` distinguishes our timeout (a
  // reportable failure) from a caller abort (rethrown, since the caller discards it itself).
  const callerSignal = options.signal ?? undefined;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  // API responses carry live data and must never be served from the HTTP cache. A cached stale
  // response (e.g. an index.html served during a dev-proxy hiccup) otherwise poisons GETs.
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, { ...options, headers, signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
  } catch (error) {
    // No response within the bound: surface like any other unreachable-server failure so the
    // caller stops loading instead of awaiting forever.
    if (timedOut) return { ok: false, status: 0, code: 'network_error', message: 'Request timed out' };
    // An abort is the caller replacing its own request, not a failure — callers that pass a signal
    // discard the rejection themselves, and turning it into a result would look like a real error.
    if ((error instanceof DOMException || error instanceof Error) && error.name === 'AbortError') throw error;
    // Offline, DNS failure, TLS refusal, server unreachable: no response ever existed, so there is
    // no HTTP status to report. Callers read this like any other failure instead of a rejection.
    return { ok: false, status: 0, code: 'network_error', message: 'Network request failed' };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }

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
    if ((options.method ?? 'GET').toUpperCase() !== 'GET') recordApiMutation();
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
      detail: body.error.detail,
      fields: body.error.fields,
      fieldDetails: body.error.fieldDetails,
    };
  }
  if ((options.method ?? 'GET').toUpperCase() !== 'GET') recordApiMutation();
  return {
    ok: true,
    status: response.status,
    data: body.data,
    meta: 'meta' in body ? body.meta : undefined,
  };
}

const inFlightGets = new Map<string, Promise<RawApiResult>>();

// Test seam only: drop any coalescing keys still held by requests that a test left in flight,
// so one test's pending GET can't be shared into the next. Production never calls this — a live
// coalesced request already removes its own key on settle (identity-checked), and clearing an
// entry the owning request no longer matches is a no-op there.
export function resetApiClientState(): void {
  inFlightGets.clear();
}

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
  return validateResponseContract({
    decoder, path, method, status: raw.status, data: raw.data, meta: raw.meta,
    successStatuses: apiOptions.successStatuses,
  });
}
