import { detectOverlap, toMinutes, mergeIntervals } from './availability';
import type { TimeInterval } from './availability';
import { OPEN_APPOINTMENT_STATES } from './appointment-lifecycle';

// The two schedulable owner kinds — professionals and resources (rooms).
export type OwnerKind = 'professional' | 'resource';

// Language-neutral conflict classes. The frontend localizes from `type` + `entity`; the API
// never builds a display string. ConflictType and the decoder/label-map both derive from this
// array, so a new conflict type is a compile error everywhere it isn't handled yet.
export const CONFLICT_TYPE_VALUES = [
  'professional_overlap',
  'resource_overlap',
  'professional_availability',
  'resource_availability',
  'requested_block',
  'slot_alignment',
] as const;

export type ConflictType = (typeof CONFLICT_TYPE_VALUES)[number];

export function isConflictType(value: string): value is ConflictType {
  return CONFLICT_TYPE_VALUES.some((type) => type === value);
}

export type Conflict = {
  type: ConflictType;
  entity: { kind: OwnerKind; id: number; name: string };
  range: { start: string; end: string };
};

export type ConflictVerdict = {
  can_save: boolean;
  requires_override: boolean;
  can_override: boolean;
  conflicts: Conflict[];
};

export type BookedAppointment = {
  id: number;
  start: string;
  end: string;
  state: (typeof OPEN_APPOINTMENT_STATES)[number];
};

export type ConflictOwner = {
  id: number;
  name: string;
  // Grid of discrete bookable slots (NOT minus booked); booked occupancy is passed separately.
  slots: TimeInterval[];
  booked: BookedAppointment[];
};

// Whole-appointment containment: the proposed range must sit inside a single available window.
function containedInGrid(pStart: number, pEnd: number, slots: TimeInterval[]): boolean {
  const merged = mergeIntervals(slots.map((s) => ({ start: toMinutes(s.start), end: toMinutes(s.end) })));
  return merged.some((iv) => iv.start <= pStart && pEnd <= iv.end);
}

// A normal booking must equal one whole grid slot (start AND length). Off-grid ⇒ slot_alignment,
// the class staff override as a sobreturno.
function matchesGridSlot(pStart: number, pEnd: number, slots: TimeInterval[]): boolean {
  return slots.some((s) => toMinutes(s.start) === pStart && toMinutes(s.end) === pEnd);
}

// Pure conflict aggregator. Overlap classes come from `booked` (scheduled ⇒ *_overlap, requested ⇒
// requested_block); availability/slot_alignment come from the grid. End-exclusive throughout.
export function evaluateConflicts(input: {
  proposed: { start: string; end: string; date: string };
  callerIsStaff: boolean;
  excludeAppointmentId?: number;
  professional: ConflictOwner;
  resource?: ConflictOwner;
}): ConflictVerdict {
  const { proposed, callerIsStaff, excludeAppointmentId, professional, resource } = input;
  const pStart = toMinutes(proposed.start);
  const pEnd = toMinutes(proposed.end);
  const conflicts: Conflict[] = [];

  const evalOwner = (owner: ConflictOwner, kind: OwnerKind, checkAlignment: boolean) => {
    const entity = { kind, id: owner.id, name: owner.name };

    for (const b of owner.booked) {
      if (excludeAppointmentId !== undefined && b.id === excludeAppointmentId) continue;
      if (
        detectOverlap(
          { startsAt: pStart, endsAt: pEnd },
          { startsAt: toMinutes(b.start), endsAt: toMinutes(b.end) },
        )
      ) {
        conflicts.push({
          type: b.state === 'requested' ? 'requested_block' : kind === 'professional' ? 'professional_overlap' : 'resource_overlap',
          entity,
          range: { start: b.start, end: b.end },
        });
      }
    }

    if (!containedInGrid(pStart, pEnd, owner.slots)) {
      conflicts.push({
        type: kind === 'professional' ? 'professional_availability' : 'resource_availability',
        entity,
        range: { start: proposed.start, end: proposed.end },
      });
    } else if (checkAlignment && !matchesGridSlot(pStart, pEnd, owner.slots)) {
      conflicts.push({ type: 'slot_alignment', entity, range: { start: proposed.start, end: proposed.end } });
    }
  };

  evalOwner(professional, 'professional', true);
  if (resource) evalOwner(resource, 'resource', false);

  const hasConflicts = conflicts.length > 0;
  return {
    can_save: !hasConflicts,
    requires_override: hasConflicts,
    can_override: callerIsStaff,
    conflicts,
  };
}
