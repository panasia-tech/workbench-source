// 盘点记录（电脑版）：筛选项原页面放在 data.options 里，但 H5 的页面实例上 this.options 是页面参数（同名盖住了），
// 模板里拿不到；电脑版另放一份同样的选项。手机上也是这个原因筛选条不显示（运行时的问题，见回复）
export default {
  data: {
    dkStatusOptions: [
      { value: '', label: '全部' },
      { value: 'COMPLETED', label: '有差异' },
      { value: 'APPROVED', label: '账实相符' },
    ],
  },
}
