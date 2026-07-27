import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { formatDefaultAppointmentTitle, useAppointmentLabels } from '@/composables/useAppointmentLabels';
import { resetFkOptionsCache } from '@/composables/useForeignKeyOptions';
import { useAuthStore } from '@/stores/auth';
import { i18n } from '@/i18n';
import { es } from '@/i18n/es';
import type { Appointment } from '@/api/appointments';

vi.mock('@/api/crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/crud')>();
  return {
    ...actual,
    // Empty roster on every table: client/resource/service/professional never resolve via the
    // FK-options cache, exercising the payload-driven path (or, when the payload is also bare,
    // the true last-resort fallback).
    listRows: vi.fn(async () => ({ ok: true, data: [] })),
  };
});

describe('appointment default title', () => {
  it('orders client, resource, service, and professional with normal hyphens', () => {
    expect(formatDefaultAppointmentTitle('Homero Simpson', 'Consultorio 2', 'Psicología', 'Dr. Hibbert', 'Turno'))
      .toBe('Homero Simpson - Consultorio 2 - Psicología - Dr. Hibbert');
  });

  it('omits unavailable segments without leaving empty separators', () => {
    expect(formatDefaultAppointmentTitle('Homero Simpson', null, 'Psicología', null, 'Turno'))
      .toBe('Homero Simpson - Psicología');
    expect(formatDefaultAppointmentTitle(null, null, null, null, 'Turno')).toBe('Turno');
  });

  it('appends sobreturno without replacing the client, resource, service, or professional', () => {
    expect(formatDefaultAppointmentTitle(
      'Homero Simpson',
      'Consultorio 2',
      'Psicología',
      'Dr. Hibbert',
      'Turno',
      'Sobreturno',
    )).toBe('Homero Simpson - Consultorio 2 - Psicología - Dr. Hibbert - Sobreturno');
  });

  // The maintainer's explicit decision: the last-resort label is a bare noun, never "Turno #<id>" —
  // surrounding UI (calendar position, list row date/time) already disambiguates which one it is.
  it('never carries a raw database id when nothing else resolves', () => {
    const fallback = formatDefaultAppointmentTitle(null, null, null, null, 'Turno');
    expect(fallback).toBe('Turno');
    expect(fallback).not.toMatch(/#/);
  });
});

function appt(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: '42', client_user_id: '999', professional_user_id: '1', resource_id: null, service_id: '999',
    starts_at: '2026-07-06T10:00:00Z', duration_minutes: 30, ends_at: '2026-07-06T10:30:00Z',
    state: 'scheduled', name: null, description: null, price: '100.00',
    override_conflict: false, override_actor_id: null, staff_note: null, conflict_ignored: false,
    created_at: '2026-07-06T10:00:00Z', updated_at: '2026-07-06T10:00:00Z',
    series_id: null, occurrence_date: null,
    ...overrides,
  };
}

function setViewer(role: 'Admin' | 'Receptionist' | 'Professional' | 'Client' | null, id = 1): void {
  const auth = useAuthStore();
  auth.user = role == null ? null : {
    id, username: 'viewer', email: null, role, business_id: 1, is_active: true, must_change_password: false,
  };
}

describe('useAppointmentLabels — title composed from the server payload, no FK cache needed', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetFkOptionsCache();
    i18n.global.locale.value = 'es';
    setViewer('Admin');
  });

  it('renders service and professional straight from the payload, without ever priming the FK cache', () => {
    const { defaultAppointmentTitle } = useAppointmentLabels();
    const title = defaultAppointmentTitle(appt({
      client_user_id: '999', service_id: '999', professional_user_id: '5',
      client_name: 'Homero Simpson', service_name: 'Psicología', professional_name: 'Dr. Hibbert',
    }));

    // Resolved purely from the payload fields — the mocked FK roster is empty, so any of these
    // appearing proves the title did not go through labelFor at all.
    expect(title).toBe('Homero Simpson - Psicología - Dr. Hibbert');
  });

  it('does not append the professional when a Professional views their own appointment', () => {
    setViewer('Professional', 5);
    const { defaultAppointmentTitle } = useAppointmentLabels();
    const title = defaultAppointmentTitle(appt({
      professional_user_id: '5', client_user_id: '999', service_id: '999',
      client_name: 'Homero Simpson', service_name: 'Psicología', professional_name: 'Dr. Hibbert',
    }));

    expect(title).toBe('Homero Simpson - Psicología');
    expect(title).not.toContain('Dr. Hibbert');
  });

  it('still appends the professional when a Professional views a different professional\'s appointment', () => {
    setViewer('Professional', 5);
    const { defaultAppointmentTitle } = useAppointmentLabels();
    const title = defaultAppointmentTitle(appt({
      professional_user_id: '6', client_user_id: '999', service_id: '999',
      client_name: 'Homero Simpson', service_name: 'Psicología', professional_name: 'Dr. Nick',
    }));

    expect(title).toContain('Dr. Nick');
  });
});

describe('useAppointmentLabels — last-resort fallback carries no raw id', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetFkOptionsCache();
    i18n.global.locale.value = 'es';
    setViewer('Admin');
  });

  it('defaultAppointmentTitle renders the bare i18n label when the payload and the FK cache both miss', () => {
    const { defaultAppointmentTitle } = useAppointmentLabels();
    const title = defaultAppointmentTitle(appt({ id: '42', client_user_id: '999', service_id: '999' }));

    expect(title).toBe(es.portal.appointmentFallback);
    expect(title).not.toContain('42');
    expect(title).not.toContain('#');
  });

  it('pendingClientName renders the same bare label for an unresolved, unnamed request', () => {
    const { pendingClientName } = useAppointmentLabels();
    const label = pendingClientName(appt({ id: '77', client_user_id: '999', name: null }));

    expect(label).toBe(es.portal.appointmentFallback);
    expect(label).not.toContain('77');
    expect(label).not.toContain('#');
  });
});
