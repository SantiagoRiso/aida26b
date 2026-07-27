import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import type { TableKey } from '@shared/ssot/derived';
import { listRows } from '@/api/crud';
import { listRowsFrom } from './helpers/api-fixtures';
import { resetFkOptionsCache } from '@/composables/useForeignKeyOptions';
import SidebarNav from '@/components/staff/SidebarNav.vue';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import TimeField from '@/components/shared/TimeField.vue';
import GenericFilters from '@/components/generic/GenericFilters.vue';
import { useAuthStore } from '@/stores/auth';

vi.mock('@/router/prefetch', () => ({ prefetchRoute: vi.fn() }));
vi.mock('@/api/crud', () => ({ listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }) }));

function i18nPlugin() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

describe('language is declared to assistive tech, not just applied to the UI', () => {
  beforeEach(() => {
    localStorage.removeItem('language');
    document.documentElement.lang = 'es';
  });

  it('setLanguage stamps <html lang> alongside the locale, so pronunciation follows the content', async () => {
    setActivePinia(createPinia());
    const { useUiStore } = await import('@/stores/ui');
    const ui = useUiStore();

    ui.setLanguage('en');
    expect(document.documentElement.lang).toBe('en');

    ui.setLanguage('es');
    expect(document.documentElement.lang).toBe('es');
  });
});

describe('SidebarNav — the current page is announced, not only coloured', () => {
  async function mountNav(current: string) {
    setActivePinia(createPinia());
    const auth = useAuthStore();
    auth.user = {
      id: 1, username: 'admin', email: null, role: 'Admin', business_id: 5,
      is_active: true, must_change_password: false,
    };
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        'staff-dashboard', 'staff-calendar', 'staff-schedule', 'staff-requests', 'staff-clients',
        'staff-professionals', 'staff-business', 'staff-users', 'staff-audit', 'staff-profile',
        'staff-settings',
      ].map((name) => ({ path: `/${name}`, name, component: { template: '<div/>' } })),
    });
    await router.push({ name: current });
    await router.isReady();
    const wrapper = mount(SidebarNav, { global: { plugins: [i18nPlugin(), router] } });
    await flushPromises();
    return wrapper;
  }

  it('marks only the active destination with aria-current', async () => {
    const wrapper = await mountNav('staff-clients');
    const links = wrapper.findAll('a');

    const current = links.filter((a) => a.attributes('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0].text()).toBe(es.nav.clients);
  });

  it('moves aria-current with the route', async () => {
    const wrapper = await mountNav('staff-audit');
    const current = wrapper.findAll('a').filter((a) => a.attributes('aria-current') === 'page');
    expect(current[0].text()).toBe(es.nav.audit);
  });

  it('names the navigation landmark', async () => {
    const wrapper = await mountNav('staff-dashboard');
    expect(wrapper.get('nav').attributes('aria-label')).toBe(es.nav.mainLabel);
  });
});

describe('Skeleton — announces loading in the UI language', () => {
  it.each(['row', 'tile', 'grid'] as const)('%s variant carries a localized status label', (variant) => {
    const wrapper = mount(Skeleton, { props: { variant }, global: { plugins: [i18nPlugin()] } });
    const root = wrapper.get('div');
    expect(root.attributes('role')).toBe('status');
    expect(root.attributes('aria-busy')).toBe('true');
    expect(root.attributes('aria-label')).toBe(es.loading);
  });
});

describe('EmptyState — a list going empty is announced', () => {
  it('is a live status region', () => {
    const wrapper = mount(EmptyState, { global: { plugins: [i18nPlugin()] } });
    expect(wrapper.get('div').attributes('role')).toBe('status');
  });
});

describe('GenericFilters — every filter control has an accessible name', () => {
  beforeEach(() => {
    resetFkOptionsCache();
    vi.mocked(listRows).mockImplementation(listRowsFrom({
      businesses: [{
        id: 'biz-1', name: 'Clínica Central', timezone: 'America/Argentina/Buenos_Aires',
        currency_code: 'ARS', min_booking_days: null, max_booking_days: null,
      }],
    }));
  });

  // Super-admin: the business column exercised below is only offered to a viewer who spans tenants.
  function mountFilters(tableKey: TableKey) {
    const pinia = createPinia();
    setActivePinia(pinia);
    useAuthStore(pinia).user = {
      id: 1, username: 'admin', email: null, role: 'Admin',
      business_id: null, is_active: true, must_change_password: false,
    };
    return mount(GenericFilters, { props: { tableKey }, global: { plugins: [i18nPlugin()] } });
  }

  async function addFilter(wrapper: ReturnType<typeof mountFilters>, field: string) {
    await wrapper.get(`select[aria-label="${es.generic.selectColumnAria}"]`).setValue(field);
    await wrapper.get('button').trigger('click');
    await flushPromises();
  }

  it('ties the field name to the referenced-row picker, which otherwise has no name at all', async () => {
    const wrapper = mountFilters('users' as TableKey);
    await addFilter(wrapper, 'business_id');

    const label = wrapper.get('label[for]');
    const input = wrapper.get(`input#${label.attributes('for')}`);
    expect(input.attributes('placeholder')).toBe(es.generic.all);
  });

  it('ties the field name to a text filter box', async () => {
    const wrapper = mountFilters('services' as TableKey);
    await addFilter(wrapper, 'name');

    const label = wrapper.get('label[for]');
    const input = wrapper.get(`input#${label.attributes('for')}`);
    expect(input.attributes('placeholder')).toBe(es.generic.filterPlaceholder);
  });

  it('names the remove button, which reads as a bare glyph otherwise', async () => {
    const wrapper = mountFilters('services' as TableKey);
    await addFilter(wrapper, 'name');

    const remove = wrapper.findAll('button').find((b) => b.text() === '✕');
    expect(remove!.attributes('aria-label')).toContain('Nombre');
  });
});

describe('TimeField — the adjuster is reachable and the arrows follow the caret', () => {
  function mountField(modelValue: string) {
    return mount(TimeField, {
      props: { modelValue, id: 'start' },
      attachTo: document.body,
      global: { plugins: [i18nPlugin()] },
    });
  }

  async function openPopover(wrapper: ReturnType<typeof mountField>) {
    await wrapper.get('input').trigger('focus');
  }

  it('leaves the stepper buttons in the tab order', async () => {
    const wrapper = mountField('10:00');
    await openPopover(wrapper);

    const steppers = wrapper.findAll('button');
    expect(steppers).toHaveLength(4);
    for (const button of steppers) expect(button.attributes('tabindex')).toBeUndefined();
  });

  it('adjusts the hour when the caret is in the hour half', async () => {
    const wrapper = mountField('10:00');
    const input = wrapper.get('input');
    (input.element as HTMLInputElement).setSelectionRange(1, 1);

    await input.trigger('keydown', { key: 'ArrowUp' });

    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['11:00']);
  });

  it('adjusts the minutes when the caret is past the colon', async () => {
    const wrapper = mountField('10:00');
    const input = wrapper.get('input');
    (input.element as HTMLInputElement).setSelectionRange(4, 4);

    await input.trigger('keydown', { key: 'ArrowUp' });
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['10:05']);

    (input.element as HTMLInputElement).setSelectionRange(4, 4);
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['10:00']);
  });

  it('still normalizes a partial value when focus moves into the adjuster', async () => {
    const wrapper = mountField('');
    const input = wrapper.get('input');
    await input.trigger('focus');
    await input.setValue('9:3');

    await input.trigger('blur');

    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['09:30']);
  });
});
