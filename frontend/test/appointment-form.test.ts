import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import AppointmentForm from '@/components/calendar/AppointmentForm.vue';
import DateField from '@/components/shared/DateField.vue';
import type { Appointment } from '@/api/appointments';

// The form pulls its dropdowns and the professional→service map from the CRUD list API;
// stub it so mounting doesn't reach the network.
vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));
// SlotPicker fetches availability on mount when a professional + date are set (reschedule mode).
vi.mock('@/api/scheduling', () => ({
  getAvailability: vi.fn().mockResolvedValue({ ok: true, data: { slots: [] } }),
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

    const start = wrapper.get('#appt-start').element as HTMLInputElement;
    const duration = wrapper.get('#appt-duration').element as HTMLInputElement;

    // The regression this guards: reschedule used to leave the start field empty, blocking save.
    expect(start.value).not.toBe('');
    expect(start.value).toBe(expectedTime);
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
    expect(wrapper.find('#appt-start').exists()).toBe(true);
    expect(wrapper.find('#appt-duration').exists()).toBe(true);
  });
});
