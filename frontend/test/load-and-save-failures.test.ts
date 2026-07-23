import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createRouter, createMemoryHistory } from 'vue-router';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { apiFailure, apiSuccess } from './helpers/api-fixtures';

vi.mock('@/api/ledger', () => ({ getBalance: vi.fn(), getLedger: vi.fn() }));
vi.mock('@/api/profile', () => ({ getMyProfile: vi.fn(), updateMyProfile: vi.fn() }));
vi.mock('@/api/crud', () => ({
  listRows: vi.fn(),
  getRow: () => Promise.resolve({ ok: false, status: 404, code: 'not_found', message: 'not found' }),
  updateRow: vi.fn(),
  createRow: vi.fn(),
  deleteRow: vi.fn(),
}));
vi.mock('@/api/appointments', () => ({ listAppointments: vi.fn(), listRelatedClientIds: vi.fn() }));
vi.mock('@/api/audit', () => ({ listAudit: vi.fn() }));

import BalanceView from '@/views/portal/BalanceView.vue';
import ProfileView from '@/views/staff/ProfileView.vue';
import { getBalance, getLedger } from '@/api/ledger';
import { getMyProfile, updateMyProfile } from '@/api/profile';
import { listRows, updateRow } from '@/api/crud';
import { listAppointments } from '@/api/appointments';
import { listAudit } from '@/api/audit';
import { useAdminDashboard } from '@/composables/useAdminDashboard';
import { useProfessionalDashboard } from '@/composables/useProfessionalDashboard';
import { useReceptionistDashboard } from '@/composables/useReceptionistDashboard';

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

// BalanceView keeps its page and chosen order in the URL, so it needs a router to mount.
function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div/>' } }] });
}

function signIn(role: 'Client' | 'Professional') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  auth.user = {
    id: 1,
    username: 'demo',
    email: null,
    role,
    business_id: 1,
    is_active: true,
    must_change_password: false,
  };
  return pinia;
}

describe('BalanceView — a failed load never reads as a settled account', () => {
  beforeEach(() => vi.resetAllMocks());

  function mountBalance() {
    const pinia = signIn('Client');
    return mount(BalanceView, { global: { plugins: [pinia, makeRouter(), makeI18n()] } });
  }

  it('says the balance could not be loaded instead of showing a dash', async () => {
    vi.mocked(getBalance).mockResolvedValue(apiFailure('internal', 'boom'));
    vi.mocked(getLedger).mockResolvedValue(apiSuccess([]));

    const wrapper = mountBalance();
    await flushPromises();

    expect(wrapper.text()).toContain(es.portal.balanceLoadError);
    // Either verdict would be a claim about money the server never confirmed.
    expect(wrapper.text()).not.toContain(es.portal.balanceOk);
    expect(wrapper.text()).not.toContain(es.portal.balanceDue);
    expect(wrapper.text()).not.toContain('boom');
  });

  it('says the entries could not be loaded instead of "sin movimientos"', async () => {
    vi.mocked(getBalance).mockResolvedValue(apiSuccess({ client_user_id: '1', balance_ars: '0.00' }));
    vi.mocked(getLedger).mockResolvedValue(apiFailure('internal', 'boom'));

    const wrapper = mountBalance();
    await flushPromises();

    expect(wrapper.text()).toContain(es.portal.ledgerLoadErrorHeading);
    expect(wrapper.text()).not.toContain(es.portal.noLedgerHeading);
  });

  it('an account that really is settled and empty still reads that way', async () => {
    vi.mocked(getBalance).mockResolvedValue(apiSuccess({ client_user_id: '1', balance_ars: '0.00' }));
    vi.mocked(getLedger).mockResolvedValue(apiSuccess([]));

    const wrapper = mountBalance();
    await flushPromises();

    expect(wrapper.text()).toContain(es.portal.balanceOk);
    expect(wrapper.text()).toContain(es.portal.noLedgerHeading);
    expect(wrapper.text()).not.toContain(es.portal.balanceLoadError);
  });

});

describe('ProfileView — a rejected save says so', () => {
  beforeEach(() => vi.resetAllMocks());

  const PROFILE = {
    profile: { id: '1', display_name: 'Dra. Ana', bio: null, email: null, phone: null },
  };
  const OFFERING = {
    id: 'ps-1', professional_user_id: '1', service_id: '9',
    min_booking_days: null, max_booking_days: null,
  };

  function mountProfile() {
    const pinia = signIn('Professional');
    return mount(ProfileView, {
      global: {
        plugins: [pinia, makeI18n()],
        stubs: { CalendarGrantsSection: true, MyExceptionsSection: true },
      },
    });
  }

  it('surfaces a rejected per-service write instead of leaving the edit looking saved', async () => {
    vi.mocked(getMyProfile).mockResolvedValue(apiSuccess(PROFILE));
    vi.mocked(listRows).mockResolvedValue(apiSuccess([OFFERING]));
    vi.mocked(updateRow).mockResolvedValue(apiFailure('forbidden', 'Forbidden', 403));

    const wrapper = mountProfile();
    await flushPromises();

    const saveButtons = wrapper.findAll('button').filter((b) => b.text() === es.actions.save);
    await saveButtons[saveButtons.length - 1]!.trigger('click');
    await flushPromises();

    expect(wrapper.findAllComponents({ name: 'FieldError' }).some((c) => c.text().length > 0)).toBe(true);
    // The server's English prose never reaches the screen.
    expect(wrapper.text()).not.toContain('Forbidden');
  });

  it('surfaces a rejected profile save', async () => {
    vi.mocked(getMyProfile).mockResolvedValue(apiSuccess(PROFILE));
    vi.mocked(listRows).mockResolvedValue(apiSuccess([]));
    vi.mocked(updateMyProfile).mockResolvedValue(apiFailure('internal', 'boom'));

    const wrapper = mountProfile();
    await flushPromises();

    await wrapper.get('#pf-save').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain(es.profile.saveError);
  });

  it('a failed profile load is reported, not rendered as an empty profile', async () => {
    vi.mocked(getMyProfile).mockResolvedValue(apiFailure('internal', 'boom'));
    vi.mocked(listRows).mockResolvedValue(apiSuccess([]));

    const wrapper = mountProfile();
    await flushPromises();

    expect(wrapper.text()).toContain(es.profile.loadError);
  });

  it('a failed services load is not "no services assigned"', async () => {
    vi.mocked(getMyProfile).mockResolvedValue(apiSuccess(PROFILE));
    vi.mocked(listRows).mockResolvedValue(apiFailure('internal', 'boom'));

    const wrapper = mountProfile();
    await flushPromises();

    expect(wrapper.text()).toContain(es.profile.servicesLoadError);
    expect(wrapper.text()).not.toContain(es.profile.noServices);
  });
});

describe('staff dashboards — a failed load is flagged, not shown as an empty day', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setActivePinia(createPinia());
  });

  it('professional', async () => {
    vi.mocked(listAppointments).mockResolvedValue(apiFailure('internal', 'boom'));
    const { proLoadFailed, proUpcoming, loadingPro, loadProfessional } = useProfessionalDashboard();
    await loadProfessional();

    expect(proLoadFailed.value).toBe(true);
    expect(proUpcoming.value).toEqual([]);
    expect(loadingPro.value).toBe(false);
  });

  it('receptionist', async () => {
    vi.mocked(listAppointments).mockResolvedValue(apiFailure('internal', 'boom'));
    const { recLoadFailed, loadReceptionist } = useReceptionistDashboard();
    await loadReceptionist();

    expect(recLoadFailed.value).toBe(true);
  });

  it('admin', async () => {
    vi.mocked(listAppointments).mockResolvedValue(apiFailure('internal', 'boom'));
    vi.mocked(listAudit).mockResolvedValue(apiFailure('internal', 'boom'));
    const { adminLoadFailed, adminTodayCount, loadAdmin } = useAdminDashboard();
    await loadAdmin();

    expect(adminLoadFailed.value).toBe(true);
    expect(adminTodayCount.value).toBe(0);
  });

  it('a successful load leaves the flag down', async () => {
    vi.mocked(listAppointments).mockResolvedValue(apiSuccess([]));
    const { recLoadFailed, loadReceptionist } = useReceptionistDashboard();
    await loadReceptionist();

    expect(recLoadFailed.value).toBe(false);
  });

  it('a rejected request still clears the spinner', async () => {
    vi.mocked(listAppointments).mockRejectedValue(new TypeError('Failed to fetch'));
    const { loadingRec, loadReceptionist } = useReceptionistDashboard();
    await expect(loadReceptionist()).rejects.toThrow();

    expect(loadingRec.value).toBe(false);
  });
});
