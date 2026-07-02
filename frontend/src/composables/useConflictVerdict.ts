import type { ConflictVerdict, Conflict } from '@shared/ssot/domain/conflict';

// The API never builds a display string; localization is the frontend's responsibility.

const CONFLICT_MESSAGES: Record<string, (entity: string, start: string, end: string) => string> = {
  professional_overlap: (entity, start, end) =>
    `Este horario se superpone con otro turno de ${entity} (${start}–${end}).`,
  resource_overlap: (entity, start, end) =>
    `El recurso "${entity}" ya está ocupado en ese horario (${start}–${end}).`,
  professional_availability: (entity) =>
    `${entity} no tiene disponibilidad en este horario.`,
  resource_availability: (entity) =>
    `El recurso "${entity}" no está disponible en este horario.`,
  requested_block: (entity, start, end) =>
    `Hay una solicitud pendiente de ${entity} en ese horario (${start}–${end}).`,
  slot_alignment: (entity) =>
    `El horario no se alinea con los bloques de disponibilidad de ${entity}.`,
};

export interface ConflictDescription {
  lines: string[];
  canOverride: boolean;
}

export function useConflictVerdict() {
  function describeConflict(c: Conflict): string {
    const fn = CONFLICT_MESSAGES[c.type];
    if (!fn) return `Conflicto: ${c.type} en ${c.entity.name}`;
    return fn(c.entity.name, c.range.start, c.range.end);
  }

  function describe(verdict: ConflictVerdict): ConflictDescription {
    return {
      lines: verdict.conflicts.map(describeConflict),
      canOverride: verdict.can_override,
    };
  }

  return { describe };
}
