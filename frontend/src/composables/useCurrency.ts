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

export function useCurrency() {
  function formatARS(amount: string | number): string {
    const n = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (Number.isNaN(n)) return '$ -';
    return ARS_FORMATTER.format(n);
  }

  function formatDate(iso: string | Date): string {
    const d = typeof iso === 'string' ? new Date(iso) : iso;
    return DATE_FORMATTER.format(d);
  }

  function formatDateTime(iso: string | Date): string {
    const d = typeof iso === 'string' ? new Date(iso) : iso;
    return DATETIME_FORMATTER.format(d);
  }

  return { formatARS, formatDate, formatDateTime };
}
