import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '@/api/client';
import type { AvailabilityResult } from '@/api/scheduling';

const { apiFetchMock, mutationState } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  mutationState: { generation: 0 },
}));

vi.mock('@/api/client', () => ({
  apiFetchDecoded: apiFetchMock,
}));
vi.mock('@/api/mutation-generation', () => ({ getApiMutationGeneration: () => mutationState.generation }));

import { getAvailabilityRange, invalidateAvailabilityCache } from '@/api/scheduling';

const success: ApiResult<AvailabilityResult[]> = {
  ok: true,
  data: [{ date: '2026-07-20', open: true, slots: [{ start: '09:00', end: '09:50' }] }],
};

beforeEach(() => {
  apiFetchMock.mockReset();
  mutationState.generation = 0;
  invalidateAvailabilityCache();
});

describe('availability range request reuse', () => {
  it('shares an identical in-flight request within one load cycle', async () => {
    let resolve!: (value: ApiResult<AvailabilityResult[]>) => void;
    apiFetchMock.mockReturnValue(new Promise((done) => { resolve = done; }));
    const controller = new AbortController();

    const first = getAvailabilityRange('prof:2', '2026-07-20', '2026-07-27', undefined, {
      signal: controller.signal,
    });
    const second = getAvailabilityRange('prof:2', '2026-07-20', '2026-07-27', undefined, {
      signal: controller.signal,
    });

    expect(apiFetchMock).toHaveBeenCalledOnce();
    resolve(success);
    await expect(Promise.all([first, second])).resolves.toEqual([success, success]);
  });

  it('serves a recent successful result without another API call', async () => {
    apiFetchMock.mockResolvedValue(success);

    await getAvailabilityRange('prof:2', '2026-07-20', '2026-07-27');
    await getAvailabilityRange('prof:2', '2026-07-20', '2026-07-27');

    expect(apiFetchMock).toHaveBeenCalledOnce();
  });

  it('invalidates cached ranges after scheduling data changes', async () => {
    apiFetchMock.mockResolvedValue(success);
    await getAvailabilityRange('prof:2', '2026-07-20', '2026-07-27');

    mutationState.generation += 1;
    await getAvailabilityRange('prof:2', '2026-07-20', '2026-07-27');

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes the cycle abort signal to the underlying request', async () => {
    apiFetchMock.mockResolvedValue(success);
    const controller = new AbortController();

    await getAvailabilityRange('res:4', '2026-07-20', '2026-07-27', undefined, {
      signal: controller.signal,
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.stringContaining('owner=res%3A4'),
      { signal: controller.signal },
    );
  });
});
