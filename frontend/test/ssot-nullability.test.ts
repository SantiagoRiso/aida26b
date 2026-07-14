import { describe, it, expectTypeOf } from 'vitest';
import type { TableRecordMap } from '@shared/ssot/derived';

// Compile-time contract: a column whose validator declares `nullable: true` derives
// `| null` in TableRecordMap; every other column keeps its exact primitive type.
// vue-tsc gates these assertions (this file is in tsconfig include).
describe('SSoT nullability derivation', () => {
  it('derives | null for validator-nullable columns', () => {
    expectTypeOf<TableRecordMap['professional_services']['max_booking_days']>().toEqualTypeOf<number | null>();
    expectTypeOf<TableRecordMap['professional_services']['min_booking_days']>().toEqualTypeOf<number | null>();
    expectTypeOf<TableRecordMap['users']['business_id']>().toEqualTypeOf<string | null>();
    expectTypeOf<TableRecordMap['clients']['dni']>().toEqualTypeOf<string | null>();
    expectTypeOf<TableRecordMap['schedule_block_services']['duration_minutes']>().toEqualTypeOf<number | null>();
  });

  it('keeps non-nullable columns exact', () => {
    expectTypeOf<TableRecordMap['services']['name']>().toEqualTypeOf<string>();
    expectTypeOf<TableRecordMap['users']['is_active']>().toEqualTypeOf<boolean>();
    expectTypeOf<TableRecordMap['services']['default_duration_minutes']>().toEqualTypeOf<number>();
  });
});
