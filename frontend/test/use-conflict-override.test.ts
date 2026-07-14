import { describe, it, expect, vi } from 'vitest';
import { useConflictOverride } from '@/composables/useConflictOverride';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';

const verdict = (over = true): ConflictVerdict =>
  ({ conflicts: [], can_override: over }) as unknown as ConflictVerdict;

describe('useConflictOverride', () => {
  it('raiseConflict opens the dialog with the verdict and optional revert', () => {
    const c = useConflictOverride();
    const revert = vi.fn();
    const v = verdict();

    c.raiseConflict(v, vi.fn(), revert);

    expect(c.conflictOpen.value).toBe(true);
    // The ref wraps stored objects in a reactive proxy, so compare structurally.
    expect(c.conflictVerdict.value).toStrictEqual(v);
    expect(c.conflictRevert.value).toBe(revert);
  });

  it('raiseConflict without revert leaves revert null', () => {
    const c = useConflictOverride();
    c.raiseConflict(verdict(), vi.fn());
    expect(c.conflictRevert.value).toBeNull();
  });

  it('confirm closes immediately, retries with override:true, and clears only after the retry settles', async () => {
    const c = useConflictOverride();
    let openDuringRetry: boolean | null = null;
    let verdictDuringRetry: ConflictVerdict | null = null;
    let resolveRetry!: () => void;
    const retry = vi.fn((override: boolean) => {
      expect(override).toBe(true);
      // Dialog already closed, but the raised state must survive until the retry settles.
      openDuringRetry = c.conflictOpen.value;
      verdictDuringRetry = c.conflictVerdict.value;
      return new Promise<void>((res) => { resolveRetry = res; });
    });
    const v = verdict();
    c.raiseConflict(v, retry, vi.fn());

    const pending = c.onOverrideConfirm();
    expect(retry).toHaveBeenCalledWith(true);
    expect(openDuringRetry).toBe(false);
    expect(verdictDuringRetry).toStrictEqual(v);
    // Still pending → nothing cleared yet.
    expect(c.conflictVerdict.value).toStrictEqual(v);

    resolveRetry();
    await pending;
    expect(c.conflictVerdict.value).toBeNull();
    expect(c.conflictRevert.value).toBeNull();
    expect(c.conflictOpen.value).toBe(false);
  });

  it('a retry that raises a further conflict keeps the fresh state instead of being cleared', async () => {
    const c = useConflictOverride();
    const second = verdict(false);
    const secondRetry = vi.fn(async () => {});
    const retry = vi.fn(async () => {
      c.raiseConflict(second, secondRetry);
    });
    c.raiseConflict(verdict(), retry);

    await c.onOverrideConfirm();

    expect(c.conflictOpen.value).toBe(true);
    expect(c.conflictVerdict.value).toStrictEqual(second);
  });

  it('cancel clears without invoking the retry (dialog itself runs the revert)', () => {
    const c = useConflictOverride();
    const retry = vi.fn(async () => {});
    const revert = vi.fn();
    c.raiseConflict(verdict(), retry, revert);

    c.onOverrideCancel();

    expect(retry).not.toHaveBeenCalled();
    // Snap-back belongs to ConflictOverrideDialog, which calls revert before emitting cancel.
    expect(revert).not.toHaveBeenCalled();
    expect(c.conflictOpen.value).toBe(false);
    expect(c.conflictVerdict.value).toBeNull();
    expect(c.conflictRevert.value).toBeNull();
  });
});
