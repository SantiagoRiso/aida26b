import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import type { LedgerEntry } from '@/api/ledger';

vi.mock('@/api/ledger', () => ({
  getBalance: vi.fn(),
  getLedger: vi.fn(),
}));

import BalanceView from '@/views/portal/BalanceView.vue';

const LIMIT = 25;

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

function mountBalance() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  auth.user = {
    id: 1,
    username: 'demo_client',
    email: null,
    role: 'Client',
    business_id: 'biz-1',
    is_active: true,
    must_change_password: false,
  };
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  return mount(BalanceView, { global: { plugins: [pinia, i18n] } });
}

describe('BalanceView — empty ledger', () => {
  beforeEach(() => vi.resetAllMocks());

  it('renders the empty state and no Load more button when there are no entries', async () => {
    const { getBalance, getLedger } = await import('@/api/ledger');
    (getBalance as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { client_user_id: '1', balance_ars: '0.00' } });
    (getLedger as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] });

    const wrapper = mountBalance();
    await flushPromises();

    expect(wrapper.text()).toContain(es.portal.noLedgerHeading);
    expect(wrapper.text()).toContain(es.portal.noLedgerBody);
    expect(wrapper.findAll('button').some((b) => b.text() === es.portal.loadMore)).toBe(false);
    // A zero balance is not overdue.
    expect(wrapper.text()).toContain(es.portal.balanceOk);
  });

  it('shows the overdue balanceDue message when the balance is positive', async () => {
    const { getBalance, getLedger } = await import('@/api/ledger');
    (getBalance as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { client_user_id: '1', balance_ars: '500.00' } });
    (getLedger as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] });

    const wrapper = mountBalance();
    await flushPromises();

    expect(wrapper.text()).toContain(es.portal.balanceDue);
  });
});

describe('BalanceView — Load more pagination', () => {
  beforeEach(() => vi.resetAllMocks());

  it('shows Load more when the first page is full, appends page 2, and hides it once page 2 is short', async () => {
    const { getBalance, getLedger } = await import('@/api/ledger');
    (getBalance as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { client_user_id: '1', balance_ars: '0.00' } });

    const page1 = Array.from({ length: LIMIT }, (_, i) => makeEntry(i + 1));
    const page2 = [makeEntry(100), makeEntry(101)]; // short page → no more after this

    const getLedgerMock = getLedger as ReturnType<typeof vi.fn>;
    getLedgerMock.mockResolvedValueOnce({ ok: true, data: page1 });

    const wrapper = mountBalance();
    await flushPromises();

    expect(getLedgerMock).toHaveBeenCalledWith(1, 1, LIMIT);
    const loadMoreButton = () => wrapper.findAll('button').find((b) => b.text() === es.portal.loadMore);
    expect(loadMoreButton()).toBeTruthy();
    expect(wrapper.findAll('tbody tr')).toHaveLength(LIMIT);

    getLedgerMock.mockResolvedValueOnce({ ok: true, data: page2 });
    await loadMoreButton()!.trigger('click');
    await flushPromises();

    // Client-side page increments to 2; the same limit is used for the next fetch.
    expect(getLedgerMock).toHaveBeenLastCalledWith(1, 2, LIMIT);
    expect(wrapper.findAll('tbody tr')).toHaveLength(LIMIT + page2.length);
    // page2.length (2) < LIMIT → hasMore flips false, the button disappears.
    expect(loadMoreButton()).toBeUndefined();
  });
});
