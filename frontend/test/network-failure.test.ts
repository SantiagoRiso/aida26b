import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { installGlobalErrorHandlers, setUncaughtFailureReporter } from '@/global-errors';
import type { UncaughtFailure } from '@/global-errors';
import AuditView from '@/views/staff/AuditView.vue';

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountAuditView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  auth.user = {
    id: 1,
    username: 'staff',
    email: null,
    role: 'Admin',
    business_id: 5,
    is_active: true,
    must_change_password: false,
  };

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div/>' } }],
  });
  await router.push('/');
  await router.isReady();

  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  const wrapper = mount(AuditView, {
    global: { plugins: [pinia, router, i18n], stubs: { DateField: true } },
  });
  await flushPromises();
  return wrapper;
}

describe('a list view whose load hits a dead network', () => {
  it('leaves the loading state and reports the failure inline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const wrapper = await mountAuditView();

    expect(wrapper.findComponent({ name: 'Skeleton' }).exists()).toBe(false);
    expect(wrapper.text()).toContain(es.audit.errorHeading);
    // An empty table would misreport the record as "no events".
    expect(wrapper.text()).not.toContain(es.audit.emptyHeading);
  });
});

describe('global error handlers', () => {
  it('reports an error thrown during render instead of losing it', () => {
    const reported: UncaughtFailure[] = [];
    const restore = setUncaughtFailureReporter((failure) => { reported.push(failure); });
    const Boom = { setup() { throw new Error('render exploded'); }, template: '<div/>' };
    const app = createApp(Boom);
    try {
      installGlobalErrorHandlers(app);
      app.mount(document.createElement('div'));
    } finally {
      app.unmount();
      restore();
    }

    expect(reported).toHaveLength(1);
    expect(reported[0].source).toBe('render');
    expect(reported[0].message).toBe('Error: render exploded');
  });

  it('reports an unhandled promise rejection', () => {
    const reported: UncaughtFailure[] = [];
    const restore = setUncaughtFailureReporter((failure) => { reported.push(failure); });
    const app = createApp({ template: '<div/>' });
    try {
      installGlobalErrorHandlers(app);
      window.dispatchEvent(Object.assign(new Event('unhandledrejection'), {
        reason: new Error('nobody caught me'),
      }));
    } finally {
      restore();
    }

    expect(reported).toContainEqual({ source: 'promise', message: 'Error: nobody caught me' });
  });
});
