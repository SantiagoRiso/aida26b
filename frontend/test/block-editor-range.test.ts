import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { isValidTimeRange } from '@shared/ssot/domain';
import BlockEditorModal from '@/components/schedule/BlockEditorModal.vue';

// The block editor had no client-side range check at all: an end not after its start reached the
// schedule_blocks_time_order CHECK and came back as a constraint error naming no field. The rule is
// now shared with the exception form, which already enforced it, so both screens and the database
// agree on what a valid window is.

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

// TransitionRoot/Dialog render nothing under jsdom, so the chrome is stubbed to expose the panel.
const passThrough = { template: '<div><slot /></div>' };
const headlessStubs = {
  TransitionRoot: passThrough,
  TransitionChild: passThrough,
  Dialog: passThrough,
  DialogPanel: passThrough,
  DialogTitle: passThrough,
};

function mountModal(block: { start_time: string; end_time: string }, submit = vi.fn()) {
  return {
    submit,
    wrapper: mount(BlockEditorModal, {
      props: {
        open: true,
        block: { id: '1', professional_user_id: '1', resource_id: null, weekday: 'mon', ...block } as never,
        submit,
        showServices: false,
      },
      global: { plugins: [makeI18n()], stubs: headlessStubs },
    }),
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('isValidTimeRange', () => {
  it('accepts a window whose end is after its start', () => {
    expect(isValidTimeRange('09:00', '13:00')).toBe(true);
  });

  it('rejects an end equal to the start, since a zero-length block books nothing', () => {
    expect(isValidTimeRange('09:00', '09:00')).toBe(false);
  });

  it('rejects an end before the start', () => {
    expect(isValidTimeRange('13:00', '09:00')).toBe(false);
  });

  // A half-filled range is not a range: letting one through reaches the database as a NOT NULL
  // violation rather than a message about the field the user left blank.
  it.each([
    ['', '13:00'],
    ['09:00', ''],
    [null, '13:00'],
    ['09:00', null],
    [undefined, undefined],
  ])('rejects a missing bound (%s, %s)', (start, end) => {
    expect(isValidTimeRange(start, end)).toBe(false);
  });

  it('compares zero-padded times as text, so an hour boundary does not fool it', () => {
    expect(isValidTimeRange('09:00', '10:00')).toBe(true);
    expect(isValidTimeRange('10:00', '09:00')).toBe(false);
  });
});

describe('BlockEditorModal blocks an invalid window before it reaches the server', () => {
  it('does not submit when the end is not after the start, and says why', async () => {
    const { wrapper, submit } = mountModal({ start_time: '13:00', end_time: '09:00' });

    await wrapper.find('[data-testid="block-edit-save"]').trigger('click');

    expect(submit).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(es.apiError.endAfterStart);
  });

  it('submits a valid window and shows no error', async () => {
    const { wrapper, submit } = mountModal({ start_time: '09:00', end_time: '13:00' });
    submit.mockResolvedValue(true);

    await wrapper.find('[data-testid="block-edit-save"]').trigger('click');

    expect(submit).toHaveBeenCalledWith({ weekday: 'mon', startTime: '09:00', endTime: '13:00' });
    expect(wrapper.text()).not.toContain(es.apiError.endAfterStart);
  });
});
