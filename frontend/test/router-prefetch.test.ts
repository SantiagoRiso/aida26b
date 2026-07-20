import { describe, it, expect, vi } from 'vitest';
import { h, defineComponent } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
import type { FunctionalComponent } from 'vue';
import { prefetchRoute } from '@/router/prefetch';

const lazyRoute = () => {
  const loader = vi.fn(() => Promise.resolve({ default: defineComponent({ render: () => h('div') }) }));
  return { loader, route: { path: '/lazy', name: 'lazy', component: loader } };
};

function makeRouter(routes: Parameters<typeof createRouter>[0]['routes']) {
  return createRouter({ history: createMemoryHistory(), routes });
}

describe('prefetchRoute', () => {
  it('invokes a lazy loader to warm its chunk', async () => {
    const { loader, route } = lazyRoute();
    const router = makeRouter([route]);

    prefetchRoute(router, { name: 'lazy' });

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('prefetches a given route only once', async () => {
    const { loader, route } = lazyRoute();
    const router = makeRouter([{ ...route, path: '/lazy-once', name: 'lazy-once' }]);

    prefetchRoute(router, { name: 'lazy-once' });
    prefetchRoute(router, { name: 'lazy-once' });

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('leaves an already-resolved options component alone', async () => {
    const render = vi.fn(() => h('div'));
    const router = makeRouter([
      { path: '/resolved', name: 'resolved', component: defineComponent({ render }) },
    ]);

    prefetchRoute(router, { name: 'resolved' });

    expect(render).not.toHaveBeenCalled();
  });

  // A resolved functional component is a function too, so a bare `typeof === 'function'` test would
  // invoke its render body instead of loading a chunk.
  it('does not invoke a resolved functional component', async () => {
    const functional = vi.fn(() => h('div')) as FunctionalComponent;
    functional.displayName = 'Resolved';
    const router = makeRouter([{ path: '/functional', name: 'functional', component: functional }]);

    prefetchRoute(router, { name: 'functional' });

    expect(functional).not.toHaveBeenCalled();
  });

  it('allows a retry after a failed load', async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('chunk load failed'))
      .mockResolvedValueOnce({ default: defineComponent({ render: () => h('div') }) });
    const router = makeRouter([{ path: '/flaky', name: 'flaky', component: loader }]);

    prefetchRoute(router, { name: 'flaky' });
    await Promise.resolve();
    await Promise.resolve();
    prefetchRoute(router, { name: 'flaky' });

    expect(loader).toHaveBeenCalledTimes(2);
  });
});
