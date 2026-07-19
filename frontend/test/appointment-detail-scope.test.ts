import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import type { Appointment, AppointmentSeries } from '@/api/appointments';

// Mirrors calendar-view-children.test.ts's CalendarDialogs setup: stub the network so mounting
// never leaves jsdom, and headlessui's TransitionRoot/Dialog chrome (which renders nothing under
// jsdom) so the dialogs' real content — which buttons appear, what they call — is reachable.
vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  deleteRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));
vi.mock('@/api/business', () => ({
  getMySettings: vi.fn().mockResolvedValue({ ok: false, status: 500, code: 'x', message: 'x' }),
}));
vi.mock('@/api/appointments', () => ({
  materializeOccurrence: vi.fn(),
  endSeries: vi.fn(),
  transitionAppointment: vi.fn(),
  patchAppointment: vi.fn(),
  ignoreAppointmentConflict: vi.fn(),
  getSeries: vi.fn(),
  splitSeriesFuture: vi.fn(),
  updateSeries: vi.fn(),
}));

import CalendarDialogs from '@/components/calendar/CalendarDialogs.vue';
import {
  materializeOccurrence, endSeries, transitionAppointment, patchAppointment, ignoreAppointmentConflict,
} from '@/api/appointments';

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

const passThrough = { template: '<div><slot /></div>' };
const headlessStubs = {
  TransitionRoot: passThrough,
  TransitionChild: passThrough,
  Dialog: passThrough,
  DialogPanel: passThrough,
  DialogTitle: passThrough,
};

const baseAppointment: Appointment = {
  id: '11',
  starts_at: '2099-01-07T13:00:00.000Z',
  ends_at: '2099-01-07T13:50:00.000Z',
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
};

function seriesAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    ...baseAppointment,
    id: '22',
    series_id: '5',
    occurrence_date: '2099-01-07',
    ...overrides,
  };
}

const seriesRow: AppointmentSeries = {
  id: '5',
  client_user_id: '7',
  professional_user_id: '2',
  service_id: '3',
  resource_id: null,
  frequency: 'weekly',
  interval: 1,
  weekday: 'mon',
  week_of_month: null,
  day_of_month: null,
  start_time: '13:00',
  duration_minutes: 50,
  price_ars: '6500.00',
  start_date: '2099-01-07',
  end_kind: 'open',
  end_count: null,
  end_date: null,
  created_by_user_id: null,
  status: 'ended',
  created_at: '2026-07-17T00:00:00.000Z',
  updated_at: '2026-07-17T00:00:00.000Z',
};

function mountDialogs(appt: Appointment | null) {
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

function findButtonByText(wrapper: ReturnType<typeof mountDialogs>, text: string) {
  return wrapper.findAll('button').find((b) => b.text() === text);
}

async function clickCancel(wrapper: ReturnType<typeof mountDialogs>) {
  const btn = findButtonByText(wrapper, es.calendar.cancel);
  expect(btn).toBeTruthy();
  await btn!.trigger('click');
  await flushPromises();
}

describe('AppointmentDetailPanel + SeriesScopeDialog: cancel scope', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    const auth = useAuthStore();
    auth.user = {
      id: 1, username: 'staff', email: null, role: 'Admin',
      business_id: null, is_active: true, must_change_password: false,
    };
  });

  it('cancels a non-series appointment directly, with no scope chooser', async () => {
    vi.mocked(transitionAppointment).mockResolvedValue({
      ok: true, data: { ...baseAppointment, state: 'canceled' },
    });
    const w = mountDialogs(baseAppointment);
    await flushPromises();

    await clickCancel(w);

    expect(transitionAppointment).toHaveBeenCalledWith('11', 'canceled');
    expect(materializeOccurrence).not.toHaveBeenCalled();
    expect(endSeries).not.toHaveBeenCalled();
    expect(w.text()).not.toContain(es.calendar.scopeDialogTitle);
  });

  it('opens the scope chooser instead of transitioning directly for a series-bound appointment', async () => {
    const w = mountDialogs(seriesAppointment());
    await flushPromises();

    await clickCancel(w);

    expect(transitionAppointment).not.toHaveBeenCalled();
    expect(w.text()).toContain(es.calendar.scopeDialogTitle);
    expect(w.text()).toContain(es.calendar.scopeThis);
    expect(w.text()).toContain(es.calendar.scopeFuture);
    expect(w.text()).toContain(es.calendar.scopeWhole);
  });

  it('"whole series" calls endSeries with no from_date and refreshes the caller', async () => {
    vi.mocked(endSeries).mockResolvedValue({ ok: true, data: { ended: seriesRow, canceled: [] } });
    const w = mountDialogs(seriesAppointment());
    await flushPromises();
    await clickCancel(w);

    await findButtonByText(w, es.calendar.scopeWhole)!.trigger('click');
    await flushPromises();

    expect(endSeries).toHaveBeenCalledWith('5');
    expect(w.emitted('detail-close')).toBeTruthy();
    expect(w.emitted('series-mutated')).toBeTruthy();
  });

  it('"this and future" calls endSeries with the occurrence date', async () => {
    vi.mocked(endSeries).mockResolvedValue({ ok: true, data: { ended: seriesRow, canceled: [] } });
    const w = mountDialogs(seriesAppointment());
    await flushPromises();
    await clickCancel(w);

    await findButtonByText(w, es.calendar.scopeFuture)!.trigger('click');
    await flushPromises();

    expect(endSeries).toHaveBeenCalledWith('5', '2099-01-07');
  });

  it('"this occurrence" on an already-materialized row cancels it directly, no materialize call', async () => {
    const appt = seriesAppointment();
    vi.mocked(transitionAppointment).mockResolvedValue({ ok: true, data: { ...appt, state: 'canceled' } });
    const w = mountDialogs(appt);
    await flushPromises();
    await clickCancel(w);

    await findButtonByText(w, es.calendar.scopeThis)!.trigger('click');
    await flushPromises();

    expect(materializeOccurrence).not.toHaveBeenCalled();
    expect(transitionAppointment).toHaveBeenCalledWith('22', 'canceled');
    expect(w.emitted('detail-mutated')).toBeTruthy();
  });

  it('"this occurrence" on a virtual row materializes first, then cancels the resolved real id', async () => {
    const materialized: Appointment = { ...seriesAppointment(), id: '99', is_virtual: false };
    vi.mocked(materializeOccurrence).mockResolvedValue({ ok: true, data: { appointment: materialized } });
    vi.mocked(transitionAppointment).mockResolvedValue({ ok: true, data: { ...materialized, state: 'canceled' } });
    const virtualAppt = seriesAppointment({ is_virtual: true });
    const w = mountDialogs(virtualAppt);
    await flushPromises();
    await clickCancel(w);

    await findButtonByText(w, es.calendar.scopeThis)!.trigger('click');
    await flushPromises();

    expect(materializeOccurrence).toHaveBeenCalledWith('5', '2099-01-07');
    expect(transitionAppointment).toHaveBeenCalledWith('99', 'canceled');
  });
});

describe('AppointmentDetailPanel: materialize-on-action', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    const auth = useAuthStore();
    auth.user = {
      id: 1, username: 'staff', email: null, role: 'Admin',
      business_id: null, is_active: true, must_change_password: false,
    };
  });

  it('completing a virtual occurrence materializes it first, then transitions the resolved id', async () => {
    const past = '2000-01-07T13:00:00.000Z';
    const materialized: Appointment = { ...seriesAppointment({ starts_at: past }), id: '77', is_virtual: false };
    vi.mocked(materializeOccurrence).mockResolvedValue({ ok: true, data: { appointment: materialized } });
    vi.mocked(transitionAppointment).mockResolvedValue({ ok: true, data: { ...materialized, state: 'completed' } });
    const virtualAppt = seriesAppointment({ starts_at: past, is_virtual: true });
    const w = mountDialogs(virtualAppt);
    await flushPromises();

    const completeBtn = findButtonByText(w, es.calendar.complete);
    expect(completeBtn).toBeTruthy();
    await completeBtn!.trigger('click');
    await flushPromises();

    expect(materializeOccurrence).toHaveBeenCalledWith('5', '2099-01-07');
    expect(transitionAppointment).toHaveBeenCalledWith('77', 'completed');
  });

  it('rescheduling a series appointment opens the scope chooser instead of materializing directly', async () => {
    const virtualAppt = seriesAppointment({ is_virtual: true });
    const w = mountDialogs(virtualAppt);
    await flushPromises();

    const rescheduleBtn = findButtonByText(w, es.calendar.reschedule);
    expect(rescheduleBtn).toBeTruthy();
    await rescheduleBtn!.trigger('click');
    await flushPromises();

    expect(materializeOccurrence).not.toHaveBeenCalled();
    expect(w.emitted('reschedule')).toBeFalsy();
    expect(w.text()).toContain(es.calendar.scopeDialogTitleReschedule);
    expect(w.text()).toContain(es.calendar.scopeThis);
    expect(w.text()).toContain(es.calendar.scopeFuture);
    expect(w.text()).toContain(es.calendar.scopeWhole);
  });

  it('reschedule scope "this occurrence" materializes the virtual row, then emits reschedule with the resolved appointment', async () => {
    const materialized: Appointment = { ...seriesAppointment(), id: '55', is_virtual: false };
    vi.mocked(materializeOccurrence).mockResolvedValue({ ok: true, data: { appointment: materialized } });
    const virtualAppt = seriesAppointment({ is_virtual: true });
    const w = mountDialogs(virtualAppt);
    await flushPromises();

    await findButtonByText(w, es.calendar.reschedule)!.trigger('click');
    await flushPromises();
    await findButtonByText(w, es.calendar.scopeThis)!.trigger('click');
    await flushPromises();

    expect(materializeOccurrence).toHaveBeenCalledWith('5', '2099-01-07');
    expect(w.emitted('reschedule')).toBeTruthy();
    expect(w.emitted('reschedule')![0][0]).toEqual(materialized);
  });

  it('a non-series appointment reschedules with no scope chooser', async () => {
    const w = mountDialogs(baseAppointment);
    await flushPromises();

    await findButtonByText(w, es.calendar.reschedule)!.trigger('click');
    await flushPromises();

    expect(materializeOccurrence).not.toHaveBeenCalled();
    expect(w.emitted('reschedule')).toBeTruthy();
    expect(w.emitted('reschedule')![0][0]).toEqual(baseAppointment);
    expect(w.text()).not.toContain(es.calendar.scopeDialogTitleReschedule);
  });

  it('a real (non-virtual) series row completing does NOT call materializeOccurrence', async () => {
    const past = '2000-01-07T13:00:00.000Z';
    const realAppt = seriesAppointment({ starts_at: past });
    vi.mocked(transitionAppointment).mockResolvedValue({ ok: true, data: { ...realAppt, state: 'completed' } });
    const w = mountDialogs(realAppt);
    await flushPromises();

    const completeBtn = findButtonByText(w, es.calendar.complete);
    expect(completeBtn).toBeTruthy();
    await completeBtn!.trigger('click');
    await flushPromises();

    expect(materializeOccurrence).not.toHaveBeenCalled();
    expect(transitionAppointment).toHaveBeenCalledWith('22', 'completed');
  });

  it('editing the note on a virtual occurrence materializes it first, then patches the resolved id', async () => {
    const materialized: Appointment = { ...seriesAppointment(), id: '88', is_virtual: false };
    vi.mocked(materializeOccurrence).mockResolvedValue({ ok: true, data: { appointment: materialized } });
    vi.mocked(patchAppointment).mockResolvedValue({ ok: true, data: { ...materialized, staff_note: 'x' } });
    const virtualAppt = seriesAppointment({ is_virtual: true });
    const w = mountDialogs(virtualAppt);
    await flushPromises();

    const editBtn = findButtonByText(w, es.calendar.editNote);
    expect(editBtn).toBeTruthy();
    await editBtn!.trigger('click');
    await w.find('textarea').setValue('x');
    const saveBtn = findButtonByText(w, es.actions.save);
    expect(saveBtn).toBeTruthy();
    await saveBtn!.trigger('click');
    await flushPromises();

    expect(materializeOccurrence).toHaveBeenCalledWith('5', '2099-01-07');
    expect(patchAppointment).toHaveBeenCalledWith('88', { staff_note: 'x' });
  });

  it('a real (non-virtual) series row editing the note does NOT call materializeOccurrence', async () => {
    const realAppt = seriesAppointment();
    vi.mocked(patchAppointment).mockResolvedValue({ ok: true, data: { ...realAppt, staff_note: 'x' } });
    const w = mountDialogs(realAppt);
    await flushPromises();

    const editBtn = findButtonByText(w, es.calendar.editNote);
    await editBtn!.trigger('click');
    await w.find('textarea').setValue('x');
    const saveBtn = findButtonByText(w, es.actions.save);
    await saveBtn!.trigger('click');
    await flushPromises();

    expect(materializeOccurrence).not.toHaveBeenCalled();
    expect(patchAppointment).toHaveBeenCalledWith('22', { staff_note: 'x' });
  });

  it('ignoring a conflict on a virtual occurrence materializes it first, then calls ignoreAppointmentConflict with the resolved id', async () => {
    const materialized: Appointment = { ...seriesAppointment(), id: '66', is_virtual: false };
    vi.mocked(materializeOccurrence).mockResolvedValue({ ok: true, data: { appointment: materialized } });
    vi.mocked(ignoreAppointmentConflict).mockResolvedValue({ ok: true, data: { ...materialized, conflict_ignored: true } });
    const virtualAppt = seriesAppointment({ is_virtual: true, in_conflict: true });
    const w = mountDialogs(virtualAppt);
    await flushPromises();

    const ignoreBtn = findButtonByText(w, es.calendar.ignoreConflict);
    expect(ignoreBtn).toBeTruthy();
    await ignoreBtn!.trigger('click');
    await flushPromises();

    expect(materializeOccurrence).toHaveBeenCalledWith('5', '2099-01-07');
    expect(ignoreAppointmentConflict).toHaveBeenCalledWith('66', true);
  });
});
