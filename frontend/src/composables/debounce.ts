// Trailing-edge debounce for user-typed input: a burst of keystrokes must cost one request,
// not one per character.
// eslint-disable-next-line no-restricted-syntax -- variadic tuple generic: the debounced callback's argument list is arbitrary per call site; no narrower constraint expresses "any argument list"
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel: () => void;
}

// eslint-disable-next-line no-restricted-syntax -- variadic tuple generic: the debounced callback's argument list is arbitrary per call site; no narrower constraint expresses "any argument list"
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const wrapped = (...args: A) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };

  wrapped.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return wrapped;
}
