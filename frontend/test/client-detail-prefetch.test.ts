import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({
  getRow: vi.fn(),
  listAppointments: vi.fn(),
  generation: 0,
}));

vi.mock('@/api/crud', () => ({ getRow: mocks.getRow }));
vi.mock('@/api/appointments', () => ({ listAppointments: mocks.listAppointments }));
vi.mock('@/api/client', () => ({ getApiMutationGeneration: () => mocks.generation }));

import {
  prefetchClientDetail,
  resetClientDetailPrefetch,
  takeClientDetailPrefetch,
} from '@/composables/clientDetailPrefetch';

beforeEach(() => {
  resetClientDetailPrefetch();
  mocks.generation = 0;
  mocks.getRow.mockReset().mockResolvedValue({ ok: true, data: { id: '7' } });
  mocks.listAppointments.mockReset().mockResolvedValue({ ok: true, data: [] });
});

describe('client detail prefetch', () => {
  it('starts profile and appointment reads once and hands the result to the panel', async () => {
    prefetchClientDetail(7);
    prefetchClientDetail(7);
    expect(mocks.getRow).toHaveBeenCalledTimes(1);
    expect(mocks.listAppointments).toHaveBeenCalledTimes(1);
    await expect(takeClientDetailPrefetch(7)).resolves.toMatchObject({
      profile: { ok: true }, appointments: { ok: true },
    });
    expect(takeClientDetailPrefetch(7)).toBeNull();
  });

  it('discards prefetched data after a mutation generation change', async () => {
    prefetchClientDetail(7);
    await flushPromises();
    mocks.generation = 1;
    expect(takeClientDetailPrefetch(7)).toBeNull();
  });
});
