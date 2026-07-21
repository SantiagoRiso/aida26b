import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import type { Router } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import type { Role } from '@shared/types/roles';
import NavDrawer from '@/components/staff/NavDrawer.vue';
import { useAuthStore } from '@/stores/auth';

vi.mock('@/router/prefetch', () => ({ prefetchRoute: vi.fn() }));

const NAV_ROUTES = [
  'staff-dashboard', 'staff-calendar', 'staff-schedule', 'staff-requests', 'staff-clients',
  'staff-professionals', 'staff-business', 'staff-users', 'staff-audit', 'staff-profile',
  'staff-settings', 'login',
] as const;

async function makeRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: NAV_ROUTES.map((name) => ({ path: `/${name}`, name, component: { template: '<div/>' } })),
  });
  await router.push({ name: 'staff-dashboard' });
  await router.isReady();
  return router;
}

async function mountDrawer(open: boolean, role: Role = 'Admin') {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.user = {
    id: 1, username: 'admin', email: null, role, business_id: 5,
    is_active: true, must_change_password: false,
  };
  const router = await makeRouter();
  const wrapper = mount(NavDrawer, {
    props: { open },
    attachTo: document.body,
    global: {
      // No teleport stub: the Dialog portals itself, and flattening that makes Headless UI
      // re-register its title id on every pass, which breaks the dialog's accessible name.
      plugins: [createI18n({ legacy: false, locale: 'es', messages: { es, en } }), router],
    },
  });
  await flushPromises();
  return { wrapper, router };
}

function dialogEl(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

function accessibleName(dialog: HTMLElement): string {
  const labelledBy = dialog.getAttribute('aria-labelledby');
  if (!labelledBy) return dialog.getAttribute('aria-label') ?? '';
  return labelledBy
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .join(' ')
    .trim();
}

describe('NavDrawer', () => {
  let mountedDrawers: VueWrapper[] = [];

  beforeEach(() => {
    mountedDrawers.forEach((w) => w.unmount());
    mountedDrawers = [];
    document.body.innerHTML = '';
  });

  it('renders nothing until it is opened', async () => {
    const { wrapper } = await mountDrawer(false);
    mountedDrawers.push(wrapper);
    expect(dialogEl()).toBeNull();
  });

  it('opens as a named dialog carrying the staff navigation', async () => {
    const { wrapper } = await mountDrawer(true);
    mountedDrawers.push(wrapper);

    const dialog = dialogEl();
    expect(dialog).not.toBeNull();
    expect(accessibleName(dialog!)).toBe(es.nav.menu);

    const linkText = [...dialog!.querySelectorAll('a')].map((a) => a.textContent?.trim());
    expect(linkText).toContain(es.nav.clients);
    expect(linkText).toContain(es.nav.calendar);
  });

  it('keeps the sidebar role filtering: a professional gets no admin-only destinations', async () => {
    const { wrapper } = await mountDrawer(true, 'Professional');
    mountedDrawers.push(wrapper);

    const linkText = [...dialogEl()!.querySelectorAll('a')].map((a) => a.textContent?.trim());
    expect(linkText).toContain(es.nav.calendar);
    expect(linkText).not.toContain(es.nav.users);
    expect(linkText).not.toContain(es.nav.audit);
  });

  it('traps focus inside the panel', async () => {
    const { wrapper } = await mountDrawer(true);
    mountedDrawers.push(wrapper);

    // Opening moves focus into the panel rather than leaving it on the shell behind the overlay.
    // That focus cannot then Tab its way out is asserted in a real browser (mobile-shell.spec.ts),
    // since the trap's escape handling depends on layout jsdom does not compute.
    expect(dialogEl()!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('asks to close on Escape', async () => {
    const { wrapper } = await mountDrawer(true);
    mountedDrawers.push(wrapper);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();

    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('asks to close once navigation happens, so the destination is not left covered', async () => {
    const { wrapper, router } = await mountDrawer(true);
    mountedDrawers.push(wrapper);

    await router.push({ name: 'staff-clients' });
    await flushPromises();

    expect(wrapper.emitted('close')).toBeTruthy();
  });
});
