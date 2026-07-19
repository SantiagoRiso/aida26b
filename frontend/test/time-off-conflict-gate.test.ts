import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { previewTimeOffConflicts } from '@/api/scheduling';
import { useTimeOffConflictGate, shortDate } from '@/composables/useTimeOffConflictGate';

vi.mock('@/api/scheduling', () => ({ previewTimeOffConflicts: vi.fn() }));
const mockPreview = vi.mocked(previewTimeOffConflicts);

describe('useTimeOffConflictGate', () => {
  beforeEach(() => {
    // The gate resolves its confirm copy through useLabel/useUiStore (Pinia).
    setActivePinia(createPinia());
    mockPreview.mockReset();
  });

  it('proceeds without a dialog when the preview reports no conflict', async () => {
    mockPreview.mockResolvedValue({ ok: true, data: { count: 0 } });
    const gate = useTimeOffConflictGate();

    await expect(gate.confirmTimeOff({ date: '2026-07-17' })).resolves.toBe(true);
    expect(gate.open.value).toBe(false);
    expect(gate.message.value).toBe('');
  });

  it('opens the dialog on a conflict and resolves true only when confirmed', async () => {
    mockPreview.mockResolvedValue({ ok: true, data: { count: 3 } });
    const gate = useTimeOffConflictGate();

    const pending = gate.confirmTimeOff({ date: '2026-07-17' });
    await flushPromises();

    expect(gate.open.value).toBe(true);
    // The confirm copy is the gate's own — one home for the wording, both callers share it.
    expect(gate.message.value).toBe('Va a dejar 3 turnos en conflicto el 17/07. ¿Continuar?');

    gate.onConfirm();
    await expect(pending).resolves.toBe(true);
    expect(gate.open.value).toBe(false);
  });

  it('singularizes the confirm copy for one conflicting turno', async () => {
    mockPreview.mockResolvedValue({ ok: true, data: { count: 1 } });
    const gate = useTimeOffConflictGate();

    const pending = gate.confirmTimeOff({ date: '2026-03-05' });
    await flushPromises();

    expect(gate.message.value).toBe('Va a dejar 1 turno en conflicto el 05/03. ¿Continuar?');
    gate.onCancel();
    await expect(pending).resolves.toBe(false);
  });

  it('resolves false (and closes) when the conflict dialog is cancelled', async () => {
    mockPreview.mockResolvedValue({ ok: true, data: { count: 9 } });
    const gate = useTimeOffConflictGate();

    const pending = gate.confirmTimeOff({ date: '2026-07-17' });
    await flushPromises();
    expect(gate.open.value).toBe(true);

    gate.onCancel();
    await expect(pending).resolves.toBe(false);
    expect(gate.open.value).toBe(false);
  });

  // Fail open: an unsuccessful preview proceeds without a dialog so a hiccup never blocks the save.
  it('treats a non-ok preview as no conflict', async () => {
    mockPreview.mockResolvedValue({ ok: false, status: 500, code: 'boom', message: 'boom' });
    const gate = useTimeOffConflictGate();

    await expect(gate.confirmTimeOff({ date: '2026-07-17' })).resolves.toBe(true);
  });
});

describe('shortDate', () => {
  it('renders YYYY-MM-DD as DD/MM', () => {
    expect(shortDate('2026-07-17')).toBe('17/07');
  });
});
