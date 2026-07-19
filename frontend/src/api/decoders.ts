// eslint-disable-next-line no-restricted-syntax -- Decoder guards are the reusable untrusted-value boundary.
type DecoderGuard<T> = (value: unknown) => value is T;
// eslint-disable-next-line no-restricted-syntax -- Decoder diagnostics inspect the same untrusted boundary value.
type DecoderExplain = (value: unknown, path?: string) => string | null;

export type Decoder<T> = DecoderGuard<T> & { explain: DecoderExplain };

function decoder<T>(guard: DecoderGuard<T>, expected: string): Decoder<T> {
  const explain: DecoderExplain = (value, path = '$') => guard(value) ? null : `${path}: expected ${expected}`;
  return Object.assign(guard, { explain });
}

export function externalDecoder<T>(guard: DecoderGuard<T>, explain: DecoderExplain): Decoder<T> {
  return Object.assign(guard, { explain });
}

export const undefinedValue = decoder<undefined>((value): value is undefined => value === undefined, 'no content');
export const stringValue = decoder<string>((value): value is string => typeof value === 'string', 'string');
export const numberValue = decoder<number>(
  (value): value is number => typeof value === 'number' && Number.isFinite(value),
  'finite number',
);
export const booleanValue = decoder<boolean>((value): value is boolean => typeof value === 'boolean', 'boolean');

export function nullable<T>(inner: Decoder<T>): Decoder<T | null> {
  const guard: DecoderGuard<T | null> = (value): value is T | null => value === null || inner(value);
  const explain: DecoderExplain = (value, path = '$') => value === null ? null : inner.explain(value, path);
  return Object.assign(guard, { explain });
}

export function optional<T>(inner: Decoder<T>): Decoder<T | undefined> {
  const guard: DecoderGuard<T | undefined> = (value): value is T | undefined => value === undefined || inner(value);
  const explain: DecoderExplain = (value, path = '$') => value === undefined ? null : inner.explain(value, path);
  return Object.assign(guard, { explain });
}

export function literal<const T extends string | number | boolean | null>(expected: T): Decoder<T> {
  return decoder((value): value is T => value === expected, JSON.stringify(expected));
}

export function union<A, B>(a: Decoder<A>, b: Decoder<B>): Decoder<A | B> {
  const guard: DecoderGuard<A | B> = (value): value is A | B => a(value) || b(value);
  const explain: DecoderExplain = (value, path = '$') => (
    guard(value) ? null : `${path}: did not match either allowed shape`
  );
  return Object.assign(guard, { explain });
}

export function object<T>(shape: { [K in keyof T]-?: Decoder<T[K]> }): Decoder<T> {
  const guard: DecoderGuard<T> = (value): value is T => {
    if (!isUnknownRecord(value)) return false;
    for (const key in shape) {
      if (!shape[key](value[key])) return false;
    }
    return true;
  };
  const explain: DecoderExplain = (value, path = '$') => {
    if (!isUnknownRecord(value)) return `${path}: expected object`;
    for (const key in shape) {
      const failure = shape[key].explain(value[key], `${path}.${key}`);
      if (failure) return failure;
    }
    return null;
  };
  return Object.assign(guard, { explain });
}

export function stringEnum<const T extends string>(values: readonly T[]): Decoder<T> {
  return decoder(
    (value): value is T => typeof value === 'string' && values.some((candidate) => candidate === value),
    `one of ${values.join(', ')}`,
  );
}

export function arrayOf<T>(item: Decoder<T>): Decoder<T[]> {
  const guard: DecoderGuard<T[]> = (value): value is T[] => Array.isArray(value) && value.every(item);
  const explain: DecoderExplain = (value, path = '$') => {
    if (!Array.isArray(value)) return `${path}: expected array`;
    for (let index = 0; index < value.length; index += 1) {
      const failure = item.explain(value[index], `${path}[${index}]`);
      if (failure) return failure;
    }
    return null;
  };
  return Object.assign(guard, { explain });
}

export function recordOf<T>(item: Decoder<T>): Decoder<Record<string, T>> {
  const guard: DecoderGuard<Record<string, T>> = (value): value is Record<string, T> => (
    isUnknownRecord(value) && Object.values(value).every(item)
  );
  const explain: DecoderExplain = (value, path = '$') => {
    if (!isUnknownRecord(value)) return `${path}: expected object`;
    for (const [key, field] of Object.entries(value)) {
      const failure = item.explain(field, `${path}.${key}`);
      if (failure) return failure;
    }
    return null;
  };
  return Object.assign(guard, { explain });
}

// eslint-disable-next-line no-restricted-syntax -- Base object guard narrows values at runtime decoder boundaries.
export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
