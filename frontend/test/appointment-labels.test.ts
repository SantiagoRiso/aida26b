import { describe, expect, it } from 'vitest';
import { formatDefaultAppointmentTitle } from '@/composables/useAppointmentLabels';

describe('appointment default title', () => {
  it('orders client, resource, and service with normal hyphens', () => {
    expect(formatDefaultAppointmentTitle('Homero Simpson', 'Consultorio 2', 'Psicología', 'Turno #1'))
      .toBe('Homero Simpson - Consultorio 2 - Psicología');
  });

  it('omits unavailable segments without leaving empty separators', () => {
    expect(formatDefaultAppointmentTitle('Homero Simpson', null, 'Psicología', 'Turno #1'))
      .toBe('Homero Simpson - Psicología');
    expect(formatDefaultAppointmentTitle(null, null, null, 'Turno #1')).toBe('Turno #1');
  });

  it('appends sobreturno without replacing the client, resource, or service', () => {
    expect(formatDefaultAppointmentTitle(
      'Homero Simpson',
      'Consultorio 2',
      'Psicología',
      'Turno #1',
      'Sobreturno',
    )).toBe('Homero Simpson - Consultorio 2 - Psicología - Sobreturno');
  });
});
