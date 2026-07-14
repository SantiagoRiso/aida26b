import { describe, test, expect } from 'vitest';
import { parseListRequest } from '../src/routes/list-request';
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  filterParam,
  stripFilterPrefix,
  isReservedListParam,
} from '../../shared/src/ssot/list-protocol';

describe('list-protocol helpers', () => {
  test('filterParam and stripFilterPrefix are inverses', () => {
    expect(filterParam('name')).toBe('filter_name');
    expect(stripFilterPrefix(filterParam('name'))).toBe('name');
  });

  test('reserved list params are exactly page/sort/dir/limit', () => {
    for (const key of ['page', 'sort', 'dir', 'limit']) {
      expect(isReservedListParam(key)).toBe(true);
    }
    expect(isReservedListParam('id')).toBe(false);
    expect(isReservedListParam('filter_name')).toBe(false);
  });
});

describe('parseListRequest', () => {
  test('empty query yields policy defaults', () => {
    const spec = parseListRequest({});
    expect(spec).toEqual({
      filters: [],
      sort: undefined,
      dir: 'asc',
      page: 1,
      limit: LIST_DEFAULT_LIMIT,
    });
  });

  test('limit is capped at the shared max and floored at 1', () => {
    expect(parseListRequest({ limit: '9999' }).limit).toBe(LIST_MAX_LIMIT);
    expect(parseListRequest({ limit: '-5' }).limit).toBe(1);
  });

  test('non-numeric limit and page fall back to defaults', () => {
    expect(parseListRequest({ limit: 'abc' }).limit).toBe(LIST_DEFAULT_LIMIT);
    expect(parseListRequest({ page: 'abc' }).page).toBe(1);
  });

  test('page is clamped to [1, 1000]', () => {
    expect(parseListRequest({ page: '0' }).page).toBe(1);
    expect(parseListRequest({ page: '5000' }).page).toBe(1000);
  });

  test('lexes the ! negation marker off filter values', () => {
    const spec = parseListRequest({ filter_role: '!Client' });
    expect(spec.filters).toEqual([
      { field: 'role', values: [{ negated: true, value: 'Client' }] },
    ]);
  });

  test('range syntax passes through untouched — interpretation is the compiler\'s', () => {
    const spec = parseListRequest({ filter_price: '10,60' });
    expect(spec.filters).toEqual([
      { field: 'price', values: [{ negated: false, value: '10,60' }] },
    ]);
  });

  test('repeated filter params keep every value', () => {
    const spec = parseListRequest({ filter_state: ['requested', '!cancelled'] });
    expect(spec.filters).toEqual([
      {
        field: 'state',
        values: [
          { negated: false, value: 'requested' },
          { negated: true, value: 'cancelled' },
        ],
      },
    ]);
  });

  test('empty filter values and non-filter keys are dropped', () => {
    const spec = parseListRequest({ filter_name: '', id: '7', sort: 'name' });
    expect(spec.filters).toEqual([]);
    expect(spec.sort).toBe('name');
  });

  test('array-valued sort and dir take the first value', () => {
    const spec = parseListRequest({ sort: ['name', 'id'], dir: ['desc', 'asc'] });
    expect(spec.sort).toBe('name');
    expect(spec.dir).toBe('desc');
  });
});
