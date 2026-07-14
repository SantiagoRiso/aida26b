// ARS and date formatting fixed to Argentine conventions — independent of the language toggle.
// Only UI chrome/labels translate; monetary amounts and dates always render in es-AR.

const ARS_FORMATTER = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const DATE_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const DATETIME_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const TIME_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// Date-only strings must parse as LOCAL dates: new Date('YYYY-MM-DD') is UTC midnight,
// which renders as the previous day in Argentina (UTC-3).
function toLocalDate(iso: string | Date): Date {
  if (typeof iso === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return new Date(iso);
  }
  return iso;
}

// Today as 'YYYY-MM-DD' in the user's timezone (toISOString would give the UTC day).
export function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function useCurrency() {
  function formatARS(amount: string | number): string {
    const n = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (Number.isNaN(n)) return '$ -';
    return ARS_FORMATTER.format(n);
  }

  function formatDate(iso: string | Date): string {
    return DATE_FORMATTER.format(toLocalDate(iso));
  }

  function formatDateTime(iso: string | Date): string {
    return DATETIME_FORMATTER.format(toLocalDate(iso));
  }

  function formatTime(iso: string | Date): string {
    return TIME_FORMATTER.format(toLocalDate(iso));
  }

  return { formatARS, formatDate, formatDateTime, formatTime };
}
