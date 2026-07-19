import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { weekdayOf } from '@shared/ssot/domain/availability';
import type { Appointment, ScheduleSeriesBody, ScheduleSeriesResult } from '@/api/appointments';
import type { Wire } from '@shared/ssot/query-types';
import type { AppointmentSeriesRow } from '@shared/ssot/query-types';

// Mirrors appointment-form.test.ts: stub the network so mounting never leaves jsdom.
// listRows is differentiated per table so the professional/service Selectors auto-populate
// via the form's own single-option watcher (see AppointmentForm.vue), without touching the
// (searchable) client combobox — the client comes in via prefillClientId instead.
vi.mock('@/api/crud', () => ({
  listRows: vi.fn((table: string) => {
    if (table === 'professionals') {
      return Promise.resolve({ ok: true, data: [{ id: '2', display_name: 'Dra. Bouvier' }] });
    }
    if (table === 'services') {
      return Promise.resolve({ ok: true, data: [{ id: '3', name: 'Consulta' }] });
    }
    return Promise.resolve({ ok: true, data: [] });
  }),
}));
vi.mock('@/api/scheduling', () => ({
  getAvailability: vi.fn().mockResolvedValue({ ok: true, data: { slots: [] } }),
  getBookingWindow: vi.fn().mockResolvedValue({ ok: true, data: { min_date: '2000-01-01', max_date: null } }),
}));
vi.mock('@/api/appointments', () => ({
  scheduleAppointment: vi.fn(),
  rescheduleAppointment: vi.fn(),
  scheduleSeries: vi.fn(),
}));

import AppointmentForm from '@/components/calendar/AppointmentForm.vue';
import { scheduleAppointment, scheduleSeries } from '@/api/appointments';

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

const baseAppointment: Appointment = {
  id: 11,
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

const PREFILL_DATE = '2026-07-20';
const PREFILL_START = '10:00';
const PREFILL_DURATION = 30;

function mountCreateForm() {
  return mount(AppointmentForm, {
    props: {
      prefillClientId: 7,
      prefillDate: PREFILL_DATE,
      prefillStart: PREFILL_START,
      prefillDuration: PREFILL_DURATION,
    },
    global: { plugins: [makeI18n()] },
  });
}

function seriesResult(skipped: ScheduleSeriesResult['preview']['skipped']): ScheduleSeriesResult {
  const series: Wire<AppointmentSeriesRow> = {
    id: '100',
    client_user_id: '7',
    professional_user_id: '2',
    service_id: '3',
    resource_id: null,
    frequency: 'weekly',
    interval: 1,
    weekday: 'mon',
    week_of_month: null,
    day_of_month: null,
    start_time: PREFILL_START,
    duration_minutes: PREFILL_DURATION,
    price_ars: '6500.00',
    start_date: PREFILL_DATE,
    end_kind: 'count',
    end_count: 4,
    end_date: null,
    created_by_user_id: null,
    status: 'active',
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
  };
  return { series, preview: { skipped } };
}

describe('AppointmentForm recurrence section visibility', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('is hidden entirely in edit mode', async () => {
    const wrapper = mount(AppointmentForm, {
      props: { appointment: baseAppointment },
      global: { plugins: [makeI18n()] },
    });
    await flushPromises();
    expect(wrapper.find('#appt-recurrence').exists()).toBe(false);
  });

  it('shows only the toggle checkbox until checked, in create mode', async () => {
    const wrapper = mountCreateForm();
    await flushPromises();
    expect(wrapper.find('#appt-recurrence').exists()).toBe(true);
    expect(wrapper.find('#appt-frequency').exists()).toBe(false);
  });
});

describe('AppointmentForm recurrence frequency sub-fields', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('weekly shows weekday only', async () => {
    const wrapper = mountCreateForm();
    await flushPromises();
    await wrapper.find('#appt-recurrence').setValue(true);

    expect(wrapper.find('#appt-weekday').exists()).toBe(true);
    expect(wrapper.find('#appt-week-of-month').exists()).toBe(false);
    expect(wrapper.find('#appt-day-of-month').exists()).toBe(false);

    // Defaults to the weekday of the prefilled date.
    const weekdaySelect = wrapper.get('#appt-weekday').element as HTMLSelectElement;
    expect(weekdaySelect.value).toBe(weekdayOf(PREFILL_DATE));
  });

  it('monthly_dow shows weekday + week_of_month', async () => {
    const wrapper = mountCreateForm();
    await flushPromises();
    await wrapper.find('#appt-recurrence').setValue(true);
    await wrapper.find('#appt-frequency').setValue('monthly_dow');

    expect(wrapper.find('#appt-weekday').exists()).toBe(true);
    expect(wrapper.find('#appt-week-of-month').exists()).toBe(true);
    expect(wrapper.find('#appt-day-of-month').exists()).toBe(false);
  });

  it('monthly_dom shows day_of_month only', async () => {
    const wrapper = mountCreateForm();
    await flushPromises();
    await wrapper.find('#appt-recurrence').setValue(true);
    await wrapper.find('#appt-frequency').setValue('monthly_dom');

    expect(wrapper.find('#appt-weekday').exists()).toBe(false);
    expect(wrapper.find('#appt-week-of-month').exists()).toBe(false);
    expect(wrapper.find('#appt-day-of-month').exists()).toBe(true);
  });
});

describe('AppointmentForm recurrence submit', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('calls scheduleSeries (not scheduleAppointment) with the built body when recurrence is on', async () => {
    vi.mocked(scheduleSeries).mockResolvedValue({ ok: true, data: seriesResult([]), meta: {} });

    const wrapper = mountCreateForm();
    await flushPromises();
    await wrapper.find('#appt-recurrence').setValue(true);

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(scheduleSeries).toHaveBeenCalledTimes(1);
    expect(scheduleAppointment).not.toHaveBeenCalled();

    const body = vi.mocked(scheduleSeries).mock.calls[0][0] as ScheduleSeriesBody;
    expect(body.client_user_id).toBe(7);
    expect(body.professional_user_id).toBe(2);
    expect(body.service_id).toBe(3);
    expect(body.frequency).toBe('weekly');
    expect(body.interval).toBe(1);
    expect(body.weekday).toBe(weekdayOf(PREFILL_DATE));
    expect(body.week_of_month).toBeFalsy();
    expect(body.day_of_month).toBeFalsy();
    expect(body.start_time).toBe(PREFILL_START);
    expect(body.start_date).toBe(PREFILL_DATE);
    expect(body.duration_minutes).toBe(PREFILL_DURATION);
    expect(body.end_kind).toBe('count');
    expect(body.end_count).toBe(1);
  });

  it('renders the skipped-dates report on success, with an empty-state when nothing was skipped', async () => {
    vi.mocked(scheduleSeries).mockResolvedValue({ ok: true, data: seriesResult([]), meta: {} });

    const wrapper = mountCreateForm();
    await flushPromises();
    await wrapper.find('#appt-recurrence').setValue(true);
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain(es.calendar.seriesSkippedTitle);
    expect(wrapper.text()).toContain(es.calendar.seriesNoConflicts);
    // The form itself is replaced by the report — no more field inputs to submit again.
    expect(wrapper.find('#appt-frequency').exists()).toBe(false);
  });

  it('renders each skipped date with its conflict description', async () => {
    vi.mocked(scheduleSeries).mockResolvedValue({
      ok: true,
      data: seriesResult([
        {
          date: '2026-07-27',
          conflicts: [
            {
              type: 'professional_overlap',
              entity: { kind: 'professional', id: 2, name: 'Dra. Bouvier' },
              range: { start: '10:00', end: '10:30' },
            },
          ],
        },
      ]),
      meta: {},
    });

    const wrapper = mountCreateForm();
    await flushPromises();
    await wrapper.find('#appt-recurrence').setValue(true);
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('2026-07-27');
    expect(wrapper.text()).toContain(
      es.conflicts.professionalOverlap
        .replace('{entity}', 'Dra. Bouvier')
        .replace('{start}', '10:00')
        .replace('{end}', '10:30'),
    );
  });

  it('recurrence off still calls the existing single-create path, unchanged', async () => {
    vi.mocked(scheduleAppointment).mockResolvedValue({
      ok: true,
      data: { saved: true, appointment: baseAppointment },
      meta: {},
    });

    const wrapper = mountCreateForm();
    await flushPromises();
    // Checkbox left unchecked.
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(scheduleAppointment).toHaveBeenCalledTimes(1);
    expect(scheduleSeries).not.toHaveBeenCalled();
    expect(wrapper.emitted('saved')?.[0]).toEqual([baseAppointment]);
  });
});
