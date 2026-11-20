// 场景自动发送的高清业务卡片图生成器（离线 SVG Data URI，聊天窗缩略+点击全屏高清查看）
// 1. 发货前自动发送：《官方保修激活确认卡（含杭州市富阳区人民法院管辖条款）》
// 2. 申请退款第一时间自动发送：《退款理由选择“不想要了/协商一致”真实手机UI三步操作引导图》
// 3. 签收提醒自动发送：《顺丰当面验机与售后保障卡》

function toUri(svg) {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg.trim());
}

export function makeWarrantyCardSvg({
  productName = '二手严选数码单品（一机一码）',
  skuCode = '990001549229-A',
  sn = 'B6P-CN-RJA8821A',
} = {}) {
  const safeName = productName.length > 26 ? productName.slice(0, 26) + '…' : productName;
  return toUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 470" width="720" height="470">
      <defs>
        <linearGradient id="whdr" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#1e3a8a"/>
          <stop offset="100%" stop-color="#2563eb"/>
        </linearGradient>
        <linearGradient id="wbtn" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#059669"/>
          <stop offset="100%" stop-color="#10b981"/>
        </linearGradient>
      </defs>

      <!-- 外框白卡 -->
      <rect x="4" y="4" width="712" height="462" rx="20" fill="#ffffff" stroke="#bfdbfe" stroke-width="3"/>

      <!-- 顶部蓝金盾牌横幅 -->
      <path d="M4 24 Q4 4 24 4 L696 4 Q716 4 716 24 L716 96 L4 96 Z" fill="url(#whdr)"/>
      <circle cx="52" cy="50" r="24" fill="#ffffff" fill-opacity="0.16"/>
      <text x="52" y="58" text-anchor="middle" fill="#fde047" font-size="24">🛡</text>
      <text x="88" y="45" fill="#ffffff" font-size="22" font-weight="900" font-family="sans-serif">店铺质保服务激活确认卡（发货前必读）</text>
      <text x="88" y="73" fill="#dbeafe" font-size="13.5" font-family="sans-serif">一机一码实拍核验 · 顺丰保价运输 · 回复「同意」即刻生效</text>

      <!-- 绑定机器信息栏 -->
      <rect x="28" y="114" width="664" height="62" rx="12" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1.5"/>
      <text x="46" y="140" fill="#0f172a" font-size="14.5" font-weight="800" font-family="sans-serif">核验商品：${safeName}</text>
      <text x="46" y="163" fill="#475569" font-size="13" font-family="monospace">仓库唯一码：${skuCode}   ｜   机身序列号(SN)：${sn}</text>

      <!-- 条款正文区 -->
      <text x="32" y="206" fill="#1e293b" font-size="14" font-weight="800" font-family="sans-serif">一、实拍与保修服务说明</text>
      <text x="32" y="230" fill="#475569" font-size="13" font-family="sans-serif">1. 上方发出的照片与测试视频即为本单发出的同一台实物，成色、划痕与配件均已如实展示。</text>
      <text x="32" y="252" fill="#475569" font-size="13" font-family="sans-serif">2. 激活后享本店质保服务（非人为损坏免费保修/协助官方联保；私拆封签或进水碎屏除外）。</text>

      <!-- 重点高亮：富阳法院管辖条款框 -->
      <rect x="28" y="272" width="664" height="98" rx="12" fill="#fffbeb" stroke="#f59e0b" stroke-width="2"/>
      <rect x="44" y="285" width="168" height="24" rx="6" fill="#d97706"/>
      <text x="128" y="302" text-anchor="middle" fill="#ffffff" font-size="12.5" font-weight="800" font-family="sans-serif">⚖️ 法律与争议管辖条款</text>
      <text x="44" y="331" fill="#78350f" font-size="14" font-weight="800" font-family="sans-serif">双方明确约定：因本订单交易、商品品质或售后服务产生的任何争议，</text>
      <text x="44" y="354" fill="#b45309" font-size="14.5" font-weight="900" font-family="sans-serif">协商不成的，任何一方均同意提交【杭州市富阳区人民法院】诉讼管辖。</text>

      <!-- 底部行动号召按钮图 -->
      <rect x="28" y="388" width="664" height="56" rx="14" fill="url(#wbtn)"/>
      <text x="360" y="422" text-anchor="middle" fill="#ffffff" font-size="17" font-weight="900" font-family="sans-serif">👉 核对实拍无异议，请直接回复【同意】激活保修并安排发货</text>
    </svg>
  `);
}

export function makeRefundGuideUiSvg() {
  return toUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 820 500" width="820" height="500">
      <defs>
        <linearGradient id="rhdr" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#ea580c"/>
          <stop offset="100%" stop-color="#f97316"/>
        </linearGradient>
      </defs>

      <!-- 背景底板 -->
      <rect x="4" y="4" width="812" height="492" rx="22" fill="#fff7ed" stroke="#fdba74" stroke-width="3"/>

      <!-- 顶部标题条 -->
      <path d="M4 26 Q4 4 26 4 L794 4 Q816 4 816 26 L816 82 L4 82 Z" fill="url(#rhdr)"/>
      <text x="410" y="39" text-anchor="middle" fill="#ffffff" font-size="21" font-weight="900" font-family="sans-serif">📱 极速秒退款操作指引（请按下面手机界面 3 步选对原因）</text>
      <text x="410" y="65" text-anchor="middle" fill="#ffedd5" font-size="13.5" font-weight="700" font-family="sans-serif">选【不想要了】或【协商一致】系统将自动为您秒通过退款！选其他原因会卡人工审核延迟到账</text>

      <!-- ==================== 手机界面 ① ==================== -->
      <g transform="translate(26, 100)">
        <!-- 步骤标题 -->
        <rect x="48" y="0" width="144" height="28" rx="14" fill="#ea580c"/>
        <text x="120" y="19" text-anchor="middle" fill="#ffffff" font-size="13" font-weight="900" font-family="sans-serif">第 ① 步：点修改申请</text>

        <!-- 手机外壳 -->
        <rect x="10" y="38" width="220" height="336" rx="24" fill="#1e293b" stroke="#475569" stroke-width="3"/>
        <rect x="18" y="48" width="204" height="316" rx="17" fill="#f8fafc"/>
        <!-- 状态栏与导航 -->
        <text x="32" y="64" fill="#64748b" font-size="10" font-weight="700">9:41</text>
        <text x="120" y="84" text-anchor="middle" fill="#0f172a" font-size="13" font-weight="800">‹  退款详情</text>
        <line x1="18" y1="93" x2="222" y2="93" stroke="#e2e8f0"/>

        <!-- 手机内容区 -->
        <rect x="28" y="104" width="184" height="54" rx="8" fill="#fff7ed"/>
        <text x="38" y="125" fill="#c2410c" font-size="12.5" font-weight="800">请等待商家处理</text>
        <text x="38" y="145" fill="#9a3412" font-size="10.5">原因选错需转专员人工排队核实</text>

        <rect x="28" y="168" width="184" height="92" rx="8" fill="#ffffff" stroke="#e2e8f0"/>
        <text x="38" y="190" fill="#64748b" font-size="11">商品：二手严选数码商品</text>
        <text x="38" y="212" fill="#64748b" font-size="11">退款金额：¥ 原路全额退回</text>
        <text x="38" y="234" fill="#dc2626" font-size="11" font-weight="700">当前原因：待修改为秒退项</text>

        <!-- 底部操作栏 + 红框高亮 [修改申请] -->
        <line x1="18" y1="312" x2="222" y2="312" stroke="#e2e8f0"/>
        <rect x="34" y="323" width="76" height="28" rx="14" fill="#f1f5f9" stroke="#cbd5e1"/>
        <text x="72" y="341" text-anchor="middle" fill="#64748b" font-size="11">撤销申请</text>

        <rect x="122" y="321" width="88" height="32" rx="16" fill="#fff1f2" stroke="#e11d48" stroke-width="2.5"/>
        <text x="166" y="341" text-anchor="middle" fill="#e11d48" font-size="12" font-weight="900">修改申请</text>

        <!-- 红圈手指提示 -->
        <circle cx="204" cy="316" r="13" fill="#e11d48"/>
        <text x="204" y="321" text-anchor="middle" fill="#ffffff" font-size="12" font-weight="900">点</text>
      </g>

      <!-- 箭头 1->2 -->
      <text x="275" y="285" text-anchor="middle" fill="#ea580c" font-size="26" font-weight="900">➔</text>

      <!-- ==================== 手机界面 ② ==================== -->
      <g transform="translate(290, 100)">
        <rect x="38" y="0" width="164" height="28" rx="14" fill="#ea580c"/>
        <text x="120" y="19" text-anchor="middle" fill="#ffffff" font-size="13" font-weight="900" font-family="sans-serif">第 ② 步：勾选以下任一项</text>

        <rect x="10" y="38" width="220" height="336" rx="24" fill="#1e293b" stroke="#475569" stroke-width="3"/>
        <!-- 半透明遮罩 + 底部弹出选择菜单 UI -->
        <rect x="18" y="48" width="204" height="316" rx="17" fill="#64748b"/>
        <rect x="18" y="112" width="204" height="252" rx="16" fill="#ffffff"/>

        <text x="120" y="136" text-anchor="middle" fill="#0f172a" font-size="13" font-weight="900">请选择退款原因</text>
        <line x1="18" y1="146" x2="222" y2="146" stroke="#e2e8f0"/>

        <!-- 推荐项 1：不想要了 -->
        <rect x="26" y="156" width="188" height="46" rx="9" fill="#ecfdf5" stroke="#10b981" stroke-width="2"/>
        <text x="36" y="177" fill="#065f46" font-size="12" font-weight="900">✅ 多拍 / 拍错 / 不想要了</text>
        <text x="36" y="194" fill="#059669" font-size="10.5" font-weight="700">推荐选这项 · 系统 0 秒自动退</text>
        <circle cx="198" cy="179" r="8" fill="#10b981"/>

        <!-- 推荐项 2：协商一致 -->
        <rect x="26" y="210" width="188" height="46" rx="9" fill="#ecfdf5" stroke="#10b981" stroke-width="2"/>
        <text x="36" y="231" fill="#065f46" font-size="12" font-weight="900">✅ 协商一致退款</text>
        <text x="36" y="248" fill="#059669" font-size="10.5" font-weight="700">或选这项 · 免审极速原路退回</text>
        <circle cx="198" cy="233" r="8" fill="none" stroke="#10b981" stroke-width="2"/>

        <!-- 错误项置灰对比 -->
        <rect x="26" y="266" width="188" height="38" rx="8" fill="#f8fafc"/>
        <text x="36" y="289" fill="#94a3b8" font-size="11">✕ 质量/描述不符（需人工漫长核验）</text>

        <rect x="26" y="314" width="188" height="36" rx="18" fill="#f97316"/>
        <text x="120" y="337" text-anchor="middle" fill="#ffffff" font-size="12.5" font-weight="900">确定选择</text>
      </g>

      <!-- 箭头 2->3 -->
      <text x="539" y="285" text-anchor="middle" fill="#ea580c" font-size="26" font-weight="900">➔</text>

      <!-- ==================== 手机界面 ③ ==================== -->
      <g transform="translate(554, 100)">
        <rect x="44" y="0" width="152" height="28" rx="14" fill="#059669"/>
        <text x="120" y="19" text-anchor="middle" fill="#ffffff" font-size="13" font-weight="900" font-family="sans-serif">第 ③ 步：点提交秒到账</text>

        <rect x="10" y="38" width="220" height="336" rx="24" fill="#1e293b" stroke="#475569" stroke-width="3"/>
        <rect x="18" y="48" width="204" height="316" rx="17" fill="#f8fafc"/>
        <text x="32" y="64" fill="#64748b" font-size="10" font-weight="700">9:42</text>
        <text x="120" y="84" text-anchor="middle" fill="#0f172a" font-size="13" font-weight="800">‹  修改退款申请</text>
        <line x1="18" y1="93" x2="222" y2="93" stroke="#e2e8f0"/>

        <rect x="28" y="108" width="184" height="44" rx="8" fill="#ffffff" stroke="#10b981" stroke-width="1.5"/>
        <text x="36" y="127" fill="#64748b" font-size="10.5">退款原因</text>
        <text x="36" y="143" fill="#059669" font-size="12" font-weight="900">不想要了 / 协商一致  ✓</text>

        <rect x="28" y="162" width="184" height="44" rx="8" fill="#ffffff" stroke="#e2e8f0"/>
        <text x="36" y="181" fill="#64748b" font-size="10.5">退回方式</text>
        <text x="36" y="197" fill="#0f172a" font-size="12" font-weight="800">极速原路退回（免等待）</text>

        <rect x="28" y="218" width="184" height="62" rx="8" fill="#ecfdf5"/>
        <text x="120" y="244" text-anchor="middle" fill="#047857" font-size="12" font-weight="800">⚡ 系统自动检测通过</text>
        <text x="120" y="264" text-anchor="middle" fill="#059669" font-size="11">提交后无需人工审批立即秒退！</text>

        <!-- 底部橙色大按钮 -->
        <rect x="28" y="314" width="184" height="38" rx="19" fill="#ea580c" stroke="#dc2626" stroke-width="2"/>
        <text x="120" y="338" text-anchor="middle" fill="#ffffff" font-size="13.5" font-weight="900">提交修改（立即秒退）</text>
      </g>
    </svg>
  `);
}

export function makeSignRemindCardSvg() {
  return toUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 320" width="680" height="320">
      <rect x="4" y="4" width="672" height="312" rx="18" fill="#ffffff" stroke="#cbd5e1" stroke-width="2"/>
      <rect x="4" y="4" width="672" height="68" rx="18" fill="#0f172a"/>
      <text x="34" y="46" fill="#38bdf8" font-size="20" font-weight="900" font-family="sans-serif">📦 顺丰派件签收温馨提示卡</text>
      <text x="34" y="114" fill="#1e293b" font-size="14.5" font-weight="700">1. 请当着顺丰小哥面检查外箱封口是否完好，如外箱严重变形破损请直接拍照拒签。</text>
      <text x="34" y="152" fill="#1e293b" font-size="14.5" font-weight="700">2. 显示器/精密数码请平放桌面双手托底取出，切勿单手捏屏幕内屏以防压碎面板。</text>
      <text x="34" y="190" fill="#1e293b" font-size="14.5" font-weight="700">3. 插线测试如遇疑问（如独显机箱需插横向独立显卡DP口），随时发图联系客服为您解答！</text>
      <rect x="34" y="226" width="612" height="56" rx="12" fill="#f0fdf4" stroke="#86efac"/>
      <text x="340" y="260" text-anchor="middle" fill="#15803d" font-size="15" font-weight="800">本机已绑定唯一序列号质保档案 · 祝您用机愉快！</text>
    </svg>
  `);
}
