import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { weekdayOf } from '@shared/ssot/domain/availability';
import type { Appointment, AppointmentSeries } from '@/api/appointments';
import DateField from '@/components/shared/DateField.vue';
import TimeField from '@/components/shared/TimeField.vue';
import {
  recurrenceStateFromSeries,
  buildRulePatch,
  buildReschedulePatch,
  validateRecurrenceFields,
} from '@/composables/seriesRule';

// Mirrors appointment-detail-scope.test.ts's CalendarDialogs setup: stub the network so mounting
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
  materializeOccurrence, getSeries, splitSeriesFuture, updateSeries,
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
  interval: 2,
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
  status: 'active',
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

async function setDateTime(wrapper: ReturnType<typeof mountDialogs>, date: string, start: string) {
  await wrapper.findComponent(DateField).vm.$emit('update:modelValue', date);
  await wrapper.findComponent(TimeField).vm.$emit('update:modelValue', start);
}

describe('reschedule scope — Part 1', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    const auth = useAuthStore();
    auth.user = {
      id: 1, username: 'staff', email: null, role: 'Admin',
      business_id: null, is_active: true, must_change_password: false,
    };
  });

  it('opens the scope chooser for a series-bound appointment', async () => {
    const w = mountDialogs(seriesAppointment());
    await flushPromises();

    await findButtonByText(w, es.calendar.reschedule)!.trigger('click');
    await flushPromises();

    expect(w.text()).toContain(es.calendar.scopeDialogTitleReschedule);
    expect(w.text()).toContain(es.calendar.scopeThis);
    expect(w.text()).toContain(es.calendar.scopeFuture);
    expect(w.text()).toContain(es.calendar.scopeWhole);
  });

  it('"this occurrence" materializes the row and hands off to the normal reschedule form — no series endpoint', async () => {
    const materialized: Appointment = { ...seriesAppointment(), id: '99', is_virtual: false };
    vi.mocked(materializeOccurrence).mockResolvedValue({ ok: true, data: { appointment: materialized } });
    const w = mountDialogs(seriesAppointment({ is_virtual: true }));
    await flushPromises();

    await findButtonByText(w, es.calendar.reschedule)!.trigger('click');
    await flushPromises();
    await findButtonByText(w, es.calendar.scopeThis)!.trigger('click');
    await flushPromises();

    expect(materializeOccurrence).toHaveBeenCalledWith('5', '2099-01-07');
    expect(w.emitted('reschedule')).toBeTruthy();
    expect(w.emitted('reschedule')![0][0]).toEqual(materialized);
    expect(splitSeriesFuture).not.toHaveBeenCalled();
    expect(updateSeries).not.toHaveBeenCalled();
    expect(getSeries).not.toHaveBeenCalled();
  });

  it('"whole series" fetches the rule, then calls updateSeries with the new start_time and derived weekday', async () => {
    vi.mocked(getSeries).mockResolvedValue({ ok: true, data: seriesRow });
    vi.mocked(updateSeries).mockResolvedValue({ ok: true, data: { series: seriesRow } });
    const w = mountDialogs(seriesAppointment());
    await flushPromises();

    await findButtonByText(w, es.calendar.reschedule)!.trigger('click');
    await flushPromises();
    await findButtonByText(w, es.calendar.scopeWhole)!.trigger('click');
    await flushPromises();

    expect(getSeries).toHaveBeenCalledWith('5');
    const newDate = '2099-02-02';
    await setDateTime(w, newDate, '15:30');
    await w.get('form').trigger('submit');
    await flushPromises();

    expect(updateSeries).toHaveBeenCalledWith('5', { start_time: '15:30', weekday: weekdayOf(newDate) });
    expect(w.emitted('series-mutated')).toBeTruthy();
  });

  it('"this and future" calls splitSeriesFuture with the occurrence date and the same patch shape', async () => {
    vi.mocked(getSeries).mockResolvedValue({ ok: true, data: seriesRow });
    vi.mocked(splitSeriesFuture).mockResolvedValue({ ok: true, data: { ended: seriesRow, created: seriesRow } });
    const w = mountDialogs(seriesAppointment());
    await flushPromises();

    await findButtonByText(w, es.calendar.reschedule)!.trigger('click');
    await flushPromises();
    await findButtonByText(w, es.calendar.scopeFuture)!.trigger('click');
    await flushPromises();

    const newDate = '2099-02-09';
    await setDateTime(w, newDate, '10:15');
    await w.get('form').trigger('submit');
    await flushPromises();

    expect(splitSeriesFuture).toHaveBeenCalledWith('5', '2099-01-07', { start_time: '10:15', weekday: weekdayOf(newDate) });
  });

  it('a monthly_dom series does not send a weekday when rescheduled', async () => {
    const domSeries: AppointmentSeries = { ...seriesRow, frequency: 'monthly_dom', weekday: null, day_of_month: 7 };
    vi.mocked(getSeries).mockResolvedValue({ ok: true, data: domSeries });
    vi.mocked(updateSeries).mockResolvedValue({ ok: true, data: { series: domSeries } });
    const w = mountDialogs(seriesAppointment());
    await flushPromises();

    await findButtonByText(w, es.calendar.reschedule)!.trigger('click');
    await flushPromises();
    await findButtonByText(w, es.calendar.scopeWhole)!.trigger('click');
    await flushPromises();

    await setDateTime(w, '2099-03-14', '09:00');
    await w.get('form').trigger('submit');
    await flushPromises();

    expect(updateSeries).toHaveBeenCalledWith('5', { start_time: '09:00' });
  });
});

describe('"Editar serie" rule editor — Part 2', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    const auth = useAuthStore();
    auth.user = {
      id: 1, username: 'staff', email: null, role: 'Admin',
      business_id: null, is_active: true, must_change_password: false,
    };
  });

  it('opens prefilled from the fetched series', async () => {
    vi.mocked(getSeries).mockResolvedValue({ ok: true, data: seriesRow });
    const w = mountDialogs(seriesAppointment());
    await flushPromises();

    await findButtonByText(w, es.calendar.editSeries)!.trigger('click');
    await flushPromises();

    expect(getSeries).toHaveBeenCalledWith('5');
    expect((w.get('#appt-interval').element as HTMLInputElement).value).toBe('2');
    // weekly frequency shows the weekday field, prefilled from the series.
    expect(w.text()).toContain(es.calendar.editSeriesTitle);
  });

  it('the scope chooser (edit-rule) offers only future/whole — no "this occurrence"', async () => {
    vi.mocked(getSeries).mockResolvedValue({ ok: true, data: seriesRow });
    const w = mountDialogs(seriesAppointment());
    await flushPromises();
    await findButtonByText(w, es.calendar.editSeries)!.trigger('click');
    await flushPromises();

    await w.get('form').trigger('submit');
    await flushPromises();

    expect(w.text()).toContain(es.calendar.scopeDialogTitleEditRule);
    expect(findButtonByText(w, es.calendar.scopeThis)).toBeUndefined();
    expect(w.text()).toContain(es.calendar.scopeFuture);
    expect(w.text()).toContain(es.calendar.scopeWhole);
  });

  it('saving with "whole" calls updateSeries with the (unchanged, prefilled) rule patch', async () => {
    vi.mocked(getSeries).mockResolvedValue({ ok: true, data: seriesRow });
    vi.mocked(updateSeries).mockResolvedValue({ ok: true, data: { series: seriesRow } });
    const w = mountDialogs(seriesAppointment());
    await flushPromises();
    await findButtonByText(w, es.calendar.editSeries)!.trigger('click');
    await flushPromises();
    await w.get('form').trigger('submit');
    await flushPromises();

    await findButtonByText(w, es.calendar.scopeWhole)!.trigger('click');
    await flushPromises();

    expect(updateSeries).toHaveBeenCalledWith('5', {
      frequency: 'weekly',
      interval: 2,
      weekday: 'mon',
      week_of_month: null,
      day_of_month: null,
      end_kind: 'open',
      end_count: null,
      end_date: null,
    });
    expect(w.emitted('series-mutated')).toBeTruthy();
  });

  it('saving with "this and future" calls splitSeriesFuture with the occurrence date and rule patch', async () => {
    vi.mocked(getSeries).mockResolvedValue({ ok: true, data: seriesRow });
    vi.mocked(splitSeriesFuture).mockResolvedValue({ ok: true, data: { ended: seriesRow, created: seriesRow } });
    const w = mountDialogs(seriesAppointment());
    await flushPromises();
    await findButtonByText(w, es.calendar.editSeries)!.trigger('click');
    await flushPromises();
    await w.get('form').trigger('submit');
    await flushPromises();

    await findButtonByText(w, es.calendar.scopeFuture)!.trigger('click');
    await flushPromises();

    expect(splitSeriesFuture).toHaveBeenCalledWith('5', '2099-01-07', {
      frequency: 'weekly',
      interval: 2,
      weekday: 'mon',
      week_of_month: null,
      day_of_month: null,
      end_kind: 'open',
      end_count: null,
      end_date: null,
    });
  });
});

describe('non-series appointment', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    const auth = useAuthStore();
    auth.user = {
      id: 1, username: 'staff', email: null, role: 'Admin',
      business_id: null, is_active: true, must_change_password: false,
    };
  });

  it('reschedules with no scope chooser and shows no "Editar serie" affordance', async () => {
    const w = mountDialogs(baseAppointment);
    await flushPromises();

    expect(findButtonByText(w, es.calendar.editSeries)).toBeUndefined();

    await findButtonByText(w, es.calendar.reschedule)!.trigger('click');
    await flushPromises();

    expect(w.emitted('reschedule')).toBeTruthy();
    expect(w.text()).not.toContain(es.calendar.scopeDialogTitleReschedule);
    expect(getSeries).not.toHaveBeenCalled();
  });
});

describe('seriesRule composable', () => {
  it('recurrenceStateFromSeries + buildRulePatch round-trips a weekly series unchanged', () => {
    const state = recurrenceStateFromSeries(seriesRow);
    expect(state).toEqual({
      frequency: 'weekly',
      interval: '2',
      weekday: 'mon',
      week_of_month: '1',
      day_of_month: '1',
      end_kind: 'open',
      end_count: '1',
      end_date: '',
    });
    expect(buildRulePatch(state)).toEqual({
      frequency: 'weekly',
      interval: 2,
      weekday: 'mon',
      week_of_month: null,
      day_of_month: null,
      end_kind: 'open',
      end_count: null,
      end_date: null,
    });
  });

  it('buildRulePatch explicitly nulls fields that no longer apply after a frequency switch', () => {
    const state = recurrenceStateFromSeries(seriesRow);
    state.frequency = 'monthly_dom';
    state.day_of_month = '15';
    expect(buildRulePatch(state)).toEqual({
      frequency: 'monthly_dom',
      interval: 2,
      weekday: null,
      week_of_month: null,
      day_of_month: 15,
      end_kind: 'open',
      end_count: null,
      end_date: null,
    });
  });

  it('buildReschedulePatch only includes weekday for weekday-anchored frequencies', () => {
    expect(buildReschedulePatch(seriesRow, '2099-02-02', '15:30')).toEqual({
      start_time: '15:30',
      weekday: weekdayOf('2099-02-02'),
    });
    const domSeries: AppointmentSeries = { ...seriesRow, frequency: 'monthly_dom' };
    expect(buildReschedulePatch(domSeries, '2099-02-02', '15:30')).toEqual({ start_time: '15:30' });
  });

  it('validateRecurrenceFields requires weekday for weekly/monthly_dow and day_of_month for monthly_dom', () => {
    const t = (k: string) => k;
    const weekly = recurrenceStateFromSeries({ ...seriesRow, weekday: null });
    expect(validateRecurrenceFields(weekly, t).weekday).toBeTruthy();

    const dom = recurrenceStateFromSeries({ ...seriesRow, frequency: 'monthly_dom', weekday: null, day_of_month: null });
    dom.day_of_month = '';
    expect(validateRecurrenceFields(dom, t).day_of_month).toBeTruthy();
  });
});
