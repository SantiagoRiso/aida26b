import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { LIST_DEFAULT_LIMIT } from '@shared/ssot/list-protocol';
import type { LedgerEntry } from '@/api/ledger';

vi.mock('@/api/ledger', () => ({
  getBalance: vi.fn(),
  getLedger: vi.fn(),
}));

import BalanceView from '@/views/portal/BalanceView.vue';
import { getBalance, getLedger } from '@/api/ledger';

const getLedgerMock = vi.mocked(getLedger);
const getBalanceMock = vi.mocked(getBalance);

function makeEntry(id: number): LedgerEntry {
  return {
    id: String(id),
    client_user_id: '1',
    appointment_id: null,
    entry_type: 'payment',
    amount_ars: '1000.00',
    description: null,
    actor_user_id: null,
    created_at: '2026-01-01T12:00:00.000Z',
  } as LedgerEntry;
}

async function mountBalance(initialUrl = '/') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  auth.user = {
    id: 1,
    username: 'demo_client',
    email: null,
    role: 'Client',
    business_id: 1,
    is_active: true,
    must_change_password: false,
  };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div/>' } }],
  });
  await router.push(initialUrl);
  await router.isReady();
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  const wrapper = mount(BalanceView, { global: { plugins: [pinia, router, i18n] } });
  await flushPromises();
  return { wrapper, router };
}

function lastLedgerCall() {
  const calls = getLedgerMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1];
}

// The label is read from the i18n bundle, never hardcoded, so a wording change can't silently
// stop this suite from clicking the header it means to.
function headerButton(wrapper: Awaited<ReturnType<typeof mountBalance>>['wrapper'], label: string) {
  const th = wrapper.findAll('th').find((cell) => cell.text().startsWith(label));
  expect(th, `no header for ${label}`).toBeTruthy();
  return th!;
}

function okPage(entries: LedgerEntry[], total = entries.length) {
  return { ok: true as const, data: entries, meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total } };
}

beforeEach(() => {
  vi.resetAllMocks();
  getBalanceMock.mockResolvedValue({ ok: true, data: { client_user_id: '1', balance_ars: '0.00' } });
  getLedgerMock.mockResolvedValue(okPage([makeEntry(1)]));
});

describe('BalanceView — statement ordering', () => {
  it('asks the server for the order; the first request carries no sort at all', async () => {
    await mountBalance();
    expect(lastLedgerCall()).toEqual([1, 1, LIST_DEFAULT_LIMIT, { sort: undefined, dir: 'asc' }]);
  });

  it('clicking a column header sorts server-side, and clicking it again reverses', async () => {
    const { wrapper, router } = await mountBalance();

    await headerButton(wrapper, es.portal.amount).get('button').trigger('click');
    await flushPromises();
    expect(lastLedgerCall()[3]).toEqual({ sort: 'amount_ars', dir: 'asc' });
    expect(router.currentRoute.value.query).toMatchObject({ sort: 'amount_ars', dir: 'asc' });

    await headerButton(wrapper, es.portal.amount).get('button').trigger('click');
    await flushPromises();
    expect(lastLedgerCall()[3]).toEqual({ sort: 'amount_ars', dir: 'desc' });
    expect(router.currentRoute.value.query).toMatchObject({ sort: 'amount_ars', dir: 'desc' });
  });

  it('reports the active column through aria-sort, not only through an arrow', async () => {
    const { wrapper } = await mountBalance();

    expect(headerButton(wrapper, es.portal.amount).attributes('aria-sort')).toBe('none');
    await headerButton(wrapper, es.portal.amount).get('button').trigger('click');
    await flushPromises();
    expect(headerButton(wrapper, es.portal.amount).attributes('aria-sort')).toBe('ascending');
    expect(headerButton(wrapper, es.portal.date).attributes('aria-sort')).toBe('none');
  });

  it('re-sorting returns to page 1: the row that was on page 2 is not on page 2 of the new order', async () => {
    getLedgerMock.mockResolvedValue(okPage([makeEntry(1)], LIST_DEFAULT_LIMIT * 3));
    const { wrapper, router } = await mountBalance();

    const next = wrapper.findAll('button').find((b) => b.text() === es.generic.next);
    await next!.trigger('click');
    await flushPromises();
    expect(lastLedgerCall()[1]).toBe(2);

    await headerButton(wrapper, es.portal.type).get('button').trigger('click');
    await flushPromises();
    expect(lastLedgerCall()[1]).toBe(1);
    expect(router.currentRoute.value.query.page).toBeUndefined();
  });

  it('a column the server does not sort by is dropped from the URL rather than forwarded', async () => {
    await mountBalance('/?sort=description&dir=desc');
    expect(lastLedgerCall()[3]).toEqual({ sort: undefined, dir: 'desc' });
  });
});

describe('BalanceView — state restores from the URL', () => {
  it('a pasted link seeds the very first request with its page and order', async () => {
    await mountBalance('/?page=3&sort=entry_type&dir=desc');
    expect(lastLedgerCall()).toEqual([1, 3, LIST_DEFAULT_LIMIT, { sort: 'entry_type', dir: 'desc' }]);
  });

  // The view's own writes replace rather than push, so one navigation is one history entry; back
  // and forward move between views, and each must re-ask the server for what that view showed.
  it('back and forward re-fetch the order that entry of the history carried', async () => {
    const { router } = await mountBalance();

    await router.push('/?sort=entry_type&dir=desc');
    await flushPromises();
    expect(lastLedgerCall()[3]).toEqual({ sort: 'entry_type', dir: 'desc' });

    router.back();
    await flushPromises();
    expect(lastLedgerCall()[3]).toEqual({ sort: undefined, dir: 'asc' });

    router.forward();
    await flushPromises();
    expect(lastLedgerCall()[3]).toEqual({ sort: 'entry_type', dir: 'desc' });
  });
});

describe('BalanceView — paging', () => {
  it('shows no pager when everything fits on one page', async () => {
    const { wrapper } = await mountBalance();
    expect(wrapper.findAll('button').some((b) => b.text() === es.generic.next)).toBe(false);
  });

  it('paging asks the server for the next page and writes it to the URL', async () => {
    getLedgerMock.mockResolvedValue(okPage([makeEntry(1)], LIST_DEFAULT_LIMIT * 2));
    const { wrapper, router } = await mountBalance();

    const next = wrapper.findAll('button').find((b) => b.text() === es.generic.next);
    await next!.trigger('click');
    await flushPromises();

    expect(lastLedgerCall()[1]).toBe(2);
    expect(router.currentRoute.value.query.page).toBe('2');
  });
});

describe('BalanceView — empty ledger', () => {
  it('renders the empty state and no pager when there are no entries', async () => {
    getLedgerMock.mockResolvedValue(okPage([]));
    const { wrapper } = await mountBalance();

    expect(wrapper.text()).toContain(es.portal.noLedgerHeading);
    expect(wrapper.findAll('button').some((b) => b.text() === es.generic.next)).toBe(false);
    // A zero balance is not overdue.
    expect(wrapper.text()).toContain(es.portal.balanceOk);
  });

  it('shows the overdue message when the balance is positive', async () => {
    getBalanceMock.mockResolvedValue({ ok: true, data: { client_user_id: '1', balance_ars: '500.00' } });
    getLedgerMock.mockResolvedValue(okPage([]));
    const { wrapper } = await mountBalance();

    expect(wrapper.text()).toContain(es.portal.balanceDue);
  });
});
