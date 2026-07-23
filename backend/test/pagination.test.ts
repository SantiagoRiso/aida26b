import { describe, test, expect } from 'vitest';
import { parsePagination } from '../src/routes/pagination';
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, LIST_MAX_PAGE } from '../../shared/src/ssot/list-protocol';

describe('parsePagination', () => {
  test('empty query yields policy defaults', () => {
    expect(parsePagination({})).toEqual({ limit: LIST_DEFAULT_LIMIT, page: 1, offset: 0 });
  });

  test('limit is capped at the shared max and floored at 1', () => {
    expect(parsePagination({ limit: '9999' }).limit).toBe(LIST_MAX_LIMIT);
    expect(parsePagination({ limit: '-5' }).limit).toBe(1);
    expect(parsePagination({ limit: '0' }).limit).toBe(1);
  });

  test('page is floored at 1 and capped at the shared max', () => {
    expect(parsePagination({ page: '-5' }).page).toBe(1);
    expect(parsePagination({ page: '0' }).page).toBe(1);
    expect(parsePagination({ page: '5000' }).page).toBe(LIST_MAX_PAGE);
  });

  test('a fractional limit truncates instead of producing a fractional offset', () => {
    const { limit, page, offset } = parsePagination({ limit: '2.5', page: '2' });
    expect(limit).toBe(2);
    expect(page).toBe(2);
    expect(Number.isInteger(offset)).toBe(true);
    expect(offset).toBe(2);
  });

  test('exponential-notation input reads only its leading digit, not the full magnitude', () => {
    // parseInt("1e15", 10) reads "1" and stops at the non-digit "e" — same behavior list-request.ts
    // relies on. Number("1e15") would instead accept the full 1e15 and blow out the SQL OFFSET.
    expect(parsePagination({ page: '1e15' }).page).toBe(1);
  });

  test('non-numeric limit and page fall back to defaults', () => {
    expect(parsePagination({ limit: 'abc' }).limit).toBe(LIST_DEFAULT_LIMIT);
    expect(parsePagination({ page: 'abc' }).page).toBe(1);
  });

  test('offset is (page - 1) * limit', () => {
    expect(parsePagination({ page: '3', limit: '20' }).offset).toBe(40);
  });
});
