<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>会话陪谈台（多图快照 · 逐轮折线图 · 四 Dock 助手）</h1>
        <p class="page-sub">
          1:1 对齐升级版闲鱼内嵌 Copilot：左侧 5 维筛选与实时读秒、顶部商品多图快照大图灯箱、右侧<b>「会话 / 行情 / 工单 / 收益」</b>四 Dock 全功能联动。
        </p>
      </div>
      <div class="page-acts">
        <a href="./copilot-preview.html" class="btn sm">🧩 实机预览内嵌 Copilot v5.0</a>
        <a href="#/sellers" class="btn sm">★ 卖家与慢压池</a>
        <a :href="linkedCaseHref" class="btn pri">进入这笔订单步入式操作 ›</a>
        <Q k="im" label="怎么用" />
      </div>
    </header>

    <!-- 三栏全功能陪谈舱 -->
    <section class="card im-shell" style="padding: 0; overflow: hidden">
      <div class="im-topbar">
        <div class="im-brand">
          <span class="gf-pill">闲鱼 IM · v5.0 旗舰版</span>
          <span>买前省钱×10% + 到货退差×10%（两段独立计提） · 页面写明成色绝不重复追问</span>
        </div>
        <div class="im-top-acts">
          <button type="button" class="btn sm" @click="helperOpen = !helperOpen">
            {{ helperOpen ? '收起右侧 Copilot' : '展开右侧 Copilot' }}
          </button>
          <a :href="linkedCaseHref" class="btn sm pri">打开订单进度条 ›</a>
        </div>
      </div>

      <div class="im-grid" :class="{ collapsed: !helperOpen }">
        <!-- 1. 左栏：5 维分组胶囊（1小时包含前10分钟）+ 实时等待读秒 + 50px 右侧商品缩略图 -->
        <aside class="im-left">
          <div class="im-filter-rail">
            <button
              v-for="ft in filterTabs"
              :key="ft.k"
              type="button"
              class="flt-pill"
              :class="{ on: convTab === ft.k }"
              @click="convTab = ft.k"
            >
              <span>{{ ft.label }}</span>
              <b>{{ ft.count }}</b>
            </button>
          </div>

          <div class="im-list">
            <button
              v-for="cv in filteredConvs"
              :key="cv.conv_id"
              type="button"
              class="im-conv"
              :class="{ on: cv.conv_id === store.selectedConvId }"
              @click="selectConv(cv.conv_id)"
            >
              <div class="conv-main">
                <div class="im-conv-r1">
                  <span class="seller-nm">
                    <span v-if="cv.is_favorite_seller" class="fav-star" title="已收藏卖家">★</span>
                    <b>{{ cv.seller_name }}</b>
                  </span>
                  <span v-if="cv.matched_status === 'conflict_pending'" class="tag red">规格冲突待核</span>
                  <span v-else-if="Number(cv.slow_group) === 1" class="tag amb">慢慢压价</span>
                  <span v-else-if="cv.agreed_price_cents" class="tag grn">已谈妥</span>
                  <span v-else-if="cv.needs_manual" class="tag red">急需人工</span>
                  <span v-else class="tag">自动跟进</span>
                </div>
                <div class="im-conv-t">{{ cv.title }}</div>
                <div class="im-conv-p num">
                  <span>挂 {{ fmtYuan(cv.seller_price_cents) }} · 上限 {{ fmtYuan(cv.ceiling_price_cents) }}</span>
                  <span
                    v-if="liveWaitSec(cv) > 0"
                    class="wait-chip"
                    :class="{ hot: liveWaitSec(cv) >= 60 }"
                  >
                    ⏱ 等待 {{ liveWaitSec(cv) }}秒
                  </span>
                </div>
              </div>
              <img
                class="conv-thumb"
                :src="convThumb(cv)"
                alt="商品缩略图"
              />
            </button>
          </div>
        </aside>

        <!-- 2. 中栏：商品快照条（可点大图灯箱）+ 业务参考条 + 聊天流 + 安全发信框 -->
        <div v-if="curConv" class="im-center">
          <!-- 顶部第 1 条：商品原始多图快照卡片 -->
          <div class="snap-strip">
            <div class="snap-left" @click="openSnapshotModal">
              <div class="snap-thumbs">
                <img
                  v-for="(img, idx) in curSnapImages.slice(0, 3)"
                  :key="idx"
                  :src="img"
                  alt="快照图"
                />
              </div>
              <div class="snap-meta">
                <div class="snap-title">
                  <span class="snap-tag">📸 买前锁死快照 v{{ curItemSnap.version_no || 1 }}</span>
                  <b>{{ curItemSnap.title_raw || curConv.title }}</b>
                </div>
                <div class="snap-desc">
                  成色声明：{{ curItemSnap.quality_raw || curConv.snapshot?.seller_declaration || '已锁死原始描述' }}
                  <span class="muted"> · {{ curItemSnap.specs_raw || curConv.model_code }}</span>
                </div>
              </div>
            </div>
            <button type="button" class="btn sm pri" @click="openSnapshotModal">
              🔍 查看快照大图 ({{ curSnapImages.length }}张)
            </button>
          </div>

          <!-- 顶部第 2 条：公司参考价 + 当前谈妥 + 买前10%预计提成 + 快捷动作 -->
          <div class="ref-strip num">
            <div class="ref-metrics">
              <span>公司参考价 <b>{{ fmtYuan(curConv.ref_price_cents) }}</b></span>
              <span class="sep">|</span>
              <span>
                {{ curConv.agreed_price_cents ? '当前谈妥' : '卖家最新价' }}
                <b class="acc-txt">{{ fmtYuan(curConv.agreed_price_cents || curConv.seller_price_cents) }}</b>
              </span>
              <span class="sep">|</span>
              <span>
                买前10%预计提成
                <b class="grn-txt">¥{{ curPreCommYuan }}</b>
              </span>
              <span class="sep">|</span>
              <span>
                自动议价：
                <b>{{ pauseLabel(curConv.pause_state) }}</b>
              </span>
            </div>
            <div class="ref-actions">
              <button
                type="button"
                class="btn sm"
                :class="{ pri: curConv.is_favorite_seller }"
                @click="toggleFavoriteSeller"
              >
                {{ curConv.is_favorite_seller ? '★ 已收藏卖家' : '☆ 收藏卖家' }}
              </button>
              <button
                type="button"
                class="btn sm"
                @click="toggleSlowCurrent"
              >
                {{ Number(curConv.slow_group) === 1 ? '移出慢压' : '⏳ 慢慢压价' }}
              </button>
              <button
                v-if="curConv.pause_state === 'auto'"
                type="button"
                class="btn sm"
                :disabled="!isPracticeUnlocked()"
                @click="pauseConv(false)"
              >
                ✋ 暂停自动
              </button>
              <button
                v-else-if="curConv.pause_state === 'paused'"
                type="button"
                class="btn sm"
                :disabled="!isPracticeUnlocked()"
                @click="resumeConv"
              >
                ▶ 恢复自动
              </button>
            </div>
          </div>

          <div v-if="curConv.pause_state === 'pausing'" class="banner red" style="margin: 10px 14px 0">
            ✋ 自动助手刚发了一句话还在路上！插话前先点确认停稳，防止同一分钟报两个价穿帮：
            <button type="button" class="btn sm pri" style="margin-left: 8px" @click="ackPause">
              确认停稳，我来接手 ✓
            </button>
          </div>

          <div v-if="curConv.matched_status === 'conflict_pending'" class="banner amb" style="margin: 10px 14px 0">
            ⚠️ <b>规格冲突防错拦截中</b>：{{ curConv.context_changed_note || '标题与正文配件描述不一致，已暂停自动首报' }}
            <button type="button" class="btn sm pri" style="margin-left: 8px" @click="copilotDock = 'market'">
              去右侧「行情」修正匹配 ›
            </button>
          </div>

          <!-- 聊天消息流 -->
          <div class="im-msgs">
            <div v-for="m in curMsgs" :key="m.msg_id" class="im-bubble" :class="m.sender">
              <div class="im-b-meta">
                <b>{{ m.sender_label }}</b>
                <span v-if="m.quote_cents" class="quote-pill">报价 {{ fmtYuan(m.quote_cents) }}</span>
              </div>
              <p>{{ m.text }}</p>
            </div>
          </div>

          <!-- 底部安全输入框 -->
          <div class="im-composer">
            <input
              v-model="draft"
              class="input"
              placeholder="输入发给卖家的话（自动拦截『参考价/底价/提成/微信号/退差价』等内部敏感词）…"
              @keydown.enter.prevent="sendGate.ok && sendChat()"
            />
            <Lock
              :ok="sendGate.ok"
              :busy="busy"
              :reason="sendGate.reason"
              :fix-text="sendGate.fixText"
              @go="sendChat"
              @fix="store.ui.practice = 'chat_guard'"
            >
              发送消息
            </Lock>
          </div>
        </div>

        <!-- 3. 右栏：升级版 4-Dock 采购 Copilot（会话 / 行情 / 工单 / 收益） -->
        <aside v-if="helperOpen && curConv" class="im-copilot">
          <div class="cp-body">
            <!-- DOCK 1: 会话（SVG 买卖双方逐轮报价折线图 + 差额条 + 安全话术） -->
            <template v-if="copilotDock === 'session'">
              <div class="cp-hd">
                <span class="tag acc">会话分析 · 逐轮博弈轨迹</span>
                <Term k="leak_guard">防泄密保护</Term>
              </div>

              <!-- SVG 双方逐轮报价折线图 -->
              <div class="chart-card">
                <div class="chart-hd">
                  <b>买卖双方逐轮报价折线图</b>
                  <span class="legend">
                    <i class="dot seller" />卖家
                    <i class="dot buyer" />我方
                    <i class="dot ceil" />上限
                  </span>
                </div>
                <svg v-if="chartGeom.points.length > 0" viewBox="0 0 280 128" class="quote-svg">
                  <!-- 上限虚线 -->
                  <line
                    x1="16"
                    :y1="chartGeom.ceilY"
                    x2="264"
                    :y2="chartGeom.ceilY"
                    stroke="#d9383e"
                    stroke-width="1.2"
                    stroke-dasharray="4 3"
                  />
                  <text x="262" :y="Math.max(11, chartGeom.ceilY - 3)" text-anchor="end" font-size="9.5" fill="#d9383e">
                    上限 {{ fmtYuan(curConv.ceiling_price_cents) }}
                  </text>
                  <!-- 目标价虚线 -->
                  <line
                    x1="16"
                    :y1="chartGeom.targetY"
                    x2="264"
                    :y2="chartGeom.targetY"
                    stroke="#128a59"
                    stroke-width="1"
                    stroke-dasharray="3 3"
                  />
                  <!-- 卖家折线 -->
                  <polyline
                    v-if="chartGeom.sellerPolyline"
                    :points="chartGeom.sellerPolyline"
                    fill="none"
                    stroke="#f97316"
                    stroke-width="2.2"
                    stroke-linecap="round"
                  />
                  <!-- 我方折线 -->
                  <polyline
                    v-if="chartGeom.buyerPolyline"
                    :points="chartGeom.buyerPolyline"
                    fill="none"
                    stroke="#3454ff"
                    stroke-width="2.2"
                    stroke-linecap="round"
                  />
                  <!-- 轮次圆点与数字 -->
                  <g v-for="pt in chartGeom.points" :key="pt.id">
                    <circle
                      :cx="pt.x"
                      :cy="pt.y"
                      r="4"
                      :fill="pt.isSeller ? '#f97316' : '#3454ff'"
                    />
                    <text
                      :x="pt.x"
                      :y="pt.isSeller ? Math.max(12, pt.y - 6) : Math.min(122, pt.y + 13)"
                      text-anchor="middle"
                      font-size="9.5"
                      font-weight="700"
                      :fill="pt.isSeller ? '#c2410c' : '#1d4ed8'"
                    >
                      ¥{{ Math.round(pt.cents / 100) }}
                    </text>
                  </g>
                </svg>
                <div v-else class="muted" style="font-size: 12.5px; padding: 8px 0">
                  暂无报价轮次，发出首轮报价后自动绘制博弈曲线
                </div>

                <!-- 差额对比条 -->
                <div class="diff-bar num">
                  <span>比公司参考价省：<b>{{ fmtYuan(Math.max(0, curConv.ref_price_cents - (curConv.agreed_price_cents || curConv.seller_price_cents))) }}</b></span>
                  <span class="grn-txt">预计10%提成 ¥{{ curPreCommYuan }}</span>
                </div>
              </div>

              <!-- 卖家态度研判 -->
              <div class="cp-note">
                <b>💡 AI 研判：</b>{{ curConv.attitude_reason || '按三档价格尺稳步推进' }}
              </div>

              <!-- 安全话术胶囊 -->
              <div class="cp-sec">
                <span class="cp-lbl">点击一键填入买家口吻话术（不暴露内部词）</span>
                <button
                  v-for="(tpl, idx) in safeTpls"
                  :key="idx"
                  type="button"
                  class="cp-tpl"
                  @click="draft = tpl.text"
                >
                  <b>{{ tpl.title }}</b>
                  <small>{{ tpl.text }}</small>
                </button>
              </div>
            </template>

            <!-- DOCK 2: 行情（型号匹配修正 + 三档价格尺 + 历史版本柱图） -->
            <template v-else-if="copilotDock === 'market'">
              <div class="cp-hd">
                <span class="tag acc">行情参考 · 匹配修正</span>
                <a href="#/pricebook" class="link-sm">全量参考表 ›</a>
              </div>

              <div class="cp-ceil num">
                <div>
                  <span>首轮试探价</span>
                  <b>{{ fmtYuan(curConv.first_offer_cents) }}</b>
                </div>
                <div>
                  <span>目标成交价</span>
                  <b class="grn-txt">{{ fmtYuan(curConv.target_price_cents) }}</b>
                </div>
                <div>
                  <span>最高出价上限</span>
                  <b class="acc-txt">{{ fmtYuan(curConv.ceiling_price_cents) }}</b>
                </div>
                <div>
                  <span>公司冻结参考价</span>
                  <b>{{ fmtYuan(curConv.ref_price_cents) }}</b>
                </div>
              </div>

              <!-- 人工修正规格匹配 -->
              <div class="chart-card">
                <div class="chart-hd">
                  <b>🔧 人工修正型号/规格匹配</b>
                  <span v-if="curConv.matched_status === 'conflict_pending'" class="tag red">待核</span>
                </div>
                <select v-model="selectedModelFix" class="input" style="margin-bottom: 8px">
                  <option v-for="pb in uniquePublishedModels" :key="pb.model_code" :value="pb.model_code">
                    {{ pb.spec_label }}（参考 {{ fmtYuan(pb.ref_price_cents) }} / 上限 {{ fmtYuan(pb.ceiling_cents) }}）
                  </option>
                </select>
                <button type="button" class="btn sm pri" style="width: 100%" @click="applyModelFix">
                  确认按此规格匹配并解除冲突拦截
                </button>
              </div>

              <!-- 历史行情版本柱状对比 -->
              <div class="chart-card">
                <div class="chart-hd">
                  <b>📊 该机型参考价历史版本走势</b>
                </div>
                <div class="ver-bars">
                  <div v-for="ver in curModelVersions" :key="ver.item_id" class="ver-row num">
                    <span class="ver-lbl">v{{ ver.version_no }} ({{ ver.status === 'published' ? '现行' : ver.status === 'archived' ? '历史' : '草稿' }})</span>
                    <div class="ver-track">
                      <div
                        class="ver-fill"
                        :style="{ width: `${Math.min(100, Math.round((ver.ref_price_cents / maxVerPrice) * 100))}%` }"
                      />
                    </div>
                    <b>{{ fmtYuan(ver.ref_price_cents) }}</b>
                  </div>
                </div>
              </div>
            </template>

            <!-- DOCK 3: 工单（双轨二次议价问题单速览） -->
            <template v-else-if="copilotDock === 'tickets'">
              <div class="cp-hd">
                <span class="tag red">二次议价工单 ({{ issueCases.length }})</span>
                <a href="#/cases?bucket=issue" class="link-sm">全部问题单 ›</a>
              </div>
              <p class="muted" style="font-size: 12px">
                双轨制：<b>⚡顺丰件派送10m当场拒签加微</b> vs <b>📦已签收先锁退货等卖家开口/Plan B</b>，实际退差再拿 <b>10%</b> 提成！
              </p>
              <div class="tk-mini-list">
                <a
                  v-for="ic in issueCases.slice(0, 5)"
                  :key="ic.case_id"
                  :href="`#/case/${ic.case_id}`"
                  class="tk-mini"
                >
                  <div class="tk-r1">
                    <span class="tag" :class="ic.step_progress?.arrival_track === 'signed_platform_return' ? 'amb' : 'red'">
                      {{ ic.step_progress?.arrival_track === 'signed_platform_return' ? '📦 已签收轨' : '⚡ 顺丰拒签轨' }}
                    </span>
                    <span class="num grn-txt">预计+{{ fmtYuan(ic.prices?.est_comm_cents || 0) }}</span>
                  </div>
                  <b>{{ ic.title }}</b>
                  <small class="muted">{{ ic.step_progress?.summary }}</small>
                </a>
              </div>
            </template>

            <!-- DOCK 4: 收益（今日 ¥1,000 目标进度 + 三栏严格独立展示） -->
            <template v-else>
              <div class="cp-hd">
                <span class="tag grn">个人今日收益 · 两段各10%</span>
                <a href="#/ledger" class="link-sm">对账明细 ›</a>
              </div>

              <div class="earn-hero num">
                <div class="eh-top">
                  <span>今日累计预计提成</span>
                  <span class="muted">目标 {{ fmtYuan(earnings.daily_target_cents) }}</span>
                </div>
                <div class="eh-big">¥{{ (earnings.today_expected_cents / 100).toFixed(2) }}</div>
                <div class="eh-bar">
                  <div class="eh-fill" :style="{ width: `${earnings.progress_pct}%` }" />
                </div>
                <div class="eh-sub">
                  已完成 <b>{{ earnings.progress_pct }}%</b> · 距离今日目标还差
                  <b>¥{{ (earnings.remaining_to_target_cents / 100).toFixed(2) }}</b>
                </div>
              </div>

              <!-- 预计 / 已确认 / 已发放 严格独立三栏（绝不混加） -->
              <div class="earn-split num">
                <div>
                  <span>预计提成</span>
                  <b>¥{{ (earnings.today_expected_cents / 100).toFixed(0) }}</b>
                  <small>买前+到货在途</small>
                </div>
                <div>
                  <span>已确认待发</span>
                  <b class="acc-txt">¥{{ (earnings.confirmed_cents / 100).toFixed(0) }}</b>
                  <small>核销确认</small>
                </div>
                <div>
                  <span>已发放落袋</span>
                  <b class="grn-txt">¥{{ (earnings.paid_cents / 100).toFixed(0) }}</b>
                  <small>已入工资单</small>
                </div>
              </div>

              <div class="cp-note">
                <b>📐 零重算公式：</b><br />
                • 买前省钱提成 = <code>(参考价M − 首轮成交P) × 10%</code><br />
                • 到货退差提成 = <code>实际退回/折让差价R × 10%</code><br />
                • 严禁把 R 代回买前公式重复计提；全退未留成自动冲零。
              </div>
            </template>
          </div>

          <!-- 底部固定 4-Dock 导航栏（会话 / 行情 / 工单 / 收益） -->
          <nav class="cp-dock" aria-label="Copilot四模块切换">
            <button type="button" :class="{ on: copilotDock === 'session' }" @click="copilotDock = 'session'">
              <span>💬</span><b>会话</b>
            </button>
            <button type="button" :class="{ on: copilotDock === 'market' }" @click="copilotDock = 'market'">
              <span>📈</span><b>行情</b>
            </button>
            <button type="button" :class="{ on: copilotDock === 'tickets' }" @click="copilotDock = 'tickets'">
              <span>🛠️</span><b>工单</b>
            </button>
            <button type="button" :class="{ on: copilotDock === 'earnings' }" @click="copilotDock = 'earnings'">
              <span>💰</span><b>收益</b>
            </button>
          </nav>
        </aside>
      </div>
    </section>

    <!-- 商品快照高清多图灯箱弹窗 -->
    <dialog ref="snapDialogRef" class="snap-dialog" @click.self="closeSnapshotModal">
      <div v-if="curConv" class="sd-inner">
        <div class="sd-hd">
          <div>
            <span class="snap-tag">📸 买前锁死商品原始快照 · v{{ curItemSnap.version_no || 1 }}</span>
            <h3 style="margin-top: 4px">{{ curItemSnap.title_raw || curConv.title }}</h3>
          </div>
          <button type="button" class="btn sm" @click="closeSnapshotModal">✕ 关闭</button>
        </div>

        <div class="sd-stage">
          <img :src="curSnapImages[activeImgIdx] || './evidence/IMG_5878.PNG'" alt="商品快照高清大图" />
        </div>

        <div v-if="curSnapImages.length > 1" class="sd-thumbs">
          <button
            v-for="(img, idx) in curSnapImages"
            :key="idx"
            type="button"
            class="sd-th"
            :class="{ on: idx === activeImgIdx }"
            @click="activeImgIdx = idx"
          >
            <img :src="img" :alt="`第${idx + 1}张`" />
            <span>图 {{ idx + 1 }}</span>
          </button>
        </div>

        <div class="sd-meta">
          <div><b>原挂牌价：</b>{{ curItemSnap.asking_price_text || fmtYuan(curConv.seller_price_cents) }}</div>
          <div><b>成色标称：</b>{{ curItemSnap.quality_raw || curConv.snapshot?.seller_declaration }}</div>
          <div><b>规格参数：</b>{{ curItemSnap.specs_raw || curConv.model_code }}</div>
          <div class="wide"><b>卖家原始正文快照（到货核验铁证）：</b>{{ curItemSnap.description_raw || curConv.snapshot?.seller_declaration }}</div>
        </div>
      </div>
    </dialog>

    <!-- AdsPower 挂载说明折叠卡 -->
    <Fold title="🧩 在 AdsPower 闲鱼浏览器挂载「采购 Copilot v5.0 内嵌插件」说明（点击展开）">
      <div class="secs">
        <div class="card">
          <h3>AdsPower 应用中心一键上传（v5.0 焕新 C 端视觉版）</h3>
          <ol style="padding-left: 20px; font-size: 14px; line-height: 1.75">
            <li>打开 AdsPower 左侧「应用中心」→ 点击「上传应用」，上传根目录的 <code>采购Copilot-AdsPower插件.zip</code>。</li>
            <li>浏览闲鱼 <code>/item</code> 商品页时自动静默抓取多图快照与原话；进入 <code>/im</code> 聊天页时自动呈现左侧筛选读秒、顶部快照大图卡与右侧平行四 Dock 面板（零遮挡原生聊天框与右侧 50px 商品图）！</li>
          </ol>
        </div>
        <div class="card">
          <h3>检测本机 AdsPower 专窗状态</h3>
          <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px">
            <button type="button" class="btn sm pri" @click="checkAdsPower">检测本机 AdsPower 状态</button>
            <button
              v-if="adsInfo?.profiles?.length"
              type="button"
              class="btn sm"
              :disabled="busy"
              @click="launchAds(adsInfo.profiles[0].user_id)"
            >
              启动 #{{ adsInfo.profiles[0].serial_number }} 闲鱼专窗
            </button>
          </div>
          <p v-if="adsInfo" class="muted" style="font-size: 13.5px">
            {{
              adsInfo.local_api_connected
                ? `已连上本机 AdsPower，识别到 ${adsInfo.profiles.length} 个浏览器专窗。`
                : '当前未打开 AdsPower 客户端（打开 AdsPower 后点此按钮即可直连）。'
            }}
          </p>
        </div>
      </div>
    </Fold>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { store, callAction, isPracticeUnlocked, practiceDoneCount, findCaseByConv } from '../store.js';
import { apiGet, fmtYuan, mkIdem } from '../api.js';
import Q from '../components/Q.vue';
import Term from '../components/Term.vue';
import Lock from '../components/Lock.vue';
import Fold from '../components/Fold.vue';

const LEAK_WORDS = [
  '目标价', '参考价', '公司底价', '成本底线', '底价', '提成', '毛利',
  '加价上限', '授权上限', '最高上限', '到手刀', '二次议价', '加微信', '微信号', '退差价',
  '申请小二介入', '点小二介入', '闲鱼小法庭', '法庭见', '投诉你到底', '跟你死磕',
];

const helperOpen = ref(true);
const convTab = ref('all');
const copilotDock = ref('session');
const adsInfo = ref(null);
const draft = ref('');
const busy = ref(false);
const tickOffset = ref(0);
const snapDialogRef = ref(null);
const activeImgIdx = ref(0);
const selectedModelFix = ref('SONY-A7M4-BODY');

let tickTimer = null;
onMounted(() => {
  tickTimer = setInterval(() => {
    tickOffset.value += 1;
  }, 1000);
});
onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer);
});

const convs = computed(() => store.dashboard.conversations || []);
const within10mConvs = computed(() => convs.value.filter((c) => Number(c.idle_minutes || 0) <= 10 && Number(c.slow_group) !== 1));
// 1小时内包含前10分钟（严格落实产品口径）
const within1hConvs = computed(() => convs.value.filter((c) => Number(c.idle_minutes || 0) <= 60 && Number(c.slow_group) !== 1));
const slowConvs = computed(() => convs.value.filter((c) => Number(c.slow_group) === 1));
const favConvs = computed(() => convs.value.filter((c) => Boolean(c.is_favorite_seller)));

const filterTabs = computed(() => [
  { k: 'all', label: '全部', count: convs.value.length },
  { k: '10m', label: '10分钟内', count: within10mConvs.value.length },
  { k: '1h', label: '1小时内', count: within1hConvs.value.length },
  { k: 'slow', label: '慢慢压价', count: slowConvs.value.length },
  { k: 'fav', label: '★ 收藏', count: favConvs.value.length },
]);

const filteredConvs = computed(() => {
  if (convTab.value === '10m') return within10mConvs.value;
  if (convTab.value === '1h') return within1hConvs.value;
  if (convTab.value === 'slow') return slowConvs.value;
  if (convTab.value === 'fav') return favConvs.value;
  return convs.value;
});

const curConv = computed(
  () => convs.value.find((c) => c.conv_id === store.selectedConvId) || convs.value[0] || null
);

watch(
  () => curConv.value?.model_code,
  (mc) => {
    if (mc) selectedModelFix.value = mc;
    activeImgIdx.value = 0;
  },
  { immediate: true }
);

const curMsgs = computed(() =>
  (store.dashboard.messages || []).filter((m) => m.conv_id === curConv.value?.conv_id)
);

const curRounds = computed(() =>
  (store.dashboard.negotiation_rounds || []).filter((r) => r.conv_id === curConv.value?.conv_id)
);

const curItemSnap = computed(() => curConv.value?.item_snapshot || {});
const curSnapImages = computed(() => {
  const fromSnap = curItemSnap.value?.images || [];
  if (fromSnap.length > 0) return fromSnap;
  const fromEv = curConv.value?.evidence_urls || [];
  return fromEv.length > 0 ? fromEv : ['./evidence/IMG_5878.PNG'];
});

const curPreCommYuan = computed(() => {
  if (!curConv.value) return '0';
  const base = curConv.value.agreed_price_cents || curConv.value.target_price_cents || curConv.value.seller_price_cents;
  const diff = Math.max(0, Number(curConv.value.ref_price_cents || 0) - Number(base || 0));
  return (diff * 0.10 / 100).toFixed(0);
});

const chartGeom = computed(() => {
  const rds = curRounds.value;
  if (!curConv.value || rds.length === 0) {
    return { points: [], sellerPolyline: '', buyerPolyline: '', ceilY: 30, targetY: 70 };
  }
  const allVals = [
    ...rds.map((r) => Number(r.quote_cents)),
    Number(curConv.value.ceiling_price_cents),
    Number(curConv.value.target_price_cents),
  ].filter((v) => v > 0);
  const minV = Math.min(...allVals) * 0.96;
  const maxV = Math.max(...allVals) * 1.03;
  const span = Math.max(1000, maxV - minV);
  const toY = (v) => Math.round(108 - ((v - minV) / span) * 84);
  const stepX = rds.length === 1 ? 0 : 216 / (rds.length - 1);

  const pts = rds.map((r, idx) => {
    const isSeller = String(r.round_label || '').includes('卖') || String(r.verdict || '').includes('卖') || String(r.verdict || '').includes('挂价');
    return {
      id: r.round_id,
      x: Math.round(32 + idx * stepX),
      y: toY(Number(r.quote_cents)),
      cents: Number(r.quote_cents),
      isSeller,
    };
  });
  const sellerPts = pts.filter((p) => p.isSeller).map((p) => `${p.x},${p.y}`).join(' ');
  const buyerPts = pts.filter((p) => !p.isSeller).map((p) => `${p.x},${p.y}`).join(' ');
  return {
    points: pts,
    sellerPolyline: sellerPts,
    buyerPolyline: buyerPts,
    ceilY: toY(Number(curConv.value.ceiling_price_cents)),
    targetY: toY(Number(curConv.value.target_price_cents)),
  };
});

const uniquePublishedModels = computed(() => {
  const seen = new Set();
  return (store.dashboard.pricebook || []).filter((p) => {
    if (p.status === 'archived' || seen.has(p.model_code)) return false;
    seen.add(p.model_code);
    return true;
  });
});

const curModelVersions = computed(() =>
  (store.dashboard.pricebook || []).filter((p) => p.model_code === curConv.value?.model_code)
);

const maxVerPrice = computed(() =>
  Math.max(100000, ...curModelVersions.value.map((v) => Number(v.ref_price_cents || 0)))
);

const issueCases = computed(() =>
  (store.dashboard.cases || []).filter((c) => c.order_bucket === 'issue')
);

const earnings = computed(() =>
  store.dashboard.daily_earnings || {
    daily_target_cents: 100000,
    today_expected_cents: 0,
    remaining_to_target_cents: 100000,
    progress_pct: 0,
    confirmed_cents: 0,
    paid_cents: 0,
  }
);

const linkedCase = computed(() => (curConv.value ? findCaseByConv(curConv.value.conv_id) : null));
const linkedCaseHref = computed(() => (linkedCase.value ? `#/case/${linkedCase.value.case_id}` : '#/cases'));

const safeTpls = computed(() => {
  const f = Math.round((curConv.value?.first_offer_cents || 450000) / 100);
  const t = Math.round((curConv.value?.target_price_cents || 460000) / 100);
  return [
    {
      title: `① 诚心首轮试探（报 ¥${f}）`,
      text: `老板你好，诚心想收这台，功能正常无拆修的话，${f} 元包顺丰保价能出吗？合适我现在直接拍。`,
    },
    {
      title: `② 小步加价促成（报 ¥${t}）`,
      text: `理解哥，我也再加一点凑个实在数 ${t} 元，我们到货当天验完就确认收货绝不墨迹，行的话改好链接标价我秒付！`,
    },
    {
      title: '③ 只补问序列号（页面写明的成色绝不追问）',
      text: '老板麻烦把机器背面型号铭牌或关于本机序列号拍清楚发我核对下保修哈，核对完马上拍下付款！',
    },
  ];
});

function convThumb(cv) {
  if (cv.item_snapshot?.images?.length) return cv.item_snapshot.images[0];
  if (cv.evidence_urls?.length) return cv.evidence_urls[0];
  return './evidence/IMG_5878.PNG';
}

function liveWaitSec(cv) {
  const base = Number(cv.wait_seconds || 0);
  if (!base || cv.agreed_price_cents || Number(cv.slow_group) === 1) return 0;
  return base + tickOffset.value;
}

function pauseLabel(st) {
  if (st === 'pausing') return '停嘴确认中';
  if (st === 'paused') return '人工已接手';
  return '后台自动跟进';
}

function selectConv(cid) {
  store.selectedConvId = cid;
  localStorage.setItem('pw_conv_id', cid);
}

function openSnapshotModal() {
  activeImgIdx.value = 0;
  if (snapDialogRef.value && !snapDialogRef.value.open) {
    snapDialogRef.value.showModal();
  }
}

function closeSnapshotModal() {
  if (snapDialogRef.value?.open) snapDialogRef.value.close();
}

const sendGate = computed(() => {
  if (!isPracticeUnlocked()) {
    return {
      ok: false,
      reason: `新员工请先花 2 分钟点完防踩坑小练习（已完成 ${practiceDoneCount()}/3）`,
      fixText: '去做小练习',
    };
  }
  if (curConv.value?.pause_state === 'pausing') {
    return { ok: false, reason: '自动助手刚发的话还没停稳，请先点上方「确认停稳，我来接手」' };
  }
  if (!draft.value.trim()) {
    return { ok: false, reason: '请先输入内容，或直接点右侧现成话术填入' };
  }
  const hit = LEAK_WORDS.find((w) => draft.value.includes(w));
  if (hit) {
    return { ok: false, reason: `已帮你拦住内部保密词「${hit}」！删掉这个词就能发送` };
  }
  return { ok: true };
});

async function sendChat() {
  busy.value = true;
  try {
    await callAction(
      `/api/conversations/${curConv.value.conv_id}/send`,
      {
        sender: 'buyer_human',
        text: draft.value,
        expected_context_version: curConv.value.context_version,
        idempotency_key: mkIdem('im'),
      },
      '消息已发出并记入订单存档！'
    );
    draft.value = '';
  } finally {
    busy.value = false;
  }
}

async function pauseConv(simulateInflight) {
  await callAction(
    `/api/conversations/${curConv.value.conv_id}/pause`,
    { simulate_inflight: simulateInflight },
    '已让自动助手停嘴，现在由你亲自跟进'
  );
}

async function ackPause() {
  await callAction(
    `/api/conversations/${curConv.value.conv_id}/pause-resolve`,
    { resolution: 'confirm_sent' },
    '自动助手已停稳，可以放心发消息了'
  );
}

async function resumeConv() {
  await callAction(`/api/conversations/${curConv.value.conv_id}/resume`, {}, '已恢复自动助手跟进');
}

async function toggleFavoriteSeller() {
  if (!curConv.value) return;
  const sid = curConv.value.seller_id || `SELLER-${curConv.value.conv_id}`;
  if (curConv.value.is_favorite_seller) {
    await callAction('/api/sellers/favorite', { seller_id: sid, remove: true }, `已取消收藏「${curConv.value.seller_name}」`);
  } else {
    await callAction(
      '/api/sellers/favorite',
      {
        seller_id: sid,
        seller_name: curConv.value.seller_name,
        scope: 'team',
        tags: ['沟通顺畅', '重点关注'],
        note: `会话陪谈台一键收藏（${curConv.value.title}）`,
      },
      `已收藏卖家「${curConv.value.seller_name}」并共享给采购组`
    );
  }
}

async function toggleSlowCurrent() {
  if (!curConv.value) return;
  const nextSlow = Number(curConv.value.slow_group) !== 1;
  await callAction(
    `/api/conversations/${curConv.value.conv_id}/group`,
    { slow_group: nextSlow },
    nextSlow ? '已移入慢慢压价长线池' : '已移回常规实时跟进'
  );
}

async function applyModelFix() {
  if (!curConv.value) return;
  await callAction(
    `/api/conversations/${curConv.value.conv_id}/correct-match`,
    { model_code: selectedModelFix.value, resume_auto: true },
    `已修正型号匹配为 ${selectedModelFix.value} 并解除规格冲突拦截`
  );
}

async function checkAdsPower() {
  const res = await apiGet('./api/adspower/status');
  adsInfo.value = res.adspower || res.data || res;
}

async function launchAds(userId) {
  busy.value = true;
  try {
    await callAction('/api/adspower/launch-copilot', { user_id: userId }, '已通知 AdsPower 打开闲鱼采购专窗！');
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.im-topbar {
  background: #111827;
  color: #fff;
  padding: 10px 18px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.im-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
}
.gf-pill {
  background: #ffda00;
  color: #111827;
  padding: 3px 10px;
  border-radius: 999px;
  font-weight: 900;
  font-size: 12px;
}
.im-top-acts {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.im-grid {
  display: grid;
  grid-template-columns: 295px minmax(0, 1fr) 340px;
  min-height: 600px;
}
.im-grid.collapsed {
  grid-template-columns: 295px minmax(0, 1fr);
}
.im-left {
  border-right: 1px solid var(--line);
  background: var(--soft);
  display: flex;
  flex-direction: column;
}
.im-filter-rail {
  display: flex;
  flex-wrap: wrap;
  padding: 8px;
  gap: 5px;
  border-bottom: 1px solid var(--line);
}
.flt-pill {
  padding: 5px 9px;
  border-radius: 999px;
  background: var(--panel);
  border: 1px solid var(--line);
  font-size: 12px;
  font-weight: 700;
  color: var(--mute);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.flt-pill.on {
  background: var(--acc);
  border-color: var(--acc);
  color: #fff;
}
.im-list {
  padding: 8px;
  display: grid;
  gap: 6px;
  overflow-y: auto;
  max-height: 540px;
}
.im-conv {
  padding: 10px;
  border-radius: 13px;
  background: var(--panel);
  border: 1.5px solid transparent;
  text-align: left;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 50px;
  gap: 8px;
  align-items: center;
}
.im-conv.on {
  border-color: var(--acc);
  background: var(--acc-soft);
}
.conv-main {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.conv-thumb {
  width: 50px;
  height: 50px;
  border-radius: 9px;
  object-fit: cover;
  border: 1px solid var(--line);
}
.im-conv-r1 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}
.seller-nm {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fav-star {
  color: #f59e0b;
  font-size: 14px;
}
.im-conv-t {
  font-size: 12px;
  color: var(--ink2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.im-conv-p {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--mute);
}
.wait-chip {
  padding: 1px 6px;
  border-radius: 999px;
  background: #e0f2fe;
  color: #0369a1;
  font-weight: 700;
  font-size: 11px;
}
.wait-chip.hot {
  background: var(--red-soft);
  color: var(--red-ink);
}

.im-center {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.snap-strip {
  padding: 10px 14px;
  background: #f8fafc;
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.snap-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
  cursor: pointer;
}
.snap-thumbs {
  display: flex;
  gap: 4px;
  flex: none;
}
.snap-thumbs img {
  width: 42px;
  height: 42px;
  border-radius: 8px;
  object-fit: cover;
  border: 1px solid var(--line);
}
.snap-meta {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.snap-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.snap-tag {
  background: #ffda00;
  color: #111827;
  font-size: 11px;
  font-weight: 800;
  padding: 2px 7px;
  border-radius: 6px;
  flex: none;
}
.snap-desc {
  font-size: 12px;
  color: var(--ink2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ref-strip {
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.ref-metrics {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.sep {
  color: var(--line);
}
.ref-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.im-msgs {
  flex: 1;
  padding: 14px;
  display: grid;
  gap: 10px;
  align-content: start;
  overflow-y: auto;
  max-height: 360px;
}
.im-bubble {
  max-width: 82%;
  padding: 10px 14px;
  border-radius: 14px;
  background: var(--soft);
  font-size: 13.5px;
  line-height: 1.5;
}
.im-bubble.buyer_human,
.im-bubble.buyer_ai {
  justify-self: end;
  background: var(--acc-soft);
}
.im-bubble.system {
  justify-self: center;
  max-width: 94%;
  background: var(--amb-soft);
  color: var(--amb-ink);
  font-size: 12.5px;
}
.im-b-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  color: var(--mute);
  margin-bottom: 3px;
}
.quote-pill {
  background: var(--panel);
  padding: 0 6px;
  border-radius: 999px;
  font-weight: 700;
  color: var(--acc);
}
.im-composer {
  padding: 12px 14px;
  border-top: 1px solid var(--line);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}

.im-copilot {
  border-left: 1px solid var(--line);
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.cp-body {
  padding: 12px;
  display: grid;
  gap: 10px;
  align-content: start;
  overflow-y: auto;
  max-height: 535px;
}
.cp-hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.link-sm {
  font-size: 12px;
  font-weight: 700;
}
.chart-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px 12px;
}
.chart-hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12.5px;
  margin-bottom: 6px;
}
.legend {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--mute);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}
.dot.seller { background: #f97316; }
.dot.buyer { background: #3454ff; }
.dot.ceil { background: #d9383e; }
.quote-svg {
  width: 100%;
  height: 128px;
  background: #fcfdff;
  border-radius: 8px;
}
.diff-bar {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.cp-note {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 9px 11px;
  font-size: 12px;
  line-height: 1.5;
}
.cp-ceil {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}
.cp-ceil > div {
  background: var(--panel);
  padding: 9px 10px;
  border-radius: 11px;
  border: 1px solid var(--line);
}
.cp-ceil span {
  display: block;
  font-size: 11px;
  color: var(--mute);
}
.cp-ceil b {
  font-size: 16px;
  font-weight: 900;
}
.acc-txt { color: var(--acc); }
.grn-txt { color: var(--grn); }

.ver-bars {
  display: grid;
  gap: 6px;
}
.ver-row {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr) 58px;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.ver-lbl {
  color: var(--mute);
  font-size: 11.5px;
}
.ver-track {
  height: 8px;
  background: var(--soft);
  border-radius: 999px;
  overflow: hidden;
}
.ver-fill {
  height: 100%;
  background: var(--acc);
  border-radius: 999px;
}

.tk-mini-list {
  display: grid;
  gap: 8px;
}
.tk-mini {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 9px 11px;
  display: grid;
  gap: 3px;
  color: var(--ink);
}
.tk-mini:hover {
  border-color: var(--acc);
  text-decoration: none;
}
.tk-r1 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}
.tk-mini b {
  font-size: 12.5px;
  line-height: 1.35;
}

.earn-hero {
  background: linear-gradient(135deg, #111827, #1e293b);
  color: #fff;
  border-radius: 13px;
  padding: 13px 14px;
  display: grid;
  gap: 6px;
}
.eh-top {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  opacity: 0.88;
}
.eh-big {
  font-size: 24px;
  font-weight: 900;
  color: #ffda00;
}
.eh-bar {
  height: 8px;
  background: rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  overflow: hidden;
}
.eh-fill {
  height: 100%;
  background: #ffda00;
  border-radius: 999px;
}
.eh-sub {
  font-size: 11.5px;
  opacity: 0.92;
}
.earn-split {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.earn-split > div {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 8px;
  text-align: center;
  display: grid;
  gap: 2px;
}
.earn-split span {
  font-size: 11px;
  color: var(--mute);
}
.earn-split b {
  font-size: 15px;
}
.earn-split small {
  font-size: 10.5px;
  color: var(--mute);
}

.cp-sec {
  display: grid;
  gap: 6px;
}
.cp-lbl {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--mute);
}
.cp-tpl {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 8px 10px;
  text-align: left;
  display: grid;
  gap: 3px;
}
.cp-tpl:hover {
  border-color: var(--acc);
}
.cp-tpl b {
  font-size: 12.5px;
}
.cp-tpl small {
  font-size: 11.5px;
  color: var(--mute);
  line-height: 1.35;
}

.cp-dock {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-top: 1px solid var(--line);
  background: var(--panel);
  padding: 5px 6px;
  gap: 4px;
}
.cp-dock button {
  padding: 6px 4px;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 11.5px;
  color: var(--mute);
}
.cp-dock button.on {
  background: var(--acc-soft);
  color: var(--acc);
  font-weight: 800;
}

/* 快照高清大图灯箱 */
.snap-dialog {
  border: 0;
  border-radius: 18px;
  padding: 0;
  max-width: 760px;
  width: 92vw;
  box-shadow: var(--sh-up);
  background: var(--panel);
  color: var(--ink);
}
.snap-dialog::backdrop {
  background: rgba(15, 23, 42, 0.62);
}
.sd-inner {
  padding: 20px;
  display: grid;
  gap: 14px;
}
.sd-hd {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.sd-stage {
  background: #0f172a;
  border-radius: 12px;
  height: 360px;
  display: grid;
  place-items: center;
  overflow: hidden;
}
.sd-stage img {
  max-height: 350px;
  max-width: 100%;
  object-fit: contain;
}
.sd-thumbs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.sd-th {
  border: 2px solid var(--line);
  border-radius: 10px;
  padding: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  background: var(--soft);
}
.sd-th.on {
  border-color: var(--acc);
  background: var(--acc-soft);
}
.sd-th img {
  width: 44px;
  height: 44px;
  border-radius: 6px;
  object-fit: cover;
}
.sd-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
  background: var(--soft);
  padding: 12px 14px;
  border-radius: 12px;
  font-size: 13px;
}
.sd-meta .wide {
  grid-column: 1 / -1;
}

@media (max-width: 1120px) {
  .im-grid, .im-grid.collapsed {
    grid-template-columns: minmax(0, 1fr);
  }
  .im-left {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .im-copilot {
    border-left: 0;
    border-top: 1px solid var(--line);
  }
}
</style>
