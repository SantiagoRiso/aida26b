import crypto from 'crypto';
import { promisify } from 'util';
import type { Role } from '../../shared/src/types/roles';

const scrypt = promisify(crypto.scrypt);

export type AuthUser = {
  id: number;
  username: string;
  email: string | null;
  role: Role;
  business_id: number | null;
  is_active: boolean;
  must_change_password: boolean;
};

export const SESSION_COOKIE = 'aida_session';
export const SESSION_DAYS = 7;

export const MIN_PASSWORD_LENGTH = 8;

// A submitted password is only accepted once it clears the minimum length — shared by the
// change-password and admin create/reset paths so the rule lives in one place.
export function readPassword(value: string | undefined): string | null {
  return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH ? value : null;
}

export async function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return { passwordHash: key.toString('hex'), passwordSalt: salt };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string) {
  const { passwordHash } = await hashPassword(password, salt);
  const actual = Buffer.from(passwordHash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header?: string) {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  header.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) return;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  });

  return cookies;
}

export function sessionCookie(token: string, secure: boolean) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export function clearSessionCookie(secure: boolean) {
  return [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

// auth.users wire row as node-pg returns it: BIGINT columns arrive as strings.
export type UsersWireRow = {
  id: string;
  username: string;
  email: string | null;
  role: Role;
  business_id: string | null;
  is_active: boolean;
  must_change_password: boolean;
};

export function publicUser(row: UsersWireRow): AuthUser {
  return {
    id: Number(row.id),
    username: String(row.username),
    email: row.email === null || row.email === undefined ? null : String(row.email),
    role: row.role,
    business_id: row.business_id == null ? null : Number(row.business_id),
    is_active: Boolean(row.is_active),
    must_change_password: Boolean(row.must_change_password),
  };
}
