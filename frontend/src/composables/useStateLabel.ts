import { useLabel } from '@/composables/useLabel';
import { APPOINTMENT_STATES, ROLE_LABELS } from '@shared/ssot/domain';
import { isRole } from '@shared/types/roles';

// SSOT is the single label source for data vocabulary (states, roles); vue-i18n keeps UI
// chrome only. Unknown values render verbatim (defensive: server may add states first).
export function useStateLabel() {
  const { label } = useLabel();

  function stateLabel(state: string): string {
    const entry = APPOINTMENT_STATES.find((s) => s.value === state);
    return entry ? label(entry.label) : state;
  }

  function roleLabel(role: string): string {
    const text = isRole(role) ? ROLE_LABELS[role] : undefined;
    return text ? label(text) : role;
  }

  return { stateLabel, roleLabel };
}
