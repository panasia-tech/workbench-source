import { commonMethods } from '../../../lib/pager.js'

// 填写上架信息（电脑版）：只补几个按钮用的小方法，数据和保存照原页面
export default {
  methods: {
    ...commonMethods,

    // 原页面的「拿掉」接的是 media-gallery 组件的 remove 事件（e.detail.index）；电脑版自己画图墙，转一下
    dkRemoveImage(e) {
      this.removeImage({ detail: { index: Number(e.currentTarget.dataset.index) } })
    },

    // 原模板靠 button 的 disabled 挡住「提交中」的重复点击；电脑版用 view 当按钮，在这里挡
    dkRedraw(e) {
      if (this.data.submittingRedraw) return
      this.submitRedraw(e)
    },

    dkTextToImage() {
      if (this.data.submittingRedraw || !(this.data.t2iPrompt || '').trim()) return
      this.submitTextToImage()
    },
  },
}
