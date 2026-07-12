import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

async function importFresh() {
  // Dynamic import avoids module-level singleton issues.
  const { apiFetch } = await import('@/api/client');
  const { useUiStore } = await import('@/stores/ui');
  return { apiFetch, useUiStore };
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
    const result = await apiFetch<{ id: number; name: string }>('/appointments/1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ id: 1, name: 'Test' });
      expect(result.meta).toBeUndefined();
    }
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
    const result = await apiFetch<{ id: number }[]>('/appointments');
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
    const result = await apiFetch<{ user: typeof user }>('/auth/me');
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

describe('403 on any route', () => {
  it('pushes exactly one notPermitted toast and returns ok:false', async () => {
    mockFetch(403, { success: false, error: { code: 'forbidden', message: 'Forbidden' } });
    const { apiFetch, useUiStore } = await importFresh();
    const ui = useUiStore();
    const toastSpy = vi.spyOn(ui, 'toast');

    const result = await apiFetch('/admin/users/999/deactivate', { method: 'POST' });

    expect(toastSpy).toHaveBeenCalledWith('error', 'notPermitted');
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
