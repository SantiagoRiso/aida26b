import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { dayISO } from '@/composables/availabilityShading';

vi.mock('@/api/appointments', () => ({
  listAppointments: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  rescheduleAppointment: vi.fn(),
  approveAppointment: vi.fn(),
}));
vi.mock('@/api/scheduling', () => ({
  getAvailabilityRange: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));
vi.mock('@/api/closures', () => ({ listClosures: vi.fn().mockResolvedValue({ ok: true, data: [] }) }));
vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  getRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  createRow: vi.fn(),
  updateRow: vi.fn(),
  deleteRow: vi.fn(),
}));

import { listAppointments } from '@/api/appointments';
import { getAvailabilityRange } from '@/api/scheduling';
import CalendarView from '@/views/staff/CalendarView.vue';

const mockedList = vi.mocked(listAppointments);
const mockedAvailability = vi.mocked(getAvailabilityRange);

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

// The grid interaction layer reaches for the surface's rendered root; a bare stub has no such
// method, and this test only cares about the fetch bounds.
const CalendarSurfaceStub = defineComponent({
  setup(_props, { expose }) {
    expose({ getRootEl: () => null });
    return () => null;
  },
});

beforeEach(() => {
  setActivePinia(createPinia());
  mockedList.mockClear();
  mockedAvailability.mockClear();
});

// FullCalendar reports its visible range with an EXCLUSIVE end (activeEnd). The availability
// endpoint wants that as-is, but a bare date_to on the appointments filter includes the whole named
// day, so passing activeEnd there would pull in a trailing day that is not on the grid.
describe('CalendarView — visible range bounds', () => {
  it('fetches appointments up to the last day actually on the grid, not the exclusive end', async () => {
    mount(CalendarView, {
      global: {
        plugins: [makeI18n()],
        stubs: {
          CalendarSurface: CalendarSurfaceStub,
          CalendarFilterBar: true,
          CalendarDialogs: true,
          ExceptionList: true,
        },
      },
    });
    await flushPromises();

    const filters = mockedList.mock.calls[0][0]!;
    expect(filters.date_from).toBe(dayISO(new Date(), 0));
    expect(filters.date_to).toBe(dayISO(new Date(), 6));
  });
});
