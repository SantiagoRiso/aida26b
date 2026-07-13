import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import BusinessView from '@/views/staff/BusinessView.vue';
import { useAuthStore } from '@/stores/auth';
import type { getSettings as GetSettings, updateSettings as UpdateSettings } from '@/api/business';

const getSettings = vi.fn();
const updateSettings = vi.fn();
vi.mock('@/api/business', () => ({
  getSettings: (...a: Parameters<typeof GetSettings>) => getSettings(...a),
  updateSettings: (...a: Parameters<typeof UpdateSettings>) => updateSettings(...a),
}));
// CrudSection lists rows via the CRUD API; stub so the page mounts offline.
vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  deleteRow: vi.fn().mockResolvedValue({ ok: true }),
  createRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  updateRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));
// The calendar-permissions accordion mounts CalendarGrantsSection even while collapsed (v-show);
// stub so it doesn't hit the network offline.
vi.mock('@/api/grants', () => ({
  listGrants: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  listGrantableStaff: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  createGrant: vi.fn().mockResolvedValue({ ok: true, data: { id: '1' } }),
  revokeGrant: vi.fn().mockResolvedValue({ ok: true, data: { id: '1', revoked: true } }),
}));
// The business-closures accordion mounts BusinessClosuresSection (v-show); stub so it stays offline.
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
  auth.user = { id: 1, username: 'a', role: 'Admin', business_id: 5 } as never;
  return mount(BusinessView, { global: { plugins: [makeI18n()] } });
}

describe('BusinessView settings form', () => {
  beforeEach(() => {
    getSettings.mockReset();
    updateSettings.mockReset();
    getSettings.mockResolvedValue({
      ok: true,
      data: { id: '5', cancellation_cutoff_hours: 24, min_booking_days: 1, max_booking_days: 30 },
    });
    updateSettings.mockResolvedValue({
      ok: true,
      data: { id: '5', cancellation_cutoff_hours: 24, min_booking_days: 1, max_booking_days: 30 },
    });
  });

  it('prefills from getSettings and saves all three fields', async () => {
    const wrapper = mountAsAdmin();
    await flushPromises();

    const min = wrapper.get('#biz-min-days').element as HTMLInputElement;
    expect(min.value).toBe('1');

    await wrapper.get('#biz-max-days').setValue('45');
    await wrapper.get('#biz-settings-save').trigger('click');
    await flushPromises();

    expect(updateSettings).toHaveBeenCalledWith(5, {
      cancellation_cutoff_hours: 24,
      min_booking_days: 1,
      max_booking_days: 45,
    });
  });

  it('clears the cap when max is emptied', async () => {
    const wrapper = mountAsAdmin();
    await flushPromises();

    await wrapper.get('#biz-max-days').setValue('');
    await wrapper.get('#biz-settings-save').trigger('click');
    await flushPromises();

    expect(updateSettings).toHaveBeenCalledWith(5, {
      cancellation_cutoff_hours: 24,
      min_booking_days: 1,
      max_booking_days: null,
    });
  });

  it('blocks save and shows an error when max < min', async () => {
    const wrapper = mountAsAdmin();
    await flushPromises();
    await wrapper.get('#biz-min-days').setValue('10');
    await wrapper.get('#biz-max-days').setValue('5');
    await wrapper.get('#biz-settings-save').trigger('click');
    await flushPromises();

    expect(updateSettings).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('mayor o igual');
  });
});
