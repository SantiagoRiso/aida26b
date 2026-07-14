import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { listAppointments, transitionAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { createEntry } from '@/api/ledger';
import { useAuthStore } from '@/stores/auth';
import { useSettleCard } from '@/composables/useSettleCard';
import type { Role } from '@shared/types/roles';

vi.mock('@/api/appointments', () => ({
  listAppointments: vi.fn(),
  transitionAppointment: vi.fn(),
}));
vi.mock('@/api/ledger', () => ({ createEntry: vi.fn() }));

const mockedList = listAppointments as ReturnType<typeof vi.fn>;
const mockedTransition = transitionAppointment as ReturnType<typeof vi.fn>;
const mockedCreateEntry = createEntry as ReturnType<typeof vi.fn>;

function makeAppt(overrides: Partial<Appointment> = {}): Appointment {
  const startsAt = new Date(Date.now() - 10 * 60_000).toISOString();
  return {
    id: 'a1',
    client_user_id: '3',
    professional_user_id: '7',
    resource_id: null,
    service_id: 's1',
    starts_at: startsAt,
    duration_minutes: 30,
    ends_at: new Date(Date.now() + 20 * 60_000).toISOString(),
    state: 'scheduled',
    name: null,
    description: null,
    price: '1500.00',
    override_conflict: false,
    override_actor_id: null,
    staff_note: null,
    created_at: startsAt,
    updated_at: startsAt,
    conflict_ignored: false,
    ...overrides,
  };
}

function mountCard(role: Role = 'Professional', id = 7) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = {
    id,
    username: 'u',
    email: null,
    role,
    business_id: null,
    is_active: true,
    must_change_password: false,
  };

  let card!: ReturnType<typeof useSettleCard>;
  const Host = defineComponent({
    setup() {
      card = useSettleCard();
      return () => null;
    },
  });
  const wrapper = mount(Host, { global: { plugins: [pinia] } });
  return { card, wrapper };
}

beforeEach(() => {
  mockedList.mockReset();
  mockedTransition.mockReset();
  mockedCreateEntry.mockReset();
  mockedList.mockResolvedValue({ ok: true, data: [makeAppt()] });
});

describe('useSettleCard — loading and amounts', () => {
  it('loads candidates on mount and prefills the payment amount with the frozen price', async () => {
    const { card } = mountCard();
    await flushPromises();

    expect(mockedList).toHaveBeenCalledTimes(1);
    expect(card.currentAppointments.value).toHaveLength(1);
    expect(card.amounts.value['a1']).toBe('1500.00');
    expect(card.canSettle(makeAppt())).toBe(true);
  });

  it('keeps an operator-typed amount across the periodic refetch', async () => {
    const { card } = mountCard();
    await flushPromises();

    card.amounts.value['a1'] = '2000';
    await card.loadCurrent();
    expect(card.amounts.value['a1']).toBe('2000');
  });

  it('never loads for admins — they oversee, they do not settle turnos', async () => {
    const { card } = mountCard('Admin');
    await flushPromises();
    expect(card.showsCard.value).toBe(false);
    expect(mockedList).not.toHaveBeenCalled();
  });
});

describe('useSettleCard — settling', () => {
  it('"paid" completes the turno and posts the payment for the typed amount', async () => {
    mockedTransition.mockResolvedValue({ ok: true, data: makeAppt({ state: 'completed' }) });
    mockedCreateEntry.mockResolvedValue({ ok: true, data: {} });

    const { card } = mountCard();
    await flushPromises();
    card.amounts.value['a1'] = ' 1800 ';
    await card.settle(makeAppt(), 'paid');

    expect(mockedTransition).toHaveBeenCalledWith('a1', 'completed');
    expect(mockedCreateEntry).toHaveBeenCalledWith({
      client_user_id: '3',
      entry_type: 'payment',
      amount_ars: '1800',
      appointment_id: 'a1',
    });
  });

  it('"absent" marks a no_show and never posts a payment', async () => {
    mockedTransition.mockResolvedValue({ ok: true, data: makeAppt({ state: 'no_show' }) });

    const { card } = mountCard();
    await flushPromises();
    await card.settle(makeAppt(), 'absent');

    expect(mockedTransition).toHaveBeenCalledWith('a1', 'no_show');
    expect(mockedCreateEntry).not.toHaveBeenCalled();
  });

  it('a failed transition posts nothing — the turno was not completed', async () => {
    mockedTransition.mockResolvedValue({ ok: false, code: 'too_early' });

    const { card } = mountCard();
    await flushPromises();
    await card.settle(makeAppt(), 'paid');

    expect(mockedCreateEntry).not.toHaveBeenCalled();
    expect(card.processing.value['a1']).toBe(false);
  });
});
