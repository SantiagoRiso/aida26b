import type { AuthUser, AuthUserResult } from '@shared/ssot/contracts/auth';
import { arrayOf, booleanValue, externalDecoder, numberValue, object, stringEnum, stringValue } from '@/api/decoders';
import type { Conflict, ConflictVerdict } from '@shared/ssot/domain/conflict';
import { CONFLICT_TYPE_VALUES } from '@shared/ssot/domain/conflict';
import { authUserContractFailure, isAuthUser } from '@shared/ssot/contracts/auth';

export const authUser = externalDecoder<AuthUser>(isAuthUser, authUserContractFailure);

export const wrappedAuthUser = object<AuthUserResult>({ user: authUser });

export const conflict = object<Conflict>({
  type: stringEnum(CONFLICT_TYPE_VALUES),
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
