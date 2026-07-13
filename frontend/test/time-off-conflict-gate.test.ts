import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { previewTimeOffConflicts } from '@/api/scheduling';
import { useTimeOffConflictGate, shortDate } from '@/composables/useTimeOffConflictGate';

vi.mock('@/api/scheduling', () => ({ previewTimeOffConflicts: vi.fn() }));
const mockPreview = vi.mocked(previewTimeOffConflicts);

describe('useTimeOffConflictGate', () => {
  beforeEach(() => mockPreview.mockReset());

  it('proceeds without a dialog when the preview reports no conflict', async () => {
    mockPreview.mockResolvedValue({ ok: true, data: { count: 0 } });
    const gate = useTimeOffConflictGate();
    const build = vi.fn();

    await expect(gate.confirmTimeOff({ date: '2026-07-17' }, build)).resolves.toBe(true);
    expect(gate.open.value).toBe(false);
    expect(build).not.toHaveBeenCalled();
  });

  it('opens the dialog on a conflict and resolves true only when confirmed', async () => {
    mockPreview.mockResolvedValue({ ok: true, data: { count: 3 } });
    const gate = useTimeOffConflictGate();

    const pending = gate.confirmTimeOff({ date: '2026-07-17' }, (n) => `count ${n}`);
    await flushPromises();

    expect(gate.open.value).toBe(true);
    expect(gate.message.value).toBe('count 3');

    gate.onConfirm();
    await expect(pending).resolves.toBe(true);
    expect(gate.open.value).toBe(false);
  });

  it('resolves false (and closes) when the conflict dialog is cancelled', async () => {
    mockPreview.mockResolvedValue({ ok: true, data: { count: 9 } });
    const gate = useTimeOffConflictGate();

    const pending = gate.confirmTimeOff({ date: '2026-07-17' }, (n) => `count ${n}`);
    await flushPromises();
    expect(gate.open.value).toBe(true);

    gate.onCancel();
    await expect(pending).resolves.toBe(false);
    expect(gate.open.value).toBe(false);
  });

  // Fail open: an unsuccessful preview proceeds without a dialog so a hiccup never blocks the save.
  it('treats a non-ok preview as no conflict', async () => {
    mockPreview.mockResolvedValue({ ok: false, code: 'boom', message: 'boom' } as never);
    const gate = useTimeOffConflictGate();

    await expect(gate.confirmTimeOff({ date: '2026-07-17' }, () => 'x')).resolves.toBe(true);
  });
});

describe('shortDate', () => {
  it('renders YYYY-MM-DD as DD/MM', () => {
    expect(shortDate('2026-07-17')).toBe('17/07');
  });
});
