import { detectOverlap } from './scheduling';
import type { TimeInterval } from './scheduling';

// Language-neutral conflict classes. The frontend localizes from `type` + `entity`; the API
// never builds a display string.
export type ConflictType =
  | 'professional_overlap'
  | 'resource_overlap'
  | 'professional_availability'
  | 'resource_availability'
  | 'requested_block'
  | 'slot_alignment';

export type Conflict = {
  type: ConflictType;
  entity: { kind: 'professional' | 'resource'; id: number; name: string };
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
  state: 'scheduled' | 'requested';
};

export type ConflictOwner = {
  id: number;
  name: string;
  // Grid of discrete bookable slots (NOT minus booked); booked occupancy is passed separately.
  slots: TimeInterval[];
  booked: BookedAppointment[];
};

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

function mergeMinutes(intervals: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

// Whole-appointment containment: the proposed range must sit inside a single available window.
function containedInGrid(pStart: number, pEnd: number, slots: TimeInterval[]): boolean {
  const merged = mergeMinutes(slots.map((s) => ({ start: toMin(s.start), end: toMin(s.end) })));
  return merged.some((iv) => iv.start <= pStart && pEnd <= iv.end);
}

// A normal booking must equal one whole grid slot (start AND length). Off-grid ⇒ slot_alignment,
// the class staff override as a sobreturno.
function matchesGridSlot(pStart: number, pEnd: number, slots: TimeInterval[]): boolean {
  return slots.some((s) => toMin(s.start) === pStart && toMin(s.end) === pEnd);
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
  const pStart = toMin(proposed.start);
  const pEnd = toMin(proposed.end);
  const conflicts: Conflict[] = [];

  const evalOwner = (owner: ConflictOwner, kind: 'professional' | 'resource', checkAlignment: boolean) => {
    const entity = { kind, id: owner.id, name: owner.name };

    for (const b of owner.booked) {
      if (excludeAppointmentId !== undefined && b.id === excludeAppointmentId) continue;
      if (
        detectOverlap(
          { startsAt: pStart, endsAt: pEnd },
          { startsAt: toMin(b.start), endsAt: toMin(b.end) },
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
