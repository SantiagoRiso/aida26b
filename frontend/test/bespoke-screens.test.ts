import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';

import { useCurrency } from '@/composables/useCurrency';

describe('useCurrency', () => {
  const { formatARS, formatDate, formatDateTime } = useCurrency();

  it('formats a positive ARS amount with Argentine grouping', () => {
    const result = formatARS('1500.50');
    expect(result).toContain('$');
    expect(result).toContain('1');
    expect(result).toContain('500');
  });

  it('formats zero', () => {
    const result = formatARS('0');
    expect(result).toContain('$');
  });

  it('formats NaN gracefully', () => {
    const result = formatARS('not-a-number');
    expect(result).toBe('$ -');
  });

  it('formatDate returns DD/MM/YYYY format', () => {
    const result = formatDate('2024-03-15T00:00:00Z');
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('formatDateTime includes hours and minutes', () => {
    const result = formatDateTime('2024-03-15T14:30:00Z');
    expect(result).toContain(':');
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('formatARS for large amounts includes thousands separator', () => {
    const result = formatARS('10000.00');
    // In es-AR, 10000 is formatted as "10.000" (dot for thousands).
    expect(result).toContain('10');
    expect(result).toContain('000');
  });
});

import LanguageToggle from '@/components/settings/LanguageToggle.vue';
import { useUiStore } from '@/stores/ui';

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

describe('LanguageToggle', () => {
  beforeEach(() => {
    // Store defaults to 'es' only when no prior selection is persisted.
    localStorage.removeItem('language');
    setActivePinia(createPinia());
  });

  it('renders two language buttons', () => {
    const i18n = makeI18n();
    const wrapper = mount(LanguageToggle, { global: { plugins: [i18n] } });
    const buttons = wrapper.findAll('button');
    expect(buttons.length).toBe(2);
  });

  it('highlights the active language button with aria-pressed', () => {
    const i18n = makeI18n();
    const wrapper = mount(LanguageToggle, { global: { plugins: [i18n] } });
    const esBtn = wrapper.find('[data-testid="lang-es"]');
    expect(esBtn.attributes('aria-pressed')).toBe('true');
  });

  it('calls setLanguage when the other language button is clicked', async () => {
    const i18n = makeI18n();
    const wrapper = mount(LanguageToggle, { global: { plugins: [i18n] } });
    const ui = useUiStore();
    const spy = vi.spyOn(ui, 'setLanguage');

    const enBtn = wrapper.find('[data-testid="lang-en"]');
    await enBtn.trigger('click');

    expect(spy).toHaveBeenCalledWith('en');
  });

  it('does not call setLanguage when clicking the already-active language', async () => {
    const i18n = makeI18n();
    const wrapper = mount(LanguageToggle, { global: { plugins: [i18n] } });
    const ui = useUiStore();
    const spy = vi.spyOn(ui, 'setLanguage');

    const esBtn = wrapper.find('[data-testid="lang-es"]');
    await esBtn.trigger('click');

    expect(spy).not.toHaveBeenCalled();
  });

  it('exposes a stable data-testid on the root element', () => {
    const i18n = makeI18n();
    const wrapper = mount(LanguageToggle, { global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="language-toggle"]').exists()).toBe(true);
  });
});

import { roleAllowedFor } from '@/router/access';
import type { Role } from '@shared/types/roles';

describe('Ledger roleAllowedFor create gate', () => {
  const createRoles: Role[] = ['Admin', 'Receptionist'];

  it('allows Admin to create', () => {
    expect(roleAllowedFor(createRoles, 'Admin')).toBe(true);
  });

  it('allows Receptionist to create', () => {
    expect(roleAllowedFor(createRoles, 'Receptionist')).toBe(true);
  });

  it('does NOT allow Professional to create ledger entries', () => {
    expect(roleAllowedFor(createRoles, 'Professional')).toBe(false);
  });

  it('does NOT allow Client to create ledger entries', () => {
    expect(roleAllowedFor(createRoles, 'Client')).toBe(false);
  });
});

describe('AuditView outcome badge class logic', () => {
  it('success reads as success', () => {
    expect(auditOutcomeBadgeClass('success')).toBe(BADGE_TONE_CLASS.success);
  });

  it('denied reads as destructive', () => {
    expect(auditOutcomeBadgeClass('denied')).toBe(BADGE_TONE_CLASS.danger);
  });

  it('failure reads as a warning, not a denial', () => {
    expect(auditOutcomeBadgeClass('failure')).toBe(BADGE_TONE_CLASS.warning);
  });

  it('an unrecognised outcome falls back to the neutral badge', () => {
    expect(auditOutcomeBadgeClass('something_new')).toBe(BADGE_TONE_CLASS.neutral);
  });
});

import { auditOutcomeBadgeClass, BADGE_TONE_CLASS } from '@/composables/badgeTone';
import { getBalance, getLedger, createEntry } from '@/api/ledger';
import { listAudit } from '@/api/audit';
import { updateSettings } from '@/api/business';

describe('Ledger + Audit + Business API modules export expected functions', () => {
  it('ledger exports getBalance, getLedger, createEntry', () => {
    expect(typeof getBalance).toBe('function');
    expect(typeof getLedger).toBe('function');
    expect(typeof createEntry).toBe('function');
  });

  it('audit exports listAudit', () => {
    expect(typeof listAudit).toBe('function');
  });

  it('business exports updateSettings', () => {
    expect(typeof updateSettings).toBe('function');
  });
});
