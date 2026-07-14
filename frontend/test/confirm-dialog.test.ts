import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

function mountDialog(open: boolean) {
  return mount(ConfirmDialog, {
    props: { open, title: 'T', body: 'B', confirmLabel: 'OK' },
    global: { plugins: [makeI18n()], stubs: { teleport: true } },
  });
}

describe('ConfirmDialog Escape handling', () => {
  it('emits cancel when Escape is pressed while open', () => {
    const w = mountDialog(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(w.emitted('cancel')).toBeTruthy();
  });

  it('ignores Escape when closed (so it never dismisses a modal behind it)', () => {
    const w = mountDialog(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(w.emitted('cancel')).toBeFalsy();
  });
});
