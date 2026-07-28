// How each entity is named, defined once. Both ends compose from these: the frontend for calendar
// and list titles, the backend for the audit log's entity column. A name written twice drifts:
// a turno was once "client - service" on one screen and "client · time" on another.

// Parts join with a separator rather than a template so a caller can pass only what it has and
// still read the same way. Whitespace-only parts are dropped, since a blank field must not leave a
// dangling separator.
export const NAME_PART_SEPARATOR = ' - ';

// The when is set off from the who, so a name carrying a time does not read as another participant.
export const NAME_WHEN_SEPARATOR = ' · ';

export function joinNameParts(parts: ReadonlyArray<string | null | undefined>): string {
  return parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part !== '')
    .join(NAME_PART_SEPARATOR);
}

// A person is their login when they have one and their display name otherwise: a contact-only
// client has no username at all. Mirrors the SQL `personName()` the audit query sorts by.
export function personDisplayName(username: string | null, displayName: string | null): string {
  return (username ?? '').trim() || (displayName ?? '').trim();
}

// A turno is named by its participants, plus when it is if the caller has no other way to show
// that. A calendar cell already sits at its own time and passes no `when`; an audit row is a flat
// list and passes one, because a client books more than once.
export interface AppointmentNameParts {
  client?: string | null;
  resource?: string | null;
  service?: string | null;
  professional?: string | null;
  designation?: string | null;
  when?: string | null;
}

export function appointmentName(parts: AppointmentNameParts, fallback: string): string {
  const who = joinNameParts([parts.client, parts.resource, parts.service, parts.professional, parts.designation]);
  const when = typeof parts.when === 'string' ? parts.when.trim() : '';
  if (who === '') {
    if (when === '') return fallback;
    // No fallback to qualify means the time is all there is to say, not a suffix to nothing.
    return fallback === '' ? when : `${fallback}${NAME_WHEN_SEPARATOR}${when}`;
  }
  return when === '' ? who : `${who}${NAME_WHEN_SEPARATOR}${when}`;
}

// A movement is named by the session it settles, since that is what a client disputes: which
// visit is this money for. Only a manual entry carries a typed description, and the automatic
// session charge never does, so most rows have nothing else to show.
//
// Callers pass only the parts their screen does not already state. A statement sits inside one
// client and omits `client`; an audit row is a flat list across clients and passes it.
export interface LedgerEntryNameParts {
  client?: string | null;
  service?: string | null;
  professional?: string | null;
  when?: string | null;
}

export function ledgerEntryName(parts: LedgerEntryNameParts, fallback: string): string {
  return appointmentName(
    { client: parts.client, service: parts.service, professional: parts.professional, when: parts.when },
    fallback,
  );
}
