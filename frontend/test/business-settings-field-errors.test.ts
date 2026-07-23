import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createRouter, createMemoryHistory } from 'vue-router';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useUiStore } from '@/stores/ui';
import BusinessView from '@/views/staff/BusinessView.vue';
import { useAuthStore } from '@/stores/auth';
import type { getSettings as GetSettings, updateSettings as UpdateSettings } from '@/api/business';

// The settings PATCH now returns `fieldDetails` keyed by the column it rejects (max_booking_days →
// maxBookingBelowMin, min_booking_days → nonNegativeInteger). These prove BusinessView places that
// per-field reason on the field, and falls back to the top-level code when no field detail exists.

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
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div/>' } }],
  });
  return mount(BusinessView, { global: { plugins: [makeI18n(), router] } });
}

describe('BusinessView: server field reasons land on their fields', () => {
  beforeEach(() => {
    getSettings.mockReset();
    updateSettings.mockReset();
    getSettings.mockResolvedValue({
      ok: true,
      data: { id: '5', cancellation_cutoff_hours: 24, min_booking_days: 1, max_booking_days: 30 },
    });
  });

  // Values that pass the client-side precheck (min <= max) but the server still rejects — so the
  // per-field reason must come from the response, not local validation.
  it('places maxBookingBelowMin on the max-days field', async () => {
    updateSettings.mockResolvedValue({
      ok: false, status: 422, code: 'validation_error', message: 'invalid',
      fieldDetails: { max_booking_days: { key: 'maxBookingBelowMin' } },
    });

    const wrapper = mountAsAdmin();
    await flushPromises();
    await wrapper.get('#biz-settings-save').trigger('click');
    await flushPromises();

    expect(wrapper.get('#biz-max-days-error').text()).toBe(es.fieldError.maxBookingBelowMin);
    // Not a toast, and not the generic error.
    expect(useUiStore().toasts.at(-1)?.messageKey).not.toBe(es.toast.genericError);
  });

  it('places nonNegativeInteger on the min-days field', async () => {
    updateSettings.mockResolvedValue({
      ok: false, status: 422, code: 'validation_error', message: 'invalid',
      fieldDetails: { min_booking_days: { key: 'nonNegativeInteger' } },
    });

    const wrapper = mountAsAdmin();
    await flushPromises();
    await wrapper.get('#biz-settings-save').trigger('click');
    await flushPromises();

    expect(wrapper.get('#biz-min-days-error').text()).toBe(es.fieldError.nonNegativeInteger);
  });

  // No per-field detail: fall back to the translated top-level code, not the opaque generic toast.
  it('falls back to the top-level code when the rejection carries no field detail', async () => {
    updateSettings.mockResolvedValue({
      ok: false, status: 403, code: 'forbidden', message: 'nope',
    });

    const wrapper = mountAsAdmin();
    await flushPromises();
    await wrapper.get('#biz-settings-save').trigger('click');
    await flushPromises();

    expect(useUiStore().toasts.at(-1)?.messageKey).toBe(es.apiError.code.forbidden);
  });
});
