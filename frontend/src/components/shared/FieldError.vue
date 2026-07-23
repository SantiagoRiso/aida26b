<script setup lang="ts">
// `id` lets the field it belongs to point at it with aria-describedby.
defineProps<{
  message?: string;
  id?: string;
}>();
</script>

<template>
  <p
    v-if="message"
    :id="id"
    role="alert"
    class="mt-1 text-sm text-destructive"
  >
    {{ message }}
  </p>
</template>
