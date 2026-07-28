import { describe, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { LIST_DEFAULT_LIMIT } from '@shared/ssot/list-protocol';
import { structure } from '@shared/ssot/structure';
import type { AuthUser } from '@shared/ssot/contracts/auth';
import type { TableRecordMap } from '@shared/ssot/derived';
import type { Wire } from '@shared/ssot/query-types';

// Regression for: "Después de ponerle reset contraseña a un usuario, no cambia de no a sí, tuve
// que salir y volver a entrar." The backend flips must_change_password to true on a successful
// reset (RETURNING ... must_change_password in db/users.ts), but the row kept showing the old
// value because submitReset() never asked the list to reload -- unlike confirmDeactivate(), which
// already bumps reloadKey. This proves the row picks up the server's new value from a fresh
// fetch, in the same mounted view, with no navigation and no patched-in guess.

function userRow(mustChangePassword: boolean): Wire<TableRecordMap['users']> {
  return {
    id: '2',
    business_id: null,
    username: 'cliente1',
    email: 'cliente1@example.com',
    role: 'Client',
    is_active: true,
    must_change_password: mustChangePassword,
  };
}

vi.mock('@/api/crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/crud')>();
  return {
    ...actual,
    listRows: vi.fn(),
    getRow: vi.fn(),
    createRow: vi.fn(),
    updateRow: vi.fn(),
    deleteRow: vi.fn(),
  };
});

vi.mock('@/api/admin-users', () => ({
  createUser: vi.fn(),
  deactivateUser: vi.fn(),
  resetPassword: vi.fn(),
  enableClientLogin: vi.fn(),
}));

// DetailPanel's Headless UI Dialog/TransitionRoot renders empty under jsdom; stub it to plain
// slot content gated on `open` so the reset form is actually reachable in the test.
const DetailPanelStub = {
  name: 'DetailPanel',
  props: ['open', 'title'],
  template: '<div v-if="open"><slot /></div>',
};

function makePlugins() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  const adminUser: AuthUser = {
    id: 1, username: 'admin', email: null, role: 'Admin',
    business_id: null, is_active: true, must_change_password: false,
  };
  auth.user = adminUser;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div/>' } }] });
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  return { pinia, router, i18n };
}

import UsersView from '@/views/staff/UsersView.vue';

describe('UsersView -- reset password refreshes the row without a remount or navigation', () => {
  it('the row flips from No to Sí after a successful reset, from a re-fetch of the list', async () => {
    const { listRows } = await import('@/api/crud');
    const { resetPassword } = await import('@/api/admin-users');

    let usersCalls = 0;
    (listRows as ReturnType<typeof vi.fn>).mockImplementation(async (table: string) => {
      if (table !== 'users') return { ok: true, data: [], meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 0 } };
      usersCalls += 1;
      // First load reflects the stale pre-reset state; only a second fetch would see the flip.
      return { ok: true, data: [userRow(usersCalls > 1)], meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 1 } };
    });
    (resetPassword as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      data: { user: { id: '2', username: 'cliente1', role: 'Client' } },
    });

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(UsersView, {
      global: { plugins: [pinia, router, i18n], stubs: { DetailPanel: DetailPanelStub } },
    });
    await flushPromises();

    expect(usersCalls).toBe(1);

    // is_active is also a boolean column rendered as Sí/No, so the must_change_password cell is
    // located by its own SSoT header label rather than by scanning for any "Sí"/"No" text.
    const mustChangeLabel = structure.tables.users.columns.must_change_password.label.es;
    function mustChangePasswordCellText(): string {
      const headers = wrapper.findAll('th').map((th) => th.text());
      const columnIndex = headers.findIndex((h) => h.includes(mustChangeLabel));
      expect(columnIndex).toBeGreaterThanOrEqual(0);
      const row = wrapper.findAll('tbody tr')[0];
      return row.findAll('td')[columnIndex].text();
    }

    expect(mustChangePasswordCellText()).toBe(es.generic.no);

    const resetButton = wrapper.findAll('button').find((b) => b.text() === es.users.resetPassword);
    expect(resetButton).toBeTruthy();
    await resetButton!.trigger('click');
    await flushPromises();

    await wrapper.find('#new-password').setValue('NuevaClave123!');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(resetPassword).toHaveBeenCalledWith('2', 'NuevaClave123!');
    expect(usersCalls).toBe(2);
    expect(mustChangePasswordCellText()).toBe(es.generic.yes);
  });
});
