import { useUiStore } from '@/stores/ui';
import type { ToastKind } from '@/stores/ui';

export function useToast() {
  const ui = useUiStore();

  return {
    toast(kind: ToastKind, messageKey: string, params?: Record<string, string>) {
      ui.toast(kind, messageKey, params);
    },
    success(messageKey: string) {
      ui.toast('success', messageKey);
    },
    error(messageKey: string, params?: Record<string, string>) {
      ui.toast('error', messageKey, params);
    },
    info(messageKey: string) {
      ui.toast('info', messageKey);
    },
    dismiss(id: number) {
      ui.dismissToast(id);
    },
  };
}
