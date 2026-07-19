import { describe, expect, it } from 'vitest';
import { appointmentContract } from '@/api/appointments';
import { authUserContractFailure, isAuthUser } from '@shared/ssot/contracts/auth';

const clientAppointment = {
  id: '1',
  client_user_id: '2',
  professional_user_id: '3',
  resource_id: null,
  service_id: '4',
  starts_at: '2026-07-20T12:00:00.000Z',
  duration_minutes: 50,
  ends_at: '2026-07-20T12:50:00.000Z',
  state: 'scheduled',
  name: null,
  description: null,
  price: '8000.00',
  override_conflict: false,
  created_at: '2026-07-19T12:00:00.000Z',
  updated_at: '2026-07-19T12:00:00.000Z',
  conflict_ignored: false,
  series_id: null,
  occurrence_date: null,
};

describe('shared API contracts', () => {
  it('accepts client appointment responses with staff-only fields omitted', () => {
    expect(appointmentContract(clientAppointment)).toBe(true);
  });

  it('keeps AuthUser validation and diagnostics on the same shared contract', () => {
    const invalid = { id: 1, username: 'admin', email: null, role: 'Admin', business_id: '1' };
    expect(isAuthUser(invalid)).toBe(false);
    expect(authUserContractFailure(invalid)).toBe('$.business_id: expected finite number or null');
  });
});
