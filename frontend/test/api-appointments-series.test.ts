import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appointmentPaths } from '@shared/ssot/api-paths';
import {
  scheduleSeries,
  materializeOccurrence,
  updateSeries,
  splitSeriesFuture,
  endSeries,
  type ScheduleSeriesBody,
  type ScheduleSeriesResult,
  type AppointmentSeries,
} from '@/api/appointments';

vi.mock('@/api/client', () => ({ apiFetchDecoded: vi.fn() }));

import { apiFetchDecoded } from '@/api/client';

const mockedApiFetch = vi.mocked(apiFetchDecoded);

const series: AppointmentSeries = {
  id: '1',
  client_user_id: '10',
  professional_user_id: '20',
  service_id: '30',
  resource_id: null,
  frequency: 'weekly',
  interval: 1,
  weekday: 'mon',
  week_of_month: null,
  day_of_month: null,
  start_time: '09:00:00',
  duration_minutes: 30,
  price_ars: '1000',
  start_date: '2026-07-20',
  end_kind: 'count',
  end_count: 5,
  end_date: null,
  created_by_user_id: '99',
  status: 'active',
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:00:00.000Z',
};

const scheduleSeriesBody: ScheduleSeriesBody = {
  client_user_id: 10,
  professional_user_id: 20,
  service_id: 30,
  frequency: 'weekly',
  interval: 1,
  weekday: 'mon',
  start_time: '09:00',
  start_date: '2026-07-20',
  duration_minutes: 30,
  end_kind: 'count',
  end_count: 5,
};

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('scheduleSeries', () => {
  it('POSTs to seriesCreate with the body and returns the parsed result', async () => {
    const payload: ScheduleSeriesResult = { series, preview: { skipped: [] } };
    mockedApiFetch.mockResolvedValue({ ok: true, data: payload });

    const result = await scheduleSeries(scheduleSeriesBody);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      expect.any(Function),
      appointmentPaths.seriesCreate(),
      { method: 'POST', body: JSON.stringify(scheduleSeriesBody) },
      { toastOnForbidden: true },
    );
    expect(result).toEqual({ ok: true, data: payload });
  });

  it('passes through skipped conflicts from the preview untouched', async () => {
    const payload: ScheduleSeriesResult = {
      series,
      preview: {
        skipped: [
          {
            date: '2026-07-27',
            conflicts: [
              {
                type: 'professional_overlap',
                entity: { kind: 'professional', id: 20, name: 'Dr. Ana' },
                range: { start: '2026-07-27T09:00:00.000Z', end: '2026-07-27T09:30:00.000Z' },
              },
            ],
          },
        ],
      },
    };
    mockedApiFetch.mockResolvedValue({ ok: true, data: payload });

    const result = await scheduleSeries(scheduleSeriesBody);

    expect(result).toEqual({ ok: true, data: payload });
  });
});

describe('materializeOccurrence', () => {
  it('POSTs to seriesMaterialize with the occurrence_date', async () => {
    const appointment = { id: '5' };
    mockedApiFetch.mockResolvedValue({ ok: true, data: { appointment } });

    const result = await materializeOccurrence(1, '2026-07-27');

    expect(mockedApiFetch).toHaveBeenCalledWith(
      expect.any(Function),
      appointmentPaths.seriesMaterialize(1),
      { method: 'POST', body: JSON.stringify({ occurrence_date: '2026-07-27' }) },
      { toastOnForbidden: true },
    );
    expect(result).toEqual({ ok: true, data: { appointment } });
  });
});

describe('updateSeries', () => {
  it('PUTs to seriesDetail with the patch', async () => {
    const patch = { interval: 2 };
    mockedApiFetch.mockResolvedValue({ ok: true, data: { series } });

    const result = await updateSeries(1, patch);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      expect.any(Function),
      appointmentPaths.seriesDetail(1),
      { method: 'PUT', body: JSON.stringify(patch) },
      { toastOnForbidden: true },
    );
    expect(result).toEqual({ ok: true, data: { series } });
  });
});

describe('splitSeriesFuture', () => {
  it('POSTs to seriesFuture with from_date and patch', async () => {
    const patch = { interval: 2 };
    const ended = { ...series, id: '1', status: 'ended' };
    const created = { ...series, id: '2' };
    mockedApiFetch.mockResolvedValue({ ok: true, data: { ended, created } });

    const result = await splitSeriesFuture(1, '2026-08-01', patch);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      expect.any(Function),
      appointmentPaths.seriesFuture(1),
      { method: 'POST', body: JSON.stringify({ from_date: '2026-08-01', patch }) },
      { toastOnForbidden: true },
    );
    expect(result).toEqual({ ok: true, data: { ended, created } });
  });
});

describe('endSeries', () => {
  it('POSTs to seriesEnd with from_date when given', async () => {
    const ended = { ...series, status: 'ended' };
    mockedApiFetch.mockResolvedValue({ ok: true, data: { ended, canceled: ['7', '8'] } });

    const result = await endSeries(1, '2026-08-01');

    expect(mockedApiFetch).toHaveBeenCalledWith(
      expect.any(Function),
      appointmentPaths.seriesEnd(1),
      { method: 'POST', body: JSON.stringify({ from_date: '2026-08-01' }) },
      { toastOnForbidden: true },
    );
    expect(result).toEqual({ ok: true, data: { ended, canceled: ['7', '8'] } });
  });

  it('POSTs an empty body when from_date is omitted (server defaults to series start_date)', async () => {
    const ended = { ...series, status: 'ended' };
    mockedApiFetch.mockResolvedValue({ ok: true, data: { ended, canceled: [] } });

    await endSeries(1);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      expect.any(Function),
      appointmentPaths.seriesEnd(1),
      { method: 'POST', body: JSON.stringify({}) },
      { toastOnForbidden: true },
    );
  });
});
