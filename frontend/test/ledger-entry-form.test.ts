import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { listAppointments } from '@/api/appointments';
import { createEntry } from '@/api/ledger';
import { useAuthStore } from '@/stores/auth';
import type { Role } from '@shared/types/roles';
import LedgerEntryForm from '@/components/ledger/LedgerEntryForm.vue';

vi.mock('@/api/appointments', () => ({ listAppointments: vi.fn() }));
vi.mock('@/api/ledger', () => ({ createEntry: vi.fn() }));

const mockedList = listAppointments as ReturnType<typeof vi.fn>;
const mockedCreateEntry = createEntry as ReturnType<typeof vi.fn>;

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

function mountAs(role: Role) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = {
    id: 7,
    username: 'u',
    email: 'u@demo.test',
    role,
    business_id: 1,
    is_active: true,
    must_change_password: false,
  };
  return mount(LedgerEntryForm, {
    props: { clientUserId: 3 },
    global: { plugins: [pinia, makeI18n()] },
  });
}

function typeOptions(wrapper: ReturnType<typeof mountAs>): string[] {
  return wrapper
    .findAll('select')[0]
    .findAll('option')
    .map((o) => o.attributes('value') ?? '')
    .filter((v) => v !== '');
}

beforeEach(() => {
  mockedList.mockResolvedValue({
    ok: true,
    data: [
      {
        id: 'a1',
        client_user_id: '3',
        professional_user_id: '7',
        service_id: 's1',
        resource_id: null,
        starts_at: '2026-07-21T13:40:00.000Z',
        duration_minutes: 50,
        state: 'scheduled',
        name: 'Sesión',
        description: null,
        price: '6500.00',
        series_id: null,
        occurrence_date: null,
      },
    ],
  });
  mockedCreateEntry.mockResolvedValue({ ok: true, data: {} });
});

describe('LedgerEntryForm — entry types by role', () => {
  it('offers a receptionist both charge and payment, and nothing else', () => {
    const wrapper = mountAs('Receptionist');
    expect(typeOptions(wrapper)).toEqual(['charge', 'payment']);
  });

  it('offers an admin every entry type', () => {
    const wrapper = mountAs('Admin');
    expect(typeOptions(wrapper)).toEqual([
      'charge',
      'payment',
      'adjustment_debit',
      'adjustment_credit',
    ]);
  });

  it('offers a professional every entry type', () => {
    const wrapper = mountAs('Professional');
    expect(typeOptions(wrapper)).toHaveLength(4);
  });
});

describe('LedgerEntryForm — appointment link', () => {
  it('requires the appointment on a receptionist payment', async () => {
    const wrapper = mountAs('Receptionist');
    await wrapper.findAll('select')[0].setValue('payment');
    await flushPromises();

    const selects = wrapper.findAll('select');
    expect(selects).toHaveLength(2);
    expect(selects[1].attributes('required')).toBeDefined();
  });

  it('leaves an admin payment unallocated, with no appointment picker', async () => {
    const wrapper = mountAs('Admin');
    await wrapper.findAll('select')[0].setValue('payment');
    await flushPromises();

    expect(wrapper.findAll('select')).toHaveLength(1);
  });

  it('blocks a receptionist payment submitted without an appointment', async () => {
    const wrapper = mountAs('Receptionist');
    await wrapper.findAll('select')[0].setValue('payment');
    await flushPromises();
    await wrapper.find('input[inputmode="decimal"]').setValue('100.00');

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(mockedCreateEntry).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(es.ledger.appointmentRequired);
  });

  it('sends a receptionist payment once the appointment is chosen', async () => {
    const wrapper = mountAs('Receptionist');
    await wrapper.findAll('select')[0].setValue('payment');
    await flushPromises();
    await wrapper.findAll('select')[1].setValue('a1');
    await wrapper.find('input[inputmode="decimal"]').setValue('100.00');

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(mockedCreateEntry).toHaveBeenCalledWith({
      client_user_id: 3,
      entry_type: 'payment',
      amount_ars: '100.00',
      appointment_id: 'a1',
    });
  });
});

describe('LedgerEntryForm — amount defaulting', () => {
  it('prefills a charge from the appointment price', async () => {
    const wrapper = mountAs('Receptionist');
    await wrapper.findAll('select')[0].setValue('charge');
    await flushPromises();
    await wrapper.findAll('select')[1].setValue('a1');
    await flushPromises();

    expect((wrapper.find('input[inputmode="decimal"]').element as HTMLInputElement).value)
      .toBe('6500.00');
  });

  // A payment may be partial, so inheriting the full booked price would quietly overstate it.
  it('does not prefill a payment from the appointment price', async () => {
    const wrapper = mountAs('Receptionist');
    await wrapper.findAll('select')[0].setValue('payment');
    await flushPromises();
    await wrapper.findAll('select')[1].setValue('a1');
    await flushPromises();

    expect((wrapper.find('input[inputmode="decimal"]').element as HTMLInputElement).value).toBe('');
  });

  it('requires an explicit amount on a payment', async () => {
    const wrapper = mountAs('Receptionist');
    await wrapper.findAll('select')[0].setValue('payment');
    await flushPromises();
    await wrapper.findAll('select')[1].setValue('a1');
    await flushPromises();

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(mockedCreateEntry).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(es.ledger.amountRequired);
  });
});
