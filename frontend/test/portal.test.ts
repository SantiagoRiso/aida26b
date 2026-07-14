import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createRouter, createMemoryHistory } from 'vue-router';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';

import StatusBadge from '@/components/portal/StatusBadge.vue';
import PortalNav from '@/components/portal/PortalNav.vue';

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/portal/appointments', name: 'portal-appointments', component: { template: '<div/>' } },
      { path: '/portal/balance', name: 'portal-balance', component: { template: '<div/>' } },
      { path: '/portal/preferences', name: 'portal-preferences', component: { template: '<div/>' } },
    ],
  });
}

describe('StatusBadge', () => {
  // stateLabel() resolves through useLabel/useUiStore (Pinia), unlike the old plain t() lookup.
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  const states = [
    { state: 'requested', labelEs: 'Solicitado' },
    { state: 'scheduled', labelEs: 'Programado' },
    { state: 'completed', labelEs: 'Completado' },
    { state: 'canceled', labelEs: 'Cancelado' },
    { state: 'no_show', labelEs: 'Ausente' },
    { state: 'rejected', labelEs: 'Rechazado' },
  ];

  for (const { state, labelEs } of states) {
    it(`renders label for state "${state}"`, () => {
      const i18n = makeI18n();
      const wrapper = mount(StatusBadge, {
        props: { state },
        global: { plugins: [i18n] },
      });
      expect(wrapper.text()).toContain(labelEs);
    });
  }

  it('applies blue class for requested state', () => {
    const i18n = makeI18n();
    const wrapper = mount(StatusBadge, {
      props: { state: 'requested' },
      global: { plugins: [i18n] },
    });
    expect(wrapper.html()).toContain('text-blue-700');
  });

  it('applies neutral class for canceled state', () => {
    const i18n = makeI18n();
    const wrapper = mount(StatusBadge, {
      props: { state: 'canceled' },
      global: { plugins: [i18n] },
    });
    expect(wrapper.html()).toContain('text-neutral');
  });

  it('applies neutral class for rejected state', () => {
    const i18n = makeI18n();
    const wrapper = mount(StatusBadge, {
      props: { state: 'rejected' },
      global: { plugins: [i18n] },
    });
    expect(wrapper.html()).toContain('text-neutral');
  });

  it('applies success class for completed state', () => {
    const i18n = makeI18n();
    const wrapper = mount(StatusBadge, {
      props: { state: 'completed' },
      global: { plugins: [i18n] },
    });
    expect(wrapper.html()).toContain('text-success');
  });
});

describe('PortalNav', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders three nav links', async () => {
    const router = makeRouter();
    const i18n = makeI18n();
    await router.push('/portal/appointments');

    const wrapper = mount(PortalNav, {
      global: { plugins: [router, i18n] },
    });

    const links = wrapper.findAll('a');
    expect(links.length).toBe(3);
  });

  it('includes Mis turnos link', async () => {
    const router = makeRouter();
    const i18n = makeI18n();
    await router.push('/portal/appointments');

    const wrapper = mount(PortalNav, {
      global: { plugins: [router, i18n] },
    });

    expect(wrapper.html()).toContain('Mis turnos');
  });

  // "Solicitar turno" is no longer a nav tab — it's a button on the appointments dashboard.
  it('does not include a Solicitar turno nav link', async () => {
    const router = makeRouter();
    const i18n = makeI18n();
    await router.push('/portal/appointments');

    const wrapper = mount(PortalNav, {
      global: { plugins: [router, i18n] },
    });

    expect(wrapper.html()).not.toContain('Solicitar turno');
  });
});

describe('isCancelable logic', () => {
  // Mirrors AppointmentsView's cancel gate so it can be tested without mounting the view.
  const CUTOFF_HOURS = 24;

  function isCancelable(state: string, startsAt: string): boolean {
    if (state === 'requested') return true;
    if (state !== 'scheduled') return false;
    const d = new Date(startsAt);
    const hoursUntil = (d.getTime() - Date.now()) / (1000 * 60 * 60);
    return hoursUntil > CUTOFF_HOURS;
  }

  it('requested appointments are always cancelable', () => {
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
    expect(isCancelable('requested', farFuture)).toBe(true);
  });

  it('requested appointments past due date are still cancelable (withdraw)', () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString();
    expect(isCancelable('requested', pastDate)).toBe(true);
  });

  it('scheduled appointment > 24h in future is cancelable', () => {
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString();
    expect(isCancelable('scheduled', farFuture)).toBe(true);
  });

  it('scheduled appointment within 24h is NOT cancelable', () => {
    const nearFuture = new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString();
    expect(isCancelable('scheduled', nearFuture)).toBe(false);
  });

  it('scheduled appointment in the past is NOT cancelable', () => {
    const past = new Date(Date.now() - 1000 * 60 * 60 * 1).toISOString();
    expect(isCancelable('scheduled', past)).toBe(false);
  });

  it('completed appointments are not cancelable', () => {
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString();
    expect(isCancelable('completed', farFuture)).toBe(false);
  });

  it('canceled appointments are not cancelable again', () => {
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString();
    expect(isCancelable('canceled', farFuture)).toBe(false);
  });
});

describe('Portal route configuration', () => {
  it('portal-routes exports three routes', async () => {
    const { default: portalRoutes } = await import('@/router/portal-routes');
    expect(portalRoutes.length).toBe(3);
  });

  it('all portal routes require authentication', async () => {
    const { default: portalRoutes } = await import('@/router/portal-routes');
    for (const route of portalRoutes) {
      expect(route.meta?.requiresAuth).toBe(true);
    }
  });

  it('all portal routes are restricted to Client role', async () => {
    const { default: portalRoutes } = await import('@/router/portal-routes');
    for (const route of portalRoutes) {
      const roles = route.meta?.roles as string[] | undefined;
      expect(roles).toContain('Client');
    }
  });

  it('portal-appointments route is named portal-appointments', async () => {
    const { default: portalRoutes } = await import('@/router/portal-routes');
    const route = portalRoutes.find((r) => r.name === 'portal-appointments');
    expect(route).toBeDefined();
    expect(route!.name).toBe('portal-appointments');
    // Must be a lazy-import function, not a static PlaceholderView object.
    expect(typeof route!.component).toBe('function');
  });
});
