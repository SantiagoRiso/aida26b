import { ref } from 'vue';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';

export type ConflictRetry = (override: boolean) => Promise<void>;

// Shared plumbing for the conflict warn-then-confirm dialog: a save that came back unsaved
// raises the verdict here; confirm re-runs the same save with override:true.
export function useConflictOverride() {
  const conflictOpen = ref(false);
  const conflictVerdict = ref<ConflictVerdict | null>(null);
  const conflictRetryFn = ref<ConflictRetry | null>(null);
  // Drag/resize snap-back; ConflictOverrideDialog invokes it itself before emitting cancel.
  const conflictRevert = ref<(() => void) | null>(null);

  function raiseConflict(
    verdict: ConflictVerdict,
    retry: ConflictRetry,
    revert?: (() => void) | null,
  ) {
    conflictVerdict.value = verdict;
    conflictRetryFn.value = retry;
    conflictRevert.value = revert ?? null;
    conflictOpen.value = true;
  }

  function clear() {
    conflictVerdict.value = null;
    conflictRetryFn.value = null;
    conflictRevert.value = null;
  }

  // Close first (no double-confirm), clear only after the retry settles; if the override retry
  // raised a further conflict, that fresh state must survive, so only a still-closed dialog clears.
  async function onOverrideConfirm() {
    conflictOpen.value = false;
    const retry = conflictRetryFn.value;
    if (retry) await retry(true);
    if (!conflictOpen.value) clear();
  }

  function onOverrideCancel() {
    conflictOpen.value = false;
    clear();
  }

  return {
    conflictOpen,
    conflictVerdict,
    conflictRevert,
    raiseConflict,
    onOverrideConfirm,
    onOverrideCancel,
  };
}
