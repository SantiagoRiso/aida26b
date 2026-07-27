import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { dayISO } from '@/composables/availabilityShading';
import { useAuthStore } from '@/stores/auth';
import type { AuthUser } from '@/stores/auth';
import type { VirtualOccurrence } from '@shared/ssot/query-types';

vi.mock('@/api/appointments', () => ({
  listAppointments: vi.fn(),
  transitionAppointment: vi.fn(),
  materializeOccurrence: vi.fn(),
}));
vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));
vi.mock('@/api/business', () => ({
  getMySettings: vi.fn().mockResolvedValue({
    ok: true, data: { id: '1', cancellation_cutoff_hours: 24, min_booking_days: 0, max_booking_days: null },
  }),
}));

import { listAppointments } from '@/api/appointments';
import AppointmentsView, { SERIES_PORTAL_HORIZON_DAYS } from '@/views/portal/AppointmentsView.vue';

// Now-relative fixture — never a hardcoded calendar date (repo rule).
const OCCURRENCE_DATE = dayISO(new Date(), 3);
const STARTS_AT = `${OCCURRENCE_DATE}T13:00:00.000Z`;

function makeVirtual(overrides: Partial<VirtualOccurrence> = {}): VirtualOccurrence {
  return {
    id: null,
    series_id: '9',
    occurrence_date: OCCURRENCE_DATE,
    client_user_id: '4',
    professional_user_id: '2',
    service_id: '3',
    resource_id: null,
    starts_at: STARTS_AT,
    duration_minutes: 30,
    price: '5000.00',
    state: 'scheduled',
    name: null,
    description: null,
    is_virtual: true,
    in_conflict: false,
    service_name: 'Servicio',
    professional_name: 'Profesional',
    client_name: 'Cliente',
    ...overrides,
  };
}

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

const clientViewer: AuthUser = {
  id: 4, username: 'client', email: null, role: 'Client',
  business_id: 1, is_active: true, must_change_password: false,
};

describe('portal AppointmentsView requests a bounded date range', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    const auth = useAuthStore();
    auth.user = clientViewer;
  });

  // This is the actual regression: without date_from/date_to the backend never expands a series
  // into virtual occurrences, so the portal silently never sees them regardless of how the list
  // renders is_virtual rows.
  it('load() calls listAppointments with a bounded forward date range', async () => {
    vi.mocked(listAppointments).mockResolvedValue({ ok: true, data: [] });

    mount(AppointmentsView, {
      global: { plugins: [makeI18n()], stubs: { CalendarView: true } },
    });
    await flushPromises();

    expect(listAppointments).toHaveBeenCalledTimes(1);
    const [filters] = vi.mocked(listAppointments).mock.calls[0]!;
    expect(filters?.date_from).toBe(dayISO(new Date(), 0));
    expect(filters?.date_to).toBe(dayISO(new Date(), SERIES_PORTAL_HORIZON_DAYS));
    expect(filters?.limit).toBe(100);
  });

  it('renders a virtual occurrence from a ranged response with the recurring badge and no cancel affordance', async () => {
    vi.mocked(listAppointments).mockResolvedValue({ ok: true, data: [makeVirtual()] });

    const wrapper = mount(AppointmentsView, {
      global: { plugins: [makeI18n()], stubs: { CalendarView: true } },
    });
    await flushPromises();

    expect(wrapper.text()).toContain(es.portal.recurringBadge);
    expect(wrapper.text()).not.toContain(es.actions.cancel);
    expect(wrapper.text()).not.toContain(es.portal.withdrawRequest);
  });
});
