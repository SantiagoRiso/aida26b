import type { Router, RouteLocationRaw, RouteComponent } from 'vue-router';

type LazyRouteComponent = () => Promise<RouteComponent | { default: RouteComponent }>;

// A route entry is either an already-resolved component (nothing to fetch) or a lazy loader.
// Resolved functional and class components are functions too, so `typeof` alone can't tell them
// apart; calling one would invoke a render function instead of loading a chunk.
function isLazyRouteComponent(
  component: RouteComponent | LazyRouteComponent,
): component is LazyRouteComponent {
  return typeof component === 'function'
    && !('displayName' in component)
    && !('props' in component)
    && !('__vccOpts' in component);
}

const prefetched = new Set<string>();

export function prefetchRoute(router: Router, to: RouteLocationRaw): void {
  const resolved = router.resolve(to);
  if (prefetched.has(resolved.fullPath)) return;
  prefetched.add(resolved.fullPath);
  for (const record of resolved.matched) {
    for (const component of Object.values(record.components ?? {})) {
      if (!isLazyRouteComponent(component)) continue;
      void Promise.resolve(component()).catch(() => {
        prefetched.delete(resolved.fullPath);
      });
    }
  }
}
