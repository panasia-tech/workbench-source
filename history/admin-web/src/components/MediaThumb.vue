<script setup>
import { computed } from 'vue'
import { Box } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { isOssArchived, isVideoUrl, resolveDisplayUrl } from '../utils/media'

const props = defineProps({
  url: { type: String, default: '' },
  size: { type: String, default: 'medium' },
  preview: { type: Boolean, default: true },
  fit: { type: String, default: 'cover' },
})

const archived = computed(() => isOssArchived(props.url))
const displayUrl = computed(() => resolveDisplayUrl(props.url))
const isVideo = computed(() => !archived.value && isVideoUrl(props.url))

function onArchivedClick() {
  ElMessage.info('文件已归档至本地 NAS，OSS 上不可访问')
}

function onVideoClick(e) {
  e.stopPropagation()
  if (displayUrl.value) window.open(displayUrl.value, '_blank')
}
</script>

<template>
  <div
    class="media-thumb"
    :class="[`media-thumb--${size}`, { 'media-thumb--archived': archived, 'media-thumb--empty': !url }]"
    @click="archived ? onArchivedClick() : undefined"
  >
    <div v-if="archived" class="media-thumb__archived">
      <el-icon :size="28"><Box /></el-icon>
      <span class="media-thumb__archived-title">已归档</span>
      <span class="media-thumb__archived-hint">本地 NAS</span>
    </div>
    <div v-else-if="isVideo && displayUrl" class="media-thumb__video-wrap" @click.stop="onVideoClick">
      <video class="media-thumb__video" :src="displayUrl" controls preload="metadata" @click.stop />
      <span class="media-thumb__badge">视频</span>
    </div>
    <el-image
      v-else-if="displayUrl"
      class="media-thumb__img"
      :src="displayUrl"
      :fit="fit"
      :preview-src-list="preview ? [displayUrl] : []"
      preview-teleported
      hide-on-click-modal
    />
    <span v-else class="media-thumb__empty">—</span>
  </div>
</template>

<style scoped>
.media-thumb {
  position: relative;
  overflow: hidden;
  border-radius: 8px;
  border: 1px solid var(--border-color, #f0f0f0);
  background: #fafafa;
  flex-shrink: 0;
  cursor: pointer;
}

.media-thumb--small {
  width: 56px;
  height: 56px;
}

.media-thumb--medium {
  width: 80px;
  height: 80px;
}

.media-thumb--large {
  width: 120px;
  height: 120px;
}

.media-thumb--xlarge {
  width: 200px;
  height: 200px;
}

.media-thumb--fill {
  width: 100%;
  max-width: 320px;
  height: 200px;
}

.media-thumb__img {
  width: 100%;
  height: 100%;
  display: block;
}

.media-thumb__img :deep(.el-image__inner) {
  width: 100%;
  height: 100%;
}

.media-thumb__video-wrap {
  width: 100%;
  height: 100%;
  position: relative;
}

.media-thumb__video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.media-thumb__badge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 2px 8px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 4px;
}

.media-thumb--archived {
  border-style: dashed;
  border-color: #d9d9d9;
  background: #fafafa;
  cursor: default;
}

.media-thumb__archived {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #8c8c8c;
  text-align: center;
  padding: 8px;
}

.media-thumb__archived-title {
  font-size: 12px;
  font-weight: 600;
  color: #595959;
}

.media-thumb__archived-hint {
  font-size: 11px;
  color: #8c8c8c;
}

.media-thumb__empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #bfbfbf;
  font-size: 14px;
}
</style>
