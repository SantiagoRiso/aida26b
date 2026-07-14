// Resolves the booking's captured price and duration.
//   Price    = client override > per-block/service override > service default.
//   Duration = staff sobreturno > per-block/service override > service default.
// The dry-run and the save call this so preview never drifts from the saved value. Prices stay
// decimal strings matching priceColumn's '^\d+(\.\d{1,2})?$'.
export function resolveBooking(input: {
  serviceDefaultPriceArs: string;
  serviceDefaultDurationMinutes?: number | null;
  clientOverridePriceArs?: string | null;
  blockServicePriceArs?: string | null;
  blockServiceDurationMinutes?: number | null;
  sobreturnoDurationMinutes?: number | null;
}): { effective_price: string; effective_duration_minutes: number } {
  const price = (v?: string | null): string | undefined =>
    v !== null && v !== undefined && v !== '' ? v : undefined;
  const effective_price =
    price(input.clientOverridePriceArs) ??
    price(input.blockServicePriceArs) ??
    input.serviceDefaultPriceArs;

  const dur = (v?: number | null): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
  const effective_duration_minutes =
    dur(input.sobreturnoDurationMinutes) ??
    dur(input.blockServiceDurationMinutes) ??
    dur(input.serviceDefaultDurationMinutes);
  if (effective_duration_minutes === undefined) {
    throw new Error(
      'resolveBooking requires a duration source: service default, block override, or sobreturno',
    );
  }

  return { effective_price, effective_duration_minutes };
}
