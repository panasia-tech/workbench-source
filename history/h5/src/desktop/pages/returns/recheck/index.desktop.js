import { commonMethods } from '../../../lib/pager.js'

// 退回复验（电脑版）：只多一个点缩略图看大图（手机上点照片是删除，电脑上删除换成右上角的 ×）
export default {
  methods: {
    dkPreview: commonMethods.dkPreview,
  },
}
