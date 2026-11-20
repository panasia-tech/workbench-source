<template>
  <wx-video>
    <video
      ref="v"
      :src="videoSrc"
      :poster="poster || undefined"
      :controls="ctl"
      :autoplay="isTrue(autoplay)"
      :loop="isTrue(loop)"
      :muted="isTrue(muted) || !ctl"
      playsinline
      webkit-playsinline
      preload="metadata"
      :style="{ objectFit: objectFit === 'fill' ? 'fill' : objectFit }"
      @play="emit('play', {}, $event)"
      @pause="emit('pause', {}, $event)"
      @ended="emit('ended', {}, $event)"
      @error="emit('error', { errMsg: 'video error' }, $event)"
      @timeupdate="onTime"
      @loadedmetadata="onMeta"
    />
    <i v-if="!ctl && isTrue(showCenterPlayBtn)" class="wx-video__play" aria-hidden="true" />
  </wx-video>
</template>

<script>
import { isTrue } from '../runtime/util.js'

export default {
  name: 'MpVideo',
  props: {
    src: { default: '' },
    poster: { default: '' },
    controls: { default: true },
    autoplay: { default: false },
    loop: { default: false },
    muted: { default: false },
    objectFit: { default: 'contain' },
    showCenterPlayBtn: { default: true },
    mpOn: { default: null },
  },
  computed: {
    ctl() {
      return this.controls === '' || isTrue(this.controls)
    },
    videoSrc() {
      // iOS 不预载首帧，加个时间片段让它显示第一帧当封面
      if (!this.src || this.poster || String(this.src).includes('#')) return this.src || undefined
      return `${this.src}#t=0.1`
    },
  },
  methods: {
    isTrue,
    emit(type, detail, e) {
      const fn = this.mpOn && this.mpOn[type]
      if (typeof fn === 'function') fn(detail, e)
    },
    onTime(e) {
      this.emit('timeupdate', { currentTime: e.target.currentTime, duration: e.target.duration }, e)
    },
    onMeta(e) {
      const v = e.target
      this.emit('loadedmetadata', { width: v.videoWidth, height: v.videoHeight, duration: v.duration }, e)
    },
  },
}
</script>
