import { ref } from 'vue';
import { previewTimeOffConflicts, type TimeOffPreviewBody } from '@/api/scheduling';

// Warn-then-confirm gate for adding time-off. Previews how many open, future turnos the time-off
// would leave in conflict; if any, resolves only once the user confirms the dialog. A clean add —
// or a preview that errors — proceeds silently, so the gate never blocks a save on its own failure.
// Nothing here mutates data; flagging is computed server-side and clears when the time-off is removed.
export function useTimeOffConflictGate() {
  const open = ref(false);
  const message = ref('');
  let resolver: ((proceed: boolean) => void) | null = null;

  function settle(proceed: boolean) {
    open.value = false;
    const r = resolver;
    resolver = null;
    r?.(proceed);
  }

  async function confirmTimeOff(
    body: TimeOffPreviewBody,
    buildMessage: (count: number) => string,
  ): Promise<boolean> {
    // Fail open: a preview that errors or reports no conflict proceeds without a dialog. The warning
    // is advisory — the server-side flag is computed regardless, so a hiccup must never block a save.
    let count = 0;
    try {
      const res = await previewTimeOffConflicts(body);
      count = res.ok ? res.data.count : 0;
    } catch {
      return true;
    }
    if (count === 0) return true;
    message.value = buildMessage(count);
    open.value = true;
    return new Promise<boolean>((resolve) => { resolver = resolve; });
  }

  return {
    open,
    message,
    confirmTimeOff,
    onConfirm: () => settle(true),
    onCancel: () => settle(false),
  };
}

// 'YYYY-MM-DD' → 'DD/MM' for the confirm copy ("… en conflicto el 17/07").
export function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}
