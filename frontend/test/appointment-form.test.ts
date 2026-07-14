import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import AppointmentForm from '@/components/calendar/AppointmentForm.vue';
import DateField from '@/components/shared/DateField.vue';
import TimeField from '@/components/shared/TimeField.vue';
import type { Appointment } from '@/api/appointments';

// The form pulls its dropdowns and the professional→service map from the CRUD list API;
// stub it so mounting doesn't reach the network.
vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));
// SlotPicker fetches availability on mount when a professional + date are set (reschedule mode).
vi.mock('@/api/scheduling', () => ({
  getAvailability: vi.fn().mockResolvedValue({ ok: true, data: { slots: [] } }),
  getBookingWindow: vi.fn().mockResolvedValue({ ok: true, data: { min_date: '2000-01-01', max_date: null } }),
}));

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

const baseAppointment: Appointment = {
  id: 11,
  // 13:00 UTC — the wall-clock time the form must show is the LOCAL equivalent, not "13:00".
  starts_at: '2026-07-07T13:00:00.000Z',
  ends_at: '2026-07-07T13:50:00.000Z',
  duration_minutes: 50,
  client_user_id: 7,
  professional_user_id: 2,
  service_id: 3,
  resource_id: 1,
  state: 'scheduled',
  name: 'Sesión - Homero',
  description: null,
  price: '6500.00',
  override_conflict: false,
  override_actor_id: null,
  staff_note: null,
  conflict_ignored: false,
};

describe('AppointmentForm reschedule prefill', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('prefills the start time and date from the appointment (local wall-clock, not the UTC slice)', async () => {
    const wrapper = mount(AppointmentForm, {
      props: { appointment: baseAppointment },
      global: { plugins: [makeI18n()] },
    });
    await flushPromises();

    // The wall-clock the rest of the app renders comes from the local Date, not the ISO slice.
    const d = new Date(baseAppointment.starts_at);
    const p = (n: number) => String(n).padStart(2, '0');
    const expectedTime = `${p(d.getHours())}:${p(d.getMinutes())}`;
    const expectedDate = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;

    const duration = wrapper.get('#appt-duration').element as HTMLInputElement;

    // The regression this guards: reschedule used to leave the start field empty, blocking save.
    const startValue = wrapper.findComponent(TimeField).props('modelValue');
    expect(startValue).not.toBe('');
    expect(startValue).toBe(expectedTime);
    // The date is bound to the shared DateField as an ISO 'yyyy-MM-dd' string.
    expect(wrapper.findComponent(DateField).props('modelValue')).toBe(expectedDate);
    expect(duration.value).toBe('50');
  });

  it('opens the manual time/duration inputs in reschedule mode', async () => {
    const wrapper = mount(AppointmentForm, {
      props: { appointment: baseAppointment },
      global: { plugins: [makeI18n()] },
    });
    await flushPromises();
    expect(wrapper.findComponent(TimeField).exists()).toBe(true);
    expect(wrapper.find('#appt-duration').exists()).toBe(true);
  });
});

describe('AppointmentForm day stepper', () => {
  beforeEach(() => setActivePinia(createPinia()));

  // Same local-wall-clock math the component uses, so the expectations hold whenever the suite runs.
  const p = (n: number) => String(n).padStart(2, '0');
  const ymd = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const addDaysISO = (iso: string, days: number) => {
    const [y, m, d] = iso.split('-').map(Number);
    return ymd(new Date(y, m - 1, d + days));
  };
  const today = ymd(new Date());
  const dateOf = (w: ReturnType<typeof mount>) => w.findComponent(DateField).props('modelValue');
  const isDisabled = (w: ReturnType<typeof mount>, aria: string) =>
    (w.get(`button[aria-label="${aria}"]`).element as HTMLButtonElement).disabled;

  it('new booking: ◀ is disabled at today, ▶ advances, and ◀ clamps back to today', async () => {
    const wrapper = mount(AppointmentForm, { global: { plugins: [makeI18n()] } });
    await flushPromises();

    // Empty date → the floor is today, so stepping back is blocked.
    expect(isDisabled(wrapper, 'Día anterior')).toBe(true);

    await wrapper.get('button[aria-label="Día siguiente"]').trigger('click');
    expect(dateOf(wrapper)).toBe(addDaysISO(today, 1));
    expect(isDisabled(wrapper, 'Día anterior')).toBe(false);

    await wrapper.get('button[aria-label="Día anterior"]').trigger('click');
    expect(dateOf(wrapper)).toBe(today);
    // Back at the floor: disabled again, and it never steps into the past.
    expect(isDisabled(wrapper, 'Día anterior')).toBe(true);
  });

  it('reschedule: stepping is not clamped (edits around an existing, possibly past, date)', async () => {
    // baseAppointment sits on 2026-07-07 — in the past relative to "now".
    const wrapper = mount(AppointmentForm, {
      props: { appointment: baseAppointment },
      global: { plugins: [makeI18n()] },
    });
    await flushPromises();

    expect(isDisabled(wrapper, 'Día anterior')).toBe(false);
    const before = dateOf(wrapper) as string;
    await wrapper.get('button[aria-label="Día anterior"]').trigger('click');
    expect(dateOf(wrapper)).toBe(addDaysISO(before, -1));
  });
});
