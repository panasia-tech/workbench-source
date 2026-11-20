<script setup>
import { computed } from 'vue'
import MediaThumb from './MediaThumb.vue'
import { normalizeMediaList } from '../utils/media'

const props = defineProps({
  urls: { type: Array, default: () => [] },
  thumbSize: { type: String, default: 'medium' },
  preview: { type: Boolean, default: true },
})

const items = computed(() => normalizeMediaList(props.urls))
const hasItems = computed(() => items.value.length > 0)
</script>

<template>
  <div v-if="hasItems" class="media-gallery">
    <MediaThumb
      v-for="(item, index) in items"
      :key="`${item.url}-${index}`"
      :url="item.url"
      :size="thumbSize"
      :preview="preview && !item.archived"
    />
  </div>
</template>

<style scoped>
.media-gallery {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
</style>
