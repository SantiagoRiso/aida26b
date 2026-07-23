import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import type { Appointment } from '@/api/appointments';

// The backend now carries the runtime cutoff hours in an error's `detail`; these prove each
// consumer surfaces that interpolated number instead of a generic, number-less line.

vi.mock('@/api/appointments', () => ({
  listAppointments: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  transitionAppointment: vi.fn(),
  patchAppointment: vi.fn(),
  ignoreAppointmentConflict: vi.fn(),
  materializeOccurrence: vi.fn(),
  endSeries: vi.fn(),
  getSeries: vi.fn(),
  splitSeriesFuture: vi.fn(),
  updateSeries: vi.fn(),
}));
vi.mock('@/api/ledger', () => ({ createEntry: vi.fn() }));
vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  getRow: vi.fn().mockResolvedValue({ ok: false, status: 404, code: 'not_found', message: 'x' }),
  deleteRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));
vi.mock('@/api/business', () => ({
  getMySettings: vi.fn().mockResolvedValue({
    ok: true, data: { id: '1', cancellation_cutoff_hours: 24, min_booking_days: 0, max_booking_days: null },
  }),
}));

import { transitionAppointment } from '@/api/appointments';
import CalendarDialogs from '@/components/calendar/CalendarDialogs.vue';
import AppointmentsView from '@/views/portal/AppointmentsView.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import { useSettleCard } from '@/composables/useSettleCard';

const mockedTransition = transitionAppointment as ReturnType<typeof vi.fn>;

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

function makeAppt(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: '11',
    starts_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    ends_at: new Date(Date.now() + 73 * 60 * 60 * 1000).toISOString(),
    duration_minutes: 50,
    client_user_id: '7',
    professional_user_id: '2',
    service_id: '3',
    resource_id: '1',
    state: 'scheduled',
    name: 'Sesión',
    description: null,
    price: '6500.00',
    override_conflict: false,
    override_actor_id: null,
    staff_note: null,
    conflict_ignored: false,
    series_id: null,
    occurrence_date: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const passThrough = { template: '<div><slot /></div>' };
const headlessStubs = {
  TransitionRoot: passThrough,
  TransitionChild: passThrough,
  Dialog: passThrough,
  DialogPanel: passThrough,
  DialogTitle: passThrough,
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('AppointmentDetailPanel: a cutoff rejection surfaces the hours', () => {
  beforeEach(() => {
    const auth = useAuthStore();
    auth.user = {
      id: 1, username: 'staff', email: null, role: 'Admin',
      business_id: null, is_active: true, must_change_password: false,
    };
  });

  function mountDialogs(appt: Appointment) {
    return mount(CalendarDialogs, {
      props: {
        detailAppointment: appt,
        detailOpen: true,
        formOpen: false,
        prefillSobreturno: false,
        moveConfirmOpen: false,
        moveConfirmBody: '',
        conflictOpen: false,
        conflictVerdict: null,
        conflictRevert: null,
      },
      global: { plugins: [makeI18n()], stubs: headlessStubs },
    });
  }

  it('cancelling inside the cutoff shows the interpolated hours, not the generic error', async () => {
    mockedTransition.mockResolvedValue({
      ok: false, status: 422, code: 'outside_cutoff',
      message: 'Cancellation is only allowed at least 24 hour(s) before the appointment',
      detail: { key: 'cancelCutoff', params: { hours: 24 } },
    });

    const w = mountDialogs(makeAppt());
    await flushPromises();

    const cancelBtn = w.findAll('button').find((b) => b.text() === es.calendar.cancel);
    expect(cancelBtn).toBeTruthy();
    await cancelBtn!.trigger('click');
    await flushPromises();

    const toast = useUiStore().toasts.at(-1);
    expect(toast?.messageKey).toContain('24');
    expect(toast?.messageKey).not.toContain('{hours}');
    expect(toast?.messageKey).not.toBe(es.toast.genericError);
  });
});

describe('useSettleCard: a too-early no_show surfaces the hours', () => {
  function mountCard() {
    setActivePinia(createPinia());
    const auth = useAuthStore();
    auth.user = {
      id: 7, username: 'u', email: null, role: 'Professional',
      business_id: null, is_active: true, must_change_password: false,
    };
    let card!: ReturnType<typeof useSettleCard>;
    const Host = defineComponent({
      setup() { card = useSettleCard(); return () => null; },
    });
    mount(Host, { global: { plugins: [makeI18n()] } });
    return card;
  }

  it('marking absent too early shows the no_show cutoff hours, not the generic error', async () => {
    mockedTransition.mockResolvedValue({
      ok: false, status: 422, code: 'too_early',
      message: "Cannot mark 'no_show' more than 48 hour(s) before the appointment",
      detail: { key: 'noShowTooEarly', params: { hours: 48 } },
    });

    const card = mountCard();
    await flushPromises();
    await card.settle(makeAppt(), 'absent');

    const toast = useUiStore().toasts.at(-1);
    expect(toast?.messageKey).toContain('48');
    expect(toast?.messageKey).not.toContain('{hours}');
    expect(toast?.messageKey).not.toBe(es.toast.genericError);
  });
});

describe('portal AppointmentsView: a client cancel inside the cutoff surfaces the hours', () => {
  beforeEach(() => {
    const auth = useAuthStore();
    auth.user = {
      id: 7, username: 'client', email: null, role: 'Client',
      business_id: 1, is_active: true, must_change_password: false,
    };
  });

  it('confirmCancel resolves outside_cutoff to the interpolated hours', async () => {
    const { listAppointments } = await import('@/api/appointments');
    (listAppointments as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [makeAppt()] });

    const w = mount(AppointmentsView, {
      global: { plugins: [makeI18n()], stubs: { CalendarView: true } },
    });
    await flushPromises();

    const cancelBtn = w.findAll('button').find((b) => b.text() === es.actions.cancel);
    expect(cancelBtn).toBeTruthy();
    await cancelBtn!.trigger('click');
    await flushPromises();

    mockedTransition.mockResolvedValue({
      ok: false, status: 422, code: 'outside_cutoff',
      message: 'Cancellation is only allowed at least 24 hour(s) before the appointment',
      detail: { key: 'cancelCutoff', params: { hours: 24 } },
    });

    w.findComponent(ConfirmDialog).vm.$emit('confirm');
    await flushPromises();

    expect(mockedTransition).toHaveBeenCalledWith('11', 'canceled');
    const toast = useUiStore().toasts.at(-1);
    expect(toast?.messageKey).toContain('24');
    expect(toast?.messageKey).not.toContain('{hours}');
    expect(toast?.messageKey).not.toBe(es.toast.genericError);
  });
});
