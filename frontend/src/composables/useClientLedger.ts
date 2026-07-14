import { ref, computed } from 'vue';
import type { Ref } from 'vue';
import { getBalance, getLedger } from '@/api/ledger';
import type { LedgerEntry } from '@/api/ledger';
import type { Appointment } from '@/api/appointments';
import { useAuthStore } from '@/stores/auth';
import { roleAllowedFor } from '@/router/access';
import { LEDGER_WRITE_ROLES } from '@shared/ssot/domain/finance';
import type { Role } from '@shared/types/roles';

export function useClientLedger(clientId: number, appointments: Ref<Appointment[]>) {
  const auth = useAuthStore();
  const role = computed(() => auth.user?.role as Role | undefined);

  const balance = ref<string | null>(null);
  const entries = ref<LedgerEntry[]>([]);
  const showEntryForm = ref(false);

  const canCreateLedger = computed(() => !!role.value && roleAllowedFor(LEDGER_WRITE_ROLES, role.value));

  // Ledger reads are server-scoped: an Admin sees any client in the business, but a Professional or
  // Receptionist only clients they've actually seen. Gate the whole Cuenta Corriente section on that
  // so we never fire (and toast on) a read we aren't allowed to make.
  const ledgerAccessible = computed(() => role.value === 'Admin' || appointments.value.length > 0);

  const balancePositive = computed(() => balance.value != null && parseFloat(balance.value) > 0);

  async function loadLedger() {
    const [bal, led] = await Promise.all([getBalance(clientId), getLedger(clientId, 1, 50)]);
    balance.value = bal.ok ? bal.data.balance_ars : null;
    entries.value = led.ok ? led.data : [];
  }

  function onEntrySaved() {
    showEntryForm.value = false;
    void loadLedger();
  }

  return {
    balance,
    entries,
    loadLedger,
    ledgerAccessible,
    balancePositive,
    canCreateLedger,
    showEntryForm,
    onEntrySaved,
  };
}
