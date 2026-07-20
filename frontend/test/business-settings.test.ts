import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createRouter, createMemoryHistory } from 'vue-router';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import BusinessView from '@/views/staff/BusinessView.vue';
import { useAuthStore } from '@/stores/auth';
import type { getSettings as GetSettings, updateSettings as UpdateSettings } from '@/api/business';

// business-view.test.ts already covers the happy path (prefill, save all three fields, clearing
// the cap) and the max<min rejection. This file fills the one gap the plan calls out that isn't
// covered there: negative-value rejection (min/max booking-days, and the cutoff sharing the same
// nonNegInt gate) — kept in its own file per the plan rather than duplicating the existing cases.
const getSettings = vi.fn();
const updateSettings = vi.fn();
vi.mock('@/api/business', () => ({
  getSettings: (...a: Parameters<typeof GetSettings>) => getSettings(...a),
  updateSettings: (...a: Parameters<typeof UpdateSettings>) => updateSettings(...a),
}));
vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  deleteRow: vi.fn().mockResolvedValue({ ok: true }),
  createRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  updateRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));
vi.mock('@/api/grants', () => ({
  listGrants: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  listGrantableStaff: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  createGrant: vi.fn().mockResolvedValue({ ok: true, data: { id: '1' } }),
  revokeGrant: vi.fn().mockResolvedValue({ ok: true, data: { id: '1', revoked: true } }),
}));
vi.mock('@/api/closures', () => ({
  listClosures: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  createClosure: vi.fn().mockResolvedValue({ ok: true, data: { id: '1' } }),
  deleteClosure: vi.fn().mockResolvedValue({ ok: true, data: { id: '1', deleted: true } }),
}));

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}
function mountAsAdmin() {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.user = {
    id: 1, username: 'a', email: null, role: 'Admin', business_id: 5,
    is_active: true, must_change_password: false,
  };
  // The embedded table binds its list state to the URL, so a router has to be present.
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div/>' } }],
  });
  return mount(BusinessView, { global: { plugins: [makeI18n(), router] } });
}

describe('BusinessView settings — negative-value validation', () => {
  beforeEach(() => {
    getSettings.mockReset();
    updateSettings.mockReset();
    getSettings.mockResolvedValue({
      ok: true,
      data: { id: '5', cancellation_cutoff_hours: 24, min_booking_days: 1, max_booking_days: 30 },
    });
  });

  it('rejects a negative minimum booking days without saving', async () => {
    const wrapper = mountAsAdmin();
    await flushPromises();

    await wrapper.get('#biz-min-days').setValue('-5');
    await wrapper.get('#biz-settings-save').trigger('click');
    await flushPromises();

    expect(updateSettings).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(es.business.valuesNonNegative);
  });

  it('rejects a negative cancellation cutoff without saving', async () => {
    const wrapper = mountAsAdmin();
    await flushPromises();

    await wrapper.get('#biz-cutoff').setValue('-1');
    await wrapper.get('#biz-settings-save').trigger('click');
    await flushPromises();

    expect(updateSettings).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(es.business.valuesNonNegative);
  });

  it('rejects a negative maximum booking days (distinct from the max<min message)', async () => {
    const wrapper = mountAsAdmin();
    await flushPromises();

    // min stays a valid non-negative value so only the max-specific check can fire.
    await wrapper.get('#biz-min-days').setValue('0');
    await wrapper.get('#biz-max-days').setValue('-3');
    await wrapper.get('#biz-settings-save').trigger('click');
    await flushPromises();

    expect(updateSettings).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(es.business.maxDaysInvalid);
  });

  it('a stale error clears once the values are fixed and saved successfully', async () => {
    updateSettings.mockResolvedValue({
      ok: true,
      data: { id: '5', cancellation_cutoff_hours: 24, min_booking_days: 0, max_booking_days: 30 },
    });
    const wrapper = mountAsAdmin();
    await flushPromises();

    await wrapper.get('#biz-min-days').setValue('-5');
    await wrapper.get('#biz-settings-save').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain(es.business.valuesNonNegative);

    await wrapper.get('#biz-min-days').setValue('0');
    await wrapper.get('#biz-settings-save').trigger('click');
    await flushPromises();

    expect(updateSettings).toHaveBeenCalledWith(5, {
      cancellation_cutoff_hours: 24,
      min_booking_days: 0,
      max_booking_days: 30,
    });
    expect(wrapper.text()).not.toContain(es.business.valuesNonNegative);
  });
});
