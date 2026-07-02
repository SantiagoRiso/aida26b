import { useUiStore } from '@/stores/ui';
import type { ToastKind } from '@/stores/ui';

export function useToast() {
  const ui = useUiStore();

  return {
    toast(kind: ToastKind, messageKey: string) {
      ui.toast(kind, messageKey);
    },
    success(messageKey: string) {
      ui.toast('success', messageKey);
    },
    error(messageKey: string) {
      ui.toast('error', messageKey);
    },
    info(messageKey: string) {
      ui.toast('info', messageKey);
    },
    dismiss(id: number) {
      ui.dismissToast(id);
    },
  };
}
