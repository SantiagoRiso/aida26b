import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { getRow, listRows } from '@/api/crud';
import { listAppointments } from '@/api/appointments';
import { getBalance, getLedger } from '@/api/ledger';
import { resetFkOptionsCache } from '@/composables/useForeignKeyOptions';
import { useAuthStore } from '@/stores/auth';
import ClientDetail from '@/components/staff/ClientDetail.vue';

vi.mock('@/api/crud', () => ({
  getRow: vi.fn(),
  listRows: vi.fn(),
  deleteRow: vi.fn(),
}));
vi.mock('@/api/appointments', () => ({
  listAppointments: vi.fn(),
  transitionAppointment: vi.fn(),
}));
vi.mock('@/api/ledger', () => ({
  getBalance: vi.fn(),
  getLedger: vi.fn(),
}));

const mockedGetRow = getRow as ReturnType<typeof vi.fn>;
const mockedListRows = listRows as ReturnType<typeof vi.fn>;
const mockedListAppointments = listAppointments as ReturnType<typeof vi.fn>;
const mockedGetBalance = getBalance as ReturnType<typeof vi.fn>;
const mockedGetLedger = getLedger as ReturnType<typeof vi.fn>;

// Children unrelated to this fix: stubbed so their own network calls/dialog chrome (Headless UI
// renders empty under jsdom) don't entangle this test with a different component's behavior.
const stubs = {
  ClientPricesSection: true,
  GenericForm: true,
  AppointmentForm: true,
  ConflictOverrideDialog: true,
  LedgerEntryForm: true,
  DetailPanel: true,
  ConfirmDialog: true,
};

function mountDetail() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = {
    id: 1, username: 'admin', email: null, role: 'Admin',
    business_id: null, is_active: true, must_change_password: false,
  };
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  return mount(ClientDetail, {
    props: { clientId: 3 },
    global: { plugins: [pinia, i18n], stubs },
  });
}

describe('ClientDetail — a professional/service the roster does not carry', () => {
  beforeEach(() => {
    resetFkOptionsCache();
    vi.clearAllMocks();
    mockedGetRow.mockResolvedValue({
      ok: true,
      data: { id: '3', display_name: 'Homero Simpson', dni: null, email: 'h@demo.test', phone: null, notes: null },
    });
    // The FK-options roster (professionals/services) never carries the ids the pending
    // appointment below references — both stay unresolved.
    mockedListRows.mockResolvedValue({ ok: true, data: [] });
    mockedGetBalance.mockResolvedValue({ ok: true, data: { client_user_id: '3', balance_ars: '0.00' } });
    mockedGetLedger.mockResolvedValue({ ok: true, data: [] });
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const futureEnd = new Date(future.getTime() + 30 * 60 * 1000);
    mockedListAppointments.mockResolvedValue({
      ok: true,
      data: [{
        id: '5', client_user_id: '3', professional_user_id: '999', resource_id: null, service_id: '888',
        starts_at: future.toISOString(), duration_minutes: 30, ends_at: futureEnd.toISOString(),
        state: 'scheduled', name: null, description: null, price: '100.00',
        override_conflict: false, override_actor_id: null, staff_note: null, conflict_ignored: false,
        created_at: future.toISOString(), updated_at: future.toISOString(),
        series_id: null, occurrence_date: null,
      }],
    });
  });

  it('renders the shared unresolved-reference label, never a raw #id, for the pending appointment row', async () => {
    const w = mountDetail();
    await flushPromises();
    await flushPromises();

    const pendingSection = w.text();
    expect(pendingSection).toContain(es.generic.unresolvedReference);
    expect(pendingSection).not.toContain('#999');
    expect(pendingSection).not.toContain('#888');
  });
});
