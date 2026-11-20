import { commonMethods } from '../../lib/pager.js'

// 验货任务（电脑版）：只加点缩略图看大图；列表、搜索、物流查询都是手机版原来的方法（一次拉 100 条，不分页）
export default {
  methods: { ...commonMethods },
}
