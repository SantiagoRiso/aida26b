import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { arrayOf, numberValue, object, optional, stringValue, undefinedValue, union } from '@/api/decoders';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

async function importFresh() {
  // Dynamic import avoids module-level singleton issues.
  const { apiFetchDecoded } = await import('@/api/client');
  const { useUiStore } = await import('@/stores/ui');
  const apiFetch = (path: string, options?: RequestInit, apiOptions?: Parameters<typeof apiFetchDecoded>[3]) => (
    apiFetchDecoded(transportPayload, path, options, apiOptions)
  );
  return { apiFetch, useUiStore };
}

const namedEntity = object<{ id: number; name: string }>({ id: numberValue, name: stringValue });
const basicEntity = object<{ id: number; name?: string }>({ id: numberValue, name: optional(stringValue) });
const authPayload = object<{ user: { id: number; username: string; role: string } }>({
  user: object({ id: numberValue, username: stringValue, role: stringValue }),
});
const transportPayload = union(undefinedValue, union(basicEntity, union(authPayload, arrayOf(basicEntity))));

function mockFetch<T>(status: number, body: T, headers?: Record<string, string>) {
  const responseBody = body === undefined ? '' : JSON.stringify(body);
  const res = new Response(responseBody || null, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
}

describe('enveloped success — data object', () => {
  it('returns ok:true with data', async () => {
    mockFetch(200, { success: true, data: { id: 1, name: 'Test' } });
    const { apiFetch } = await importFresh();
    const result = await apiFetch('/appointments/1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ id: 1, name: 'Test' });
      expect(result.meta).toBeUndefined();
    }
  });
});

describe('decoded payload contract', () => {
  it('accepts data matching the endpoint decoder', async () => {
    mockFetch(200, { success: true, data: { id: 1, name: 'Test' } });
    const { apiFetchDecoded } = await import('@/api/client');
    const result = await apiFetchDecoded(namedEntity, '/appointments/1');
    expect(result).toEqual({ ok: true, data: { id: 1, name: 'Test' }, meta: undefined });
  });

  it('rejects a successful response with an unexpected endpoint status', async () => {
    mockFetch(201, { success: true, data: { id: 1, name: 'Test' } });
    const { apiFetchDecoded } = await import('@/api/client');
    const result = await apiFetchDecoded(namedEntity, '/appointments/1', {}, { successStatuses: [200] });
    expect(result).toEqual({
      ok: false,
      status: 201,
      code: 'bad_response',
      message: 'Unexpected response status',
      diagnostic: '$status: expected 200, received 201',
    });
  });

  it('rejects an enveloped payload that violates the endpoint contract', async () => {
    mockFetch(200, { success: true, data: { id: 'wrong', name: 'Test' } });
    const { apiFetchDecoded } = await import('@/api/client');
    const result = await apiFetchDecoded(namedEntity, '/appointments/1');
    expect(result).toEqual({
      ok: false,
      status: 200,
      code: 'bad_response',
      message: 'Unexpected response payload',
      diagnostic: '$.id: expected finite number',
    });
  });

  it('reports the endpoint and field path without exposing it as the user message', async () => {
    mockFetch(200, { success: true, data: { id: 'wrong', name: 'Test' } });
    const { apiFetchDecoded } = await import('@/api/client');
    const { setApiContractFailureReporter } = await import('@/api/contract-validation');
    const reporter = vi.fn();
    const restore = setApiContractFailureReporter(reporter);
    try {
      await apiFetchDecoded(namedEntity, '/appointments/1');
    } finally {
      restore();
    }
    expect(reporter).toHaveBeenCalledWith({
      path: '/appointments/1',
      status: 200,
      diagnostic: '$.id: expected finite number',
    });
  });
});

describe('enveloped success — list with meta', () => {
  it('returns ok:true with data array and meta', async () => {
    mockFetch(200, {
      success: true,
      data: [{ id: 1 }, { id: 2 }],
      meta: { page: 1, limit: 20, total: 2 },
    });
    const { apiFetch } = await importFresh();
    const result = await apiFetch('/appointments');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.meta).toEqual({ page: 1, limit: 20, total: 2 });
    }
  });
});

describe('enveloped error', () => {
  it('returns ok:false with code and message', async () => {
    mockFetch(400, {
      success: false,
      error: { code: 'validation_error', message: 'Invalid field', fields: { name: 'Required' } },
    });
    const { apiFetch } = await importFresh();
    const result = await apiFetch('/appointments', { method: 'POST' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('validation_error');
      expect(result.message).toBe('Invalid field');
      expect(result.fields).toEqual({ name: 'Required' });
    }
  });

  it('carries the translation keys through to the caller', async () => {
    mockFetch(403, {
      success: false,
      error: {
        code: 'forbidden',
        message: 'Professional may only manage their own calendar grants',
        detail: { key: 'grantOwnCalendarOnly' },
        fields: { name: 'name must be at most 80 characters' },
        fieldDetails: { name: { key: 'maxLength', params: { max: 80 } } },
      },
    });
    const { apiFetch } = await importFresh();
    const result = await apiFetch('/grants', { method: 'POST' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toEqual({ key: 'grantOwnCalendarOnly' });
      expect(result.fieldDetails).toEqual({ name: { key: 'maxLength', params: { max: 80 } } });
    }
  });

  // A malformed key must not cost us the error itself; code and prose still arrive.
  it('drops unusable translation keys instead of rejecting the envelope', async () => {
    mockFetch(400, {
      success: false,
      error: {
        code: 'invalid_request',
        message: 'Invalid field',
        detail: { params: { max: 80 } },
        fieldDetails: { name: 'required' },
      },
    });
    const { apiFetch } = await importFresh();
    const result = await apiFetch('/appointments', { method: 'POST' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_request');
      expect(result.detail).toBeUndefined();
      expect(result.fieldDetails).toBeUndefined();
    }
  });

  it('keeps only the interpolation values it can render', async () => {
    mockFetch(400, {
      success: false,
      error: {
        code: 'invalid_request',
        message: 'Invalid field',
        detail: { key: 'maxLength', params: { max: 80, nested: { bad: true } } },
      },
    });
    const { apiFetch } = await importFresh();
    const result = await apiFetch('/appointments', { method: 'POST' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toEqual({ key: 'maxLength', params: { max: 80 } });
  });
});

describe('auth route success', () => {
  it('resolves the enveloped { user } payload as ok:true data', async () => {
    const user = { id: 1, username: 'demo_admin', role: 'Admin' };
    mockFetch(200, { success: true, data: { user } });
    const { apiFetch } = await importFresh();
    const result = await apiFetch('/auth/me');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ user });
    }
  });
});

describe('auth route error', () => {
  it('returns ok:false on a 401', async () => {
    mockFetch(401, { success: false, error: { code: 'invalid_credentials', message: 'Invalid credentials' } });
    const { apiFetch } = await importFresh();
    const result = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({}) }, { authMode: 'entry' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });
});

describe('401 on authenticated route', () => {
  it('calls flagSessionExpired and returns ok:false', async () => {
    mockFetch(401, { error: 'Session expired' });
    const { apiFetch, useUiStore } = await importFresh();
    const ui = useUiStore();
    const flagSpy = vi.spyOn(ui, 'flagSessionExpired');

    const result = await apiFetch('/appointments', {}, { authMode: 'authenticated' });

    expect(flagSpy).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });
});

describe('401 on entry-mode route', () => {
  it('does not call flagSessionExpired and returns ok:false', async () => {
    mockFetch(401, { error: 'Invalid credentials' });
    const { apiFetch, useUiStore } = await importFresh();
    const ui = useUiStore();
    const flagSpy = vi.spyOn(ui, 'flagSessionExpired');

    const result = await apiFetch('/auth/login', { method: 'POST' }, { authMode: 'entry' });

    expect(flagSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it('does not push a sessionExpired toast', async () => {
    mockFetch(401, { error: 'Invalid credentials' });
    const { apiFetch, useUiStore } = await importFresh();
    const ui = useUiStore();

    await apiFetch('/auth/me', {}, { authMode: 'entry' });

    const sessionToasts = ui.toasts.filter((t) => t.messageKey === 'sessionExpired');
    expect(sessionToasts).toHaveLength(0);
  });
});

describe('403 with toastOnForbidden', () => {
  it('pushes exactly one notPermitted toast and returns ok:false', async () => {
    mockFetch(403, { success: false, error: { code: 'forbidden', message: 'Forbidden' } });
    const { apiFetch, useUiStore } = await importFresh();
    const ui = useUiStore();
    const toastSpy = vi.spyOn(ui, 'toast');

    const result = await apiFetch('/admin/users/999/deactivate', { method: 'POST' }, { toastOnForbidden: true });

    expect(toastSpy).toHaveBeenCalledWith('error', 'notPermitted');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });
});

describe('403 without toastOnForbidden (default)', () => {
  it('stays silent — background/probe reads must not flash a toast', async () => {
    mockFetch(403, { success: false, error: { code: 'forbidden', message: 'Forbidden' } });
    const { apiFetch, useUiStore } = await importFresh();
    const ui = useUiStore();
    const toastSpy = vi.spyOn(ui, 'toast');

    const result = await apiFetch('/appointments');

    expect(toastSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });
});

describe('non-JSON (HTML) response guard', () => {
  it('returns ok:false bad_response instead of throwing on an HTML body', async () => {
    // A stale-cached app-shell or dev-proxy hiccup can serve HTML for an /api GET.
    const res = new Response('<!doctype html><html><body>oops</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    const { apiFetch } = await importFresh();
    const result = await apiFetch('/professionals?limit=200');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('bad_response');
      expect(result.status).toBe(200);
    }
  });
});

describe('transport failure', () => {
  it('resolves to a structured failure instead of rejecting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { apiFetch } = await importFresh();

    const result = await apiFetch('/appointments');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('network_error');
      // No response ever arrived, so there is no HTTP status to report.
      expect(result.status).toBe(0);
    }
  });

  it('reads through the same translation ladder as an enveloped error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { apiFetch } = await importFresh();
    const { apiErrorMessage } = await import('@/i18n/api-errors');
    const { es } = await import('@/i18n/es');

    const result = await apiFetch('/appointments');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(apiErrorMessage(result)).toBe(es.apiError.code.network_error);
  });

  it('stays silent — a failed background load must not toast', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { apiFetch, useUiStore } = await importFresh();
    const ui = useUiStore();
    const toastSpy = vi.spyOn(ui, 'toast');

    await apiFetch('/appointments');

    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('does not flag the session as expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { apiFetch, useUiStore } = await importFresh();
    const ui = useUiStore();

    await apiFetch('/appointments', {}, { authMode: 'authenticated' });

    expect(ui.sessionExpired).toBe(false);
  });

  // A caller that aborts its own request replaces it; callers discard that rejection themselves.
  it('still rejects when the caller aborts', async () => {
    const abort = new DOMException('The user aborted a request.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    const { apiFetch } = await importFresh();
    const controller = new AbortController();

    await expect(apiFetch('/appointments', { signal: controller.signal })).rejects.toThrow(/aborted/);
  });
});

describe('cache policy', () => {
  it('requests API data with cache: no-store', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = await importFresh();
    await apiFetch('/professionals');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/professionals'),
      expect.objectContaining({ cache: 'no-store' }),
    );
  });
});

describe('in-flight GET coalescing', () => {
  it('shares an identical concurrent GET and releases it after completion', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = await importFresh();

    const first = apiFetch('/services?limit=500');
    const second = apiFetch('/services?limit=500');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await Promise.all([first, second]);
    await apiFetch('/services?limit=500');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not share abortable requests', async () => {
    mockFetch(200, { success: true, data: [] });
    const { apiFetch } = await importFresh();
    const signal = new AbortController().signal;
    await Promise.all([apiFetch('/services', { signal }), apiFetch('/services', { signal })]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('204 No Content response', () => {
  it('returns ok:true with undefined data without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const { apiFetch } = await importFresh();
    const result = await apiFetch('/auth/logout', { method: 'POST' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeUndefined();
    }
  });
});

describe('mutation generation', () => {
  it('advances only after successful writes', async () => {
    const { apiFetchDecoded } = await import('@/api/client');
    const { getApiMutationGeneration } = await import('@/api/mutation-generation');
    const initial = getApiMutationGeneration();
    mockFetch(200, { success: true, data: { id: 1 } });

    await apiFetchDecoded(basicEntity, '/appointments', { method: 'POST' });

    expect(getApiMutationGeneration()).toBe(initial + 1);
  });
});
