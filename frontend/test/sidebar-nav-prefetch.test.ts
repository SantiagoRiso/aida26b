import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import SidebarNav from '@/components/staff/SidebarNav.vue';
import { useAuthStore } from '@/stores/auth';
import { prefetchRoute } from '@/router/prefetch';

vi.mock('@/router/prefetch', () => ({ prefetchRoute: vi.fn() }));

const NAV_ROUTES = [
  'staff-dashboard', 'staff-calendar', 'staff-schedule', 'staff-requests', 'staff-clients',
  'staff-professionals', 'staff-business', 'staff-users', 'staff-audit', 'staff-profile',
  'staff-settings',
] as const;

async function mountNav() {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.user = {
    id: 1, username: 'admin', email: null, role: 'Admin', business_id: 5,
    is_active: true, must_change_password: false,
  };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: NAV_ROUTES.map((name) => ({ path: `/${name}`, name, component: { template: '<div/>' } })),
  });
  await router.push({ name: 'staff-dashboard' });
  await router.isReady();
  const wrapper = mount(SidebarNav, {
    global: {
      plugins: [createI18n({ legacy: false, locale: 'es', messages: { es, en } }), router],
    },
  });
  await flushPromises();
  return wrapper;
}

describe('SidebarNav route warming', () => {
  beforeEach(() => {
    vi.mocked(prefetchRoute).mockClear();
  });

  it('warms the hovered destination for a mouse', async () => {
    const wrapper = await mountNav();
    const clients = wrapper.findAll('a').find((a) => a.text() === es.nav.clients);

    await clients!.trigger('pointerenter', { pointerType: 'mouse' });

    expect(prefetchRoute).toHaveBeenCalledWith(expect.anything(), { name: 'staff-clients' });
  });

  it('stays quiet on a touch pointer, where there is no hover to act on', async () => {
    const wrapper = await mountNav();
    const clients = wrapper.findAll('a').find((a) => a.text() === es.nav.clients);

    await clients!.trigger('pointerenter', { pointerType: 'touch' });

    expect(prefetchRoute).not.toHaveBeenCalled();
  });

  it('still warms on keyboard focus, so the warm path is not pointer-only', async () => {
    const wrapper = await mountNav();
    const audit = wrapper.findAll('a').find((a) => a.text() === es.nav.audit);

    await audit!.trigger('focus');

    expect(prefetchRoute).toHaveBeenCalledWith(expect.anything(), { name: 'staff-audit' });
  });
});
