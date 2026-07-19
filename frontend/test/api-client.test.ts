import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

async function importFresh() {
  // Dynamic import avoids module-level singleton issues.
  const { apiFetchDecoded } = await import('@/api/client');
  const { unknownValue } = await import('@/api/decoders');
  const { useUiStore } = await import('@/stores/ui');
  const apiFetch = (path: string, options?: RequestInit, apiOptions?: Parameters<typeof apiFetchDecoded>[3]) => (
    apiFetchDecoded(unknownValue, path, options, apiOptions)
  );
  return { apiFetch, useUiStore };
}

function isNamedEntity(value: unknown): value is { id: number; name: string } {
  return value !== null
    && typeof value === 'object'
    && 'id' in value
    && typeof value.id === 'number'
    && 'name' in value
    && typeof value.name === 'string';
}

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
    const result = await apiFetchDecoded(isNamedEntity, '/appointments/1');
    expect(result).toEqual({ ok: true, data: { id: 1, name: 'Test' }, meta: undefined });
  });

  it('rejects an enveloped payload that violates the endpoint contract', async () => {
    mockFetch(200, { success: true, data: { id: 'wrong', name: 'Test' } });
    const { apiFetchDecoded } = await import('@/api/client');
    const result = await apiFetchDecoded(isNamedEntity, '/appointments/1');
    expect(result).toEqual({
      ok: false,
      status: 200,
      code: 'bad_response',
      message: 'Unexpected response payload',
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
    const { apiFetchDecoded, getApiMutationGeneration } = await import('@/api/client');
    const { unknownValue } = await import('@/api/decoders');
    const initial = getApiMutationGeneration();
    mockFetch(200, { success: true, data: { id: 1 } });

    await apiFetchDecoded(unknownValue, '/appointments', { method: 'POST' });

    expect(getApiMutationGeneration()).toBe(initial + 1);
  });
});
