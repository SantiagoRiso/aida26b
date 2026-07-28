import type { LocalizedText } from '../../types/types';
import { isTableKey, tableOf } from '../../utils/utils';
import { APPOINTMENT_STATES } from './appointment-lifecycle';
import { LEDGER_ENTRY_TYPES } from './finance';

// The generic CRUD audit writer's create/update/delete vocabulary. Declared once here so
// backend/src/routes/crud-audit.ts (which stamps the event) and this file (which reads it back
// into a label) cannot drift apart.
export const WRITE_EVENT_SUFFIX = { create: 'created', update: 'updated', delete: 'deleted' } as const;

const CRUD_ACTION_TEXT: Record<(typeof WRITE_EVENT_SUFFIX)[keyof typeof WRITE_EVENT_SUFFIX], LocalizedText> = {
  created: { es: 'Creación', en: 'created' },
  updated: { es: 'Actualización', en: 'updated' },
  deleted: { es: 'Eliminación', en: 'deleted' },
};

// Events outside the SSOT-composable vocabulary: bespoke workflow steps, auth/session events, and
// denials. Anything decomposable by table, appointment state, or ledger entry type is deliberately
// left out, so a newly exposed table/state/entry type needs no edit here.
const BESPOKE_AUDIT_EVENT_LABELS: Record<string, LocalizedText> = {
  login_failed: { es: 'Inicio de sesión fallido', en: 'Login failed' },
  login_success: { es: 'Inicio de sesión exitoso', en: 'Login succeeded' },
  logout: { es: 'Cierre de sesión', en: 'Logout' },
  password_change_failed: { es: 'Cambio de contraseña fallido', en: 'Password change failed' },
  password_changed: { es: 'Contraseña cambiada', en: 'Password changed' },
  password_reset: { es: 'Contraseña restablecida', en: 'Password reset' },
  profile_updated: { es: 'Perfil actualizado', en: 'Profile updated' },
  permission_denied: { es: 'Permiso denegado', en: 'Permission denied' },
  user_created: { es: 'Usuario creado', en: 'User created' },
  user_deactivated: { es: 'Usuario desactivado', en: 'User deactivated' },
  login_enabled: { es: 'Acceso habilitado', en: 'Login enabled' },
  appointment_approved: { es: 'Turno aprobado', en: 'Appointment approved' },
  appointment_rescheduled: { es: 'Turno reprogramado', en: 'Appointment rescheduled' },
  appointment_patched: { es: 'Turno modificado', en: 'Appointment updated' },
  appointment_action_denied: { es: 'Acción sobre turno denegada', en: 'Appointment action denied' },
  appointment_conflict_ignored: { es: 'Conflicto de turno ignorado', en: 'Appointment conflict ignored' },
  appointment_conflict_reflagged: { es: 'Conflicto de turno reactivado', en: 'Appointment conflict reflagged' },
  conflict_override: { es: 'Anulación de conflicto', en: 'Conflict override' },
  appointment_series_occurrence_materialized: { es: 'Turno de serie generado', en: 'Series occurrence materialized' },
  appointment_series_ended: { es: 'Serie de turnos finalizada', en: 'Appointment series ended' },
  ledger_write_denied: { es: 'Movimiento contable denegado', en: 'Ledger write denied' },
  grant_denied: { es: 'Permiso de calendario denegado', en: 'Calendar grant denied' },
  grant_created: { es: 'Permiso de calendario otorgado', en: 'Calendar grant created' },
  grant_revoked: { es: 'Permiso de calendario revocado', en: 'Calendar grant revoked' },
  grant_listed: { es: 'Permisos de calendario consultados', en: 'Calendar grants listed' },
  closure_denied: { es: 'Cierre de negocio denegado', en: 'Business closure denied' },
  closure_created: { es: 'Cierre de negocio creado', en: 'Business closure created' },
  closure_updated: { es: 'Cierre de negocio actualizado', en: 'Business closure updated' },
  closure_deleted: { es: 'Cierre de negocio eliminado', en: 'Business closure deleted' },
  business_settings_updated: { es: 'Configuración del negocio actualizada', en: 'Business settings updated' },
};

// `${tableKey}_created|updated|deleted`: every generic-CRUD write stamps this shape
// (crudEventType in crud-audit.ts), so a newly exposed table is labelled with no edit here.
function composeCrudEventLabel(eventType: string): LocalizedText | null {
  for (const suffix of Object.values(WRITE_EVENT_SUFFIX)) {
    if (!eventType.endsWith(`_${suffix}`)) continue;
    const tableKey = eventType.slice(0, -(suffix.length + 1));
    if (!isTableKey(tableKey)) continue;
    const uiName = tableOf(tableKey).uiName;
    const action = CRUD_ACTION_TEXT[suffix];
    return { es: `${action.es} de ${uiName.es}`, en: `${uiName.en} ${action.en}` };
  }
  return null;
}

// `appointment_${state}`: every appointment lifecycle transition audits under this shape
// (see appointments.ts's generic transition handler and the dedicated request/schedule routes),
// so a newly added state is labelled with no edit here.
function composeAppointmentStateLabel(eventType: string): LocalizedText | null {
  const prefix = 'appointment_';
  if (!eventType.startsWith(prefix)) return null;
  const stateValue = eventType.slice(prefix.length);
  const state = APPOINTMENT_STATES.find((s) => s.value === stateValue);
  if (!state) return null;
  return { es: `Turno ${state.label.es}`, en: `Appointment ${state.label.en}` };
}

// `ledger_${entryType}_created`: every ledger write audits under this shape (appointments.ts's
// session charge, ledger.ts's manual entries), so a newly added entry type is labelled with no
// edit here.
function composeLedgerEntryLabel(eventType: string): LocalizedText | null {
  const prefix = 'ledger_';
  const suffix = '_created';
  if (!eventType.startsWith(prefix) || !eventType.endsWith(suffix)) return null;
  const entryTypeValue = eventType.slice(prefix.length, -suffix.length);
  const entry = LEDGER_ENTRY_TYPES.find((t) => t.value === entryTypeValue);
  if (!entry) return null;
  return { es: `${entry.label.es} registrado`, en: `${entry.label.en} recorded` };
}

// Resolution order matters: bespoke exact-match first so a bespoke event whose name happens to
// look composable (there are none today, but a future one might) is never mis-decomposed.
export function auditEventLabel(eventType: string): LocalizedText | null {
  return (
    BESPOKE_AUDIT_EVENT_LABELS[eventType]
    ?? composeCrudEventLabel(eventType)
    ?? composeAppointmentStateLabel(eventType)
    ?? composeLedgerEntryLabel(eventType)
    ?? null
  );
}
