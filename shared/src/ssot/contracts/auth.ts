import { isRole, type Role } from '../../types/roles';

export type AuthUser = {
  id: number;
  username: string;
  email: string | null;
  role: Role;
  business_id: number | null;
  is_active: boolean;
  must_change_password: boolean;
};

export type AuthUserResult = { user: AuthUser };

// eslint-disable-next-line no-restricted-syntax -- Base guard for an untrusted authentication response.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// eslint-disable-next-line no-restricted-syntax -- Produces field diagnostics while narrowing an authentication response.
export function authUserContractFailure(value: unknown, path = '$'): string | null {
  if (!isRecord(value)) return `${path}: expected object`;
  if (typeof value.id !== 'number' || !Number.isFinite(value.id)) return `${path}.id: expected finite number`;
  if (typeof value.username !== 'string') return `${path}.username: expected string`;
  if (value.email !== null && typeof value.email !== 'string') return `${path}.email: expected string or null`;
  if (typeof value.role !== 'string' || !isRole(value.role)) return `${path}.role: expected known role`;
  if (value.business_id !== null && (typeof value.business_id !== 'number' || !Number.isFinite(value.business_id))) {
    return `${path}.business_id: expected finite number or null`;
  }
  if (typeof value.is_active !== 'boolean') return `${path}.is_active: expected boolean`;
  if (typeof value.must_change_password !== 'boolean') return `${path}.must_change_password: expected boolean`;
  return null;
}

// eslint-disable-next-line no-restricted-syntax -- Public runtime guard for authentication responses.
export function isAuthUser(value: unknown): value is AuthUser {
  return authUserContractFailure(value) === null;
}
