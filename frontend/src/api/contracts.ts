import type { AuthUser } from '@/stores/auth';
import { arrayOf, booleanValue, nullable, numberValue, object, stringEnum, stringValue } from '@/api/decoders';
import { ROLES } from '@shared/types/roles';
import type { Conflict, ConflictVerdict } from '@shared/ssot/domain/conflict';

export const authUser = object<AuthUser>({
  id: numberValue,
  username: stringValue,
  email: nullable(stringValue),
  role: stringEnum(ROLES),
  business_id: nullable(numberValue),
  is_active: booleanValue,
  must_change_password: booleanValue,
});

export const wrappedAuthUser = object<{ user: AuthUser }>({ user: authUser });

export const conflict = object<Conflict>({
  type: stringEnum([
    'professional_overlap', 'resource_overlap', 'professional_availability',
    'resource_availability', 'requested_block', 'slot_alignment',
  ]),
  entity: object({ kind: stringEnum(['professional', 'resource']), id: numberValue, name: stringValue }),
  range: object({ start: stringValue, end: stringValue }),
});

export const conflictVerdict = object<ConflictVerdict>({
  can_save: booleanValue,
  requires_override: booleanValue,
  can_override: booleanValue,
  conflicts: arrayOf(conflict),
});
export const conflicts = arrayOf(conflict);
