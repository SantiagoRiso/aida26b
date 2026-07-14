<script setup lang="ts">
import { ref } from 'vue';
import { useLabel } from '@/composables/useLabel';
import type { TableRecordMap } from '@shared/ssot/derived';
import GenericTable from '@/components/generic/GenericTable.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ProfessionalDetail from '@/components/staff/ProfessionalDetail.vue';

const { label } = useLabel();

// Professionals are deactivated, never created here or hard-deleted.
const TABLE_KEY = 'professionals' as const;

const selectedId = ref<number | null>(null);
const detailOpen = ref(false);
const reloadKey = ref(0);

function openDetail(row: TableRecordMap['professionals']) {
  const id = Number(row.id);
  if (!Number.isFinite(id)) return;
  selectedId.value = id;
  detailOpen.value = true;
}

function onChanged() {
  reloadKey.value++;
}
</script>

<template>
  <div>
    <GenericTable :key="reloadKey" :table-key="TABLE_KEY" @edit="openDetail" />

    <DetailPanel
      :open="detailOpen"
      size="4xl"
      :title="label({ es: 'Detalle del profesional', en: 'Professional detail' })"
      @close="detailOpen = false"
      @after-leave="selectedId = null"
    >
      <ProfessionalDetail
        v-if="selectedId !== null"
        :professional-id="selectedId"
        @close="detailOpen = false"
        @changed="onChanged"
      />
    </DetailPanel>
  </div>
</template>
