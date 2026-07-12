import { describe, it, expect } from 'vitest';

// Mirrors RequestFlow's availableServices: the service list is scoped to what the chosen
// professional offers; with no professional selected, or a professional with no mapping,
// it falls back to every service.
interface Service { id: number | string; name: string }
interface ProfService { professional_user_id: string; service_id: string }

function availableServices(all: Service[], profServices: ProfService[], profId: number | null): Service[] {
  if (profId == null) return all;
  const offered = new Set(
    profServices
      .filter((ps) => String(ps.professional_user_id) === String(profId))
      .map((ps) => String(ps.service_id)),
  );
  if (offered.size === 0) return all;
  return all.filter((s) => offered.has(String(s.id)));
}

const services: Service[] = [
  { id: 1, name: 'Sesión de Psicología Infantil' },
  { id: 2, name: 'Consulta nutricional' },
  { id: 3, name: 'Sesión de kinesiología' },
];
const profServices: ProfService[] = [
  { professional_user_id: '10', service_id: '1' },
  { professional_user_id: '10', service_id: '2' },
  { professional_user_id: '20', service_id: '3' },
];

describe('portal service filter (availableServices)', () => {
  it('returns every service when no professional is selected', () => {
    expect(availableServices(services, profServices, null)).toHaveLength(3);
  });

  it('narrows to the chosen professional’s offerings', () => {
    const out = availableServices(services, profServices, 10).map((s) => s.name);
    expect(out).toEqual(['Sesión de Psicología Infantil', 'Consulta nutricional']);
  });

  it('returns a single service for a professional who offers one', () => {
    expect(availableServices(services, profServices, 20).map((s) => s.name)).toEqual(['Sesión de kinesiología']);
  });

  it('falls back to every service for a professional with no mapping', () => {
    expect(availableServices(services, profServices, 99)).toHaveLength(3);
  });
});
