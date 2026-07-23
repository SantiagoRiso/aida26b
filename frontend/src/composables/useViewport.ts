import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue';

// One breakpoint for every JS-driven responsive switch, matching the shell's sidebar/drawer swap,
// so the calendar and the navigation never disagree about what counts as a phone.
export const WIDE_VIEWPORT_QUERY = '(min-width: 768px)';

export function useNarrowViewport(): Ref<boolean> {
  const query = window.matchMedia?.(WIDE_VIEWPORT_QUERY) ?? null;
  const narrow = ref(query ? !query.matches : false);
  const onChange = (event: MediaQueryListEvent) => { narrow.value = !event.matches; };
  query?.addEventListener('change', onChange);
  // Callers outside a component (tests, plain composable use) get the ref without teardown.
  if (getCurrentScope()) onScopeDispose(() => query?.removeEventListener('change', onChange));
  return narrow;
}
