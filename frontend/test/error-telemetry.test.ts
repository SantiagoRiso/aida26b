import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { installErrorTelemetry, installGlobalErrorHandlers } from '@/global-errors';
import { numberValue, object, stringValue } from '@/api/decoders';
import { API_PREFIX, telemetryPaths } from '@shared/ssot/api-paths';
import { BROWSER_ERROR_MAX_FIELD_CHARS, BROWSER_ERROR_MAX_PER_PAGE_LOAD } from '@shared/ssot/telemetry';
import type { BrowserErrorReport } from '@shared/ssot/telemetry';

const INGEST_PATH = `${API_PREFIX}${telemetryPaths.browserError()}`;

let restoreTelemetry: (() => void) | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

afterEach(() => {
  restoreTelemetry?.();
  restoreTelemetry = null;
  vi.unstubAllGlobals();
});

// Each install owns a fresh per-page-load budget, so a test starts with a clean one.
function installWithStubbedFetch(apiResponses: Response[] = []) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...apiResponses];
  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url === INGEST_PATH) return Promise.resolve(new Response(null, { status: 204 }));
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return Promise.resolve(next);
  });
  vi.stubGlobal('fetch', fetchMock);
  restoreTelemetry = installErrorTelemetry();
  return {
    reports: () => calls
      .filter((call) => call.url === INGEST_PATH)
      .map((call) => JSON.parse(String(call.init.body)) as BrowserErrorReport),
  };
}

function enveloped(status: number, body: object) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('browser errors reach the server once telemetry is installed', () => {
  it('sends an error that escaped a component render', async () => {
    const { reports } = installWithStubbedFetch();
    const Boom = { setup() { throw new Error('render exploded'); }, template: '<div/>' };
    const app = createApp(Boom);
    try {
      installGlobalErrorHandlers(app);
      app.mount(document.createElement('div'));
    } finally {
      app.unmount();
    }

    expect(reports()).toEqual([
      { source: 'render', message: 'Error: render exploded', page: window.location.pathname, context: 'setup function' },
    ]);
  });

  it('sends an unhandled promise rejection', () => {
    const { reports } = installWithStubbedFetch();
    const app = createApp({ template: '<div/>' });
    installGlobalErrorHandlers(app);
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), {
      reason: new Error('nobody caught me'),
    }));

    expect(reports()).toEqual([
      { source: 'promise', message: 'Error: nobody caught me', page: window.location.pathname },
    ]);
  });

  it('sends a response that failed its decoder, naming the endpoint and the field', async () => {
    const { reports } = installWithStubbedFetch([
      enveloped(200, { success: true, data: { id: 'wrong', name: 'Test' } }),
    ]);
    const { apiFetchDecoded } = await import('@/api/client');
    const decoder = object<{ id: number; name: string }>({ id: numberValue, name: stringValue });

    const result = await apiFetchDecoded(decoder, '/appointments/1');

    expect(result.ok).toBe(false);
    expect(reports()).toEqual([{
      source: 'contract',
      message: '$.id: expected finite number',
      path: '/appointments/1',
      status: 200,
      page: window.location.pathname,
    }]);
  });
});

describe('what is deliberately not sent', () => {
  // A 4xx is the server answering correctly and the user being told something normal. The
  // server already logged it, so re-reporting it would only duplicate a record it already holds.
  it('says nothing about an ordinary 403', async () => {
    const { reports } = installWithStubbedFetch([
      enveloped(403, { success: false, error: { code: 'forbidden', message: 'Forbidden' } }),
    ]);
    const { apiFetchDecoded } = await import('@/api/client');
    const decoder = object<{ id: number }>({ id: numberValue });

    const result = await apiFetchDecoded(decoder, '/appointments/1');

    expect(result.ok).toBe(false);
    expect(reports()).toEqual([]);
  });

  it('says nothing about a validation 400', async () => {
    const { reports } = installWithStubbedFetch([
      enveloped(400, { success: false, error: { code: 'invalid_request', message: 'Bad', fields: { name: 'required' } } }),
    ]);
    const { apiFetchDecoded } = await import('@/api/client');
    const decoder = object<{ id: number }>({ id: numberValue });

    await apiFetchDecoded(decoder, '/services', { method: 'POST', body: '{}' });

    expect(reports()).toEqual([]);
  });
});

describe('the browser bounds what it sends', () => {
  it('reports a repeating failure once, not once per occurrence', () => {
    const { reports } = installWithStubbedFetch();
    const app = createApp({ template: '<div/>' });
    installGlobalErrorHandlers(app);
    for (let i = 0; i < 10; i += 1) {
      window.dispatchEvent(Object.assign(new Event('unhandledrejection'), {
        reason: new Error('same every frame'),
      }));
    }

    expect(reports()).toHaveLength(1);
  });

  it('stops after the per-page-load cap even when every failure is different', () => {
    const { reports } = installWithStubbedFetch();
    const app = createApp({ template: '<div/>' });
    installGlobalErrorHandlers(app);
    for (let i = 0; i < BROWSER_ERROR_MAX_PER_PAGE_LOAD + 5; i += 1) {
      window.dispatchEvent(Object.assign(new Event('unhandledrejection'), {
        reason: new Error(`distinct ${i}`),
      }));
    }

    expect(reports()).toHaveLength(BROWSER_ERROR_MAX_PER_PAGE_LOAD);
  });

  it('clips a runaway message before it leaves the browser', () => {
    const { reports } = installWithStubbedFetch();
    const app = createApp({ template: '<div/>' });
    installGlobalErrorHandlers(app);
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), {
      reason: new Error('B'.repeat(BROWSER_ERROR_MAX_FIELD_CHARS + 400)),
    }));

    expect(reports()[0].message).toHaveLength(BROWSER_ERROR_MAX_FIELD_CHARS);
  });

  it('never lets a failed report become a second failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    restoreTelemetry = installErrorTelemetry();
    const app = createApp({ template: '<div/>' });
    installGlobalErrorHandlers(app);

    expect(() => {
      window.dispatchEvent(Object.assign(new Event('unhandledrejection'), {
        reason: new Error('offline'),
      }));
    }).not.toThrow();
    await Promise.resolve();
  });
});
