import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import { es } from '@/i18n/es';
import ConflictOverrideDialog from '@/components/calendar/ConflictOverrideDialog.vue';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';

// ConflictOverrideDialog's `useConflictVerdict` composable reads the app's global i18n
// singleton directly (not via injection), so — unlike ConfirmDialog — a fresh local i18n
// instance for `global.plugins` would only satisfy the component's own useI18n() calls and
// leave the conflict-line strings untranslated. Install the real singleton and pin its
// locale so both paths render the same ES strings the app ships.
i18n.global.locale.value = 'es';

const overridableVerdict = (): ConflictVerdict => ({
  can_save: false,
  requires_override: true,
  can_override: true,
  conflicts: [
    {
      type: 'professional_overlap',
      entity: { kind: 'professional', id: 1, name: 'Dra. Pérez' },
      range: { start: '10:00', end: '10:30' },
    },
  ],
});

const blockedVerdict = (): ConflictVerdict => ({
  can_save: false,
  requires_override: true,
  can_override: false,
  conflicts: [
    {
      type: 'resource_availability',
      entity: { kind: 'resource', id: 2, name: 'Sala 1' },
      range: { start: '10:00', end: '10:30' },
    },
  ],
});

// headlessui's TransitionRoot renders nothing but a comment node under jsdom (its transition
// machinery never marks children visible), so the dialog's content is unreachable through the real
// wrappers. They are pure animation/portal chrome; stub them to pass their slots through, leaving
// this component's own logic — which conflict lines render, which buttons appear, click wiring — as
// the actual subject under test. AppButton stays real so button text and @click are exercised.
const passThrough = { template: '<div><slot /></div>' };
const headlessStubs = {
  TransitionRoot: passThrough,
  TransitionChild: passThrough,
  Dialog: passThrough,
  DialogPanel: passThrough,
  DialogTitle: passThrough,
};

function mountDialog(verdict: ConflictVerdict | null, revert?: () => void) {
  return mount(ConflictOverrideDialog, {
    props: { open: true, verdict, revert: revert ?? null },
    global: { plugins: [i18n], stubs: headlessStubs },
  });
}

function findButtonByText(wrapper: ReturnType<typeof mountDialog>, text: string) {
  return wrapper.findAll('button').find((b) => b.text() === text);
}

describe('ConflictOverrideDialog', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'es';
  });

  it('renders the conflict title, body, and per-conflict detail line', () => {
    const w = mountDialog(overridableVerdict());

    expect(w.text()).toContain(es.calendar.conflictTitle);
    expect(w.text()).toContain(es.calendar.conflictBody);

    const expectedLine = es.conflicts.professionalOverlap
      .replace('{entity}', 'Dra. Pérez')
      .replace('{start}', '10:00')
      .replace('{end}', '10:30');
    expect(w.text()).toContain(expectedLine);
  });

  it('emits confirm when "Reservar de todos modos" is clicked', async () => {
    const w = mountDialog(overridableVerdict());

    const confirmBtn = findButtonByText(w, es.actions.bookAnyway);
    expect(confirmBtn).toBeTruthy();
    await confirmBtn!.trigger('click');

    expect(w.emitted('confirm')).toBeTruthy();
    expect(w.emitted('confirm')).toHaveLength(1);
  });

  it('emits cancel and invokes revert when the cancel button is clicked', async () => {
    const revert = vi.fn();
    const w = mountDialog(overridableVerdict(), revert);

    const cancelBtn = findButtonByText(w, es.actions.cancel);
    expect(cancelBtn).toBeTruthy();
    await cancelBtn!.trigger('click');

    expect(revert).toHaveBeenCalledTimes(1);
    expect(w.emitted('cancel')).toBeTruthy();
    expect(w.emitted('cancel')).toHaveLength(1);
  });

  it('hides the override button and shows cannotOverride when can_override is false', () => {
    const w = mountDialog(blockedVerdict());

    expect(findButtonByText(w, es.actions.bookAnyway)).toBeUndefined();
    expect(w.text()).toContain(es.conflicts.cannotOverride);

    // Cancel remains the only available action.
    expect(findButtonByText(w, es.actions.cancel)).toBeTruthy();
    expect(w.findAll('button')).toHaveLength(1);
  });
});
