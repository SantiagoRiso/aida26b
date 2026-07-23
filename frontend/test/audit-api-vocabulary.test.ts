import { describe, it, expect, vi, beforeEach } from 'vitest';
import { filterParam, listParamEntries } from '@shared/ssot/list-protocol';

// Only the network call is stubbed; the request URL listAudit builds is the real one, so this
// asserts the request and the shareable URL speak the same `filter_` vocabulary.
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, apiFetchDecoded: vi.fn().mockResolvedValue({ ok: true, data: [], meta: null }) };
});

import { listAudit } from '@/api/audit';
import { apiFetchDecoded } from '@/api/client';

const fetchMock = apiFetchDecoded as ReturnType<typeof vi.fn>;

function requestedQuery(): URLSearchParams {
  const path = fetchMock.mock.calls.at(-1)?.[1] as string;
  const qs = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  return new URLSearchParams(qs);
}

beforeEach(() => {
  fetchMock.mockClear();
});

describe('listAudit serializes onto the shared filter_ grammar', () => {
  it('identity filters travel under filter_<field>, matching what the URL layer writes', async () => {
    await listAudit({ outcome: 'denied', entity_type: 'appointments' }, 1, 50);
    const q = requestedQuery();
    expect(q.get(filterParam('outcome'))).toBe('denied');
    expect(q.get(filterParam('entity_type'))).toBe('appointments');
    // No un-prefixed legacy names leak alongside.
    expect(q.has('outcome')).toBe(false);
    expect(q.has('entity_type')).toBe(false);
  });

  it('the created_at range rides the shared min,max grammar, not two ad-hoc date keys', async () => {
    await listAudit({ created_at: '2026-01-01,2026-02-01' }, 1, 50);
    const q = requestedQuery();
    expect(q.get(filterParam('created_at'))).toBe('2026-01-01,2026-02-01');
    expect(q.has('date_from')).toBe(false);
    expect(q.has('date_to')).toBe(false);
  });

  it('the emitted query is exactly what listParamEntries would produce for the same state', async () => {
    await listAudit({ outcome: 'denied', actor_user_id: 7 }, 3, 25, { sort: 'event_type', dir: 'desc' });
    const emitted = [...requestedQuery().entries()].sort();

    const expected = [
      ...new URLSearchParams(
        listParamEntries({
          page: 3,
          limit: 25,
          sort: 'event_type',
          dir: 'desc',
          filters: { outcome: 'denied', actor_user_id: '7' },
        }),
      ).entries(),
    ].sort();

    expect(emitted).toEqual(expected);
  });

  it('page 1 leaves no page key behind, mirroring the URL round-trip', async () => {
    await listAudit({}, 1, 50);
    expect(requestedQuery().has('page')).toBe(false);
  });
});

