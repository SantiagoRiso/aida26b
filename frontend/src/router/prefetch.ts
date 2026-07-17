import type { Router, RouteLocationRaw } from 'vue-router';

const prefetched = new Set<string>();

export function prefetchRoute(router: Router, to: RouteLocationRaw): void {
  const resolved = router.resolve(to);
  if (prefetched.has(resolved.fullPath)) return;
  prefetched.add(resolved.fullPath);
  for (const record of resolved.matched) {
    for (const component of Object.values(record.components ?? {})) {
      if (typeof component === 'function') void Promise.resolve(component()).catch(() => {
        prefetched.delete(resolved.fullPath);
      });
    }
  }
}
