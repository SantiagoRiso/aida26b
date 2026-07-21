// Trailing-edge debounce for user-typed input: a burst of keystrokes must cost one request,
// not one per character.
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel: () => void;
}

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
