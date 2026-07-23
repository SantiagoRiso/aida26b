import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { structure } from '@shared/ssot/structure';
import type { ApiEnvelope } from '@shared/ssot/envelope';
import type { SelfProfileRow } from '@shared/ssot/query-types';

vi.mock('@/api/admin-users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin-users')>()),
  createUser: vi.fn(),
}));

import CreateClientForm from '@/components/staff/CreateClientForm.vue';
import { createUser } from '@/api/admin-users';

const createUserMock = createUser as ReturnType<typeof vi.fn>;
const emailLabel = structure.tables.clients.columns.email.label.es;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
  createUserMock.mockResolvedValue({ ok: true, data: { id: 1, role: 'Client' } });
});

function mountForm() {
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  return mount(CreateClientForm, { global: { plugins: [createPinia(), i18n] } });
}

function emailLabelText(wrapper: ReturnType<typeof mountForm>) {
  return wrapper.get('label[for="create-client-email"]').text();
}

describe('CreateClientForm — email is optional for a contact-only client', () => {
  it('does not mark the email required and creates the client without one', async () => {
    const wrapper = mountForm();

    expect(emailLabelText(wrapper)).toBe(emailLabel);
    expect(wrapper.get('#create-client-email').attributes('required')).toBeUndefined();

    await wrapper.get('#create-client-display-name').setValue('Walk In');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(createUserMock).toHaveBeenCalledTimes(1);
    expect(createUserMock.mock.calls[0][0]).toMatchObject({
      role: 'Client',
      display_name: 'Walk In',
      email: undefined,
    });
    expect(wrapper.emitted('created')).toBeTruthy();
  });

  it('requires the email once login is enabled, and does not submit without it', async () => {
    const wrapper = mountForm();

    await wrapper.get('input[type="checkbox"]').setValue(true);

    expect(emailLabelText(wrapper)).toBe(`${emailLabel} *`);
    expect(wrapper.get('#create-client-email').attributes('required')).toBeDefined();

    await wrapper.get('#create-client-display-name').setValue('Con Acceso');
    await wrapper.get('#create-client-username').setValue('conacceso');
    await wrapper.get('#create-client-password').setValue('secret123');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(createUserMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(es.apiError.emailFormat);
  });

  it('submits credentials together with the email once it is filled in', async () => {
    const wrapper = mountForm();

    await wrapper.get('input[type="checkbox"]').setValue(true);
    await wrapper.get('#create-client-display-name').setValue('Con Acceso');
    await wrapper.get('#create-client-email').setValue('conacceso@test.com');
    await wrapper.get('#create-client-username').setValue('conacceso');
    await wrapper.get('#create-client-password').setValue('secret123');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(createUserMock.mock.calls[0][0]).toMatchObject({
      email: 'conacceso@test.com',
      username: 'conacceso',
      password: 'secret123',
    });
  });
});

describe('self profile decoding — a client may have no email', () => {
  function mockFetch(body: ApiEnvelope<{ profile: SelfProfileRow }>) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ));
  }

  it('decodes a profile whose email is null', async () => {
    mockFetch({
      success: true,
      data: { profile: { id: '7', display_name: 'Sin Email', bio: null, email: null, phone: '11' } },
    });
    const { getMyProfile } = await import('@/api/profile');
    const result = await getMyProfile();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.profile.email).toBeNull();
  });

  it('still decodes a profile that has one', async () => {
    mockFetch({
      success: true,
      data: { profile: { id: '7', display_name: 'Con Email', bio: null, email: 'a@b.com', phone: null } },
    });
    const { getMyProfile } = await import('@/api/profile');
    const result = await getMyProfile();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.profile.email).toBe('a@b.com');
  });
});
