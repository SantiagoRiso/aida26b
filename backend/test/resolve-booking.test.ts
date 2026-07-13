import { describe, it, expect } from 'vitest';
import { resolveBooking } from '../../shared/src/ssot/domain/catalog';

describe('resolveBooking precedence', () => {
  const base = { serviceDefaultPriceArs: '5000.00', serviceDefaultDurationMinutes: 30 };

  it('client override beats block and default price', () => {
    expect(
      resolveBooking({ ...base, blockServicePriceArs: '9000.00', clientOverridePriceArs: '6500.00' }).effective_price,
    ).toBe('6500.00');
  });

  it('block price beats default when no client override', () => {
    expect(resolveBooking({ ...base, blockServicePriceArs: '9000.00' }).effective_price).toBe('9000.00');
  });

  it('empty-string overrides are treated as absent', () => {
    expect(resolveBooking({ ...base, clientOverridePriceArs: '', blockServicePriceArs: '' }).effective_price).toBe('5000.00');
  });

  it('falls back to the service default price', () => {
    expect(resolveBooking(base).effective_price).toBe('5000.00');
  });

  it('duration: sobreturno beats block beats service default', () => {
    expect(resolveBooking({ ...base, blockServiceDurationMinutes: 45, sobreturnoDurationMinutes: 20 }).effective_duration_minutes).toBe(20);
    expect(resolveBooking({ ...base, blockServiceDurationMinutes: 45 }).effective_duration_minutes).toBe(45);
    expect(resolveBooking(base).effective_duration_minutes).toBe(30);
  });

  it('throws when no duration source is available', () => {
    expect(() => resolveBooking({ serviceDefaultPriceArs: '5000.00' })).toThrow();
  });
});
