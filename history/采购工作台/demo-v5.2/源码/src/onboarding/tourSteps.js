// 页面步进导览（点右上角「带我走一遍」或帮助抽屉即可启动）
export const TOURS = {
  today: {
    title: '「今天」工作台 · 4 步看懂',
    steps: [
      {
        target: '[data-tour="today-summary"]',
        title: '① 先看上面三张明白卡',
        body: '一眼看到你本月赚了多少谈价提成（买前10% + 到货议价20%）、全组买货预算还剩多少、现在有几单红灯急着办。',
      },
      {
        target: '[data-tour="today-queue"]',
        title: '② 红的先办，黄的有空看，绿的不用管',
        body: '所有要你动手的事已经按轻重缓急排好队了：先处理「到货出问题谈退差价」和「核对闲鱼改价付钱」。',
      },
      {
        target: '[data-tour="today-go"]',
        title: '③ 点「去跟着做 ›」直接进那一步',
        body: '不用自己找菜单！点一下直接跳进那笔订单当前正停着的那一步，照着屏幕上的话术和按钮点就行。',
      },
      {
        target: '[data-tour="today-help"]',
        title: '④ 任何地方拿不准，点小问号「?」',
        body: '教程、防错提醒、公司钉钉与飞书制度链接全收在小问号里，平时干活界面干干净净不铺满字。',
      },
    ],
  },
  cases: {
    title: '「采购订单」三大分类 · 3 步看懂',
    steps: [
      {
        target: '[data-tour="gal-buckets"]',
        title: '① 订单清清楚楚分三类',
        body: '「今天采购的」看买前谈价付款；「问题订单」专门一步步陪你锁退货、谈退差价；「已经完结的」看入库与到手提成。',
      },
      {
        target: '[data-tour="gal-filters"]',
        title: '② 支持只看红灯急单或搜型号卖家',
        body: '忙的时候勾一下「只看现在要办的红灯单」，3 秒钟聚焦最要紧的活。',
      },
      {
        target: '[data-tour="gal-card"]',
        title: '③ 每张卡都写明了「现在停在第几步」',
        body: '点进任意订单，上面就是一排圆圈进度条，走到哪一步亮哪一步。',
      },
    ],
  },
  'case-detail': {
    title: '订单步入式陪跑页 · 4 步看懂',
    steps: [
      {
        target: '[data-tour="case-issues"]',
        title: '① 顶部彩框直接告诉你现在要干嘛',
        body: '红框代表现在要动手（比如先去闲鱼点退货，或者去谈退差价），绿框代表全部办妥不用管。',
      },
      {
        target: '[data-tour="case-rail"]',
        title: '② 圆圈连线进度条：买前 6 步 + 二次议价 9 步',
        body: '收货前采购共 6 步（含写几乎全新/图糊不追问并给仓管打标）；到货二次议价共 9 步（双10m拒签加微 → P1–P6/G1–G6 心理博弈舱 → 整单退走次日10点对公支付）。',
      },
      {
        target: '[data-tour="case-act"]',
        title: '③ 一步一屏：12 大心理×博弈武器一键复制留痕',
        body: '第 4–8 步直接为你配齐首刀半价/P3拆项精确锚、「不用啦，谢谢」欲擒故纵、G3柠檬市场推演、P5红白脸脱敏定损单与微信四要素定案卡，点一下就复制并自动留痕！',
      },
      {
        target: '[data-tour="case-folds"]',
        title: '④ 买前原话与仓库照片收在折叠条里',
        body: '需要核对买前卖家原话、仓库开箱照片或账本流水时点「展开」就能看，平时收起不挡视线。',
      },
    ],
  },
};

export const TOUR_OF_HELP = {
  today: 'today',
  'd-count': 'today',
  'd-quota': 'today',
  'd-comm': 'today',
  cases: 'cases',
  'g-counts': 'cases',
  'g-filter': 'cases',
  'case-detail': 'case-detail',
  'proc-flow': 'case-detail',
  'c-issues': 'case-detail',
  'buy-1': 'case-detail',
  'buy-2': 'case-detail',
  'buy-3': 'case-detail',
  'buy-4': 'case-detail',
  'buy-5': 'case-detail',
  'iss-1': 'case-detail',
  'iss-2': 'case-detail',
  'iss-3': 'case-detail',
  'iss-4': 'case-detail',
};

export function tourPos(page) {
  const n = Number(localStorage.getItem(`pw_tour_pos_${page}`) || 0);
  const total = TOURS[page]?.steps?.length || 0;
  return Number.isFinite(n) && n > 0 && n < total ? n : 0;
}

export function saveTourPos(page, idx) {
  if (!page) return;
  const total = TOURS[page]?.steps?.length || 0;
  if (idx <= 0 || idx >= total) {
    localStorage.removeItem(`pw_tour_pos_${page}`);
  } else {
    localStorage.setItem(`pw_tour_pos_${page}`, String(idx));
  }
}
