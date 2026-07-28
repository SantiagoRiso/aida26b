import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { isPasswordReused } from '@shared/ssot/domain/people';

// Before the fix: the forced (post-login) ChangePasswordView blocked a repeated password with a
// live client-side check; the in-session screen had no such check and only discovered the
// rejection after a server round trip. Both now share ChangePasswordSection.vue, which runs the
// same shared/src/ssot isPasswordReused rule the backend enforces. These tests prove the
// in-session screen behaves identically to the forced one, not just that some error eventually
// appears. Staff change their own password from Configuracion; Perfil no longer carries a second
// copy of the same form.

import SettingsView from '@/views/staff/SettingsView.vue';

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

// The live pre-check must reject before ever reaching the network: a fetch stub that throws
// proves submit() short-circuited on the client instead of relying on a server round trip.
function stubUnreachableFetch() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network must not be reached')));
}

function signInProfessional() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  auth.user = {
    id: 1, username: 'demo', email: null, role: 'Professional',
    business_id: 1, is_active: true, must_change_password: false,
  };
  return pinia;
}

describe('SettingsView (in-session) rejects a repeated password like the forced flow does', () => {
  beforeEach(() => vi.resetAllMocks());

  it('blocks submit and shows the reuse error live, with no server round trip', async () => {
    stubUnreachableFetch();

    const pinia = signInProfessional();
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, makeI18n()] } });
    await flushPromises();

    await wrapper.get('#settings-pw-current').setValue('samepass123');
    await wrapper.get('#settings-pw-new').setValue('samepass123');
    await flushPromises();

    expect(wrapper.text()).toContain(es.apiError.passwordReuse);
    expect(wrapper.get('#settings-pw-save').attributes('disabled')).toBeDefined();

    await wrapper.get('#settings-pw-save').trigger('click');
    await flushPromises();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('a differing new password is not flagged and the button stays enabled', async () => {

    const pinia = signInProfessional();
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, makeI18n()] } });
    await flushPromises();

    await wrapper.get('#settings-pw-current').setValue('oldpassword1');
    await wrapper.get('#settings-pw-new').setValue('brandnewpass2');
    await flushPromises();

    expect(wrapper.text()).not.toContain(es.apiError.passwordReuse);
    expect(wrapper.get('#settings-pw-save').attributes('disabled')).toBeUndefined();
  });
});

describe('isPasswordReused (shared/src/ssot/domain/people.ts) — the single rule both sides enforce', () => {
  it('flags an identical new/current pair', () => {
    expect(isPasswordReused('samepass123', 'samepass123')).toBe(true);
  });

  it('does not flag a differing pair', () => {
    expect(isPasswordReused('brandnewpass2', 'oldpassword1')).toBe(false);
  });

  it('does not flag an empty new password (that is the separate required-field rule)', () => {
    expect(isPasswordReused('', '')).toBe(false);
  });
});
