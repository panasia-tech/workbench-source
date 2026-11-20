// Auto-generated from 节点台账与任务草案.json & 禅道补录回执.json
export const AUDIT_DATA = {
  "summary": {
    "total_nodes": 273,
    "by_status": {
      "已有演示相关代码，生产待验收": 58,
      "真实链路未接入或待开发": 104,
      "已有代码或夹具验证，实机待验收": 27,
      "已有文档或样例依据，非生产完成": 38,
      "规则或范围待确认": 46
    },
    "work_packages": 20,
    "zentao_project3_cards": 25,
    "w10_rpa_cases": 8
  },
  "packages": [
    {
      "id": "W01",
      "title": "闲鱼原生布局与视觉",
      "suggested_role": "前端",
      "priority": "P1",
      "depends_on": [
        "W19"
      ],
      "count": 15,
      "counts": {
        "D": 11,
        "V": 1,
        "L": 1,
        "U": 2,
        "Q": 0
      },
      "route": "#/conversations",
      "route_label": "会话与议价工作台",
      "ui_demo_status": "UI演示已闭环",
      "ui_note": "已用Stitch Tide Blue重构3栏工作台、顶部快照卡与参数条",
      "zentao_id": 48
    },
    {
      "id": "W02",
      "title": "会话列表分类与等待",
      "suggested_role": "前端与业务后端",
      "priority": "P1",
      "depends_on": [
        "W19"
      ],
      "count": 16,
      "counts": {
        "D": 9,
        "V": 1,
        "L": 0,
        "U": 2,
        "Q": 4
      },
      "route": "#/conversations",
      "route_label": "会话与议价工作台",
      "ui_demo_status": "UI演示闭环(含4项Q待裁定)",
      "ui_note": "会话分组/计时器/收藏夹交互已闭环，4项计时与收藏规则标记待裁定",
      "zentao_id": 49
    },
    {
      "id": "W03",
      "title": "聊天顶部商品卡和大图",
      "suggested_role": "前端",
      "priority": "P1",
      "depends_on": [
        "W04",
        "W19"
      ],
      "count": 15,
      "counts": {
        "D": 0,
        "V": 14,
        "L": 0,
        "U": 1,
        "Q": 0
      },
      "route": "#/conversations",
      "route_label": "会话与议价工作台",
      "ui_demo_status": "UI演示已闭环",
      "ui_note": "卖家降价/拒还/已出识别+依据+置信度展示，真实模型接管待U/V实机验收",
      "zentao_id": 50
    },
    {
      "id": "W04",
      "title": "商品快照与证据版本",
      "suggested_role": "后端与前端",
      "priority": "P0",
      "depends_on": [
        "W19"
      ],
      "count": 14,
      "counts": {
        "D": 0,
        "V": 6,
        "L": 1,
        "U": 7,
        "Q": 0
      },
      "route": "#/orders",
      "route_label": "下单与RPA建单",
      "ui_demo_status": "UI演示已闭环",
      "ui_note": "口头谈妥->改价核对->人工下单实付->冻结快照严格分层，防直接自动下单",
      "zentao_id": 51
    },
    {
      "id": "W05",
      "title": "商品发现与执行窗口",
      "suggested_role": "自动化后端",
      "priority": "P1",
      "depends_on": [
        "W19"
      ],
      "count": 14,
      "counts": {
        "D": 0,
        "V": 0,
        "L": 2,
        "U": 10,
        "Q": 2
      },
      "route": "#/discovery",
      "route_label": "发现线索与接管",
      "ui_demo_status": "UI演示闭环(生产抓取待接入)",
      "ui_note": "本地SQLite按(平台,商品ID,账号)去重+窗口绑定台账；真实浏览器抓取待U接入",
      "zentao_id": 52
    },
    {
      "id": "W06",
      "title": "内部价格表与报价边界",
      "suggested_role": "价格后端与采购负责人",
      "priority": "P0",
      "depends_on": [
        "W04",
        "W19"
      ],
      "count": 13,
      "counts": {
        "D": 2,
        "V": 0,
        "L": 1,
        "U": 6,
        "Q": 4
      },
      "route": "#/pricebook",
      "route_label": "价格表与规则中心",
      "ui_demo_status": "UI演示闭环(含4项Q待裁定)",
      "ui_note": "版本化参考价格表+主管发布门禁+首报<=目标<=上限硬校验",
      "zentao_id": 53
    },
    {
      "id": "W07",
      "title": "自动聊天状态与人工干预",
      "suggested_role": "执行器与前端",
      "priority": "P0",
      "depends_on": [
        "W05",
        "W06",
        "W19"
      ],
      "count": 12,
      "counts": {
        "D": 0,
        "V": 0,
        "L": 0,
        "U": 12,
        "Q": 0
      },
      "route": "#/conversations",
      "route_label": "会话与议价工作台",
      "ui_demo_status": "UI演示已闭环",
      "ui_note": "暂停发送中状态机(自动中->请求暂停中->已暂停)+改价失效+防泄漏拦截",
      "zentao_id": 54
    },
    {
      "id": "W08",
      "title": "AI 态度识别与目标推断",
      "suggested_role": "AI 与采购业务",
      "priority": "P1",
      "depends_on": [
        "W06",
        "W07"
      ],
      "count": 12,
      "counts": {
        "D": 2,
        "V": 0,
        "L": 3,
        "U": 7,
        "Q": 0
      },
      "route": "#/conversations",
      "route_label": "会话与议价工作台",
      "ui_demo_status": "UI演示闭环(外呼发送待U接入)",
      "ui_note": "议价回合轨+幂等发送键+防超上限校验；真实平台外呼执行器待接入",
      "zentao_id": 55
    },
    {
      "id": "W09",
      "title": "议价可视化与报价证据",
      "suggested_role": "前端与消息数据后端",
      "priority": "P1",
      "depends_on": [
        "W07",
        "W08"
      ],
      "count": 10,
      "counts": {
        "D": 7,
        "V": 1,
        "L": 0,
        "U": 2,
        "Q": 0
      },
      "route": "#/conversations",
      "route_label": "会话与议价工作台",
      "ui_demo_status": "UI演示闭环(本地示例截图)",
      "ui_note": "历史真实证据图+点击放大+占位图隔离标识，真实闲鱼聊天抓图待U接入",
      "zentao_id": 56
    },
    {
      "id": "W10",
      "title": "人工下单与订单关联",
      "suggested_role": "采购与订单后端",
      "priority": "P0",
      "depends_on": [
        "W04",
        "W06",
        "W07"
      ],
      "count": 10,
      "counts": {
        "D": 1,
        "V": 0,
        "L": 1,
        "U": 8,
        "Q": 0
      },
      "route": "#/orders",
      "route_label": "下单与RPA建单",
      "ui_demo_status": "UI演示闭环(8类异常已模拟)",
      "ui_note": "覆盖ERP现有PO能力并补齐W10 RPA自动抓单8种边界测试，真实ERP写回待接入",
      "zentao_id": 47
    },
    {
      "id": "W11",
      "title": "仓管验货与差异证据",
      "suggested_role": "仓管与 WMS",
      "priority": "P0",
      "depends_on": [
        "W04",
        "W10",
        "W19"
      ],
      "count": 14,
      "counts": {
        "D": 2,
        "V": 0,
        "L": 3,
        "U": 9,
        "Q": 0
      },
      "route": "#/aftersales",
      "route_label": "仓检与售后Plan B",
      "ui_demo_status": "UI演示闭环(真实WMS截图待接)",
      "ui_note": "冻结卖家原话vs仓检实拍对照+已交代/未交代/责任不明3态判定",
      "zentao_id": 57
    },
    {
      "id": "W12",
      "title": "先退货退款与等待卖家",
      "suggested_role": "采购与售后后端",
      "priority": "P0",
      "depends_on": [
        "W11",
        "W19"
      ],
      "count": 13,
      "counts": {
        "D": 4,
        "V": 0,
        "L": 1,
        "U": 8,
        "Q": 0
      },
      "route": "#/aftersales",
      "route_label": "仓检与售后Plan B",
      "ui_demo_status": "UI演示已闭环",
      "ui_note": "强制先平台退货退款并登记回执与期限，未完成前锁死Seller Offer与Plan B",
      "zentao_id": 58
    },
    {
      "id": "W13",
      "title": "Plan B 与留货补差决策",
      "suggested_role": "采购负责人及计算后端",
      "priority": "P0",
      "depends_on": [
        "W12",
        "W06"
      ],
      "count": 15,
      "counts": {
        "D": 9,
        "V": 0,
        "L": 2,
        "U": 3,
        "Q": 1
      },
      "route": "#/aftersales",
      "route_label": "仓检与售后Plan B",
      "ui_demo_status": "UI演示已闭环",
      "ui_note": "整数分同口径(S-K vs S-R)+输入变更强制重算+未拦截/超期禁止改留货",
      "zentao_id": 59
    },
    {
      "id": "W14",
      "title": "微信成交与财务凭证",
      "suggested_role": "采购及财务",
      "priority": "P0",
      "depends_on": [
        "W10",
        "W12",
        "W19"
      ],
      "count": 12,
      "counts": {
        "D": 6,
        "V": 0,
        "L": 0,
        "U": 6,
        "Q": 0
      },
      "route": "#/finance",
      "route_label": "财务、提成与成本",
      "ui_demo_status": "UI演示已闭环",
      "ui_note": "微信850拆分台账(TK-SAMPLE)+财务收付核销与仓库处置双重关单门禁",
      "zentao_id": 60
    },
    {
      "id": "W15",
      "title": "异常工单 OA 与时效升级",
      "suggested_role": "采购主管与业务后端",
      "priority": "P0",
      "depends_on": [
        "W11",
        "W12",
        "W19"
      ],
      "count": 12,
      "counts": {
        "D": 0,
        "V": 0,
        "L": 0,
        "U": 3,
        "Q": 9
      },
      "route": "#/today",
      "route_label": "经营与今日待办",
      "ui_demo_status": "UI演示闭环(含9项Q待裁定)",
      "ui_note": "多时钟SLA独立追踪与交接认领；日清时间/KPI配额等9项待业务裁定",
      "zentao_id": 61
    },
    {
      "id": "W16",
      "title": "提成收益与经营结果",
      "suggested_role": "财务规则负责人和后端",
      "priority": "P0",
      "depends_on": [
        "W06",
        "W10",
        "W14",
        "W19"
      ],
      "count": 11,
      "counts": {
        "D": 3,
        "V": 0,
        "L": 2,
        "U": 3,
        "Q": 3
      },
      "route": "#/finance",
      "route_label": "财务、提成与成本",
      "ui_demo_status": "UI演示闭环(含3项Q待裁定)",
      "ui_note": "预计/确认/发放/退款反向撤销流水已闭环；提成基数冲突标记Q演示试算",
      "zentao_id": 62
    },
    {
      "id": "W17",
      "title": "成色与价格规则待决策表",
      "suggested_role": "采购规则负责人",
      "priority": "P0",
      "depends_on": [
        "W06",
        "W11"
      ],
      "count": 22,
      "counts": {
        "D": 0,
        "V": 0,
        "L": 0,
        "U": 0,
        "Q": 22
      },
      "route": "#/pricebook",
      "route_label": "价格表与规则中心",
      "ui_demo_status": "规则配置台(22项Q待确认)",
      "ui_note": "S-E 6x6矩阵与缺口边界已可配置试算，严格标注待批准不可当生产常量",
      "zentao_id": 63
    },
    {
      "id": "W18",
      "title": "培训任务卡与议价现场提醒",
      "suggested_role": "采购培训负责人和产品",
      "priority": "P1",
      "depends_on": [
        "W11",
        "W12",
        "W13"
      ],
      "count": 15,
      "counts": {
        "D": 1,
        "V": 0,
        "L": 14,
        "U": 0,
        "Q": 0
      },
      "route": "#/training",
      "route_label": "新手引导与防呆演练",
      "ui_demo_status": "UI演示已闭环",
      "ui_note": "7步零培训任务卡+错型号/串图/断网草稿/暂停并发防呆演练",
      "zentao_id": 64
    },
    {
      "id": "W19",
      "title": "核心数据接口与可信状态",
      "suggested_role": "后端及架构",
      "priority": "P0",
      "depends_on": [],
      "count": 14,
      "counts": {
        "D": 1,
        "V": 0,
        "L": 0,
        "U": 13,
        "Q": 0
      },
      "route": "#/readiness",
      "route_label": "闭环自检审计",
      "ui_demo_status": "本地Mock状态机+待真实底座",
      "ui_note": "本地SQLite完整事务+角色越权门禁；真实AdsPower/多端WS/ERP底座待U接入",
      "zentao_id": 65
    },
    {
      "id": "W20",
      "title": "验收交付与Teambition归档草案",
      "suggested_role": "产品负责人及测试交付",
      "priority": "P1",
      "depends_on": [
        "W01",
        "W02",
        "W03",
        "W04",
        "W05",
        "W06",
        "W07",
        "W08",
        "W09",
        "W10",
        "W11",
        "W12",
        "W13",
        "W14",
        "W15",
        "W16",
        "W17",
        "W18",
        "W19"
      ],
      "count": 14,
      "counts": {
        "D": 0,
        "V": 4,
        "L": 7,
        "U": 2,
        "Q": 1
      },
      "route": "#/readiness",
      "route_label": "闭环自检审计",
      "ui_demo_status": "自动化闭环测试+待实机V验收",
      "ui_note": "随包附带verify_closed_loop.py端到端回归测试，真实闲鱼/ERP实机验收待U/V",
      "zentao_id": 66
    }
  ],
  "nodes": [
    {
      "id": "PC-001",
      "wp": "W01",
      "title": "沿用原生聊天结构",
      "trigger": "打开工作台时在原页追加组件",
      "acceptance": "原有消息和发送区仍可使用，避免整页替换",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U023",
        "U048",
        "U052",
        "U101"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-002",
      "wp": "W01",
      "title": "右栏与聊天并排",
      "trigger": "展开右栏时重新分配宽度",
      "acceptance": "右栏边界不覆盖原生消息或输入区",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U023",
        "U048",
        "U052",
        "U101"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-003",
      "wp": "W01",
      "title": "顶部参数固定位置",
      "trigger": "聊天记录滚动时保持参数可见",
      "acceptance": "参数位于消息上方且不随消息滚出",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U023",
        "U048",
        "U052",
        "U101"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-004",
      "wp": "W01",
      "title": "左右栏同步原生配色",
      "trigger": "视觉调整时使用闲鱼页面样式依据",
      "acceptance": "白灰底、灰色选中、黄色主操作一致",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U023",
        "U048",
        "U052",
        "U101"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-005",
      "wp": "W01",
      "title": "清除深蓝后台风格",
      "trigger": "独立演示与嵌入页使用同一视觉语言",
      "acceptance": "头部、按钮和气泡不再出现旧深蓝主题",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U023",
        "U048",
        "U052",
        "U101"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-006",
      "wp": "W01",
      "title": "正文可读字号",
      "trigger": "展示商品和工单内容时避免极小字",
      "acceptance": "按目标窗口肉眼检查正文与状态可读",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U023",
        "U048",
        "U052",
        "U101"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-007",
      "wp": "W01",
      "title": "增加可见聊天高度",
      "trigger": "商品、参数和提醒排布时压缩空白",
      "acceptance": "消息区达到商定最小高度，不只显示两行",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U023",
        "U048",
        "U052",
        "U101"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-008",
      "wp": "W01",
      "title": "顶部站点空间处理",
      "trigger": "采购页启用时处理占高站点装饰",
      "acceptance": "闲鱼必要入口可达且聊天高度增加",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U023",
        "U048",
        "U052",
        "U101"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-009",
      "wp": "W01",
      "title": "右栏独立滚动",
      "trigger": "右栏内容超过首屏时允许独立滚动",
      "acceptance": "底部导航不盖住最后一个操作",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U023",
        "U048",
        "U052",
        "U101"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-010",
      "wp": "W01",
      "title": "右栏收起与展开",
      "trigger": "点击收起时释放聊天宽度",
      "acceptance": "再次展开能继续查看原上下文",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U023",
        "U048",
        "U052",
        "U101"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-011",
      "wp": "W01",
      "title": "收起不代表停机",
      "trigger": "收起右栏时维持后台业务状态",
      "acceptance": "真实执行器不因界面折叠而停发或恢复",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D5",
        "D10"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-012",
      "wp": "W01",
      "title": "四个 Dock 分工",
      "trigger": "切换会话行情工单收益页面",
      "acceptance": "各页面职责和选中状态正确，互不串单",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D5"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-013",
      "wp": "W01",
      "title": "窄窗口适配",
      "trigger": "窗口改变时重新布局",
      "acceptance": "约定宽度下图片、消息、按钮仍可操作",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U023",
        "U048",
        "U052",
        "U101"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-014",
      "wp": "W01",
      "title": "读取实际前端样式",
      "trigger": "设计变更前核对闲鱼已加载样式",
      "acceptance": "样式参考保留版本和来源，不声称服务端源码",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U023",
        "U048",
        "U052",
        "U101"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-015",
      "wp": "W01",
      "title": "保持内部信息私有",
      "trigger": "在聊天附近显示行情和提成",
      "acceptance": "内部提示不进入卖家收到的消息正文",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D5"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-016",
      "wp": "W02",
      "title": "十分钟分类入口",
      "trigger": "点击左侧时间分类",
      "acceptance": "显示对应范围内会话且可打开原生聊天",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U033",
        "U056",
        "U060",
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-017",
      "wp": "W02",
      "title": "一小时分类入口",
      "trigger": "点击一小时分类",
      "acceptance": "边界与十分钟包含关系按确认规则实现",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U033",
        "U056",
        "U060",
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-018",
      "wp": "W02",
      "title": "全部分类兜底",
      "trigger": "超时或暂无卖家回复时保留可达性",
      "acceptance": "此类会话仍能从全部查到",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U033",
        "U056",
        "U060",
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-019",
      "wp": "W02",
      "title": "时间分类位于左侧",
      "trigger": "切换原生会话时保持分类入口",
      "acceptance": "分类占位不挤掉商品缩略图",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U033",
        "U056",
        "U060",
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-020",
      "wp": "W02",
      "title": "分类时间基准决策",
      "trigger": "制定生产筛选规则时选择消息时间",
      "acceptance": "明确卖家最后回复或其他基准及空值处理",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-021",
      "wp": "W02",
      "title": "分类动态刷新",
      "trigger": "收到新消息或跨过时间边界",
      "acceptance": "数量和列表一致，原选中会话不串档",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U033",
        "U056",
        "U060",
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-022",
      "wp": "W02",
      "title": "显示同步范围",
      "trigger": "页面只加载部分会话时标明范围",
      "acceptance": "已加载数量不冒充全账号会话总数",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U033",
        "U056",
        "U060",
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-023",
      "wp": "W02",
      "title": "每个会话独立倒计时",
      "trigger": "为当前加载的各会话显示等待秒数",
      "acceptance": "不同会话各有倒计时，互不共享结束时间",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U033",
        "U056",
        "U060",
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-024",
      "wp": "W02",
      "title": "倒计时起点与复位决策",
      "trigger": "新消息或人工操作发生时决定重置",
      "acceptance": "明确等谁、起点、暂停及恢复规则",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "U056",
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-025",
      "wp": "W02",
      "title": "超时提醒而非伪造完成",
      "trigger": "等待超时后展示待处理状态",
      "acceptance": "会话不被静默删除或自动结案",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U033",
        "U056",
        "U060",
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-026",
      "wp": "W02",
      "title": "慢慢压价分组",
      "trigger": "采购选择长期跟进会话",
      "acceptance": "可移入移回，分组与收藏独立",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-027",
      "wp": "W02",
      "title": "长期跟进频次决策",
      "trigger": "计划主动回访时设间隔和上限",
      "acceptance": "无配置不反复催问，配置版本可查",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-028",
      "wp": "W02",
      "title": "卖家收藏与取消",
      "trigger": "采购收藏卖家后重新打开页面",
      "acceptance": "按稳定卖家 ID 保存并允许撤销",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-029",
      "wp": "W02",
      "title": "收藏可见范围决策",
      "trigger": "多人使用收藏时定义个人或团队范围",
      "acceptance": "明确所有者和共享权限，默认不擅自全员共享",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "D6"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-030",
      "wp": "W02",
      "title": "备注与标签持久化",
      "trigger": "采购补充备注或标签后保存",
      "acceptance": "成功保存可回读，失败提示并允许重试",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D6",
        "D10"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-031",
      "wp": "W02",
      "title": "原生头像与商品图完整显示",
      "trigger": "文字变长或列表变窄时重新排布",
      "acceptance": "50px 商品图不被文本挤出可见区域",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端与业务后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U107"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-032",
      "wp": "W03",
      "title": "商品主图展示",
      "trigger": "选中有商品的会话",
      "acceptance": "卡片显示对应商品图片而非卖家头像",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-033",
      "wp": "W03",
      "title": "商品价格展示",
      "trigger": "商品卡识别到标价",
      "acceptance": "标价带来源，不冒充实付或公司行情",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-034",
      "wp": "W03",
      "title": "商品标题和描述展示",
      "trigger": "已有页面或爬虫描述时回显",
      "acceptance": "正文可读，长内容可展开查看",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-035",
      "wp": "W03",
      "title": "商品规格展示",
      "trigger": "采集到品牌型号规格时回显",
      "acceptance": "字段保留原文，缺失项标待采集",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-036",
      "wp": "W03",
      "title": "成色声明展示",
      "trigger": "商品页有成色文字时回显",
      "acceptance": "明确是卖家声明而非仓管验真",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-037",
      "wp": "W03",
      "title": "配件描述展示",
      "trigger": "原文列出配件时供采购查看",
      "acceptance": "不重复询问已列明配件",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-038",
      "wp": "W03",
      "title": "多图缩略列表",
      "trigger": "商品快照包含多张图片",
      "acceptance": "缩略图与主图来自同一商品记录",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-039",
      "wp": "W03",
      "title": "点击主图看大图",
      "trigger": "点击主图或查看快照",
      "acceptance": "弹窗显示图片和原文，可关闭返回聊天",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-040",
      "wp": "W03",
      "title": "切换大图",
      "trigger": "在弹窗选择另一缩略图",
      "acceptance": "图片序号和大图一致，无串商品",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-041",
      "wp": "W03",
      "title": "保存时间可见",
      "trigger": "展示采集记录时显示时间",
      "acceptance": "用户能辨别当前页与历史采集时点",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-042",
      "wp": "W03",
      "title": "显示原商品入口",
      "trigger": "需要核对原网页时点击链接",
      "acceptance": "打开对应商品 ID 的页面",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-043",
      "wp": "W03",
      "title": "显示图片保存状态",
      "trigger": "部分图片未能保存文件",
      "acceptance": "区分已本地保存和仅保留图链",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-044",
      "wp": "W03",
      "title": "无详情时提供采集入口",
      "trigger": "聊天未匹配到商品详情",
      "acceptance": "显示待采集或打开详情，不填虚构描述",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-045",
      "wp": "W03",
      "title": "关键商品缺失时清空旧卡",
      "trigger": "快速切换无 ID 或不同商品",
      "acceptance": "旧商品描述与价格不残留",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-046",
      "wp": "W03",
      "title": "大图不挤占常态聊天",
      "trigger": "正常聊天时折叠大图",
      "acceptance": "仅点击后打开，关闭可回原上下文",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "U111",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-047",
      "wp": "W04",
      "title": "商品 ID 关联记录",
      "trigger": "保存商品内容时使用平台商品 ID",
      "acceptance": "同 ID 可查，跨商品不得覆写",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-048",
      "wp": "W04",
      "title": "下单前完整原文留存",
      "trigger": "正式报价或下单前存档",
      "acceptance": "标题描述规格成色配件和标价齐全",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-049",
      "wp": "W04",
      "title": "图片实际文件留存",
      "trigger": "冻结证据时保存可回读媒体",
      "acceptance": "远端删图后已存文件仍可查看",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-050",
      "wp": "W04",
      "title": "原链接留存",
      "trigger": "保存快照时记录来源 URL",
      "acceptance": "每份快照能回溯采集来源",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-051",
      "wp": "W04",
      "title": "首份记录不覆盖",
      "trigger": "再次打开已有商品时保留首份",
      "acceptance": "网页后来修改不静默覆盖首份本地记录",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-052",
      "wp": "W04",
      "title": "正式多版本快照",
      "trigger": "同商品后续变更时新增版本",
      "acceptance": "可比对前后版本并绑定订单时点",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-053",
      "wp": "W04",
      "title": "订单冻结快照",
      "trigger": "订单成立时绑定正确证据版本",
      "acceptance": "后续改价不改变旧单快照",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-054",
      "wp": "W04",
      "title": "视频和检测原件留存",
      "trigger": "有商品视频或检测报告时存原件",
      "acceptance": "缩略图不能代替原视频或原报告",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-055",
      "wp": "W04",
      "title": "媒体来源与哈希",
      "trigger": "上传证据后记录文件身份",
      "acceptance": "可校验内容版本和上传记录",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-056",
      "wp": "W04",
      "title": "采集失败可见",
      "trigger": "字段选择器或网络失效时显示异常",
      "acceptance": "保留缺失说明并允许补证",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-057",
      "wp": "W04",
      "title": "存储容量不足处理",
      "trigger": "本地容量或图片限制触发",
      "acceptance": "降级图链时明确提示，不显示已永久保存",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-058",
      "wp": "W04",
      "title": "图片匹配不等于订单匹配",
      "trigger": "缺商品 ID 仅有图片线索",
      "acceptance": "显示待核；重复主图不得强行串单",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-059",
      "wp": "W04",
      "title": "证据权限和备份",
      "trigger": "团队共享快照与仓检材料时控制访问",
      "acceptance": "授权可查且备份可恢复",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端与前端",
      "type": "技术支撑",
      "source_kind": "技术建议",
      "refs": [
        "H1"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-060",
      "wp": "W04",
      "title": "快照历史时点边界",
      "trigger": "回看样本或新采集页面",
      "acceptance": "不能把采集时页面宣称为当年下单页",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P0",
      "role": "后端与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "D11",
        "U072",
        "U111"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-061",
      "wp": "W05",
      "title": "独立监听端发现链接",
      "trigger": "关键词命中商品后产生任务",
      "acceptance": "保留商品链接与发现时间",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "自动化后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D3",
        "D4",
        "D12"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-062",
      "wp": "W05",
      "title": "复用既有爬虫数据",
      "trigger": "公司已有脚本返回商品详情",
      "acceptance": "接入其字段与来源，减少重复采集",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "自动化后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U031",
        "D7"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-063",
      "wp": "W05",
      "title": "发现频率实测",
      "trigger": "评估用户提出的高频监听目标",
      "acceptance": "给出实际频率成功率与限制，非静态估算",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "自动化后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D3",
        "D4",
        "D12"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-064",
      "wp": "W05",
      "title": "商品链接去重",
      "trigger": "重复投递同一商品和账号",
      "acceptance": "不产生重复首次报价任务",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "自动化后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D3",
        "D4",
        "D12"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-065",
      "wp": "W05",
      "title": "一前台三后台布局核对",
      "trigger": "接入采购电脑执行环境",
      "acceptance": "窗口职责与现有 RPA 一致",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P1",
      "role": "自动化后端",
      "type": "规则决策",
      "source_kind": "附件开发目标",
      "refs": [
        "D3",
        "D4",
        "D12"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-066",
      "wp": "W05",
      "title": "第三后台窗口职责决策",
      "trigger": "分配后台任务前明确职责",
      "acceptance": "不自行把第三窗口指定为新账号或新用途",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P1",
      "role": "自动化后端",
      "type": "规则决策",
      "source_kind": "附件开发目标",
      "refs": [
        "D3",
        "D4",
        "D12"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-067",
      "wp": "W05",
      "title": "窗口与账号绑定",
      "trigger": "执行任务前核对当前账号",
      "acceptance": "任务只在指定账号会话运行",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "自动化后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D3",
        "D4",
        "D12"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-068",
      "wp": "W05",
      "title": "任务分配和失败重试",
      "trigger": "执行窗口忙或失败时排队",
      "acceptance": "重试有上限和记录，不重复外发",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "自动化后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D3",
        "D4",
        "D12"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-069",
      "wp": "W05",
      "title": "首次报价执行结果",
      "trigger": "后台发送首报后返回状态",
      "acceptance": "有真实消息 ID 或明确失败原因",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "自动化后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D3",
        "D4",
        "D12"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-070",
      "wp": "W05",
      "title": "后续自动聊天接入",
      "trigger": "卖家回复到来后进入执行链",
      "acceptance": "常规回复不依赖员工逐条点发送",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "自动化后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D3",
        "D4",
        "D12"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-071",
      "wp": "W05",
      "title": "执行器断线显示",
      "trigger": "后台连接丢失时更新前台",
      "acceptance": "显示连接未知或断线，不虚报自动运行",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "自动化后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D3",
        "D4",
        "D12"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-072",
      "wp": "W05",
      "title": "高频容量验收",
      "trigger": "按业务目标进行压力测试",
      "acceptance": "以约每日千会话峰值十几条每分钟做可复核测试",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "自动化后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D3",
        "D4",
        "D12"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-073",
      "wp": "W05",
      "title": "量化批量与老链接深挖分流",
      "trigger": "接入两种报价打法时区分任务来源",
      "acceptance": "分别记录适用场景，不将两种流程混作一个统一算法",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "自动化后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "F03:原文整理"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-074",
      "wp": "W05",
      "title": "老链接不等于卖家急售",
      "trigger": "使用发布时间作为筛选线索",
      "acceptance": "保留时间依据，不直接推断急售或自动提高砍价幅度",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "自动化后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "F03:原文整理"
      ],
      "route": "#/discovery"
    },
    {
      "id": "PC-075",
      "wp": "W06",
      "title": "公司价格表接入",
      "trigger": "准确识别商品后取内部定价",
      "acceptance": "内部行情有公司来源，不用公开挂牌冒充",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D8",
        "U065"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-076",
      "wp": "W06",
      "title": "准确型号匹配",
      "trigger": "标题描述规格联合识别",
      "acceptance": "单机与套机等不同条目不混价",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D8",
        "U065"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-077",
      "wp": "W06",
      "title": "关键规格冲突拦截",
      "trigger": "型号或规格来源矛盾",
      "acceptance": "转待核并停止使用不确定价格报价",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D8",
        "U065"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-078",
      "wp": "W06",
      "title": "配件口径参与匹配",
      "trigger": "不同配件组合对应条目",
      "acceptance": "价格依据反映对应组合",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D8",
        "U065"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-079",
      "wp": "W06",
      "title": "当前生效版本展示",
      "trigger": "查看行情页面时显示有效版本",
      "acceptance": "生效时间版本和维护来源可追踪",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D8",
        "U065"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-080",
      "wp": "W06",
      "title": "历史价格列表",
      "trigger": "查看历史定价时展示变更",
      "acceptance": "当前价与历史价清楚区分",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D8",
        "U065"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-081",
      "wp": "W06",
      "title": "人工修正匹配留痕",
      "trigger": "采购更正型号或规格",
      "acceptance": "记录依据和操作者，当前价格重新取值",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D8",
        "U065"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-082",
      "wp": "W06",
      "title": "撤销旧待发报价",
      "trigger": "修正匹配或更新上下文",
      "acceptance": "旧商品报价不再被执行器发送",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D8",
        "U065"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-083",
      "wp": "W06",
      "title": "首报目标上限分字段",
      "trigger": "制定报价规则时分别定义",
      "acceptance": "首报价目标价和最高价不共用字段",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "规则决策",
      "source_kind": "附件开发目标",
      "refs": [
        "D8",
        "U065"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-084",
      "wp": "W06",
      "title": "演示八成口径边界",
      "trigger": "回看示例的百分比时解释基数",
      "acceptance": "80% 仅示例，不能一键套用所有真实采购",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "规则决策",
      "source_kind": "附件开发目标",
      "refs": [
        "D8",
        "U065"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-085",
      "wp": "W06",
      "title": "正式报价比例决策",
      "trigger": "不同品类使用生产报价策略",
      "acceptance": "明确适用范围和上限，不默认旧50%至70%",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "D8",
        "F04",
        "F05"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-086",
      "wp": "W06",
      "title": "成交参考价锁定时点",
      "trigger": "计算旧单提成前冻结依据",
      "acceptance": "锁定版本不受后来调表追溯改变",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "规则决策",
      "source_kind": "附件开发目标",
      "refs": [
        "D8",
        "U065",
        "D9",
        "U031",
        "F01",
        "F02"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-087",
      "wp": "W06",
      "title": "外部行情只作参考",
      "trigger": "查看网络商品数据时标注来源",
      "acceptance": "币种状态样本时间与成交性质可辨",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P0",
      "role": "价格后端与采购负责人",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "U072",
        "D8"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-088",
      "wp": "W07",
      "title": "区分识别报价还价谈妥状态",
      "trigger": "收到执行或消息事件后更新",
      "acceptance": "状态与真实回执一致",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "执行器与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "U094"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-089",
      "wp": "W07",
      "title": "不重复问已声明内容",
      "trigger": "页面已写明规格成色配件",
      "acceptance": "不会自动插入重复核实问题",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "执行器与前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "F05",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-090",
      "wp": "W07",
      "title": "必要问题待核",
      "trigger": "关键条件仍无法从材料确认",
      "acceptance": "不编造信息，内部明确缺失再处理",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "执行器与前端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "D7"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-091",
      "wp": "W07",
      "title": "暂停请求与确认分离",
      "trigger": "采购点击暂停当前会话",
      "acceptance": "先显示暂停中，收到执行端确认才已暂停",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "执行器与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "U094"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-092",
      "wp": "W07",
      "title": "暂停仅作用当前会话",
      "trigger": "同账号存在多个并行会话",
      "acceptance": "其他会话不因本单暂停全部停机",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "执行器与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "U094"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-093",
      "wp": "W07",
      "title": "处理发送竞态",
      "trigger": "暂停时已有一条发送中",
      "acceptance": "记录其实际结果并阻止之后新发送",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "执行器与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "U094"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-094",
      "wp": "W07",
      "title": "恢复前同步最新消息",
      "trigger": "采购恢复被暂停会话",
      "acceptance": "依据最新上下文不重发旧回复",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "执行器与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "U094"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-095",
      "wp": "W07",
      "title": "消息幂等",
      "trigger": "同回执或消息重复推送",
      "acceptance": "不重复发送或推进业务",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "执行器与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "U094"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-096",
      "wp": "W07",
      "title": "上下文版本校验",
      "trigger": "切换商品或快速连续操作",
      "acceptance": "任务发送前核对会话和商品版本",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "执行器与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "U094"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-097",
      "wp": "W07",
      "title": "内部建议不对外泄漏",
      "trigger": "AI 输出价格提成及成本建议",
      "acceptance": "发给卖家的正文不含内部经营字段",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "执行器与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "U094"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-098",
      "wp": "W07",
      "title": "定位正确待办会话",
      "trigger": "点击工单或收藏中的待办",
      "acceptance": "按账号会话商品打开，不靠相似昵称",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "执行器与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "U094"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-099",
      "wp": "W07",
      "title": "失败反馈与重试",
      "trigger": "执行未知或失败时处理",
      "acceptance": "保留待办和错误，重试不冒充成功",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "执行器与前端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "U094"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-100",
      "wp": "W08",
      "title": "强硬或偏软态度识别",
      "trigger": "对方真实消息有足够证据",
      "acceptance": "输出分类和依据，不靠随机演示值",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "AI 与采购业务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U060",
        "U065",
        "P01",
        "P04"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-101",
      "wp": "W08",
      "title": "未知态度状态",
      "trigger": "消息不足或未确认发送方",
      "acceptance": "显示证据不足，避免强贴标签",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "AI 与采购业务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U060",
        "U065",
        "P01",
        "P04"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-102",
      "wp": "W08",
      "title": "态度证据片段",
      "trigger": "展示识别结果时附原话",
      "acceptance": "可定位消息出处与时间",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "AI 与采购业务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U060",
        "U065",
        "P01",
        "P04"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-103",
      "wp": "W08",
      "title": "态度动态更新",
      "trigger": "新消息改变对方态度",
      "acceptance": "保留前后判断和变化依据",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "AI 与采购业务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U060",
        "U065",
        "P01",
        "P04"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-104",
      "wp": "W08",
      "title": "预计可谈目标价",
      "trigger": "内部行情和谈判上下文可用",
      "acceptance": "显示推断依据与范围，不冒充成交承诺",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "AI 与采购业务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U060",
        "U065",
        "P01",
        "P04"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-105",
      "wp": "W08",
      "title": "采购设定目标与AI预测分离",
      "trigger": "两种目标同时存在",
      "acceptance": "来源不同字段不同，不互相覆盖",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "AI 与采购业务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U060",
        "U065",
        "P01",
        "P04"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-106",
      "wp": "W08",
      "title": "目标不可计算时留空",
      "trigger": "行情规格或样本不足",
      "acceptance": "不生成看似精确的价格",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "AI 与采购业务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U060",
        "U065",
        "P01",
        "P04"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-107",
      "wp": "W08",
      "title": "卖家防御型路由",
      "trigger": "对方强调自己发货无问题",
      "acceptance": "建议回到原文与证据，避免人格攻击",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "AI 与采购业务",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "P04:卖家状态路由",
        "P05:27"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-108",
      "wp": "W08",
      "title": "卖家情绪型路由",
      "trigger": "对方愤怒或沟通升级",
      "acceptance": "建议冷却或结束本轮，不镜像辱骂",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "AI 与采购业务",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "P04:卖家状态路由",
        "P05:27"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-109",
      "wp": "W08",
      "title": "专业商家路由",
      "trigger": "对方有明确行情依据",
      "acceptance": "建议区间和成本依据，避免假精确",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "AI 与采购业务",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "P04:卖家状态路由"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-110",
      "wp": "W08",
      "title": "权限范围内建议",
      "trigger": "AI 给出补差和让步建议",
      "acceptance": "不跳过价格底线或人工权限",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "AI 与采购业务",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "P04:Agent化终局"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-111",
      "wp": "W08",
      "title": "评估预测和分类效果",
      "trigger": "回放真实历史案例时评估",
      "acceptance": "按人工标注记录误判和目标偏差",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "AI 与采购业务",
      "type": "技术支撑",
      "source_kind": "技术建议",
      "refs": [
        "H1"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-112",
      "wp": "W09",
      "title": "逐轮双方报价图",
      "trigger": "有已确认归属的多轮报价",
      "acceptance": "我方和卖家轨迹清晰可辨",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与消息数据后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U065",
        "D4"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-113",
      "wp": "W09",
      "title": "目标价参考线",
      "trigger": "存在设定或推断目标",
      "acceptance": "图中标注目标及来源",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与消息数据后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U065",
        "D4"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-114",
      "wp": "W09",
      "title": "最新双方价差",
      "trigger": "两侧有效最新报价齐全",
      "acceptance": "按同一上下文计算并可复核",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与消息数据后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U065",
        "D4"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-115",
      "wp": "W09",
      "title": "卖家累计让价",
      "trigger": "存在可确认起点和后续报价",
      "acceptance": "正确定义起点，不把金额线索连成曲线",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与消息数据后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U065",
        "D4"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-116",
      "wp": "W09",
      "title": "每个报价附原话",
      "trigger": "点选或查看报价明细",
      "acceptance": "金额来源和说话人可追溯",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与消息数据后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U065",
        "D4"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-117",
      "wp": "W09",
      "title": "金额线索单独展示",
      "trigger": "尚未确认归属时读到金额",
      "acceptance": "标成待核，不计算真实让价",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与消息数据后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U065",
        "D4"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-118",
      "wp": "W09",
      "title": "已谈妥与单方提议分离",
      "trigger": "一方报出数字或双方明确同意",
      "acceptance": "不把850单方报价直接视为最终成交",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "前端与消息数据后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U065",
        "D4"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-119",
      "wp": "W09",
      "title": "图表随会话切换",
      "trigger": "采购切换会话商品",
      "acceptance": "清空无关曲线与目标",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "前端与消息数据后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U065",
        "D4"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-120",
      "wp": "W09",
      "title": "标价报价实付分离",
      "trigger": "同一商品有多种金额",
      "acceptance": "字段名称和来源分别展示",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "前端与消息数据后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U065",
        "D4"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-121",
      "wp": "W09",
      "title": "公开参考和本单证据分离",
      "trigger": "使用网络案例辅助预览",
      "acceptance": "公开图片和价格不冒充本单快照",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "前端与消息数据后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U065",
        "D4"
      ],
      "route": "#/conversations"
    },
    {
      "id": "PC-122",
      "wp": "W10",
      "title": "谈妥后提示改价待核",
      "trigger": "卖家口头接受价格",
      "acceptance": "保留待改价或待确认，不显示已付款",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购与订单后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "D11"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-123",
      "wp": "W10",
      "title": "核对真实页面金额",
      "trigger": "采购准备下单时读取页面",
      "acceptance": "页面金额与约定不符时提示",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与订单后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "D11"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-124",
      "wp": "W10",
      "title": "下单商品和账号校验",
      "trigger": "进入实际购买步骤",
      "acceptance": "账号商品和原快照保持一致",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与订单后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "D11"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-125",
      "wp": "W10",
      "title": "人工完成下单付款",
      "trigger": "采购在真实平台操作",
      "acceptance": "扩展不以本地点击模拟真实付款成功",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P0",
      "role": "采购与订单后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "D11"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-126",
      "wp": "W10",
      "title": "收货信息核对",
      "trigger": "下单前使用实际仓库收货信息",
      "acceptance": "地址信息从授权业务记录取得并经核对",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与订单后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "D11"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-127",
      "wp": "W10",
      "title": "真实订单号关联",
      "trigger": "平台生成订单后绑定内部记录",
      "acceptance": "同单唯一，无法确认时待核",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与订单后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "D11"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-128",
      "wp": "W10",
      "title": "实付金额留凭证",
      "trigger": "付款后接收真实回执",
      "acceptance": "原订单实付与聊天标价独立记录",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与订单后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "D11"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-129",
      "wp": "W10",
      "title": "成交事件去重",
      "trigger": "平台重复推送成功事件",
      "acceptance": "只生成一次订单和收益来源事件",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与订单后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "D11"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-130",
      "wp": "W10",
      "title": "订单取消和退款回退",
      "trigger": "订单真实取消或退款",
      "acceptance": "相应状态及预计收益可追溯调整",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与订单后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "D11"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-131",
      "wp": "W10",
      "title": "订单与仓管交接",
      "trigger": "下单完成进入到货流程",
      "acceptance": "仓管能调到正确原声明快照和配件",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与订单后端",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D4",
        "D10",
        "D11"
      ],
      "route": "#/orders"
    },
    {
      "id": "PC-132",
      "wp": "W11",
      "title": "原始声明与实物并排对照",
      "trigger": "到货验货时打开订单",
      "acceptance": "原文和仓检证据来自同单",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "U072",
        "U078",
        "F08"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-133",
      "wp": "W11",
      "title": "仓检照片上传",
      "trigger": "仓管发现外观问题",
      "acceptance": "原始文件与订单问题位置对应",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "U072",
        "U078",
        "F08"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-134",
      "wp": "W11",
      "title": "功能测试视频上传",
      "trigger": "功能异常需复核",
      "acceptance": "可回放原视频，缩略图不当结论",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "U072",
        "U078",
        "F08"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-135",
      "wp": "W11",
      "title": "检测报告原件",
      "trigger": "硬盘等参数有争议",
      "acceptance": "保存原始检测和设备标识，低清聊天图仅线索",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "U072",
        "U078",
        "F08"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-136",
      "wp": "W11",
      "title": "问题位置和程度描述",
      "trigger": "仓管记录实际瑕疵",
      "acceptance": "部位照片和影响可复核",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "U072",
        "U078",
        "F08"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-137",
      "wp": "W11",
      "title": "卖家已披露内容标识",
      "trigger": "实物情况对应原页面已知问题",
      "acceptance": "不得标成隐瞒或未披露",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "U072",
        "U078",
        "F08"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-138",
      "wp": "W11",
      "title": "原因不明状态",
      "trigger": "运输仓损或硬件原因未定",
      "acceptance": "显示待判责任，不默认卖家负责",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "P05:14",
        "F09:21"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-139",
      "wp": "W11",
      "title": "外观功能配件分栏",
      "trigger": "同件商品存在不同维度问题",
      "acceptance": "外观好不掩盖功能故障，缺件独立记录",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "待确认决策",
      "refs": [
        "F09:3",
        "F09:9"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-140",
      "wp": "W11",
      "title": "包装与内衬核对",
      "trigger": "卖家约定原盒配套包装",
      "acceptance": "核对外箱与适配内衬并留实拍",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "F08:原文整理"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-141",
      "wp": "W11",
      "title": "支架底座电源线核对",
      "trigger": "显示器等品类验收",
      "acceptance": "按原约定列缺件，不把已说明缺件当新问题",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "F08:原文整理"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-142",
      "wp": "W11",
      "title": "正常件验货结论",
      "trigger": "未发现实际问题",
      "acceptance": "完成验货记录再交实际入库流程",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "U072",
        "U078",
        "F08"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-143",
      "wp": "W11",
      "title": "异常自动关联工单",
      "trigger": "存在真实差异或待复核问题",
      "acceptance": "工单带订单快照与证据索引",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "附件开发目标",
      "refs": [
        "D7",
        "U072",
        "U078",
        "F08"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-144",
      "wp": "W11",
      "title": "破损图片展示与放大",
      "trigger": "查看到货异常工单",
      "acceptance": "实际本单实拍可放大，参考图显著注明非本单",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U078",
        "U111"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-145",
      "wp": "W11",
      "title": "几乎全新作为验货风险标签",
      "trigger": "遇到几乎全新等高承诺订单",
      "acceptance": "提醒按原文和实物细查，不自动套3折或5折报价",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P0",
      "role": "仓管与 WMS",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "F05:原文整理"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-146",
      "wp": "W12",
      "title": "发现实际问题先申请售后",
      "trigger": "收到货存在实际问题",
      "acceptance": "按平台流程发起退货退款而非只点本地状态",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094",
        "D4"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-147",
      "wp": "W12",
      "title": "申请证据并行补充",
      "trigger": "售后时限紧但有真实问题",
      "acceptance": "保留已提交事实及待补材料，不为补证错过时限",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "技术支撑",
      "source_kind": "技术建议",
      "refs": [
        "H1"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-148",
      "wp": "W12",
      "title": "申请回执与准备材料分离",
      "trigger": "打开提交页或完成申请后",
      "acceptance": "未拿到回执不得标平台已申请",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094",
        "D4"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-149",
      "wp": "W12",
      "title": "等待卖家主动留货",
      "trigger": "退货退款申请真实提交后",
      "acceptance": "默认先观察对方回应与时限",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094",
        "D4"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-150",
      "wp": "W12",
      "title": "记录谁先提出留货",
      "trigger": "收到包含留货或补差的消息",
      "acceptance": "保留说话人原文时间和方案",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094",
        "D4"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-151",
      "wp": "W12",
      "title": "平台售后期限展示",
      "trigger": "进入售后时读取实际截止时间",
      "acceptance": "显示平台截止来源，不能只靠演示时间",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094",
        "D4"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-152",
      "wp": "W12",
      "title": "卖家允许退回的分支",
      "trigger": "对方表示退回来",
      "acceptance": "保持退货路径且可按规则评估Plan B",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094",
        "D4"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-153",
      "wp": "W12",
      "title": "卖家没提留货的分支",
      "trigger": "可操作时仍无留货方案",
      "acceptance": "进入Plan B提示而非无限等待",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094",
        "D4"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-154",
      "wp": "W12",
      "title": "申请撤销独立记录",
      "trigger": "发生撤销售后动作",
      "acceptance": "保存真实回执，不自动等同留货成交",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094",
        "D4"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-155",
      "wp": "W12",
      "title": "退款状态单独记录",
      "trigger": "平台显示退款受理或成功",
      "acceptance": "申请受理到账分别展示",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094",
        "D4"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-156",
      "wp": "W12",
      "title": "退货物流跟踪",
      "trigger": "继续退货时发出商品",
      "acceptance": "运单揽收签收及异常能回查",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094",
        "D4"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-157",
      "wp": "W12",
      "title": "资金与货物双闭环",
      "trigger": "准备结案时核对状态",
      "acceptance": "仅退款或仅出库不自动代表全单完成",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094",
        "D4"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-158",
      "wp": "W12",
      "title": "平台争议继续待核",
      "trigger": "责任或申请结果有争议",
      "acceptance": "保留证据和真实状态，不承诺必退成功",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P0",
      "role": "采购与售后后端",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094",
        "D4"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-159",
      "wp": "W13",
      "title": "真实退出前置",
      "trigger": "考虑二次联系之前",
      "acceptance": "已进入真实退货或退出路径，不虚构已退",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-160",
      "wp": "W13",
      "title": "冷却提醒",
      "trigger": "对方未提留货且仍可协商",
      "acceptance": "可提示冷却后重算，不能固定等十五分钟",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-161",
      "wp": "W13",
      "title": "参考十五至六十分钟范围",
      "trigger": "解释培训冷却安排",
      "acceptance": "明确为参考，实际随物流情绪期限调整",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-162",
      "wp": "W13",
      "title": "平台时限优先",
      "trigger": "冷却期间临近平台截止",
      "acceptance": "先处理平台必要动作，不无限等待",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-163",
      "wp": "W13",
      "title": "原采购成本输入",
      "trigger": "内部复算留货价值",
      "acceptance": "成本有订单或估值依据，实付未证实时待核",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-164",
      "wp": "W13",
      "title": "瑕疵折损与整备成本",
      "trigger": "实物影响已可估计",
      "acceptance": "两项口径及依据分别说明",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-165",
      "wp": "W13",
      "title": "预期销售与风险估值",
      "trigger": "计算留货净收益",
      "acceptance": "区分估值和实际收入并标不确定性",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-166",
      "wp": "W13",
      "title": "退货和替代货源成本",
      "trigger": "计算退货重买方案",
      "acceptance": "包括真实可用替代来源及相关成本",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-167",
      "wp": "W13",
      "title": "相同评价范围比较两条路径",
      "trigger": "将留货和重买作决策",
      "acceptance": "不重复计算相同成本，不混用不同时间口径",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-168",
      "wp": "W13",
      "title": "留货更优才二次联系",
      "trigger": "有效复算显示留货有价值",
      "acceptance": "留货不更优或未计算时不能建议回拨",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-169",
      "wp": "W13",
      "title": "A 首锚 B 目标 C 底线分开",
      "trigger": "形成补差方案时配置金额",
      "acceptance": "三个金额独立并有授权边界",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "规则决策",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-170",
      "wp": "W13",
      "title": "金额变化必须重算",
      "trigger": "员工修改Plan B输入后继续",
      "acceptance": "旧计算结果不得直接推进二次联系",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-171",
      "wp": "W13",
      "title": "条件交换与递减让步",
      "trigger": "再次协商存在让价空间",
      "acceptance": "记录双方条件，不一次跳穿最低底线",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "P02",
        "P03:三",
        "P05:17"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-172",
      "wp": "W13",
      "title": "协商失败继续退",
      "trigger": "对方拒绝合适方案或低于底线",
      "acceptance": "回到原退货路径并保留记录",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "P03:四",
        "P05:30"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-173",
      "wp": "W13",
      "title": "记录回拨耗时与结果",
      "trigger": "二次联系结束时回传",
      "acceptance": "能比较首轮退出和二次恢复的真实收益",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购负责人及计算后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "P05:32"
      ],
      "route": "#/aftersales"
    },
    {
      "id": "PC-174",
      "wp": "W14",
      "title": "样本微信成交金额850",
      "trigger": "回放用户确认的真实案例",
      "acceptance": "将850标为用户确认金额，区别截图单方提议",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购及财务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U094",
        "U098",
        "U072"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-175",
      "wp": "W14",
      "title": "样本财务待转款",
      "trigger": "本案例尚无付款回执",
      "acceptance": "状态保持待财务，不显示已支付",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购及财务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U094",
        "U098",
        "U072"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-176",
      "wp": "W14",
      "title": "微信约定记录入口",
      "trigger": "线下电话微信达成新条件",
      "acceptance": "录入金额来源日期及可用凭证",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购及财务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U094",
        "U098",
        "U072"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-177",
      "wp": "W14",
      "title": "实际收款信息核验",
      "trigger": "财务准备处理转款",
      "acceptance": "由授权财务流程核对收款方与金额",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购及财务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U094",
        "F10"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-178",
      "wp": "W14",
      "title": "财务申请与实际支付分离",
      "trigger": "采购将条件交财务",
      "acceptance": "待转款状态不等同已转账",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购及财务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U094",
        "U098",
        "U072"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-179",
      "wp": "W14",
      "title": "财务待办提交回执",
      "trigger": "向实际财务系统提交申请",
      "acceptance": "成功失败或待确认有真实回执",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购及财务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U094",
        "U098",
        "U072"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-180",
      "wp": "W14",
      "title": "转款凭证填写校验",
      "trigger": "员工尝试记录已付款",
      "acceptance": "无凭证说明不得推进本地演示状态",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购及财务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U094",
        "U098",
        "U072"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-181",
      "wp": "W14",
      "title": "付款凭证真实性核对",
      "trigger": "要确认实际支付",
      "acceptance": "凭证来自财务或授权系统，非只填任意文字",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购及财务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U094",
        "U098",
        "U072"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-182",
      "wp": "W14",
      "title": "原路退款与新转款分账",
      "trigger": "样本平台退款后微信成交",
      "acceptance": "原退款金额与新850支付独立，不互相推算",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购及财务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U094",
        "U098",
        "U072"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-183",
      "wp": "W14",
      "title": "约定金额与实际支付对账",
      "trigger": "财务回执到来",
      "acceptance": "差额或币种不符保持待核",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购及财务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U094",
        "U098",
        "U072"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-184",
      "wp": "W14",
      "title": "商品去向后置核对",
      "trigger": "资金处理后准备结案",
      "acceptance": "留货入库或退回均有实际去向",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "采购及财务",
      "type": "功能或业务控制",
      "source_kind": "用户目标拆解",
      "refs": [
        "U094",
        "U098",
        "U072"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-185",
      "wp": "W14",
      "title": "财务隐私可见范围",
      "trigger": "展示转款和收款材料",
      "acceptance": "采购和财务按业务权限查必要信息",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购及财务",
      "type": "技术支撑",
      "source_kind": "技术建议",
      "refs": [
        "H1"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-186",
      "wp": "W15",
      "title": "OA触发阈值决策",
      "trigger": "普通降级或严重破损发生",
      "acceptance": "明确何种损失事件需发OA，非所有降级都触发",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购主管与业务后端",
      "type": "规则决策",
      "source_kind": "培训转化候选",
      "refs": [
        "F06",
        "F07",
        "F09:12",
        "F09:13",
        "F09"
      ],
      "route": "#/today"
    },
    {
      "id": "PC-187",
      "wp": "W15",
      "title": "同一案件工单去重",
      "trigger": "仓检售后多方同时报异常",
      "acceptance": "同一订单案件不重复创建无关工单",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购主管与业务后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "F06",
        "F07",
        "F09:12",
        "F09:13"
      ],
      "route": "#/today"
    },
    {
      "id": "PC-188",
      "wp": "W15",
      "title": "工单责任人与协作角色",
      "trigger": "任务触发后分派",
      "acceptance": "能辨责任岗位及当前处理人",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购主管与业务后端",
      "type": "规则决策",
      "source_kind": "培训转化候选",
      "refs": [
        "F06",
        "F07",
        "F09:12",
        "F09:13"
      ],
      "route": "#/today"
    },
    {
      "id": "PC-189",
      "wp": "W15",
      "title": "采购仓管交接时效",
      "trigger": "仓检完成后提交采购",
      "acceptance": "记录交接时间和待办接收情况",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购主管与业务后端",
      "type": "规则决策",
      "source_kind": "培训转化候选",
      "refs": [
        "F06",
        "F07",
        "F09:12",
        "F09:13"
      ],
      "route": "#/today"
    },
    {
      "id": "PC-190",
      "wp": "W15",
      "title": "二十二点清零口径核定",
      "trigger": "应用旧日清制度前",
      "acceptance": "明确起点适用范围及未完成如何升级",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购主管与业务后端",
      "type": "规则决策",
      "source_kind": "培训转化候选",
      "refs": [
        "F06",
        "F07",
        "F09:12",
        "F09:13"
      ],
      "route": "#/today"
    },
    {
      "id": "PC-191",
      "wp": "W15",
      "title": "次日二十四点闭环核定",
      "trigger": "应用仓管采购时效制度前",
      "acceptance": "与二十二点制度关系清楚，不双重误罚",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购主管与业务后端",
      "type": "规则决策",
      "source_kind": "培训转化候选",
      "refs": [
        "F06",
        "F07",
        "F09:12",
        "F09:13"
      ],
      "route": "#/today"
    },
    {
      "id": "PC-192",
      "wp": "W15",
      "title": "当天发走的完成定义",
      "trigger": "严重异常需当天退回时",
      "acceptance": "明确申请运单交快递或首扫哪个算完成",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购主管与业务后端",
      "type": "规则决策",
      "source_kind": "培训转化候选",
      "refs": [
        "F06",
        "F07",
        "F09:12",
        "F09:13",
        "F09"
      ],
      "route": "#/today"
    },
    {
      "id": "PC-193",
      "wp": "W15",
      "title": "停揽节假日晚间例外",
      "trigger": "临近截止但无法真实发货",
      "acceptance": "记录客观阻塞和升级，不伪造已发出",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购主管与业务后端",
      "type": "规则决策",
      "source_kind": "培训转化候选",
      "refs": [
        "F06",
        "F07",
        "F09:12",
        "F09:13"
      ],
      "route": "#/today"
    },
    {
      "id": "PC-194",
      "wp": "W15",
      "title": "卖家无地址或平台未批准",
      "trigger": "退货受外部条件阻塞",
      "acceptance": "保留待处理和升级记录，勿强制关单",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购主管与业务后端",
      "type": "规则决策",
      "source_kind": "培训转化候选",
      "refs": [
        "F06",
        "F07",
        "F09:12",
        "F09:13"
      ],
      "route": "#/today"
    },
    {
      "id": "PC-195",
      "wp": "W15",
      "title": "推进凭证与关闭凭证分级",
      "trigger": "工单达到某一节点",
      "acceptance": "区分必须推进必须结案和可选证据",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购主管与业务后端",
      "type": "规则决策",
      "source_kind": "培训转化候选",
      "refs": [
        "F06",
        "F07",
        "F09:12",
        "F09:13",
        "F09"
      ],
      "route": "#/today"
    },
    {
      "id": "PC-196",
      "wp": "W15",
      "title": "逾期升级提醒",
      "trigger": "实际截止已到且未闭环",
      "acceptance": "提示负责人并保存未完成原因",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购主管与业务后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "F06",
        "F07",
        "F09:12",
        "F09:13"
      ],
      "route": "#/today"
    },
    {
      "id": "PC-197",
      "wp": "W15",
      "title": "状态追踪和交接记录",
      "trigger": "负责人变更或跨班次",
      "acceptance": "下一人可见前情和待补事项",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "采购主管与业务后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "F06",
        "F07",
        "F09:12",
        "F09:13"
      ],
      "route": "#/today"
    },
    {
      "id": "PC-198",
      "wp": "W16",
      "title": "预计确认发放分状态",
      "trigger": "展示收益时区分统计阶段",
      "acceptance": "三种状态分别展示，不直接相加",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "财务规则负责人和后端",
      "type": "功能或业务控制",
      "source_kind": "待确认决策",
      "refs": [
        "D9",
        "U031",
        "U065",
        "F01",
        "F02"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-199",
      "wp": "W16",
      "title": "当前会话潜在收益",
      "trigger": "尚未成交时展示若成交增加",
      "acceptance": "不提前计入有效成交累计",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "财务规则负责人和后端",
      "type": "功能或业务控制",
      "source_kind": "待确认决策",
      "refs": [
        "D9",
        "U031",
        "U065",
        "F01",
        "F02"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-200",
      "wp": "W16",
      "title": "成交后一次计入预计",
      "trigger": "收到真实成交事件",
      "acceptance": "重复回执不重复加收益",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "财务规则负责人和后端",
      "type": "功能或业务控制",
      "source_kind": "待确认决策",
      "refs": [
        "D9",
        "U031",
        "U065",
        "F01",
        "F02"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-201",
      "wp": "W16",
      "title": "到货前后两段基数",
      "trigger": "讨论10%加10%示例",
      "acceptance": "先确定各段基数，不能直接变统一20%",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "财务规则负责人和后端",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "D9",
        "U031",
        "U065",
        "F01",
        "F02"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-202",
      "wp": "W16",
      "title": "节省金额与行情差基数冲突",
      "trigger": "采纳培训20%方案前",
      "acceptance": "业务选定公式来源与适用范围",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "财务规则负责人和后端",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "D9",
        "U031",
        "U065",
        "F01",
        "F02"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-203",
      "wp": "W16",
      "title": "实际返款后确认追加",
      "trigger": "到货协商补差落账",
      "acceptance": "无真实到账依据保持预计",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "财务规则负责人和后端",
      "type": "功能或业务控制",
      "source_kind": "待确认决策",
      "refs": [
        "D9",
        "U031",
        "U065",
        "F01",
        "F02"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-204",
      "wp": "W16",
      "title": "退款取消时收益撤销",
      "trigger": "原单取消或返款撤销",
      "acceptance": "有反向事件和原因，不删历史掩盖变更",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "财务规则负责人和后端",
      "type": "功能或业务控制",
      "source_kind": "待确认决策",
      "refs": [
        "D9",
        "U031",
        "U065",
        "F01",
        "F02"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-205",
      "wp": "W16",
      "title": "运费和负价差口径",
      "trigger": "计算净价与提成之前",
      "acceptance": "明确运费归集、负价差如何处理",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "财务规则负责人和后端",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "D9",
        "U031",
        "U065",
        "F01",
        "F02"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-206",
      "wp": "W16",
      "title": "每日目标与还差金额",
      "trigger": "查看收益Dock",
      "acceptance": "目标可配置，演示1000不视为正式指标",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "财务规则负责人和后端",
      "type": "功能或业务控制",
      "source_kind": "待确认决策",
      "refs": [
        "D9",
        "U031",
        "U065",
        "F01",
        "F02"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-207",
      "wp": "W16",
      "title": "议价净收益指标",
      "trigger": "衡量议价结果时对比方案",
      "acceptance": "包含真实利润成本风险，非只比砍价额",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P0",
      "role": "财务规则负责人和后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "P04:KPI",
        "P05:32"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-208",
      "wp": "W16",
      "title": "长期供应商结果复盘",
      "trigger": "同卖家多次采购后评估",
      "acceptance": "关注复购和纠纷，避免只压最后小额价差",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P0",
      "role": "财务规则负责人和后端",
      "type": "功能或业务控制",
      "source_kind": "培训转化候选",
      "refs": [
        "P04:Subjective Value"
      ],
      "route": "#/finance"
    },
    {
      "id": "PC-209",
      "wp": "W17",
      "title": "定义S至E客观判级标准",
      "trigger": "准备让仓管或AI统一判级",
      "acceptance": "每级有可拍照可复核条件，未定内容不自行补值",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-210",
      "wp": "W17",
      "title": "按品类确定判级维度",
      "trigger": "显示器手机相机等不同商品",
      "acceptance": "明确共用标准或各品类独立标准",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-211",
      "wp": "W17",
      "title": "外观与功能冲突优先级",
      "trigger": "外观好但功能坏等组合",
      "acceptance": "确定各维度和最终处置关系",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-212",
      "wp": "W17",
      "title": "价格基准选择",
      "trigger": "计算保留价或退款目标",
      "acceptance": "明确原采购市场成色或售价倒推哪个为基准",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-213",
      "wp": "W17",
      "title": "折扣与退款比例消歧",
      "trigger": "规则出现打五折等表述",
      "acceptance": "确定最终保留比例与退款比例数学定义",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-214",
      "wp": "W17",
      "title": "声明实际六乘六矩阵",
      "trigger": "给出完整等级偏差处理",
      "acceptance": "36格有依据或待定，不能猜未确认格",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-215",
      "wp": "W17",
      "title": "降级线性与非线性决策",
      "trigger": "制定等级价格曲线",
      "acceptance": "折损是否逐级固定扣点有明确结论",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-216",
      "wp": "W17",
      "title": "固定缺件扣价规则",
      "trigger": "缺电源支架遥控等配件",
      "acceptance": "明确独立扣价或等级变化且不重复扣",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-217",
      "wp": "W17",
      "title": "配件完整度独立规则",
      "trigger": "外观A但缺重要配件",
      "acceptance": "能决定保持等级扣价还是退货待核",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-218",
      "wp": "W17",
      "title": "维修成本与退货阈值",
      "trigger": "修复费用和周期影响价值",
      "acceptance": "低修高修未知修分别有处理规则",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-219",
      "wp": "W17",
      "title": "必须退货条件表",
      "trigger": "出现屏碎进水型号不符等问题",
      "acceptance": "逐项明确强制退可议价留货或人工核对",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09:11",
        "F10"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-220",
      "wp": "W17",
      "title": "非标准卖家描述归一",
      "trigger": "99新成色如图等用语",
      "acceptance": "确定可映射等级或仅保存原始声明",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-221",
      "wp": "W17",
      "title": "图片文字冲突处理",
      "trigger": "文字承诺和照片表现不同",
      "acceptance": "已知披露与风险复核规则明确，不隐瞒已知瑕疵",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-222",
      "wp": "W17",
      "title": "仓管AI主管判级权限",
      "trigger": "不同角色结论不一致",
      "acceptance": "复核权限高金额例外和升级路径明确",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-223",
      "wp": "W17",
      "title": "价格建议与自动权限边界",
      "trigger": "系统输出折扣目标或底线",
      "acceptance": "明确仅建议还是可自动执行及审批门槛",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-224",
      "wp": "W17",
      "title": "卖家差异系数决策",
      "trigger": "拟按响应赔付等历史调价",
      "acceptance": "确认V1是否需要，不擅自加卖家折扣系数",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-225",
      "wp": "W17",
      "title": "金额档位差异决策",
      "trigger": "低价高价订单采用同一规则",
      "acceptance": "确定最低金额和主管介入阈值",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-226",
      "wp": "W17",
      "title": "责任归属分类",
      "trigger": "发生卖家物流仓库采购等问题",
      "acceptance": "允许未知，不将仓损归为卖家隐瞒",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-227",
      "wp": "W17",
      "title": "最终保留价公式因子",
      "trigger": "把折损维修和风险写入算法",
      "acceptance": "逐项确认存在性与基数，示例不自动生效",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-228",
      "wp": "W17",
      "title": "溢价比例字段消歧",
      "trigger": "规则出现premium等模糊词",
      "acceptance": "指代成色市场或采购溢价必须明确命名",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-229",
      "wp": "W17",
      "title": "市场等级价差是否入模",
      "trigger": "拟引入真实市场Grade Spread",
      "acceptance": "样本清洗政策覆盖关系与例外明确",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-230",
      "wp": "W17",
      "title": "规则版本与生效时点",
      "trigger": "新规则发布或回看旧单",
      "acceptance": "按下单验收何时锁版及是否回算有结论",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P0",
      "role": "采购规则负责人",
      "type": "规则决策",
      "source_kind": "待确认决策",
      "refs": [
        "F09"
      ],
      "route": "#/pricebook"
    },
    {
      "id": "PC-231",
      "wp": "W18",
      "title": "培训规则映射程序节点",
      "trigger": "吸收16篇资料时提炼动作",
      "acceptance": "每条规则对应节点来源及适用范围",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-232",
      "wp": "W18",
      "title": "嵌入式提醒与提交页面",
      "trigger": "员工走到业务节点",
      "acceptance": "显示现在看什么做什么及留下何种记录",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "用户目标拆解",
      "refs": [
        "U085",
        "U094"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-233",
      "wp": "W18",
      "title": "内部准备卡",
      "trigger": "议价或回拨前准备事实",
      "acceptance": "原描述证据成本A/B/C和替代方案齐备",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "F00:L98",
        "P04:采购电话状态机",
        "P05:30"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-234",
      "wp": "W18",
      "title": "差异陈述卡",
      "trigger": "开始异常沟通时陈述事实",
      "acceptance": "能引用承诺X和实物Y，不编造缺陷",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "F00:L98",
        "P04:采购电话状态机",
        "P05:30"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-235",
      "wp": "W18",
      "title": "价格重置卡",
      "trigger": "原交付条件明显改变",
      "acceptance": "表达原价不接受的依据而非辱骂",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "F00:L98",
        "P04:采购电话状态机",
        "P05:30"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-236",
      "wp": "W18",
      "title": "实际影响提示卡",
      "trigger": "说明瑕疵影响使用或转售",
      "acceptance": "场景和影响真实可解释",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "F00:L98",
        "P04:采购电话状态机",
        "P05:30"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-237",
      "wp": "W18",
      "title": "替代方案提示卡",
      "trigger": "准备退出或比较成本",
      "acceptance": "替代货源和物流状态真实存在",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "F00:L98",
        "P04:采购电话状态机",
        "P05:30"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-238",
      "wp": "W18",
      "title": "补差方案与首锚卡",
      "trigger": "有证据和测算后提出方案",
      "acceptance": "首锚对应事实成本和授权边界",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "F00:L98",
        "P04:采购电话状态机",
        "P05:30"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-239",
      "wp": "W18",
      "title": "报完数字后的等待卡",
      "trigger": "对方尚未回应报价",
      "acceptance": "不连续自我降价，等待时限按场景配置",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "F00:L98",
        "P04:采购电话状态机",
        "P05:30"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-240",
      "wp": "W18",
      "title": "对方回应诊断卡",
      "trigger": "收到接受反价辩解拖延等回应",
      "acceptance": "推荐下一动作并保留依据",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "F00:L98",
        "P04:采购电话状态机",
        "P05:30"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-241",
      "wp": "W18",
      "title": "条件让步与退出卡",
      "trigger": "对方还价达到边界",
      "acceptance": "不跳穿底线，谈不成能继续真实退货",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "F00:L98",
        "P04:采购电话状态机",
        "P05:30"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-242",
      "wp": "W18",
      "title": "二次恢复窗口卡",
      "trigger": "冷却复算仍值得留货",
      "acceptance": "建议一至两句基于事实的恢复成交话术",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "U085",
        "F00:L98",
        "P04:采购电话状态机",
        "P05:30"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-243",
      "wp": "W18",
      "title": "培训完成与实操验收分离",
      "trigger": "员工学习手册后考核",
      "acceptance": "有实际任务证据，不只勾已学习",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "F00:L115"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-244",
      "wp": "W18",
      "title": "培训版本与变更留存",
      "trigger": "流程工具规则变化",
      "acceptance": "保留生效版负责人变更原因和历史",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "F00:L126"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-245",
      "wp": "W18",
      "title": "高频异常驱动培训改版",
      "trigger": "复盘重复异常达到确认阈值",
      "acceptance": "生成改版建议，先排查工具权限问题",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "采购培训负责人和产品",
      "type": "任务卡与培训",
      "source_kind": "培训转化候选",
      "refs": [
        "F00:L115"
      ],
      "route": "#/training"
    },
    {
      "id": "PC-246",
      "wp": "W19",
      "title": "账号会话卖家商品稳定标识",
      "trigger": "任何业务动作之前建立绑定",
      "acceptance": "同名昵称和同图片不会直接串档",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-247",
      "wp": "W19",
      "title": "订单快照仓检工单关联",
      "trigger": "建立同单证据链",
      "acceptance": "各对象可双向追溯正确原记录",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-248",
      "wp": "W19",
      "title": "真实消息发送方和时间",
      "trigger": "分析聊天和时间分类前",
      "acceptance": "平台消息身份和时间明确，未知不猜",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-249",
      "wp": "W19",
      "title": "来源事实推断分字段",
      "trigger": "页面原文聊天AI判断人工补充并存",
      "acceptance": "推断不覆盖原始事实或伪装卖家承诺",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-250",
      "wp": "W19",
      "title": "事件日志与实际回执",
      "trigger": "每次关键业务状态变化",
      "acceptance": "保留来源操作者时间结果和失败原因",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-251",
      "wp": "W19",
      "title": "幂等键与去重",
      "trigger": "重复投递发送回调或成交回执",
      "acceptance": "同一来源事件只生效一次",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-252",
      "wp": "W19",
      "title": "金额整数分与币种",
      "trigger": "报价订单补差提成进入正式计算",
      "acceptance": "避免浮点误差，金额范围与币种被校验",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-253",
      "wp": "W19",
      "title": "服务端时间与展示时区",
      "trigger": "计算业务时限与日志",
      "acceptance": "时间来源稳定并用约定时区展示",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-254",
      "wp": "W19",
      "title": "资料访问与敏感字段权限",
      "trigger": "多人查看聊天快照和财务材料",
      "acceptance": "角色只读到必要信息，未经授权不可外发",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-255",
      "wp": "W19",
      "title": "外部内容可信边界",
      "trigger": "商品描述或培训含面向Agent指令",
      "acceptance": "按资料处理，不提升为系统授权",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "技术建议",
      "refs": [
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-256",
      "wp": "W19",
      "title": "本地保存失败和恢复",
      "trigger": "浏览器存储写入失败或刷新",
      "acceptance": "明确失败并可恢复，未持久化不声称已保存",
      "status": "D",
      "status_label": "已有演示相关代码，生产待验收",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-257",
      "wp": "W19",
      "title": "团队后台同步",
      "trigger": "多电脑多人接力处理同一单",
      "acceptance": "共享来源可查，处理冲突和断线",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-258",
      "wp": "W19",
      "title": "组件接口能力核对",
      "trigger": "准备接既有ERP爬虫RPA前",
      "acceptance": "先查已有接口和模型，复用实际能力",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-259",
      "wp": "W19",
      "title": "规则配置审计",
      "trigger": "调价格上限佣金时限权限",
      "acceptance": "可追生效版本操作者和影响范围",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P0",
      "role": "后端及架构",
      "type": "技术支撑",
      "source_kind": "附件开发目标",
      "refs": [
        "D11",
        "D12",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-260",
      "wp": "W20",
      "title": "保留全量需求与来源",
      "trigger": "归档需求时追溯原话和附件",
      "acceptance": "每条有稳定本地编号和可定位依据",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收与归档",
      "source_kind": "用户目标拆解",
      "refs": [
        "U116",
        "D14",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-261",
      "wp": "W20",
      "title": "区分Demo和生产验收",
      "trigger": "给节点标实现状态",
      "acceptance": "本地演示或测试通过不写成业务上线完成",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收约束",
      "source_kind": "用户目标拆解",
      "refs": [
        "U116",
        "D14",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-262",
      "wp": "W20",
      "title": "AdsPower真实页面验收",
      "trigger": "修改原生UI或商品采集后",
      "acceptance": "在指定环境看到实际结果并记录版本",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收约束",
      "source_kind": "用户目标拆解",
      "refs": [
        "U116",
        "D14",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-263",
      "wp": "W20",
      "title": "会话图片布局回归",
      "trigger": "列表文字长窗口窄时测试",
      "acceptance": "缩略图完整且原生会话可点开",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收约束",
      "source_kind": "用户目标拆解",
      "refs": [
        "U116",
        "D14",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-264",
      "wp": "W20",
      "title": "商品快照多图回归",
      "trigger": "采集后切换商品再打开弹窗",
      "acceptance": "首份保存大图切换和上下文隔离通过",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收约束",
      "source_kind": "用户目标拆解",
      "refs": [
        "U116",
        "D14",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-265",
      "wp": "W20",
      "title": "业务工作流回归",
      "trigger": "按留货与退货两条路径操作",
      "acceptance": "关键前置条件和凭证门槛被覆盖",
      "status": "V",
      "status_label": "已有代码或夹具验证，实机待验收",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收约束",
      "source_kind": "用户目标拆解",
      "refs": [
        "U116",
        "D14",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-266",
      "wp": "W20",
      "title": "真实接口联调验收",
      "trigger": "后台及平台功能接入后",
      "acceptance": "从发现至订单验货售后财务有完整测试回执",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收约束",
      "source_kind": "用户目标拆解",
      "refs": [
        "U116",
        "D14",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-267",
      "wp": "W20",
      "title": "业务容量与故障验收",
      "trigger": "准备上线高频采购前",
      "acceptance": "给出并发延迟成功率与失败恢复记录",
      "status": "U",
      "status_label": "真实链路未接入或待开发",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收约束",
      "source_kind": "附件开发目标",
      "refs": [
        "D12",
        "D14"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-268",
      "wp": "W20",
      "title": "交付源码和安装说明",
      "trigger": "准备技术交接ZIP",
      "acceptance": "含manifest入口依赖版本部署位置和风险",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收与归档",
      "source_kind": "用户目标拆解",
      "refs": [
        "U116",
        "D14",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-269",
      "wp": "W20",
      "title": "交付业务技术逻辑",
      "trigger": "业务和程序员接手时查看",
      "acceptance": "流程触发角色输入输出验收及状态齐全",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收与归档",
      "source_kind": "用户目标拆解",
      "refs": [
        "U116",
        "D14",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-270",
      "wp": "W20",
      "title": "交付本次公开对话记录",
      "trigger": "打包需求来源时保存对话",
      "acceptance": "原话与助手推断可区分，不冒充内部推理导出",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收与归档",
      "source_kind": "用户目标拆解",
      "refs": [
        "U116",
        "D14",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-271",
      "wp": "W20",
      "title": "原始材料和失效说明",
      "trigger": "材料临时路径已失效时交接",
      "acceptance": "保存已解压正文原图及可证实恢复范围",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收与归档",
      "source_kind": "用户目标拆解",
      "refs": [
        "U116",
        "D14",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-272",
      "wp": "W20",
      "title": "归档结构和负责人待定",
      "trigger": "准备Teambition任务草案",
      "acceptance": "建议岗位不冒充实际负责人，不虚构项目ID",
      "status": "Q",
      "status_label": "规则或范围待确认",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "规则决策",
      "source_kind": "用户目标拆解",
      "refs": [
        "U116",
        "D14",
        "H1"
      ],
      "route": "#/readiness"
    },
    {
      "id": "PC-273",
      "wp": "W20",
      "title": "本轮只出审阅报告",
      "trigger": "用户尚未授权本轮写入",
      "acceptance": "不创建修改任务列表附件评论或权限",
      "status": "L",
      "status_label": "已有文档或样例依据，非生产完成",
      "priority": "P1",
      "role": "产品负责人及测试交付",
      "type": "验收约束",
      "source_kind": "用户目标拆解",
      "refs": [
        "U-CURRENT"
      ],
      "route": "#/readiness"
    }
  ],
  "cross_cards": [
    {
      "id": 71,
      "code": "G01",
      "project": 3,
      "title": "[G01] 采购计划、额度预占与经营反馈",
      "url": "http://127.0.0.1:8000",
      "requirements": [
        "G01-01",
        "G01-02",
        "G01-03",
        "G01-04"
      ],
      "route": "#/today",
      "verified": true
    },
    {
      "id": 80,
      "code": "G05",
      "project": 3,
      "title": "[G05] 跨岗位时限、外部等待与交接接管",
      "url": "http://127.0.0.1:8000",
      "requirements": [
        "G05-01",
        "G05-02",
        "G05-03",
        "G05-04"
      ],
      "route": "#/aftersales",
      "verified": true
    },
    {
      "id": 81,
      "code": "G06",
      "project": 3,
      "title": "[G06] 全成本归集、逐笔对账与跨期调整",
      "url": "http://127.0.0.1:8000",
      "requirements": [
        "G06-01",
        "G06-02",
        "G06-03",
        "G06-04"
      ],
      "route": "#/finance",
      "verified": true
    },
    {
      "id": 84,
      "code": "G09",
      "project": 3,
      "title": "[G09] 跨台变更、撤销及部分履约的补救",
      "url": "http://127.0.0.1:8000",
      "requirements": [
        "G09-01",
        "G09-02",
        "G09-03",
        "G09-04"
      ],
      "route": "#/aftersales",
      "verified": true
    },
    {
      "id": 86,
      "code": "G11",
      "project": 3,
      "title": "[G11] 主数据与规则变更后的影响复核",
      "url": "http://127.0.0.1:8000",
      "requirements": [
        "G11-01",
        "G11-02",
        "G11-03",
        "G11-04"
      ],
      "route": "#/pricebook",
      "verified": true
    }
  ],
  "w10_rpa_cases": [
    {
      "id": "W10-01",
      "title": "闲鱼自动下单回填不全（缺实付/地址/物流）",
      "route": "#/orders",
      "status": "UI演示已闭环",
      "rule": "按异常待补入库，标记字段缺失清单，禁止直接推已核对"
    },
    {
      "id": "W10-02",
      "title": "人工已建PO与RPA自动抓单撞车去重合并",
      "route": "#/orders",
      "status": "UI演示已闭环",
      "rule": "以平台external_order_no幂等合并，提示冲突字段由人工确认合并"
    },
    {
      "id": "W10-03",
      "title": "老订单列表未刷新漏单（回补+游标恢复）",
      "route": "#/orders",
      "status": "UI演示已闭环",
      "rule": "支持按游标回补窗口拉取历史遗漏单并保留回补审计日志"
    },
    {
      "id": "W10-04",
      "title": "拍下未付款即取消订单（释放预算配额）",
      "route": "#/orders",
      "status": "UI演示已闭环",
      "rule": "取消后立即释放G01预算预占与在手上限，不触发财务打款"
    },
    {
      "id": "W10-05",
      "title": "付款后未发货前取消订单（跟踪平台退款）",
      "route": "#/orders",
      "status": "UI演示已闭环",
      "rule": "保留实付记录并生成退款待确认单，到账前不冲抵净成本"
    },
    {
      "id": "W10-06",
      "title": "已发货后取消订单（物流拦截协同）",
      "route": "#/orders",
      "status": "UI演示已闭环",
      "rule": "触发仓管协同拦截任务，拦截确认前严禁恢复可售库存"
    },
    {
      "id": "W10-07",
      "title": "乱序迟到回调（旧状态晚于新状态到达）",
      "route": "#/orders",
      "status": "UI演示已闭环",
      "rule": "校验event_seq与occurred_at，晚到旧事件记为ignored不回退终态"
    },
    {
      "id": "W10-08",
      "title": "重复Webhook回调幂等防护",
      "route": "#/orders",
      "status": "UI演示已闭环",
      "rule": "基于idempotency_key拦截重复写入，返回首次处理结果"
    }
  ]
};
