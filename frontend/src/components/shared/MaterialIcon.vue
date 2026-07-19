<script setup lang="ts">
// Renders a Material Design icon from public/icons/<name>.svg, tinted to the current text colour via
// a CSS mask (so it inherits `currentColor` exactly like the heroicon components it replaces). Size
// comes from the caller's class (e.g. h-4 w-4), same as any icon component.
const props = defineProps<{ name: 'repeat' | 'alarm' | 'logout' }>();
</script>

<template>
  <span
    class="material-icon"
    :style="{ '-webkit-mask-image': `url(/icons/${props.name}.svg)`, 'mask-image': `url(/icons/${props.name}.svg)` }"
    aria-hidden="true"
  />
</template>

<style scoped>
.material-icon {
  display: inline-block;
  background-color: currentColor;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-size: contain;
  mask-size: contain;
}
</style>
