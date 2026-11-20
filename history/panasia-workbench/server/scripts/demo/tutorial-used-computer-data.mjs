// server/scripts/demo/tutorial-used-computer-data.mjs — 《二手电脑上架》教程内容
// 场景：公司有时候有闲置/二手电脑要卖。卖电脑需要配置单，流程涉及图吧工具箱硬件识别、
// AI（豆包/ChatGPT/Gemini 均可）生成配置单、拼多多详情页模板参考、电源机箱人工补充、闲鱼上架，
// 并衍生思考「普通商品 vs 闲置资产」的展示策略差异。

export const PROJECT = {
  name: '二手电脑上架',
  code: 'used-computer-resale',
  description:
    '公司闲置/二手电脑上架闲鱼全流程：图吧工具箱硬件识别 → AI 生成配置单 → 拼多多详情页模板参考改写 → 电源机箱人工补充（必须具体到品牌型号）→ 闲鱼上架 → 普通商品与闲置资产展示策略思考。',
  status: 'published',
  sort: 4,
};

export const STAGES = [
  {
    title: 'P0 配置单制作（图吧工具箱 + AI 辅助）',
    description:
      '图吧工具箱识别硬件配置，AI 辅助生成配置单，参考拼多多详情页模板改写为标准格式。图吧工具箱识别不到电源与机箱型号，需人工查询补充。',
    duration_note: '半天内完成',
    steps: [
      {
        title: '图吧工具箱硬件识别与首页截图',
        guide:
          '1. 在要出售的电脑上，让 agent（豆包、ChatGPT、Gemini 任选其一）提供图吧工具箱的官方下载地址，下载安装后打开；\n' +
          '2. 图吧工具箱首页会自动识别并显示电脑全部硬件信息：CPU、主板、内存、硬盘、显卡、显示器、声卡、网卡等；\n' +
          '3. 对图吧工具箱首页的硬件概览进行完整截图，确保所有硬件条目清晰可读；\n' +
          '4. 将截图作为本步骤材料提交。',
        warn_text:
          '图吧工具箱识别不到电源和机箱的具体型号，这两项需要在 P0 最后一步人工查询补充。图吧工具箱只是第一步的硬件信息来源。',
        deliver_note: '图吧工具箱首页截图已提交',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'tubatu_screenshot',
            label: '图吧工具箱首页截图',
            input_type: 'image',
            required: true,
            help_text:
              '完整截取图吧工具箱首页，确保 CPU、主板、内存、硬盘、显卡等条目清晰可读',
          },
        ],
      },
      {
        title: 'AI 生成配置单初稿（要素要求：具体到品牌型号）',
        guide:
          '1. 将图吧工具箱首页截图发给 agent（豆包、ChatGPT、Gemini 均可），要求识别截图中的硬件配置并生成配置单；\n' +
          '2. 配置单要素要求——每个配件必须具体到「品牌 + 完整型号 + 规格」，不得泛泛而谈：\n' +
          '   - CPU：AMD 锐龙7 9800X3D（而非「9800X3D」）\n' +
          '   - 内存：芝奇皇家戟 DDR5 6000C28 16G×2（而非「32G 内存」）\n' +
          '   - 显卡：华硕 RTX 4070 SUPER 12G（而非「4070S」）\n' +
          '   - 硬盘：三星 990PRO 1T NVMe 固态（而非「1T 固态」）\n' +
          '   - 主板：华擎 X870E Taichi（而非「X870 主板」）\n' +
          '3. 人工核对 AI 生成的配置单：配件是否有遗漏（如双通道内存只识别一条）、型号是否与截图一致；\n' +
          '4. 将核对后的配置单初稿粘贴提交。',
        warn_text:
          'AI 从截图识别配置时可能漏识别或张冠李戴（比如双通道内存识别成单条），必须人工逐项核对后再提交。',
        deliver_note: 'AI 配置单初稿已提交',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'spec_draft',
            label: '配置单初稿',
            input_type: 'textarea',
            required: true,
            help_text:
              '粘贴 AI 识别生成的配置单初稿文本，每个配件必须具体到品牌+型号+规格',
          },
        ],
      },
      {
        title: '拼多多模板参考与配置单改写',
        guide:
          '1. 去拼多多搜索与要出售电脑配置相近的整机商品（如「9800x3d 主机」），找到 2-3 个配置接近的整机商品详情页；\n' +
          '2. 将拼多多商品详情页截图发给 agent，让 agent 参考详情页中配置单的排版模板（分区、顺序、描述风格）；\n' +
          '3. 让 agent 按照拼多多详情页的模板格式，把我们的配置单初稿改写成上架用的标准格式；\n' +
          '4. 同时记录拼多多同类整机的售价区间，作为后续定价参考；\n' +
          '5. 将拼多多参考商品截图与改写后的标准配置单一并提交。',
        warn_text:
          '拼多多详情页模板只是格式参考，配置内容必须以我们自己电脑的实际配置为准，不要把拼多多商品的配置抄进来。',
        deliver_note: '标准格式配置单已提交',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'pdd_reference',
            label: '拼多多参考商品截图',
            input_type: 'image',
            required: true,
            help_text:
              '拼多多同类整机商品详情页截图（2-3 张），配置与售价清晰可见',
          },
          {
            material_key: 'standard_spec',
            label: '改写后的标准配置单',
            input_type: 'textarea',
            required: true,
            help_text: '粘贴参考拼多多模板改写后的标准格式配置单',
          },
        ],
      },
      {
        title: '电源与机箱人工查询补充（配置单终稿）',
        guide:
          '1. 图吧工具箱无法识别电源和机箱的具体型号，需要人工查询补充；\n' +
          '2. 电源：拆开机箱侧板查看电源侧面铭牌，或查公司采购记录/电商订单，确认电源的品牌与完整型号（例如：利民 TG1000 1000W 金牌全模组）；\n' +
          '3. 机箱：查看机箱底部或背部的型号贴纸，或查采购记录（例如：acer 掠夺者 V333R）；\n' +
          '4. 将电源、机箱信息补入标准配置单，形成完整配置单终稿。配置单中电源、机箱必须与其他配件同样具体到「品牌+型号」，「电源 1000W」「机箱 白色」这类泛泛描述不合格；\n' +
          '5. 将完整配置单终稿提交，等待审核通过后方可上架。',
        warn_text:
          '电源与机箱「具体到品牌型号」是硬性要求，示例：利民 TG1000、acer V333R。配置单终稿经审核通过后方可进入上架环节。',
        deliver_note: '完整配置单终稿已提交，等待审核',
        require_confirm: false,
        require_review: true,
        materials: [
          {
            material_key: 'final_spec',
            label: '完整配置单终稿',
            input_type: 'textarea',
            required: true,
            help_text: '粘贴包含电源、机箱具体品牌型号的完整配置单终稿',
          },
        ],
      },
    ],
  },
  {
    title: 'P1 闲鱼上架',
    description:
      '拍摄实物照片，用审核通过的配置单生成商品文案，上架公司闲鱼矩阵账号。定价参考拼多多同类整机售价区间，结合二手折旧。',
    duration_note: '当天完成',
    steps: [
      {
        title: '闲鱼商品上架',
        guide:
          '1. 拍摄电脑实物照片：整机外观、内部构造、点亮状态截图，至少 4 张。闲置资产禁止使用官方图或网图，必须真实拍摄；\n' +
          '2. 生成闲鱼商品文案：标题突出核心配置（CPU 型号 + 显卡型号），正文粘贴完整配置单终稿，附成色说明与使用时长；\n' +
          '3. 参考拼多多同类整机售价区间，结合二手折旧（成色、使用年限）确定合理售价；\n' +
          '4. 上架到公司闲鱼矩阵账号（参考「闲鱼矩阵开店」教程的账号槽位分配，闲置资产建议用个人号上架以获得更多自然流量）；\n' +
          '5. 提交闲鱼商品链接与实物照片，等待审核。',
        warn_text:
          '二手电脑属于公司闲置资产处置，商品文案中的配置必须与配置单终稿完全一致，定价需经审核确认。',
        deliver_note: '闲鱼商品已上架，等待审核',
        require_confirm: false,
        require_review: true,
        materials: [
          {
            material_key: 'xianyu_url',
            label: '闲鱼商品链接',
            input_type: 'text',
            required: true,
            help_text: '粘贴闲鱼商品的完整链接',
          },
          {
            material_key: 'product_photos',
            label: '实物照片',
            input_type: 'image',
            required: true,
            help_text: '电脑实物照片（整机外观、内部、点亮状态），至少 4 张',
          },
        ],
      },
    ],
  },
  {
    title: 'P2 展示策略思考（衍生任务）',
    description:
      '上架完成后，思考并总结公司闲鱼矩阵中「普通商品」与「闲置资产」两类商品的展示策略差异，沉淀为后续闲置资产上架的展示规范。',
    duration_note: '当天完成',
    steps: [
      {
        title: '普通商品 vs 闲置资产展示策略思考',
        guide:
          '公司的闲鱼矩阵账号同时经营两类商品：\n' +
          '1. 普通商品：稳定货源、批量上架、可持续销售的新品；\n' +
          '2. 闲置资产：如本次处理的二手电脑，一次性、唯一性、处置性质。\n' +
          '\n' +
          '从以下维度思考两类商品的展示策略差异：\n' +
          '- 文案描述：普通商品强调「全新/标准参数/官方描述」；闲置资产强调「真实成色/使用记录/使用时长」；\n' +
          '- 定价策略：普通商品对标市场价与竞品；闲置资产参考二手行情并按成色折价，追求快速变现；\n' +
          '- 照片展示：普通商品可用官方产品图；闲置资产必须实物拍摄并展示细节（划痕、磨损、灰尘）；\n' +
          '- 售后承诺：普通商品可承诺质保退换；闲置资产明确「功能正常、售出不退」；\n' +
          '- 交易预期：普通商品追求利润与复购；闲置资产追求快速回笼资金。\n' +
          '\n' +
          '将思考总结提交，后续将作为公司闲鱼矩阵闲置资产上架的展示规范参考。',
        warn_text:
          '这不是形式化的作业，总结的展示策略将用于指导公司闲鱼矩阵账号后续所有闲置资产上架工作。',
        deliver_note: '展示策略思考总结已提交',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'strategy_summary',
            label: '展示策略思考总结',
            input_type: 'textarea',
            required: true,
            help_text:
              '从文案、定价、照片、售后、交易预期等维度总结普通商品与闲置资产的展示策略差异',
          },
        ],
      },
    ],
  },
];

export const CASE = {
  client_name: '公司闲置电脑处置',
  owner_user_id: '1871790158440555',
};
