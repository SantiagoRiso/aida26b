import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { listRows } from '@/api/crud';
import { listAppointments } from '@/api/appointments';
import { useAuthStore, type AuthUser } from '@/stores/auth';
import { useBookingOptions } from '@/composables/useBookingOptions';

vi.mock('@/api/crud', () => ({ listRows: vi.fn() }));
vi.mock('@/api/appointments', () => ({ listAppointments: vi.fn() }));
const mockListRows = vi.mocked(listRows);
const mockListAppointments = vi.mocked(listAppointments);

const professionals = [
  { id: '1', display_name: 'Dra. Marge Bouvier', bio: 'Psicóloga' },
  { id: '2', display_name: 'Dr. Zoidberg', bio: null },
  { id: '3', display_name: 'Dr. Arnie Pye', bio: null },
];
const services = [
  { id: '10', name: 'Sesión de Psicología Infantil' },
  { id: '20', name: 'Consulta nutricional' },
  { id: '30', name: 'Sesión de kinesiología' },
];
const profServices = [
  { professional_user_id: '1', service_id: '10' },
  { professional_user_id: '1', service_id: '20' },
  { professional_user_id: '2', service_id: '30' },
];
const clients = [
  { id: '7', display_name: 'Homero Simpson', dni: '11222333' },
  { id: '8', display_name: 'Ned Flanders', dni: null },
];

function mockTables() {
  mockListRows.mockImplementation((table) => {
    const data =
      table === 'professionals' ? professionals
      : table === 'services' ? services
      : table === 'professional_services' ? profServices
      : table === 'clients' ? clients
      : [];
    return Promise.resolve({ ok: true, data } as never);
  });
}

function setUser(user: Partial<AuthUser> | null) {
  const auth = useAuthStore();
  auth.user = user
    ? ({
        id: 0,
        username: 'u',
        email: null,
        role: 'Admin',
        business_id: null,
        is_active: true,
        must_change_password: false,
        ...user,
      } as AuthUser)
    : null;
}

beforeEach(() => {
  setActivePinia(createPinia());
  mockListRows.mockReset();
  mockListAppointments.mockReset();
  mockTables();
  mockListAppointments.mockResolvedValue({ ok: true, data: [] } as never);
});

describe('useBookingOptions — professional scoping', () => {
  it('a Professional viewer sees only their own option', async () => {
    setUser({ id: 2, role: 'Professional' });
    const { professionalOptions } = useBookingOptions();
    await flushPromises();

    expect(professionalOptions.value).toEqual([{ value: '2', label: 'Dr. Zoidberg' }]);
  });

  it('other roles see every professional, in fetch order', async () => {
    setUser({ id: 99, role: 'Admin' });
    const { professionalOptions } = useBookingOptions();
    await flushPromises();

    expect(professionalOptions.value.map((o) => o.value)).toEqual(['1', '2', '3']);
  });
});

describe('useBookingOptions — offered-services fallback', () => {
  it('returns every service when no professional is selected', async () => {
    setUser(null);
    const selected = ref<string | null>(null);
    const { availableServiceOptions } = useBookingOptions({
      selectedProfessionalId: () => selected.value,
    });
    await flushPromises();

    expect(availableServiceOptions.value).toHaveLength(3);
  });

  it('narrows to the chosen professional’s offerings', async () => {
    setUser(null);
    const selected = ref<string | null>('1');
    const { availableServiceOptions } = useBookingOptions({
      selectedProfessionalId: () => selected.value,
    });
    await flushPromises();

    expect(availableServiceOptions.value.map((o) => o.label)).toEqual([
      'Sesión de Psicología Infantil',
      'Consulta nutricional',
    ]);
  });

  it('falls back to every service for a professional with no mapping', async () => {
    setUser(null);
    const { availableServices } = useBookingOptions({ selectedProfessionalId: () => '3' });
    await flushPromises();

    expect(availableServices.value).toHaveLength(3);
  });
});

describe('useBookingOptions — recency ranking', () => {
  const day = 86400000;

  function appts(rows: { prof: string; agoDays: number }[]) {
    mockListAppointments.mockResolvedValue({
      ok: true,
      data: rows.map((r, i) => ({
        id: String(i + 1),
        professional_user_id: r.prof,
        starts_at: new Date(Date.now() - r.agoDays * day).toISOString(),
      })),
    } as never);
  }

  it('recently seen professionals come first (most recent → oldest), the rest alphabetical', async () => {
    setUser({ id: 7, role: 'Client' });
    appts([
      { prof: '2', agoDays: 30 },
      { prof: '1', agoDays: 3 },
    ]);
    const { rankedProfessionals } = useBookingOptions({ rankByRecency: true });
    await flushPromises();

    // 1 (3 days ago), 2 (30 days ago), then 3 alphabetically alone.
    expect(rankedProfessionals.value.map((p) => p.id)).toEqual(['1', '2', '3']);
  });

  it('interactions older than a year do not rank', async () => {
    setUser({ id: 7, role: 'Client' });
    appts([{ prof: '2', agoDays: 400 }]);
    const { rankedProfessionals } = useBookingOptions({ rankByRecency: true });
    await flushPromises();

    // No live recency → purely alphabetical by display name.
    expect(rankedProfessionals.value.map((p) => p.display_name)).toEqual([
      'Dr. Arnie Pye',
      'Dr. Zoidberg',
      'Dra. Marge Bouvier',
    ]);
  });

  it('keeps the most recent interaction per professional', async () => {
    setUser({ id: 7, role: 'Client' });
    appts([
      { prof: '3', agoDays: 200 },
      { prof: '3', agoDays: 2 },
      { prof: '1', agoDays: 10 },
    ]);
    const { rankedProfessionals } = useBookingOptions({ rankByRecency: true });
    await flushPromises();

    expect(rankedProfessionals.value.map((p) => p.id)).toEqual(['3', '1', '2']);
  });

  it('does not fetch the appointment history unless opted in', async () => {
    setUser({ id: 7, role: 'Client' });
    useBookingOptions();
    await flushPromises();

    expect(mockListAppointments).not.toHaveBeenCalled();
  });
});

describe('useBookingOptions — client roster', () => {
  it('decorates client options with the DNI (empty string when missing)', async () => {
    setUser({ id: 99, role: 'Admin' });
    const { clientOptions } = useBookingOptions({ withClients: true });
    await flushPromises();

    expect(clientOptions.value).toEqual([
      { value: '7', label: 'Homero Simpson', dni: '11222333' },
      { value: '8', label: 'Ned Flanders', dni: '' },
    ]);
  });

  it('does not fetch the roster unless opted in', async () => {
    setUser({ id: 99, role: 'Admin' });
    useBookingOptions();
    await flushPromises();

    expect(mockListRows).not.toHaveBeenCalledWith('clients', expect.anything());
  });
});
