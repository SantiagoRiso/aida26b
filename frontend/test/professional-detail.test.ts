import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { getRow, listRows } from '@/api/crud';
import { listAppointments } from '@/api/appointments';
import { resetFkOptionsCache } from '@/composables/useForeignKeyOptions';
import { useAuthStore } from '@/stores/auth';
import ProfessionalDetail from '@/components/staff/ProfessionalDetail.vue';

vi.mock('@/api/crud', () => ({
  getRow: vi.fn(),
  listRows: vi.fn(),
  deleteRow: vi.fn(),
}));
vi.mock('@/api/appointments', () => ({
  listAppointments: vi.fn(),
}));

const mockedGetRow = getRow as ReturnType<typeof vi.fn>;
const mockedListRows = listRows as ReturnType<typeof vi.fn>;
const mockedListAppointments = listAppointments as ReturnType<typeof vi.fn>;

function mountDetail() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = {
    id: 1, username: 'admin', email: null, role: 'Admin',
    business_id: null, is_active: true, must_change_password: false,
  };
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  return mount(ProfessionalDetail, {
    props: { professionalId: 10 },
    global: { plugins: [pinia, i18n] },
  });
}

describe('ProfessionalDetail — a client/service the roster does not carry', () => {
  beforeEach(() => {
    resetFkOptionsCache();
    vi.clearAllMocks();
    mockedGetRow.mockResolvedValue({ ok: true, data: { id: '10', display_name: 'Dr. Uno', bio: null } });
    // Neither the FK-options roster (clients) nor the local services map carries the ids the
    // upcoming appointment below references — both stay unresolved.
    mockedListRows.mockResolvedValue({ ok: true, data: [] });
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const futureEnd = new Date(future.getTime() + 30 * 60 * 1000);
    mockedListAppointments.mockResolvedValue({
      ok: true,
      data: [{
        id: '5', client_user_id: '999', professional_user_id: '10', resource_id: null, service_id: '999',
        starts_at: future.toISOString(), duration_minutes: 30, ends_at: futureEnd.toISOString(),
        state: 'scheduled', name: null, description: null, price: '100.00',
        override_conflict: false, override_actor_id: null, staff_note: null, conflict_ignored: false,
        created_at: future.toISOString(), updated_at: future.toISOString(),
        series_id: null, occurrence_date: null,
      }],
    });
  });

  it('renders the shared unresolved-reference label, never a raw #id', async () => {
    const w = mountDetail();
    await flushPromises();
    await flushPromises();

    expect(w.text()).toContain(es.generic.unresolvedReference);
    expect(w.text()).not.toContain('#999');
  });
});
