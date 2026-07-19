import { ref, computed } from 'vue';
import { getRow } from '@/api/crud';
import { invalidateFkOptions } from '@/composables/useForeignKeyOptions';
import { useAuthStore } from '@/stores/auth';
import { roleAllowedFor, descriptorWriteRoles } from '@/router/access';
import type { TableRecordMap } from '@shared/ssot/derived';

export function useClientProfile(clientId: number, onChanged: () => void) {
  const auth = useAuthStore();
const role = computed(() => auth.user?.role);

  const client = ref<TableRecordMap['clients'] | null>(null);
  const showEditProfile = ref(false);

  // Staff panel only — a Client edits their own profile through the portal, not here.
  const canEditProfile = computed(
    () => !!role.value && roleAllowedFor(descriptorWriteRoles('clients', 'update', { exclude: ['Client'] }), role.value),
  );

  async function loadProfile() {
    const res = await getRow('clients', clientId);
    if (res.ok) client.value = res.data;
  }

  function onProfileSaved() {
    showEditProfile.value = false;
    void loadProfile();
    // A renamed client must not linger in cached FK labels elsewhere.
    invalidateFkOptions('clients');
    onChanged();
  }

  return { client, loadProfile, showEditProfile, canEditProfile, onProfileSaved };
}
