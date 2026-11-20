<template>
  <section class="card flow-card" id="sec-flow">
    <!-- 顶部标题 + 模式切换 + 一键回当前步 -->
    <div class="fc-head">
      <div>
        <h3>
          {{
            activeMode === 'issue'
              ? '💰 到货二次议价 · 双轨 9 步陪跑（买前10% + 到货实际退差10% 独立核算）'
              : '🛒 收货前采购 · 6 步手把手陪跑（含二次议价潜力研判 & 给仓管打重点验机标）'
          }}
          <Q :k="currentHelpKey" />
        </h3>
        <p class="muted" style="font-size: 13.5px">
          绿勾 ✓ 是已做完的，发光蓝圈是你现在要做的这一步；每一步只干一件事，点任意圆圈都能回看记录。
        </p>
      </div>

      <div class="fc-tools">
        <template v-if="isIssueCase">
          <button
            type="button"
            class="btn sm"
            :class="{ pri: activeMode === 'issue' }"
            @click="switchMode('issue')"
          >
            二次议价 9 步
          </button>
          <button
            type="button"
            class="btn sm"
            :class="{ pri: activeMode === 'buying' }"
            @click="switchMode('buying')"
          >
            回看买前打标记录
          </button>
        </template>

        <button
          v-if="viewStep !== curStepInMode"
          type="button"
          class="btn sm pri"
          @click="viewStep = curStepInMode"
        >
          回到当前第 {{ curStepInMode }} 步 ›
        </button>
      </div>
    </div>

    <!-- 圆圈连线步入式进度条（买前 6 步 / 到货二次议价 9 步） -->
    <div class="steps-scroll" data-tour="case-rail">
      <ol class="steps" :class="{ 'steps-9': displaySteps.length >= 9 }">
        <li
          v-for="s in displaySteps"
          :key="s.n"
          :class="[s.state, { view: viewStep === s.n }]"
          @click="viewStep = s.n"
        >
          <span class="c">{{ s.state === 'done' ? '✓' : s.n }}</span>
          <b>{{ s.t }}</b>
          <small>{{ s.state === 'done' ? '已做好' : s.state === 'cur' ? '现在做这步' : '还没到' }}</small>
        </li>
      </ol>
    </div>

    <!-- 二次议价模式专属：本单已调用心理×博弈锚点留痕条 + 一键直达定损参考表与手册 -->
    <div
      v-if="activeMode === 'issue'"
      style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px;border-radius:12px;background:var(--soft);border:1px solid var(--line);font-size:13px"
    >
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span class="tag" :class="arrivalTrackInput === 'signed_platform_return' ? 'amb' : 'red'">
          {{ arrivalTrackInput === 'signed_platform_return' ? '📦 轨道② 已签收/同城件（先退货等开口/Plan B）' : '⚡ 轨道① 顺丰到仓件（派送10m当场拒签加微）' }}
        </span>
        <b>🧠 心理×博弈锚点留痕：</b>
        <template v-if="flowState.tactics_used?.length">
          <span v-for="tc in flowState.tactics_used" :key="tc" class="tag grn">✓ 已用 {{ tc }}</span>
        </template>
        <span v-else class="muted">在第 4–8 步点任意 P1–P6 / G1–G6 话术即自动留痕</span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <a href="#/pricebook" class="btn sm">📊 查定损与选招参考表</a>
        <a href="#/manual" class="btn sm">📘 看 12 大心理博弈手册</a>
      </div>
    </div>

    <!-- ==================== 模式 A：收货前采购 6 步陪跑 ==================== -->
    <div v-if="activeMode === 'buying'" class="step-stage" :class="{ 'cur-stage': viewStep === curStepInMode }" data-tour="case-act">
      <!-- 买前第 1 步：看清货况锁原始快照 -->
      <template v-if="viewStep === 1">
        <div class="step-hd">
          <h4>第 1 步：看清型号与交易条件 · 锁死商品页原始快照 <span class="tag acc">采购员做</span></h4>
          <Term k="dont_overask">为什么只核型号不问划痕？</Term>
        </div>

        <div class="banner amb">
          📌 <b>第 1 步只做基础身份核对：</b>核清品牌型号、配置容量、本单使用账号，把卖家页面上的<b>原始文字、成色标、标价和原图</b>原封不动锁存下来。<b>注意：页面写过或照片模糊的成色问题千万先别乱问，下一步专门教你判二次议价空间！</b>
        </div>

        <div v-if="!c.conversation && !c.order" class="sub-card">
          <b>把卖家商品页上的原始描述锁存下来：</b>
          <div class="form-grid2">
            <label class="field">
              <span>卖家页面标价（元）<i class="req">*</i></span>
              <input v-model.number="initSellerYuan" type="number" class="input num" />
            </label>
            <label class="field">
              <span>页面显示的成色词<i class="req">*</i></span>
              <input v-model="initCond" class="input" placeholder="如：几乎全新 / 99新 / 95新" />
            </label>
          </div>
          <label class="field">
            <span>卖家商品页原话留底（原样复制卖家写的成色与配件承诺）<i class="req">*</i></span>
            <textarea v-model="initDecl" class="textarea" placeholder="例如：几乎全新自用爱惜无磕碰，电池96%，原盒原装充电器都在" />
          </label>
          <Lock
            :ok="unlocked"
            :busy="busy"
            reason="新员工请先点完顶部 3 个防踩坑小练习（2分钟）再操作真单"
            fix-text="去做 2 分钟练习"
            @fix="store.ui.practice = 'chat_guard'"
            @go="doInitCase"
          >
            ✓ 锁死商品原始快照，进入第 2 步判二次议价空间 ›
          </Lock>
        </div>

        <div class="ev-grid">
          <div v-for="(ev, key) in c.capture" :key="key" class="ev-card" :class="ev.state">
            <div class="ev-top">
              <b>{{ ev.name }}</b>
              <span class="tag" :class="ev.state === 'ok' ? 'grn' : ev.state === 'unknown' ? 'amb' : 'red'">
                {{ ev.state === 'ok' ? '✓ 已留好' : ev.state === 'unknown' ? '暂时拿不到' : '待补齐' }}
              </span>
            </div>
            <p class="ev-detail">{{ ev.detail }}</p>

            <div v-if="ev.state !== 'ok' && key !== 'price_shot'" class="ev-acts">
              <input
                v-model="suppInputs[key]"
                class="input"
                :placeholder="`填上核对好的${ev.name}说明…`"
              />
              <div class="ev-btn-row">
                <button type="button" class="btn sm pri" :disabled="busy" @click="doSupplement(key, false)">
                  保存留底
                </button>
                <button v-if="key === 'serial_report'" type="button" class="btn sm" :disabled="busy" @click="copyAskPhotoScript('serial_report')">
                  复制只问型号话术（不问划痕！）
                </button>
                <button type="button" class="btn sm" :disabled="busy" @click="doSupplement(key, true)">
                  卖家拍不出 · 诚实标暂时拿不到
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="next-bar">
          <span class="muted">基础型号与原始快照核清了？马上去第 2 步判断这单能不能做「二次议价」！</span>
          <button type="button" class="btn pri" @click="viewStep = 2">
            去第 2 步：判能否二次议价 & 给仓管打标 →
          </button>
        </div>
      </template>

      <!-- 买前第 2 步：进阶核心！判断能否二次议价 + 静默不问 + 给仓管打重点验机标 -->
      <template v-else-if="viewStep === 2">
        <div class="step-hd">
          <h4>
            第 2 步：判断这单能不能做「二次议价」· 给仓管打重点验机标
            <span class="tag red">进阶核心利润步！</span>
          </h4>
          <Term k="dont_overask">为什么写了几乎全新/图糊反而别问？</Term>
        </div>

        <!-- 三道傻瓜式勾选判断 -->
        <div class="sub-card">
          <b>① 对照闲鱼链接，如实点选下面 3 个特征（系统自动帮你判断有没有二次议价空间）：</b>
          <div class="check3-grid">
            <button
              type="button"
              class="chk-tile"
              :class="{ hit: evalWroteLikeNew }"
              @click="onToggleEval('like_new')"
            >
              <div class="ct-top">
                <b>1. 成色写了「几乎全新 / 99新 / 全新」吗？</b>
                <span class="tag" :class="evalWroteLikeNew ? 'red' : ''">{{ evalWroteLikeNew ? '✓ 写了几乎全新/充新' : '普通成色词' }}</span>
              </div>
              <p>卖家把话说得越满，只要到货有一道划痕、打油、缺泡沫或换件，就是铁证如山的描述不符！</p>
            </button>

            <button
              type="button"
              class="chk-tile"
              :class="{ hit: evalPhotosBlurry }"
              @click="onToggleEval('blurry')"
            >
              <div class="ct-top">
                <b>2. 卖家照片拍得很模糊 / 没拍全细节吗？</b>
                <span class="tag" :class="evalPhotosBlurry ? 'red' : ''">{{ evalPhotosBlurry ? '✓ 图很糊 / 漏拍边角底壳' : '高清多角度拍齐' }}</span>
              </div>
              <p>光线昏暗、只拍正面远景、不拍底壳边角或亮屏纯色图，大概率藏着使用痕迹！</p>
            </button>

            <button
              type="button"
              class="chk-tile"
              :class="{ safe: evalFullyDisclosed }"
              @click="onToggleEval('disclosed')"
            >
              <div class="ct-top">
                <b>3. 卖家已经把所有瑕疵都拍清写全了吗？</b>
                <span class="tag" :class="evalFullyDisclosed ? 'grn' : 'amb'">{{ evalFullyDisclosed ? '✓ 瑕疵已全披露' : '✕ 没披露全 / 藏着掖着' }}</span>
              </div>
              <p>如果每处掉漆划痕都拍了微距特写写进正文，到货就不能拿已知瑕疵二次议价了。</p>
            </button>
          </div>
        </div>

        <!-- 买前 5% 退款率防红标选号预警 -->
        <div v-if="evalCanBargain && c.account_risk?.will_breach_on_next_refund" class="banner red" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <span>
            🚨 <b>5% 防红标预警：</b>当前绑定【<b>{{ c.account_id }}</b>】近30天退款率已达 <b>{{ c.account_risk.refund_rate_pct }}%</b>（再退1单即升至 {{ c.account_risk.next_refund_rate_pct }}% 突破 5% 红标线）！高概率二次议价单建议换低退款率安全号拍下：
          </span>
          <button type="button" class="btn sm pri" :disabled="busy" @click="doSwitchSafeAccount">
            🔄 一键切用【闲鱼3号 (1.67% 安全号)】拍单
          </button>
        </div>

        <!-- 动态策略指令大卡片 -->
        <div v-if="evalCanBargain" class="calc-compare">
          <div class="cmp-box win" style="grid-column: 1 / -1">
            <div class="cmp-hd">
              <span>🎯 系统研判：这单是【高潜力二次议价肥单】！请严格按下面两条纪律操作：</span>
              <span class="tag red">严禁多嘴追问！</span>
            </div>
            <div style="font-size: 14.5px; line-height: 1.65">
              <div><b>纪律 1（闭嘴别问清）：</b>成色写了「几乎全新」或图片模糊不清时，<b>千万不要仔细问卖家“到底有没有划痕”、“你拍清楚点给我看”！</b>你一旦问清楚，卖家顺嘴回一句“二手难免有划痕不包成色”，就变成买前已告知，到货再也没法退差价了！<b>直接按链接里写的标准正常采购！</b></div>
              <div style="margin-top: 4px"><b>纪律 2（给仓管埋靶子）：</b>在下面勾选你怀疑的成色问题打上<b>「🎯 质疑成色·重点深检」</b>标记。包裹一到仓，赵仓管就会拿着放大镜和摄像头重点抓这些部位，抓到就是 <b>20% 高提成</b>！</div>
            </div>
          </div>
        </div>
        <div v-else class="banner amb">
          ⚠️ <b>系统研判：卖家已把所有瑕疵拍清披露，到货基本没有二次议价空间！</b>去第 3 步买前谈价时必须卡死最高出价上限，绝不能指望到货再砍一刀！
        </div>

        <!-- 给赵仓管打「质疑成色·重点验机」标记面板 -->
        <div class="sub-card" :class="{ 'ok-tint': c.prebuy_eval?.evaluated }">
          <div class="sub-hd">
            <b>② 给赵仓管打「🎯 质疑成色 · 到货重点深检」标记（点选重点抓查部位，绝不撒胡椒面）：</b>
            <label style="display:inline-flex;align-items:center;gap:6px;font-size:13.5px;font-weight:700;cursor:pointer">
              <input v-model="evalSuspectTag" type="checkbox" />
              <span>开启「🎯 质疑成色·重点深检」红靶标</span>
            </label>
          </div>

          <div v-if="evalSuspectTag" class="focus-chips">
            <button
              v-for="fp in presetFocusOptions"
              :key="fp"
              type="button"
              class="btn sm"
              :class="{ pri: evalFocusPoints.includes(fp) }"
              @click="toggleFocusPoint(fp)"
            >
              {{ evalFocusPoints.includes(fp) ? '✓ ' : '+ ' }}{{ fp }}
            </button>
          </div>

          <label class="field">
            <span>写给赵仓管的重点验机叮嘱（包裹到仓自动置顶弹给仓管）：</span>
            <input
              v-model="evalNoteToWh"
              class="input"
              placeholder="例如：【高危-几乎全新】卖家底壳图模糊未追问，到仓请重点强光查底壳划痕、屏幕亮斑与原装充电头！"
            />
          </label>

          <div class="agree-row">
            <Lock
              :ok="unlocked && (!evalSuspectTag || evalFocusPoints.length > 0)"
              :busy="busy"
              :reason="!unlocked ? '请先完成顶部 2 分钟新手练习' : '开启质疑成色标记时，请至少点选 1 个让仓管重点检查的部位'"
              @go="doSaveAssessBargain"
            >
              ✓ 确认二次议价判断 & 把重点验机标同步给赵仓管，去第 3 步谈价 ›
            </Lock>
          </div>
        </div>
      </template>

      <!-- 买前第 3 步：按打法谈拢买前价格 -->
      <template v-else-if="viewStep === 3">
        <div class="step-hd">
          <h4>第 3 步：按链接标准谈拢买前价格 <span class="tag acc">采购员做 · 超上限找主管</span></h4>
          <Term k="price_ladder">行情七折与三套打法说明</Term>
        </div>

        <div v-if="c.prebuy_eval?.can_secondary_bargain" class="banner amb">
          🎯 <b>本单已标记「可做二次议价 · 仓管重点验」：</b>跟卖家聊价格时<b>只谈价格和发货时间，绝对不要多嘴追问划痕成色</b>！按链接写的成色标准锁好交易即可（若属高危几乎全新单，可先按低折试探压价）。
        </div>
        <div v-else class="banner red">
          🛑 <b>本单卖家已把瑕疵全披露（无二次议价余地）：</b>买前成交价绝对不能超过最高出价上限 <b>{{ fmtYuan(c.prices?.ceiling_price_cents) }}</b>！谈不拢就找王主管或放弃，绝不亏本硬收。
        </div>

        <div class="four-nums num">
          <div class="fn-box">
            <span>卖家当前挂价</span>
            <b>{{ fmtYuan(c.conversation?.seller_price_cents || c.prices?.seller_or_agreed_cents) }}</b>
            <small>来源：{{ c.source_type }}</small>
          </div>
          <div class="fn-box hi">
            <span>① 建议开口试探价</span>
            <b>{{ fmtYuan(c.prices?.first_offer_cents) }}</b>
            <small>第 1 轮先按这个数干脆试探</small>
          </div>
          <div class="fn-box hi">
            <span>② 心里目标成交价</span>
            <b>{{ fmtYuan(c.prices?.target_price_cents) }}</b>
            <small>谈到这以内买前稳赚 10% 提成</small>
          </div>
          <div class="fn-box floor">
            <span>③ 你的最高出价上限</span>
            <b>{{ fmtYuan(c.prices?.ceiling_price_cents) }}</b>
            <small>参考价 {{ fmtYuan(c.prices?.ref_price_cents) }}（超上限找主管批）</small>
          </div>
        </div>

        <div v-if="c.conversation?.pause_state === 'pausing'" class="banner red" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <span>✋ 自动报价助手刚发了一句话还在路上！插话前先点右边按钮让它停稳，防止同一分钟报两个价穿帮。</span>
          <button type="button" class="btn sm pri" :disabled="busy" @click="doPauseAck">
            让自动助手停嘴 ✓
          </button>
        </div>

        <div v-if="c.conversation" class="sub-card">
          <div class="sub-hd">
            <b>跟卖家「{{ c.seller_name }}」的闲鱼对话记录</b>
            <span class="tag" :class="c.conversation.needs_manual ? 'red' : 'grn'">
              {{ c.conversation.ai_evidence }}
            </span>
          </div>

          <div class="chat-mini">
            <div v-for="m in c.messages" :key="m.msg_id" class="cm-row" :class="m.sender === 'seller' ? 'them' : 'us'">
              <small>{{ m.sender_label }}</small>
              <div class="cm-bub">{{ m.text }}</div>
            </div>
          </div>

          <div class="quick-pills">
            <span class="muted" style="font-size:12.5px">点一下直接填入话术（只谈价格与顺丰发货，不追问成色！）：</span>
            <button type="button" class="btn sm" @click="fillPreScript('first')">
              报开口价 {{ fmtYuan(c.prices?.first_offer_cents) }}
            </button>
            <button type="button" class="btn sm" @click="fillPreScript('target')">
              加一点到目标价 {{ fmtYuan(c.prices?.target_price_cents) }}
            </button>
            <button type="button" class="btn sm" @click="fillPreScript('change_price')">
              谈拢了催卖家改闲鱼链接价
            </button>
          </div>

          <div class="send-row">
            <input
              v-model="chatDraft"
              class="input"
              placeholder="输入发给卖家的话（自动拦截『参考价/底价/提成/二次议价』等内部词）…"
            />
            <Lock
              :ok="unlocked && !hitLeakWord && c.conversation.pause_state !== 'pausing'"
              :busy="busy"
              :reason="
                !unlocked
                  ? '请先完成顶部 2 分钟新手练习'
                  : hitLeakWord
                  ? `草稿里含有内部保密词「${hitLeakWord}」，绝对不能发给卖家！请删掉后再发`
                  : '请先点上方「让自动助手停嘴」再发消息'
              "
              penalty="把公司参考价或二次议价意图漏给卖家，这单直接报废！"
              @go="doSendMsg"
            >
              发送消息
            </Lock>
          </div>
        </div>

        <div class="sub-card ok-tint">
          <b>卖家松口答应价格了吗？填上谈好的价格进入第 4 步核对改价付款：</b>
          <div class="agree-row">
            <label class="field" style="max-width: 240px">
              <span>双方口头谈妥价（元）</span>
              <input v-model.number="agreedYuan" type="number" class="input num" />
            </label>

            <Lock
              :ok="unlocked && Boolean(c.conversation) && agreedCents > 0 && agreedCents <= (c.prices?.ceiling_price_cents || 0)"
              :busy="busy"
              :reason="
                !unlocked
                  ? '请先完成新手防踩坑练习'
                  : !c.conversation
                  ? '请先在第 1 步锁死商品快照开启对话'
                  : agreedCents > (c.prices?.ceiling_price_cents || 0)
                  ? `¥${agreedYuan} 超过了你的最高出价上限 ${fmtYuan(c.prices?.ceiling_price_cents)}！请点右边按钮找王主管特批`
                  : '请输入大于 0 的谈妥金额'
              "
              penalty="未经主管批准超上限买贵了，到货转卖直接亏损！"
              fix-text="请王主管特批"
              @fix="askBossOverCeiling"
              @go="doCreateOrderFromConv"
            >
              ✓ 记下谈妥价，去第 4 步核对闲鱼改价 ›
            </Lock>

            <button type="button" class="btn" @click="askBossOverCeiling">
              🆘 卖家死咬不降 · 问王主管批不批
            </button>
          </div>
        </div>
      </template>

      <!-- 买前第 4 步：核对闲鱼改价并付款锁快照 -->
      <template v-else-if="viewStep === 4">
        <div class="step-hd">
          <h4>第 4 步：核对闲鱼改价付钱 · 永久锁死买前快照 <span class="tag acc">采购员做</span></h4>
          <Term k="price_check">为什么分两小步？</Term>
        </div>

        <div class="banner amb">
          📌 <b>付款前三条铁律：</b>① 亲眼看闲鱼购买页标价真改成了谈妥价再付（光聊天答应不算）；② 单笔 ≤100 元小额单按「先发起OA → 再付款 → 当晚 22:00 审」，今晚 <b>21:00 前</b>必填齐已发货单号；③ <b>严禁拍运费到付</b>（仓库见到付件一律拒签）！
        </div>

        <div v-if="!c.order" class="errbox">
          还没在第 3 步登记口头谈妥价呢！请先回第 3 步填好谈妥价格。
          <button type="button" class="btn sm pri" style="margin-left:10px" @click="viewStep = 3">回第 3 步 ›</button>
        </div>

        <template v-else>
          <div class="sub-card">
            <div class="sub-hd">
              <b>① 第一小步：看一眼闲鱼购买页上的实时价格改好没？</b>
              <span class="tag" :class="priceCheckedOk ? 'grn' : 'red'">
                {{ priceCheckedOk ? '✓ 已核对一致' : '待核对页面改价' }}
              </span>
            </div>
            <p class="muted" style="font-size:13.5px">
              本单口头谈妥价：<b>{{ fmtYuan(c.order.agreed_cents) }}</b>。把你在闲鱼购买页亲眼看到的现价填在下面核对：
            </p>
            <div class="agree-row">
              <label class="field" style="max-width: 240px">
                <span>闲鱼页面当前显示的标价（元）</span>
                <input v-model.number="pageObservedYuan" type="number" class="input num" />
              </label>
              <Lock
                :ok="unlocked && Math.round(pageObservedYuan * 100) === c.order.agreed_cents"
                :busy="busy"
                :reason="
                  !unlocked
                    ? '请先完成新手防踩坑练习'
                    : `你填的闲鱼页面标价是 ¥${pageObservedYuan || 0}，跟谈妥价 ${fmtYuan(c.order.agreed_cents)} 不一致！快催卖家改好价刷新再看`
                "
                penalty="卖家没改价就直接付款，多付的差价很难要回来！"
                @go="doCheckPrice"
              >
                ✓ 我已亲眼核对闲鱼改价无误
              </Lock>
            </div>
          </div>

          <div class="sub-card" :class="{ 'ok-tint': c.order.paid_cents > 0 }">
            <div class="sub-hd">
              <b>② 第二小步：付完款填企业支付宝回执单号（自动锁死买前快照 + 推送仓管重点验机标）</b>
              <span class="tag" :class="c.order.paid_cents > 0 ? 'grn' : 'amb'">
                {{ c.order.paid_cents > 0 ? `✓ 已付 ${fmtYuan(c.order.paid_cents)} · 快照已锁死` : '核对改价后解锁' }}
              </span>
            </div>

            <div class="form-grid3">
              <label class="field">
                <span>实际支付金额（元）<i class="req">*</i></span>
                <input v-model.number="paidYuan" type="number" class="input num" />
              </label>
              <label class="field">
                <span>企业支付宝回执单号<i class="req">*</i></span>
                <input v-model="payReceiptNo" class="input mono" placeholder="如 PAY-ALI-20261116-88" />
              </label>
              <label class="field">
                <span>顺丰/快递运单号（卖家发了就填）</span>
                <input v-model="trackingNo" class="input mono" placeholder="如 SF1488990123" />
              </label>
            </div>

            <div class="agree-row" style="margin-top: 6px">
              <button v-if="!payReceiptNo" type="button" class="btn sm" @click="fillDemoPayReceipt">
                填入演示支付宝单号
              </button>

              <Lock
                :ok="unlocked && priceCheckedOk && paidReceiptValid"
                :busy="busy"
                :reason="
                  !unlocked
                    ? '请先完成新手防踩坑练习'
                    : !priceCheckedOk
                    ? '请先在上面第一小步点「我已亲眼核对闲鱼改价无误」'
                    : '请填写真实企业支付宝回执单号（至少 5 位，不能填 0 或无）'
                "
                penalty="付完钱不填单号锁死快照，万一卖家删改闲鱼链接，到货二次议价死无对证！"
                @go="doManualPay"
              >
                ✓ 保存实付单号并推送赵仓管验机 ›
              </Lock>

              <button
                v-if="!c.order.paid_cents"
                type="button"
                class="btn bad"
                :disabled="busy"
                @click="doCancelOrder"
              >
                卖家反悔不卖了 · 取消并退回预算
              </button>
            </div>
          </div>
        </template>
      </template>

      <!-- 买前第 5 步：包裹在派送 · 赵仓管 10 分钟内极速返回结果（速战速决·不符当场拒签！） -->
      <template v-else-if="viewStep === 5">
        <div class="step-hd">
          <h4>
            第 5 步：包裹正在派送 · 赵仓管 10 分钟内极速返回结果
            <span class="tag red">⚡ 派送触发 10 分钟极速 SLA · 速战速决！</span>
          </h4>
          <Term k="duty_sep">派送10分钟验货与当场拒签标准</Term>
        </div>

        <div class="banner amb" style="line-height: 1.6">
          ⚡ <b>公司极速铁律：每一单只要物流显示「正在派送」，赵仓管必须在 10 分钟内返回核验结果！</b><br />
          趁派送快递员在场速战速决：① 凡缺原厂泡沫内衬、缺 DP 线/原装电源支架、或命中未披露明显划痕亮斑，<b>一律当场拒签并拍下快递面单显示「已拒签」状态</b>；② 结果返回同一秒触发<b>业务员 10 分钟内加卖家微信强议价</b>！
        </div>

        <!-- 醒目展示采购买前预埋的「质疑成色·重点深检」红靶子！ -->
        <div v-if="c.prebuy_eval?.suspect_condition_tag" class="target-alert">
          <div class="ta-hd">
            <span class="tag red">🎯 采购预埋 · 质疑成色重点深检单</span>
            <small>买前卖家写「几乎全新/模糊未披露」，采购按纪律未打草惊蛇，请仓管重点抓拍以下部位：</small>
          </div>
          <div class="ta-chips">
            <span v-for="pt in (c.prebuy_eval.warehouse_focus_points || [])" :key="pt" class="ta-chip">
              🔍 {{ pt }}
            </span>
          </div>
          <p class="ta-note">采购叮嘱：{{ c.prebuy_eval.buyer_note_to_warehouse }}</p>
          <p class="muted" style="font-size:12.5px;margin-top:4px">
            📹 <b>取证硬标准：</b>未拆封前先起录外箱封条与面单 → 连续一镜到底（单段 ≥5 秒）→ 每处未披露瑕疵至少拍 <b>3 张不同角度近景特写</b>（注意：原盒只有外纸箱没有原厂泡沫内衬、缺DP线/支架螺丝一律算问题件）！
          </p>
        </div>

        <div class="sub-card">
          <b>买前锁死的卖家原始承诺（逐字核对）：</b>
          <p style="font-size:15px;font-weight:700;margin-top:4px">{{ c.capture?.declaration?.detail }}</p>
          <p class="muted" style="font-size:13px">
            支付回执：{{ c.order?.payment_receipt_no || '待填' }} · 运单号：{{ c.order?.tracking_no || '待卖家发货回填' }}
          </p>
        </div>

        <div class="sub-card">
          <b>赵仓管开箱实测结果分流（抓出未披露瑕疵立即开启 9 步二次议价利润引擎！）：</b>
          <div class="quick-pills">
            <span class="muted" style="font-size:12.5px">快捷填入实测结论：</span>
            <button type="button" class="btn sm" @click="whNote = '一镜到底核验：只有外纸箱无原厂泡沫内衬，缺原装DP线，且纯白亮屏右下角有3cm明显划痕（已拍3角度特写进ERP）'">
              填入：抓出无原厂泡沫+缺DP线+屏幕划痕
            </button>
            <button type="button" class="btn sm" @click="whNote = '一镜到底核验：序列号一致，屏幕外观与原装配件跟卖家描述完全一致'">
              填入：实测全对无差异
            </button>
          </div>
          <label class="field">
            <span>仓库开箱实测与瑕疵取证记录（至少 6 个字，自动沉淀 ERP 供后续销售自取）<i class="req">*</i></span>
            <textarea
              v-model="whNote"
              class="textarea"
              placeholder="写明未披露瑕疵的具体位置、长度/程度、配件包装缺失项及视频时间点…"
            />
          </label>

          <div class="agree-row">
            <Lock
              :ok="canWarehouseAct && Boolean(c.order?.paid_cents)"
              :busy="busy"
              kind="bad"
              :reason="
                !c.order?.paid_cents
                  ? '请先在第 4 步完成付款登记'
                  : '买货验货分离：点右边按钮一键切到【赵仓管】即可提交开箱瑕疵并启动二次议价'
              "
              :fix-text="c.order?.paid_cents && !canWarehouseAct ? '一键切到【赵仓管】抓差转议价' : ''"
              @fix="switchToRole('zhaocg')"
              @go="doWarehouseInspect('defect')"
            >
              🎯 抓出未披露瑕疵 · 立即转入「双轨 9 步二次议价」再拿 10% 到货提成 ›
            </Lock>

            <Lock
              :ok="canWarehouseAct && Boolean(c.order?.paid_cents)"
              :busy="busy"
              kind="ok"
              :reason="
                !c.order?.paid_cents
                  ? '还没在第 4 步登记付款单号'
                  : '点按钮切到【赵仓管】即可确认无差异入良品库'
              "
              @go="doWarehouseInspect('pass')"
            >
              ✓ 实测与描述完全一致 · 入良品库拿 10% 基础提成
            </Lock>
          </div>
        </div>
      </template>

      <!-- 买前第 6 步：无差异入库拿 10% 基础提成 -->
      <template v-else>
        <div class="step-hd">
          <h4>第 6 步：验机全对入良品库 · 10% 基础提成确认 <span class="tag grn">全部办妥</span></h4>
        </div>
        <div class="banner grn">
          🎉 <b>这笔采购单已圆满完结！</b>仓库验机与卖家买前承诺完全一致，机器已入良品库可售，你的买前省钱 <b>10% 提成（{{ fmtYuan(c.prices?.est_comm_cents) }}）</b> 已计入账本！
        </div>
        <p class="muted" style="font-size:14px">仓库入库备注：{{ c.warehouse_check_note }}</p>
      </template>
    </div>

    <!-- ==================== 模式 B：二次议价 · 问题订单 9 步细颗粒度陪跑 ==================== -->
    <div v-else class="step-stage" :class="{ 'cur-stage': viewStep === curStepInMode }" data-tour="case-act">
      <!-- 二次议价第 1 步：派送 10 分钟极速出结果 · 判路线 + 识别捡漏保底盈利单 -->
      <template v-if="viewStep === 1">
        <div class="step-hd">
          <h4>
            第 1 步：验货抓差 · 选择双轨议价路线（顺丰拒签闪电战 vs 已签收先退货等开口）
            <span class="tag grn">⚡ 仓管 {{ flowState.wh_10m_result_mins || 6 }} 分钟已出结果</span>
          </h4>
          <Term k="erp_self_service">ERP 瑕疵自取与两段 10% 提成</Term>
        </div>

        <!-- 本单所属闲鱼账号 5% 退款率 & 纠纷率防红标监控条 -->
        <div v-if="c.account_risk" class="banner" :class="c.account_risk.risk_level === 'grn' ? 'grn' : 'amb'">
          🛡️ <b>5% 防红标监控（{{ c.account_risk.account_label }}）：</b>
          近30天退款率 <b>{{ c.account_risk.refund_rate_pct }}%</b>（再退1单 → <b>{{ c.account_risk.next_refund_rate_pct }}%</b>）·
          纠纷率 <b>{{ c.account_risk.dispute_rate_pct }}%</b>（红线均 <b>≤ 5.0%</b>）——
          <b>非不必要，绝不跟卖家扯皮、绝不点小二介入！</b>
        </div>

        <div v-if="bp?.is_salvage_profitable" class="banner grn">
          💎 <b>系统自动预警【捡漏保底盈利肥单】：</b>这台买前价格够低，就算卖家一分不退原价收下，扣掉整备后依然净赚 <b>¥{{ Math.round((bp.salvage_zero_refund_net_cents || 0) / 100) }}</b>！先按半价狠砍冲 10% 到货提成，万一卖家强硬打 95338 死活不降，<b>严禁赌气真退</b>（第 7 步用「嫌弃式勉强收下」稳吃保底利润）！
        </div>
        <div v-else-if="flowState.hit_prebuy_tag" class="banner amb">
          🎯 <b>买前预埋标记精准命中！</b>买前未打草惊蛇追问，赵仓管按重点检查项（<b>{{ flowState.prebuy_focus || '外观成色与原装配件' }}</b>）抓出了未披露实锤证据，原片与 3 角度特写已沉淀进 ERP！
        </div>

        <div class="compare-ev">
          <div class="cev-box">
            <span class="tag acc">买前锁死快照（卖家原始承诺）</span>
            <p>{{ c.ticket?.evidence_declared || c.capture?.declaration?.detail }}</p>
            <small class="muted">注意：卖家买前已明确说过的瑕疵绝不能拿来找茬！只抓下面未披露项。</small>
          </div>
          <div class="cev-box bad">
            <span class="tag red">赵仓管一镜到底开箱抓出的「未披露差异」</span>
            <p>{{ c.ticket?.evidence_warehouse || c.warehouse_check_note }}</p>
            <small class="muted">✓ 开箱连续原片（≥5秒）+ 问题部位 3 张不同角度特写已绑本单 ERP</small>
          </div>
        </div>

        <div class="sub-card">
          <b>① 选择本单所属「双轨二次议价场景」（老板拍板双轨并行）：</b>
          <div class="settle-mode" style="margin-bottom: 10px">
            <label class="radio-pill" :class="{ on: arrivalTrackInput === 'sf_express_refuse' }">
              <input v-model="arrivalTrackInput" type="radio" value="sf_express_refuse" @change="returnModeInput = 'station_refuse'" />
              <span>⚡ 轨道① 顺丰到仓件闪电战：派送10m当场拒签 → 业务员10m确认面单已拒签+电联加微信直砍</span>
            </label>
            <label class="radio-pill" :class="{ on: arrivalTrackInput === 'signed_platform_return' }">
              <input v-model="arrivalTrackInput" type="radio" value="signed_platform_return" @change="returnModeInput = 'platform_return'" />
              <span>📦 轨道② 同城货拉拉/签收后测出暗病（如机械盘）：先提平台退货锁48h → 优先等卖家先开口提留货/Plan B</span>
            </label>
          </div>

          <b>② 判货物可留性（屏幕不碎、核心能用，原则上优先强议价留货转化利润）：</b>
          <div class="settle-mode">
            <label class="radio-pill" :class="{ on: triageRoute === 'bargain_keep' }">
              <input v-model="triageRoute" type="radio" value="bargain_keep" />
              <span>✓ 屏幕未碎 / 属成色配件参数差异 → 进入强议价留货（实际退差再拿 10% 提成）</span>
            </label>
            <label class="radio-pill" :class="{ on: triageRoute === 'direct_return' }">
              <input v-model="triageRoute" type="radio" value="direct_return" />
              <span>✕ 屏碎 / 主板进水大修 / 序列号不符锁机 → 严重硬伤不硬收，当天退回不过夜</span>
            </label>
          </div>

          <div class="agree-row">
            <Lock
              :ok="unlocked"
              :busy="busy"
              reason="请先完成顶部 2 分钟新手练习"
              @go="doStep1Triage"
            >
              ✓ 确认轨道与分流路线 · 进入第 2 步锁退货权 ›
            </Lock>
          </div>
        </div>
      </template>

      <!-- 二次议价第 2 步：拒签后黄金 10 分钟响应：确认面单已显示拒签 + 第一时间加卖家微信！ -->
      <template v-else-if="viewStep === 2">
        <div class="step-hd">
          <h4>
            第 2 步：拒签黄金 10 分钟响应 · 确认面单已拒签 + 第一时间加卖家微信
            <span class="tag red">⚡ 10 分钟内必办 · 速战速决！</span>
          </h4>
          <Term k="return_first">为什么先电联加微信不在闲鱼谈？</Term>
        </div>

        <div class="banner red" style="line-height:1.6">
          ⚡ <b>公司速战速决硬规矩（违者扣提成）：</b><br />
          ① <b>确认面单显示「拒签」：</b>东西拒签后，业务员必须在 <b>10 分钟内响应</b>，亲眼确认快递面单 / 顺丰物流轨迹上<b>已经显示「已拒签」</b>（卖家手机一收到拒签推送，损失厌恶瞬间拉满）！<br />
          ② <b>第一时间加对方微信（防闲鱼封号）：</b>严禁在闲鱼打字发“微信号 / wx / 便宜点 / 退差价”！<b>直接拨打面单电话口头秒加卖家微信</b>，把高清拒签原片和半价砍价全放到微信速战速决！
        </div>

        <div class="sub-card">
          <b>① 选择现场卡位方式 & 复制「零封号风险电联加微信」话术：</b>
          <div class="settle-mode">
            <label class="radio-pill" :class="{ on: returnModeInput === 'station_refuse' }">
              <input v-model="returnModeInput" type="radio" value="station_refuse" />
              <span>🌟 主力闪电战（派送当场拒签）：确认面单已显示「拒签」+ 电联第一时间加卖家微信</span>
            </label>
            <label class="radio-pill" :class="{ on: returnModeInput === 'platform_return' }">
              <input v-model="returnModeInput" type="radio" value="platform_return" />
              <span>开箱后发现暗病：先点闲鱼「退货退款」锁住 48h 倒计时 + 电联加卖家微信</span>
            </label>
          </div>

          <div class="sub-hd" style="margin-top:6px">
            <b>📞 拨打面单电话 10 秒加上卖家微信标准话术（闲鱼后台零违规痕迹）：</b>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button
                type="button"
                class="btn sm pri"
                @click="copyText(bp?.psychology_arsenal?.safe_add_wechat?.phone_script || '喂哥，刚顺丰派送现场核对跟描述有出入先做拒签了，你手机号能加微信吗？我马上加你把现场高清视频发你看下！', '已复制电联加微话术！')"
              >
                复制电联加微信话术
              </button>
              <button type="button" class="btn sm" @click="copyReturnApplyText">
                复制闲鱼合规客观说明（零微信号/零砍价词）
              </button>
            </div>
          </div>
          <div class="script-quote">
            {{ bp?.psychology_arsenal?.safe_add_wechat?.phone_script || standardReturnApplyText }}
          </div>
        </div>

        <div class="sub-card" :class="{ 'ok-tint': Boolean(c.ticket?.platform_return_no) }">
          <div class="sub-hd">
            <b>② 10 分钟响应双确认打卡（勾选面单已显示拒签 + 登记已加卖家微信，立即解锁后续砍价）：</b>
            <span class="tag" :class="c.ticket?.platform_return_no ? 'grn' : 'red'">
              {{ c.ticket?.platform_return_no ? `✓ 已确认拒签并加微 (${c.ticket.platform_return_no})` : '🔒 待 10 分钟内确认面单拒签+加微' }}
            </span>
          </div>

          <label class="chk-line">
            <input v-model="waybillRefusedChecked" type="checkbox" />
            <span><b>我已确认快递面单 / 顺丰物流轨迹上已经明确显示「已拒签」</b>（或已提交平台退货锁死时效）</span>
          </label>
          <label class="chk-line">
            <input v-model="sellerWechatAdded" type="checkbox" />
            <span><b>我已在 10 分钟内第一时间加上卖家微信</b>，并把仓管现场拒签/瑕疵实拍原片发给了对方</span>
          </label>

          <div class="agree-row" style="margin-top:6px">
            <label class="field" style="min-width: 210px; flex: 1">
              <span>面单拒签单号 / 闲鱼退货单号<i class="req">*</i></span>
              <input v-model="returnNoInput" class="input mono" placeholder="如 SF-REFUSE-8821" />
            </label>
            <label class="field" style="min-width: 190px; flex: 1">
              <span>已加卖家微信号/昵称（留痕）</span>
              <input v-model="sellerWechatIdInput" class="input" placeholder="如 laze / 萧山老楼" />
            </label>

            <button v-if="!returnNoInput" type="button" class="btn sm" @click="fillDemoReturnNo">
              填入演示拒签+微信号
            </button>

            <Lock
              :ok="unlocked && returnNoInput.trim().length >= 5 && (!isStationRefuseMode || waybillRefusedChecked) && sellerWechatAdded"
              :busy="busy"
              :reason="
                !unlocked
                  ? '请先完成顶部 2 分钟新手练习'
                  : !waybillRefusedChecked && isStationRefuseMode
                  ? '请先勾选确认快递面单上已经显示「已拒签」！'
                  : !sellerWechatAdded
                  ? '请先第一时间加上卖家微信并打勾确认！'
                  : '请输入面单拒签回执号或退货单号（至少 5 位字符）'
              "
              penalty="拒签超 10 分钟不响应、不确认面单拒签或不加微信跟进，按制度扣除本单全部提成！"
              @go="doSaveReturnFirst"
            >
              ✓ 10分钟响应完成 · 去第 3 步盯 95338 与卖家急迫信号 ›
            </Lock>
          </div>
        </div>
      </template>

      <!-- 二次议价第 3 步：盯顺丰 95338 实时动作 · 看卖家急不急 -->
      <template v-else-if="viewStep === 3">
        <div class="step-hd">
          <h4>第 3 步：微信发原片 · 盯顺丰 95338 动作看卖家急不急 <span class="tag amb">动作大于嘴硬！</span></h4>
          <Q k="iss-2" label="信号与95338" />
        </div>

        <div v-if="!c.ticket?.platform_return_no" class="errbox">
          🔒 请先回第 2 步确认面单已显示拒签并加上卖家微信！
          <button type="button" class="btn sm pri" style="margin-left:8px" @click="viewStep = 2">回第 2 步 ›</button>
        </div>

        <template v-else>
          <div class="banner amb">
            🧘 <b>速战速决判断法：加上卖家微信把拒签面单和瑕疵原片甩过去后，立刻看他两个信号：</b>① 他有没有急着问“能不能少点钱别退回来了”？② 他有没有真打<b>顺丰 95338</b> 让快递退回？<b>嘴上喊退但没打 95338 = 心虚想成交！直接进第 4 步首刀半价砍！</b>
          </div>

          <div class="sub-card">
            <b>① 当前顺丰 95338 双向物流实时状态（防包裹半路失控）：</b>
            <div class="settle-mode">
              <label class="radio-pill" :class="{ on: sf95338Input === 'station_hold' }">
                <input v-model="sf95338Input" type="radio" value="station_hold" />
                <span>📦 面单已标拒签 · 包裹暂存快递员/站点（黄金速战速决窗口！）</span>
              </label>
              <label class="radio-pill" :class="{ on: sf95338Input === 'seller_called_95338_return' }">
                <input v-model="sf95338Input" type="radio" value="seller_called_95338_return" />
                <span>🚨 卖家放狠话「我打 95338 已经让他退了」（开启防退走拦截锁，谈妥必须撤回 95338！）</span>
              </label>
            </div>

            <b style="margin-top:6px">② 点选卖家在微信里的第一反应（如实记录）：</b>
            <div class="sig-grid">
              <button
                v-for="sig in (bp?.seller_signals || [])"
                :key="sig.key"
                type="button"
                class="sig-item sig-btn"
                :class="[sig.color, { picked: signalPick === sig.key }]"
                @click="onPickSignal(sig.key)"
              >
                <div style="display:flex;justify-content:space-between;gap:6px;align-items:center">
                  <b>{{ sig.title }}</b>
                  <span v-if="signalPick === sig.key" class="tag acc">已选</span>
                </div>
                <p>{{ sig.advice }}</p>
              </button>
            </div>

            <!-- 博弈锚点 G2：鲁宾斯坦贴现因子 (δ) 耐心差诊断与战略晾单建议 -->
            <div v-if="bp?.rubinstein_model" class="banner grn" style="margin-top:6px">
              ♟️ <b>博弈锚点 G2 · 鲁宾斯坦耐心差压制（我方货源耐心 δ={{ bp.rubinstein_model.buyer_delta }} &gt; 卖家现金焦虑 δ={{ liveSellerDelta }}）：</b>
              <span class="tag acc" style="margin: 0 6px">{{ liveWaitBadge }}</span>
              <span>{{ liveWaitAdvice }}</span>
            </div>

            <label class="field" style="margin-top:6px">
              <span>卖家微信原话留痕（选填）：</span>
              <input
                v-model="sellerSignalWords"
                class="input"
                placeholder="例如：卖家急问『200 行不行？别退回来了』或『那你给我退回吧，我打 95338 已经让他退了』"
              />
            </label>

            <div class="agree-row">
              <Lock
                :ok="unlocked && Boolean(signalPick)"
                :busy="busy"
                reason="请点选上面三张卡片中的一种卖家信号"
                @go="doSaveSignal"
              >
                ✓ 记下卖家与 95338 状态 · 去第 4 步首刀直接半价大砍 ›
              </Lock>
            </div>
          </div>
        </template>
      </template>

      <!-- 二次议价第 4 步：首刀直接半价大砍（50%）· 砍得越多提成越多！ -->
      <template v-else-if="viewStep === 4">
        <div class="step-hd">
          <h4>
            第 4 步：首刀直接按半价大砍（50%）· 砍得越多你提成越多！
            <span class="tag red">🔪 首轮必对半砍 · 绝不心软！</span>
          </h4>
          <Term k="plan_b">首轮对半砍与四组数字规则</Term>
        </div>

        <div v-if="!c.ticket?.platform_return_no" class="errbox">
          🔒 请先回第 2 步确认面单拒签并加上卖家微信！
          <button type="button" class="btn sm pri" style="margin-left:8px" @click="viewStep = 2">回第 2 步 ›</button>
        </div>

        <template v-else-if="bp">
          <!-- 首刀双模定锚器：极简50%半价直砍 vs P3零整拆项精确锚+P1心理账户重置 -->
          <div class="sub-card ok-tint">
            <div class="sub-hd">
              <b>🔪 首刀双模心理定锚器（到货实际退差再拿 10% 提成，与买前 10% 独立叠加！按卖家段位切首刀）：</b>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button
                  type="button"
                  class="btn sm"
                  :class="{ pri: firstCutMode === 'half' }"
                  @click="firstCutMode = 'half'"
                >
                  🔪 模式1：50% 半价直砍（治急躁散客）
                </button>
                <button
                  type="button"
                  class="btn sm"
                  :class="{ pri: firstCutMode === 'precise' }"
                  @click="firstCutMode = 'precise'"
                >
                  🧮 模式2：P3 拆项精确锚 + P1 废单重估（治较真老手）
                </button>
              </div>
            </div>

            <template v-if="firstCutMode === 'half'">
              <div class="script-quote">
                {{ bp.psychology_arsenal?.half_price_first_cut?.short_wechat_quote }}
              </div>
              <div class="agree-row">
                <button
                  type="button"
                  class="btn sm pri"
                  @click="copyText(bp.psychology_arsenal?.half_price_first_cut?.short_wechat_quote || '', '已复制微信半价首刀金句！发完晾他等急')"
                >
                  📋 复制微信半价首刀（“{{ Math.round((bp.half_price_keep_cents || 0) / 100) }} 可以接受”）
                </button>
                <button
                  v-if="anchorByCode('G1')"
                  type="button"
                  class="btn sm"
                  @click="copyAndLogTactic(anchorByCode('G1'), 1, bp.anchor_a_cents)"
                >
                  ♟️ 叠加 G1 谢林默认退件锁（“不回我就自动退回亏运费”）
                </button>
              </div>
              <p class="muted" style="font-size:13px">
                💰 <b>提成账算清楚：</b>原单实付 <b>{{ fmtYuan(c.ticket?.paid_cents) }}</b>，首刀半价报 <b>{{ fmtYuan(bp.half_price_keep_cents) }}</b>（砍掉 <b>{{ fmtYuan(bp.half_price_slash_cents) }}</b> → 谈成你个人再拿 10% 到货提成 <b>{{ fmtYuan(bp.half_price_comm_cents) }}</b>！退一步按目标价谈成也拿 <b>{{ fmtYuan(Math.round(bp.target_b_cents * 0.1)) }}</b>！）
              </p>
            </template>

            <template v-else>
              <p class="muted" style="font-size:13px;line-height:1.5">
                🧠 <b>P1 塞勒心理账户重置 + P3 零整精确锚原理：</b>绝不说“你退我钱”（触发 2.25 倍割肉痛感），也绝不报整百拍脑袋数！改说<b>「原单已拒签作废，按 3 项有零头的客观定损单重新估价收货」</b>，锚定留存率提升 35%+！
              </p>
              <div v-if="preciseBreakdown" class="four-nums num" style="grid-template-columns: repeat(4, minmax(0, 1fr))">
                <div class="fn-box">
                  <span>① 二销成色降档</span>
                  <b>-¥{{ preciseBreakdown.part1_dep_yuan }}</b>
                  <small>客观成色差</small>
                </div>
                <div class="fn-box">
                  <span>② 配件/耗材补配</span>
                  <b>-¥{{ preciseBreakdown.part2_part_yuan }}</b>
                  <small>实补工料费</small>
                </div>
                <div class="fn-box">
                  <span>③ 拆检质保风险金</span>
                  <b>-¥{{ preciseBreakdown.part3_labor_yuan }}</b>
                  <small>测试工时费</small>
                </div>
                <div class="fn-box hi">
                  <span>现状重估收购价</span>
                  <b>¥{{ preciseBreakdown.precise_keep_yuan }}</b>
                  <small>你拿提成 ¥{{ preciseBreakdown.precise_comm_yuan }}</small>
                </div>
              </div>
              <div class="script-quote">{{ anchorByCode('P3')?.script }}</div>
              <div class="agree-row">
                <button
                  type="button"
                  class="btn sm pri"
                  @click="copyAndLogTactic(anchorByCode('P3'), 1, bp.anchor_a_cents)"
                >
                  📋 复制「P3 三项有零头精确核价话术」
                </button>
                <button
                  type="button"
                  class="btn sm"
                  @click="copyAndLogTactic(anchorByCode('P1'), 1, bp.anchor_a_cents)"
                >
                  🧠 复制「P1 心理账户清零·废单重估话术」
                </button>
              </div>
            </template>
          </div>

          <div class="four-nums num">
            <div class="fn-box hi">
              <span>① 首刀开口锚点 A（第一口报它！）</span>
              <b>{{ fmtYuan(bp.anchor_a_cents) }}</b>
              <small>折损 + 整备 {{ fmtYuan(bp.repair_cost_cents) }} + 谈判余量</small>
            </div>
            <div class="fn-box hi">
              <span>② 心里理想目标 B</span>
              <b>{{ fmtYuan(bp.target_b_cents) }}</b>
              <small>谈到这数你个人再拿 10% 到货提成 {{ fmtYuan(Math.round(bp.target_b_cents * 0.1)) }}</small>
            </div>
            <div class="fn-box floor">
              <span>③ 最低留货底线 C（系统红线）</span>
              <b>{{ fmtYuan(bp.floor_c_cents) }}</b>
              <small>低于此数留货不如退掉重买！</small>
            </div>
            <div class="fn-box">
              <span>④ 真实保底退路（底气来源）</span>
              <b style="font-size:16px">真退换买同款</b>
              <small>{{ bp.batna_label }}</small>
            </div>
          </div>

          <!-- 留货 vs 退货重买 净赚黄框对比试算器 -->
          <div class="sub-card">
            <div class="sub-hd">
              <b>📊 留下来 vs 退回去换买别家，实时净赚与你的到货 10% 提成测算：</b>
            </div>

            <div class="agree-row" style="margin-bottom: 10px">
              <label class="field" style="max-width: 240px">
                <span>试算退差金额（元，默认目标 B）</span>
                <input v-model.number="sellerOfferYuan" type="number" class="input num" />
              </label>
              <label class="field" style="max-width: 220px">
                <span>配原装件 / 整备维修成本（元）</span>
                <input v-model.number="repairYuan" type="number" class="input num" />
              </label>
              <Lock
                :ok="unlocked"
                :busy="busy"
                reason="请先完成新手练习"
                @go="doCalcBargain(true)"
              >
                🔄 锁定四组底牌，去第 5 步打首通电话破局 ›
              </Lock>
            </div>

            <div class="calc-compare num">
              <div class="cmp-box" :class="{ win: liveKeepNet > liveReplaceNet }">
                <div class="cmp-hd">
                  <span>路径 A：谈退 {{ fmtYuan(liveOfferCents) }} 把货留下来</span>
                  <span v-if="liveKeepNet > liveReplaceNet" class="tag grn">✓ 留货多赚 {{ fmtYuan(liveKeepNet - liveReplaceNet) }}</span>
                  <span v-else class="tag red">✕ 退太少 · 不如退货</span>
                </div>
                <div class="cmp-big">公司预计净赚：{{ fmtYuan(liveKeepNet) }}</div>
                <div class="muted" style="font-size:12.5px">
                  预计卖价 {{ fmtYuan(c.ticket?.s_market_cents) }} −（原实付 {{ fmtYuan(c.ticket?.paid_cents) }} − 退差 {{ fmtYuan(liveOfferCents) }} + 整备 {{ fmtYuan(liveRepairCents) }}）
                </div>
                <div class="cmp-comm">
                  💰 你个人再拿 10% 到货议价提成：{{ fmtYuan(Math.round(liveOfferCents * 0.1)) }}（与买前10%独立叠加）
                </div>
              </div>

              <div class="cmp-box" :class="{ win: liveKeepNet <= liveReplaceNet }">
                <div class="cmp-hd">
                  <span>路径 B：不留了，退回卖家重买同款</span>
                  <span v-if="liveKeepNet <= liveReplaceNet" class="tag amb">✓ 低于底线直接退货更赚</span>
                </div>
                <div class="cmp-big">退货重买净赚：{{ fmtYuan(liveReplaceNet) }}</div>
                <div class="muted" style="font-size:12.5px">
                  预计卖价 {{ fmtYuan(c.ticket?.s_market_cents) }} − 重买同款总成本 {{ fmtYuan(c.ticket?.r_replace_cost_cents) }}
                </div>
                <div class="muted" style="font-size:12.5px;margin-top:4px">
                  💡 记住制度保障：<b>低于底线 {{ fmtYuan(bp.floor_c_cents) }} 果断真退也是合格业绩，绝不扣罚！</b>有真退底气打电话才硬气！
                </div>
              </div>
            </div>
          </div>
        </template>
      </template>

      <!-- 二次议价第 5 步：假装毫不在意 · 说「不用了，谢谢」欲擒故纵游说 + 电话闭嘴 6 秒 -->
      <template v-else-if="viewStep === 5">
        <div class="step-hd">
          <h4>
            第 5 步：卖家着急挽留？假装毫不在意说「不用了，谢谢」+ 闭嘴 6 秒
            <span class="tag red">🎯 欲擒故纵核心心理战！</span>
          </h4>
          <Term k="silence_rule">为什么说“不用了谢谢”卖家反而大让步？</Term>
        </div>

        <template v-if="bp">
          <!-- 核心武器 1：卖家很着急问“能不能便宜几块/退200别退回来了”时的欲擒故纵三连击（1:1还原 laze 实战录像！） -->
          <div class="sub-card ok-tint">
            <div class="sub-hd">
              <b>{{ bp.psychology_arsenal?.indifferent_pushback?.title }}</b>
              <span class="tag red">严禁顺杆急着还价！</span>
            </div>
            <p class="muted" style="font-size:13.5px;line-height:1.55">
              💡 <b>实战心法：</b>很多人看到拒签后特别着急，主动问你“退你几十块 / 200 行不行，别退回来了”——<b>这时候千万别兴奋接茬讨价还价！</b>先<b>假装毫不在意推开说「不用了，谢谢」</b>，他怕来回顺丰保价费和重卖麻烦，立马主动往你的半价锚点大步加钱！
            </p>
            <div class="sig-grid">
              <div class="sig-item grn">
                <b>第 1 击：假装毫不在意推开（必发！）</b>
                <p>{{ bp.psychology_arsenal?.indifferent_pushback?.step1_brush_off }}</p>
                <button
                  type="button"
                  class="btn sm pri"
                  style="justify-self:start;margin-top:4px"
                  @click="copyText(bp.psychology_arsenal?.indifferent_pushback?.step1_brush_off, '已复制『不用啦，谢谢』！发完晾他一会儿')"
                >
                  复制「不用啦，谢谢」
                </button>
              </div>
              <div class="sig-item amb">
                <b>第 2 击：冷淡挂住半价/高位锚点</b>
                <p>{{ bp.psychology_arsenal?.indifferent_pushback?.step2_reanchor }}</p>
                <button
                  type="button"
                  class="btn sm"
                  style="justify-self:start;margin-top:4px"
                  @click="copyText(bp.psychology_arsenal?.indifferent_pushback?.step2_reanchor, '已复制冷淡挂锚话术！')"
                >
                  复制「XXX可以接受」
                </button>
              </div>
              <div class="sig-item grn">
                <b>第 3 击：游说退回三笔亏本账收网</b>
                <p>{{ bp.psychology_arsenal?.indifferent_pushback?.step3_persuade }}</p>
                <button
                  type="button"
                  class="btn sm pri"
                  style="justify-self:start;margin-top:4px"
                  @click="copyText(bp.psychology_arsenal?.indifferent_pushback?.step3_persuade, '已复制游说三笔账话术！')"
                >
                  复制游说收网话术
                </button>
              </div>
            </div>
          </div>

          <!-- 增量心理学 × 博弈学奇兵舱：点选卖家当前心理防御，一键甩出降维打击话术 -->
          <div v-if="step5TacticOptions.length" class="sub-card">
            <div class="sub-hd">
              <b>🧠 心理 × ♟️ 博弈进阶破防舱（卖家还在犹豫或炸毛？点选对应软肋一键击穿）：</b>
              <Term k="game_lemon_screening">12大心理博弈原理速查</Term>
            </div>
            <div class="obj-btns">
              <button
                v-for="item in step5TacticOptions"
                :key="item.code"
                type="button"
                class="btn sm"
                :class="{ pri: pickedPsychCode === item.code }"
                @click="pickedPsychCode = item.code"
              >
                {{ item.code.startsWith('P') ? '🧠' : '♟️' }} {{ item.code }} · {{ item.shortLabel }}
              </button>
            </div>
            <div v-if="curStep5Tactic" class="obj-detail">
              <div class="banner grn">
                <b>{{ curStep5Tactic.name }}</b>（{{ curStep5Tactic.theory }}）：{{ curStep5Tactic.when }}
              </div>
              <div class="script-quote">{{ curStep5Tactic.script }}</div>
              <div class="agree-row">
                <button
                  type="button"
                  class="btn sm pri"
                  :disabled="busy"
                  @click="copyAndLogTactic(curStep5Tactic, 1, bp.anchor_a_cents)"
                >
                  📋 复制「{{ curStep5Tactic.code }}」破防话术并记入博弈留痕
                </button>
              </div>
            </div>
          </div>

          <div class="banner amb">
            🎙️ <b>若直接打语音/电话：不是求卖家优惠，而是宣布「原价格已失效，重新定价」！</b>统一用<b>「哎哟期待落差 + 冷硬宣布原价不收 + 报准数 {{ fmtYuan(bp.anchor_a_cents) }} + 立刻闭嘴沉默 6 秒」</b>！
          </div>

          <div class="sub-card">
            <div class="six-steps">
              <b>📞 电话/微信语音 6 步顺口溜（20 秒一气呵成）：</b>
              <ol>
                <li v-for="(line, li) in bp.phone_6step" :key="li">{{ line }}</li>
              </ol>
            </div>

            <div class="style-row">
              <span class="muted" style="font-size:12.5px">按卖家类型切换首通逐字稿：</span>
              <button
                v-for="(lb, sk) in sellerStyles"
                :key="sk"
                type="button"
                class="btn sm"
                :class="{ pri: pickedStyle === sk }"
                @click="pickedStyle = sk"
              >
                {{ lb }}
              </button>
            </div>

            <div class="script-quote">{{ bp.scripts?.round1?.by_style?.[pickedStyle] }}</div>

            <!-- 互动式「黄金 6 秒闭嘴倒计时器」：专门治新员工报完价心虚自砍！ -->
            <div class="silence-box" :class="{ done: silenceDone || flowState.silence_6s_done }">
              <div>
                <b>⏱️ 黄金 6 秒闭嘴训练器：</b>
                <p class="muted" style="font-size:13px;margin-top:2px">
                  报完首刀锚点 {{ fmtYuan(bp.anchor_a_cents) }} 或发完「不用啦，谢谢」那一秒，点右边按钮盯着读秒，<b>读完前一个字都不准多说！</b>
                </p>
              </div>
              <button
                type="button"
                class="btn"
                :class="silenceLeft > 0 ? 'bad' : 'pri'"
                :disabled="silenceLeft > 0"
                @click="startSilenceTimer"
              >
                <template v-if="silenceLeft > 0">🤫 闭嘴沉默中… 剩 {{ silenceLeft }} 秒</template>
                <template v-else-if="silenceDone || flowState.silence_6s_done">✓ 已稳住 6 秒沉默（重练点此）</template>
                <template v-else>▶ 我刚报完价 · 点此默数 6 秒闭嘴</template>
              </button>
            </div>

            <div class="agree-row">
              <Lock
                :ok="unlocked && Boolean(c.ticket?.platform_return_no)"
                :busy="busy"
                reason="请先完成第 2 步确认拒签并加上微信"
                @go="doRound1Complete"
              >
                ✓ 已完成首刀半价锚 & 欲擒故纵破局 · 去第 6 步拆招游说 ›
              </Lock>
            </div>
          </div>
        </template>
      </template>

      <!-- 二次议价第 6 步：卖家顶嘴拆招 + MESO 等价多方案 + 递减阶梯让步 -->
      <template v-else-if="viewStep === 6">
        <div class="step-hd">
          <h4>第 6 步：卖家顶嘴拆招 · 递减阶梯让步 & 多方案组合 <span class="tag acc">每让一步必换当场确认</span></h4>
          <Q k="iss-3" label="拆招与让步纪律" />
        </div>

        <template v-if="bp">
          <!-- 1) 递减让步纪律条 -->
          <div class="ladder-bar">
            <div v-for="(ls, lsi) in (bp.ladder_steps || [])" :key="lsi" class="ld-step">
              <span>{{ ls.round }}</span>
              <b class="num">¥{{ ls.yuan }}</b>
              <small>{{ ls.rule }}</small>
            </div>
          </div>

          <!-- 2) 卖家 5 类顶嘴精准拆招器 -->
          <div class="sub-card">
            <b>① 卖家刚才怎么顶嘴的？点一下卖家原话，秒出「给台阶、不吵架、压实价」回法：</b>
            <div class="obj-btns">
              <button
                v-for="(ob, oi) in (bp.objection_routes || [])"
                :key="ob.key"
                type="button"
                class="btn sm"
                :class="{ pri: pickedObjIdx === oi }"
                @click="pickedObjIdx = oi"
              >
                {{ ob.label }}
              </button>
            </div>

            <div v-if="curObj" class="obj-detail">
              <div class="banner amb">💡 <b>拆招心法：</b>{{ curObj.tip }}</div>
              <div class="script-quote">{{ curObj.reply }}</div>
              <div class="agree-row">
                <button
                  type="button"
                  class="btn sm pri"
                  :disabled="busy"
                  @click="copyAndLogRound(2, 'buyer', bp.target_b_cents, curObj.reply, true)"
                >
                  复制拆招话术并记入跟进记录
                </button>
                <button
                  v-if="curObj.key === 'just_return'"
                  type="button"
                  class="btn sm bad"
                  @click="viewStep = 7"
                >
                  卖家真喊退了 → 直接去第 7 步「先退冷却·二次回拨」›
                </button>
              </div>
            </div>
          </div>

          <!-- 2.5) 心理锚点 P5：红白脸双人权力隔离（ERP系统黑脸锁死上限 + 采购员白脸私人贴补收口） -->
          <div v-if="bp.red_face_voucher" class="sub-card">
            <div class="sub-hd">
              <b>🎭 心理锚点 P5 · 红白脸权力隔离（把拒绝推给冷酷 ERP 系统，你演帮卖家争取的自己人！）：</b>
              <span class="tag red">防卖家死缠烂打逼让步</span>
            </div>
            <div class="compare-ev" style="margin-top:2px">
              <div class="cev-box" style="border-style:dashed">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
                  <span class="tag acc">对外脱敏可发卖家 · {{ bp.red_face_voucher.voucher_no }}</span>
                  <small class="muted">✓ 已自动隐去公司毛利与提成</small>
                </div>
                <p style="font-size:13px;margin-top:4px">
                  机型：<b>{{ bp.red_face_voucher.model_code }}</b>｜实测差异：{{ bp.red_face_voucher.defect_summary }}<br />
                  系统定损：降档 <b>-¥{{ bp.red_face_voucher.part1_dep_yuan }}</b> · 补件 <b>-¥{{ bp.red_face_voucher.part2_part_yuan }}</b> · 拆检 <b>-¥{{ bp.red_face_voucher.part3_labor_yuan }}</b><br />
                  <b style="color:var(--red-ink)">🛑 ERP 系统锁死最高收购红线：¥{{ bp.red_face_voucher.system_locked_max_yuan }}</b>
                </p>
              </div>
              <div class="cev-box">
                <span class="tag grn">你唱白脸 · 私人权限贴补 ¥{{ bp.red_face_voucher.good_cop_bonus_yuan }} 收口</span>
                <p style="font-size:13px;margin-top:4px">{{ anchorByCode('P5')?.script }}</p>
              </div>
            </div>
            <div class="agree-row">
              <button
                type="button"
                class="btn sm"
                @click="copyText(bp.red_face_voucher.desensitized_copy_card, '已复制脱敏《仓检核价回执卡》！先发给卖家立黑脸规矩')"
              >
                📄 复制脱敏《ERP定损红线卡》发卖家
              </button>
              <button
                type="button"
                class="btn sm pri"
                :disabled="busy"
                @click="copyAndLogTactic(anchorByCode('P5'), 2, bp.target_b_cents)"
              >
                🎭 复制「白脸私人贴 ¥{{ bp.red_face_voucher.good_cop_bonus_yuan }} 收口话术」并留痕
              </button>
            </div>
          </div>

          <!-- 3) 博弈机制设计菜单：MESO 三选一 / G4 三契约测谎仪 / G6 多机同行长期收编 -->
          <div class="sub-card">
            <div class="sub-hd">
              <b>② 博弈收网组合拳：等价三选一（MESO）× G4 三契约测谎仪 × G6 同行长期收编</b>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button type="button" class="btn sm" :class="{ pri: step6GameTab === 'meso' }" @click="step6GameTab = 'meso'">
                  📦 等价三选一方案
                </button>
                <button type="button" class="btn sm" :class="{ pri: step6GameTab === 'g4' }" @click="step6GameTab = 'g4'">
                  🎲 G4 赫维茨测谎三契约
                </button>
                <button type="button" class="btn sm" :class="{ pri: step6GameTab === 'g6' }" @click="step6GameTab = 'g6'">
                  🤝 G6 重复博弈收编同行
                </button>
              </div>
            </div>

            <div v-if="step6GameTab === 'meso'" class="sig-grid">
              <div v-for="mo in (bp.meso_options || [])" :key="mo.key" class="sig-item grn">
                <b>{{ mo.title }}</b>
                <p>{{ mo.desc }}</p>
                <button
                  type="button"
                  class="btn sm"
                  style="margin-top:4px;justify-self:start"
                  :disabled="busy"
                  @click="copyAndLogMeso(mo)"
                >
                  复制此方案发给卖家
                </button>
              </div>
            </div>

            <div v-else-if="step6GameTab === 'g4' && anchorByCode('G4')" class="obj-detail">
              <div class="banner amb">
                🎲 <b>{{ anchorByCode('G4').name }}：</b>{{ anchorByCode('G4').when }}
              </div>
              <div class="script-quote">{{ anchorByCode('G4').script }}</div>
              <div class="agree-row">
                <button type="button" class="btn sm pri" :disabled="busy" @click="copyAndLogTactic(anchorByCode('G4'), 2, bp.target_b_cents)">
                  📋 复制「G4 三契约测谎话术」（逼撒谎卖家乖乖选现金折让）
                </button>
              </div>
            </div>

            <div v-else-if="step6GameTab === 'g6' && anchorByCode('G6')" class="obj-detail">
              <div class="banner grn">
                🤝 <b>{{ anchorByCode('G6').name }}：</b>{{ anchorByCode('G6').when }}
              </div>
              <div class="script-quote">{{ anchorByCode('G6').script }}</div>
              <div class="agree-row">
                <button type="button" class="btn sm pri" :disabled="busy" @click="copyAndLogTactic(anchorByCode('G6'), 2, bp.target_b_cents)">
                  📋 复制「G6 长期供货白名单收编话术」
                </button>
              </div>
            </div>
          </div>

          <!-- 4) 登记卖家最新松口金额（实时联动算账与 20% 提成） -->
          <div class="sub-card ok-tint">
            <b>③ 卖家松口还价到多少了？填进来自动重算净赚（若卖家死咬不退，直接点右边去第 7 步冷却二次回拨）：</b>
            <div class="agree-row">
              <label class="field" style="max-width: 220px">
                <span>卖家最新愿意退差价（元）</span>
                <input v-model.number="sellerReplyYuan" type="number" class="input num" placeholder="如 300" />
              </label>
              <label class="field" style="flex:1;min-width:220px">
                <span>卖家回复摘要</span>
                <input v-model="sellerReplyNote" class="input" placeholder="如：卖家答应退 300 元，要求马上确认收货" />
              </label>
              <Lock
                :ok="unlocked && Number(sellerReplyYuan) > 0"
                :busy="busy"
                reason="请输入卖家松口的退差金额"
                @go="doLogSellerOffer"
              >
                ✓ 记下卖家报价（算清划算去第 8 步落袋）›
              </Lock>
              <button type="button" class="btn" @click="viewStep = 7">
                卖家嘴硬不让 → 去第 7 步冷却二次回拨 ›
              </button>
            </div>

            <!-- 历史过招时间线 -->
            <div v-if="bp.logs?.length" class="blog-list">
              <b style="font-size:13px;color:var(--mute)">本单逐轮过招记录（{{ bp.logs.length }} 条，完整留痕）：</b>
              <div v-for="lg in bp.logs" :key="lg.log_id" class="blog-item" :class="lg.role_side">
                <span><b>{{ lg.speaker_label }}</b> {{ lg.ask_refund_cents ? `· ${fmtYuan(lg.ask_refund_cents)}` : '' }}</span>
                <p>{{ lg.text }}</p>
              </div>
            </div>
          </div>
        </template>
      </template>

      <!-- 二次议价第 7 步：强硬卖家（打 95338 喊退）双杀路由：①「嫌弃式勉强收下」保利润 vs ② 冷却二次回拨 -->
      <template v-else-if="viewStep === 7">
        <div class="step-hd">
          <h4>
            第 7 步：卖家态度极强硬（打 95338 喊退）·「嫌弃式勉强收下」vs 冷却二次回拨
            <span class="tag red">专治硬骨头 · 绝不赌气丢利润！</span>
          </h4>
          <Term k="cooldown_callback">强硬卖家双杀心法</Term>
        </div>

        <template v-if="bp">
          <!-- 如果第 5/6 步已经谈妥高于底线，提供一键免冷却直通第 8 步 -->
          <div v-if="(c.ticket?.partial_refund_cents || 0) >= bp.floor_c_cents" class="sub-card ok-tint">
            <div class="sub-hd">
              <b>🎉 前面卖家已松口愿退 {{ fmtYuan(c.ticket.partial_refund_cents) }}（高于底线 {{ fmtYuan(bp.floor_c_cents) }}），无需冷却可直接去第 8 步落袋！</b>
              <button type="button" class="btn sm pri" :disabled="busy" @click="doCooldownAction('skip_already_agreed')">
                已谈拢免冷却 · 直接去第 8 步落袋 ›
              </button>
            </div>
          </div>

          <!-- 路线 A（老板亲授实战王牌！）：对方态度极强硬，但本单急用/买前捡漏保底仍赚钱 ->「嫌弃式勉强收下」给台阶撤 95338！ -->
          <div class="sub-card" :class="{ 'ok-tint': bp.is_salvage_profitable }">
            <div class="sub-hd">
              <b>{{ bp.psychology_arsenal?.reluctant_accept_tough?.title }}</b>
              <span class="tag" :class="bp.is_salvage_profitable ? 'grn' : 'amb'">
                {{
                  bp.is_salvage_profitable
                    ? `💎 保底仍净赚 ¥${bp.psychology_arsenal?.reluctant_accept_tough?.salvage_profit_yuan} · 严禁赌气退走！`
                    : '仅限客户急用特批场景'
                }}
              </span>
            </div>
            <p class="muted" style="font-size:13.5px;line-height:1.6">
              {{ bp.psychology_arsenal?.reluctant_accept_tough?.coach }}
            </p>
            <div class="script-quote">{{ bp.psychology_arsenal?.reluctant_accept_tough?.script }}</div>
            <div class="agree-row">
              <button
                type="button"
                class="btn sm pri"
                @click="copyText(bp.psychology_arsenal?.reluctant_accept_tough?.script, '已复制『算了吧太急了勉强收下』台阶话术！发给卖家让他撤回 95338')"
              >
                📋 复制「算了吧太急了，虽然这么烂我也勉强收下」话术
              </button>
              <label class="field" style="max-width: 210px">
                <span>顺手让卖家抹零金额（元，可填0）</span>
                <input v-model.number="reluctantTokenWipeYuan" type="number" class="input num" placeholder="如 50 或 0" />
              </label>
              <Lock
                :ok="unlocked && (bp.is_salvage_profitable || role.role === 'supervisor')"
                :busy="busy"
                kind="ok"
                reason="本单原价留货无保底毛利，若确实客户急等需强留请找王主管特批"
                @go="doCooldownAction('reluctant_salvage_keep')"
              >
                ✓ 嫌弃式勉强收下（提醒撤回 95338）· 保住利润去第 8 步 ›
              </Lock>
            </div>
          </div>

          <!-- 路线 B：常规「先退后回」15–60 分钟战略冷却重算 & 二次回拨救单 + G5 顺丰封车截单最后通牒 -->
          <div class="sub-card">
            <div class="sub-hd">
              <b>📞 路线 B（冷却 15–60 分钟二次回拨 + ♟️ G5 顺丰封车前最后 20 分钟通牒压底线 {{ fmtYuan(bp.floor_c_cents) }}）：</b>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button
                  v-if="anchorByCode('G5')"
                  type="button"
                  class="btn sm pri"
                  @click="copyAndLogTactic(anchorByCode('G5'), 3, bp.floor_c_cents)"
                >
                  ⏰ 复制「G5 顺丰20分钟后扫码封车·最后通牒」
                </button>
                <button type="button" class="btn sm" @click="copyText(bp.callback_script, '二次回拨救单话术已复制！')">
                  复制电话二次回拨逐字稿
                </button>
              </div>
            </div>
            <div class="script-quote">{{ anchorByCode('G5')?.script || bp.callback_script }}</div>

            <div class="form-grid2" style="margin-top:6px">
              <label class="field">
                <span>本次实际冷却间隔（分钟，参考 15–60 分钟）</span>
                <input v-model.number="cooldownMinsInput" type="number" class="input num" />
              </label>
              <label class="field">
                <span>二次回拨卖家最终答应补差（元，若救单成功）</span>
                <input v-model.number="rescuedYuanInput" type="number" class="input num" />
              </label>
            </div>

            <div class="agree-row" style="margin-top:6px">
              <Lock
                :ok="unlocked && Math.round(rescuedYuanInput * 100) >= bp.floor_c_cents"
                :busy="busy"
                kind="ok"
                :reason="
                  !unlocked
                    ? '请先完成新手练习'
                    : `二次回拨救单补差不能低于底线 ${fmtYuan(bp.floor_c_cents)}（若本单保底赚钱想勉强收下，请用上方路线 A！）`
                "
                @go="doCooldownAction('rescued_keep')"
              >
                ✓ 二次回拨救单成功！锁定补差去第 8 步落袋 ›
              </Lock>

              <button type="button" class="btn bad" :disabled="busy" @click="doCooldownAction('confirm_full_return')">
                ✕ 既不让步又无保底利润 · 果断和平真退（绝不扯皮 · 合格退出不扣罚）›
              </button>
            </div>
          </div>

          <!-- 路线 C 防呆硬锁：严控纠纷率 ≤ 5% · 非必要绝不扯皮 / 绝不擅点平台小二介入 -->
          <div class="sub-card" style="border-color: var(--red)">
            <div class="sub-hd">
              <b>🚫 防红标死红线：退款率 &amp; 纠纷率不得超过 5% · 非不必要绝不扯皮或点小二介入！</b>
              <Term k="rate_5pct_guard">5%防红标说明</Term>
            </div>
            <p class="muted" style="font-size:13px;line-height:1.55">
              平台风控对<b>退款率 &gt; 5%</b> 或 <b>纠纷介入率 &gt; 5%</b> 一律打红标限流！普通成色/配件分歧：<b>有利润走上方路线 A 勉强收下，没利润点上方「和平真退」干脆寄回</b>，严禁跟卖家斗嘴扯皮或点「申请小二介入 / 闲鱼小法庭」！仅遇恶意空包/假货诈骗时由【王主管】特批：
            </p>
            <div class="agree-row">
              <input
                v-model="fraudInterventionReason"
                class="input"
                style="max-width:340px"
                placeholder="仅限假货/空包诈骗填写证据说明（普通成色争议禁填）"
              />
              <Lock
                :ok="role.role === 'supervisor' && fraudInterventionReason.trim().length >= 4"
                :busy="busy"
                kind="bad"
                :reason="
                  role.role !== 'supervisor'
                    ? '非必要严禁申请小二介入（防破5%纠纷率弹红标）！确属假货诈骗请点右侧切到【王主管】核实特批'
                    : '请写明恶意诈骗/假货事实（至少4个字）后再特批介入'
                "
                :fix-text="role.role !== 'supervisor' ? '切【王主管】核验诈骗特批' : ''"
                penalty="擅自跟卖家扯皮或乱点小二介入导致账号破 5% 弹红标的，直接取消当月评优！"
                @fix="switchToRole('wangzg')"
                @go="doRequestIntervention"
              >
                🛡️ 王主管特批重大诈骗介入（计入 5% 纠纷率监控）
              </Lock>
            </div>
          </div>
        </template>
      </template>

      <!-- 二次议价第 8 步：整单全退关单（防红标/防差评/防二次申诉）+ 支付宝对公支付订单登记（T+1 次日10点审批） -->
      <template v-else-if="viewStep === 8">
        <div class="step-hd">
          <h4>
            第 8 步：整单全退关闭脱离管辖 · 支付宝对公支付订单登记
            <span class="tag red">防红标 · 防差评 · T+1次日10点审批</span>
          </h4>
          <Term k="wechat_850">为什么整单退掉不走部分退款？</Term>
        </div>

        <div v-if="c.ticket?.carrier_intercept_status === 'requested'" class="errbox" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <span>🚚 <b>注意：包裹还在顺丰半路拦截中！</b>请先去第 9 步由赵仓管确认包裹已截回仓库，再提交留货落袋！</span>
          <button type="button" class="btn sm pri" @click="viewStep = 9">去第 9 步确认顺丰截回 ›</button>
        </div>

        <!-- 核心风控锚点提示卡：为什么 2000 谈成 800 必须整单退掉关单 + 走支付宝对公支付！ -->
        <div class="banner amb" style="line-height: 1.65">
          🛡️ <b>核心风控锚点（如 ¥2,000 议价到 ¥800 成交，为什么绝不在平台申请部分退款？）：</b><br />
          ① <b>防账号红标：</b>平台风控一刀切，不管你是合理议价还是恶意砍价，频繁「部分退款」账号就会弹红标限流！<br />
          ② <b>防恶意差评 & 防二次申诉：</b>只要走了部分退款，仍有资金走平台——卖家事后不仅能刷<b>恶意差评</b>，还能向平台<b>二次申诉反咬</b>！<b>把闲鱼整单全额退掉关闭交易后，平台彻底失去管辖权，零差评、零二次申诉！</b><br />
          ③ <b>支付宝对公支付 + 订单登记 + 次日 10:00（T+1）审批：</b>谈妥的新总价统一用公司<b>【支付宝对公支付】</b>直接转给卖家，必须在下方做好<b>订单登记</b>交财务审批（因账单是 <b>T+1</b> 的，统一在<b>次日早上 10:00</b> 审批完成打款，严禁员工私人转账）！
        </div>

        <div class="sub-card">
          <b>① 选择结算落袋路径（大额折让默认必选方式 1 整单退关单 + 支付宝对公支付登记）：</b>
          <div class="settle-mode">
            <label class="radio-pill" :class="{ on: settleMode === 'corp_alipay_close' }">
              <input v-model="settleMode" type="radio" value="corp_alipay_close" />
              <span>🌟 方式 1（大额折让主推）：闲鱼整单全额退掉关单 + 支付宝对公支付直转卖家（T+1次日10点审批 · 零差评零二次申诉）</span>
            </label>
            <label class="radio-pill" :class="{ on: settleMode === 'zero_refund_keep' }">
              <input v-model="settleMode" type="radio" value="zero_refund_keep" />
              <span>🛡️ 方式 2（保 5% 退款率红线优选）：原单照常确认收货 + 卖家直补小额差价/勉强收下（0%退款率 · 0%纠纷率占用！）</span>
            </label>
            <label class="radio-pill" :class="{ on: settleMode === 'platform' }">
              <input v-model="settleMode" type="radio" value="platform" />
              <span>方式 3（仅限低退款率号极小额例外）：闲鱼平台内退部分差价（⚠️ 占退款率且有差评风险）</span>
            </label>
          </div>

          <!-- 方式 1：整单全退 + 支付宝对公支付订单登记表 -->
          <div v-if="settleMode === 'corp_alipay_close'" class="sub-card ok-tint" style="margin-top:8px">
            <div class="sub-hd">
              <b>🏦 整单全退 + 支付宝对公支付订单登记表（提交后进入陈会计「次日 10:00 T+1 账单审批」队列）：</b>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button
                  v-if="bp?.psychology_arsenal?.wechat_4elem_lock?.script"
                  type="button"
                  class="btn sm pri"
                  @click="copyText(bp.psychology_arsenal.wechat_4elem_lock.script, '已复制《微信四要素文字定案卡》！发微信让卖家回『确认同意』防反水')"
                >
                  📝 复制《微信四要素定案卡》（防反水必发！）
                </button>
                <button
                  v-if="anchorByCode('P6')"
                  type="button"
                  class="btn sm"
                  @click="copyAndLogTactic(anchorByCode('P6'), 3, 0)"
                >
                  🕊️ 复制「P6 峰终面子补偿金句」（消除屈辱感·防半夜反水！）
                </button>
                <button
                  v-if="bp?.corp_alipay_seller_script"
                  type="button"
                  class="btn sm"
                  @click="copyText(bp.corp_alipay_seller_script, '已复制！发给卖家引导点整单全退并提供收款支付宝')"
                >
                  📋 复制「整单退 + 明早10点对公打款」说明
                </button>
                <button v-if="!sellerAlipayAccount" type="button" class="btn sm" @click="fillDemoCorpAlipay">
                  填入演示卖家支付宝账号
                </button>
              </div>
            </div>

            <div class="four-nums num" style="grid-template-columns: repeat(3, minmax(0, 1fr))">
              <div class="fn-box">
                <span>① 闲鱼原单实付（整单全退关单）</span>
                <b>{{ fmtYuan(c.ticket?.paid_cents) }}</b>
                <small>关单后彻底脱离闲鱼管辖</small>
              </div>
              <div class="fn-box hi">
                <span>② 支付宝对公直转卖家成交价</span>
                <b>{{ fmtYuan(Math.round((Number(corpPayoutYuan) || 0) * 100)) }}</b>
                <small>财务次日 10:00（T+1账单）审批打款</small>
              </div>
              <div class="fn-box floor">
                <span>③ 本单议价净省（你的 20% 高提成）</span>
                <b style="color:var(--grn)">
                  省 {{ fmtYuan(Math.max(0, (c.ticket?.paid_cents || 0) - Math.round((Number(corpPayoutYuan) || 0) * 100))) }}
                </b>
                <small>
                  提成 {{ fmtYuan(Math.round(Math.max(0, (c.ticket?.paid_cents || 0) - Math.round((Number(corpPayoutYuan) || 0) * 100)) * 0.2)) }}
                </small>
              </div>
            </div>

            <div class="form-grid2">
              <label class="field">
                <span>谈妥最终支付宝对公支付成交价（元）<i class="req">*</i></span>
                <input v-model.number="corpPayoutYuan" type="number" class="input num" placeholder="如 800" />
              </label>
              <label class="field">
                <span>闲鱼整单全额退款关单号<i class="req">*</i></span>
                <input v-model="platformCloseNoInput" class="input mono" placeholder="如 GF-CLOSE-20261116-12" />
              </label>
              <label class="field">
                <span>卖家收款支付宝账号（手机号/邮箱，禁填0）<i class="req">*</i></span>
                <input v-model="sellerAlipayAccount" class="input mono" placeholder="如 00044706541 或 11c1a411fe@example.invalid" />
              </label>
              <label class="field">
                <span>卖家支付宝实名姓名（对公防转错必填）<i class="req">*</i></span>
                <input v-model="sellerAlipayName" class="input" placeholder="如 周明远" />
              </label>
            </div>

            <label class="field">
              <span>订单登记审批说明（供陈会计次日 10:00 核对 T+1 账单审批）：</span>
              <input
                v-model="corpRegNote"
                class="input"
                placeholder="如：原单 ¥2,000 抓出屏幕暗斑谈妥 ¥800 留货，闲鱼已整单全退关闭，申请次日10点T+1对公支付 ¥800"
              />
            </label>
          </div>

          <!-- 方式 2（零退款率保号通道）：原单正常确认收货 + 卖家直补小额差价/勉强收下（0%退款率占用，守住 5% 红标线！） -->
          <div v-else-if="settleMode === 'zero_refund_keep'" class="sub-card ok-tint" style="margin-top:8px">
            <b>🛡️ 零退款率保号通道（当账号退款率逼近 5% 红标线，或属于小额补差/勉强收下时使用）：</b>
            <p class="muted" style="font-size:13px;line-height:1.55">
              闲鱼原单直接正常点「确认收货」（<b>0% 平台退款率占用 · 0% 纠纷率占用</b>，彻底保护账号不破 5% 红标线），卖家通过微信/支付宝直补小额差价（或捡漏单 0 补差勉强收下）：
            </p>
            <div class="agree-row" style="margin-top:6px">
              <label class="field" style="max-width: 240px">
                <span>卖家直补差价金额（元，勉强收下可填 0）</span>
                <input v-model.number="sellerOfferYuan" type="number" class="input num" />
              </label>
            </div>
          </div>

          <!-- 方式 3：平台小额部分退差（大额时自动弹红标预警） -->
          <div v-else style="margin-top:8px;display:grid;gap:8px">
            <div v-if="liveOfferCents >= 35000" class="errbox">
              ⚠️ <b>风控预警：本单退差高达 {{ fmtYuan(liveOfferCents) }}！</b>大额折让走闲鱼「部分退款」极易导致采购账号弹<b>红标</b>，且卖家保留评价权可给<b>恶意差评</b>或向平台发起<b>二次申诉</b>！强烈建议切回上方<b>「方式 1：整单全退关单 + 支付宝对公支付」</b>！
            </div>
            <div class="agree-row">
              <label class="field" style="max-width:240px">
                <span>双方最终谈妥平台内退差金额（元）</span>
                <input v-model.number="sellerOfferYuan" type="number" class="input num" />
              </label>
              <button v-if="isCalcStale" type="button" class="btn sm pri" :disabled="busy" @click="doCalcBargain(false)">
                🔄 先刷新锁定此退差金额测算
              </button>
            </div>
          </div>
        </div>

        <!-- 《微信四要素文字定案》+《采购部议价完整披露通知》双硬核勾选 -->
        <div class="sub-card">
          <b>② 微信文字定案防反水 + 完整披露与 ERP 瑕疵材料沉淀核对（缺一项不予确认到货 10% 提成）：</b>
          <label class="chk-line">
            <input v-model="wechat4ElemChecked" type="checkbox" />
            <span>
              <b>卖家已在微信文字回复「确认同意」《四要素定案卡》</b>（明确最终给卖家多少钱而非退差口径，防次日扯皮），且<b>卖家提供的支付宝实名姓名与本人一致</b>（防代收三角诈骗）！
            </span>
          </label>
          <label class="chk-line">
            <input v-model="disclosureChecked" type="checkbox" />
            <span>
              <b>我已上传完整连续的议价聊天记录与录屏（单段 ≥5 秒，未截半截断章取义）及卖家确认收款账号记录</b>，且没有把赵仓管的开箱/拒签原片与我的议价录屏混为一谈。本单瑕疵照片与视频已绑定 ERP 单件，后续销售、售后同事可直接从 ERP 自取！
            </span>
          </label>

          <div class="agree-row" style="margin-top: 6px">
            <Lock
              :ok="canConfirmKeep && wechat4ElemChecked && disclosureChecked"
              :busy="busy"
              kind="ok"
              :reason="
                !wechat4ElemChecked
                  ? '请先发《微信四要素定案卡》让卖家文字回复确认并核对同名实名后再勾选'
                  : !disclosureChecked
                  ? '请勾选上方「完整披露与 ERP 沉淀确认」后再提交登记'
                  : keepLockReason
              "
              penalty="语音没落文字被卖家反咬、漏做对公订单登记或填假账号属于严重违规！"
              @go="doDecideAftersales('keep')"
            >
              {{
                settleMode === 'corp_alipay_close'
                  ? '✓ 提交整单退 + 支付宝对公支付订单登记（进入次日 10:00 T+1 财务审批）›'
                  : settleMode === 'zero_refund_keep'
                  ? '✓ 确认零退款率保号留货（守住 5% 红标线 · 进入第 9 步核账入库）›'
                  : '✓ 确认小额平台退差留货并归档 ERP ›'
              }}
            </Lock>

            <Lock
              :ok="unlocked && Boolean(c.ticket?.platform_return_no)"
              :busy="busy"
              kind="bad"
              reason="请先在第 2 步填好闲鱼退货单号"
              @go="doDecideAftersales('return')"
            >
              ✕ 谈不拢 · 正式走全额退货顺丰保价寄回（当天发走不过夜）›
            </Lock>
          </div>
        </div>
      </template>

      <!-- 二次议价第 9 步：次日 10:00（T+1）财务对公审批 + 赵仓管入库（双闭环发放两段 10% 提成） -->
      <template v-else>
        <div class="step-hd">
          <h4>
            第 9 步：次日 10:00（T+1）财务审批对公打款 + 赵仓管入库（确认到货 10% 提成）
            <span class="tag grn">T+1 次日10点审批闭环</span>
          </h4>
          <Q k="iss-4" />
        </div>

        <!-- 若本单走了「整单全退 + 支付宝对公支付登记」，置顶清晰展示登记单详情与次日10点T+1审批状态 -->
        <div v-if="c.corp_alipay_reg" class="sub-card" :class="c.corp_alipay_reg.approval_status === 'approved_paid' ? 'ok-tint' : ''">
          <div class="sub-hd">
            <b>🏦 《整单全退 · 支付宝对公支付订单登记单》（闲鱼已关单脱离管辖 · 零差评零申诉风险）</b>
            <span class="tag" :class="c.corp_alipay_reg.approval_status === 'approved_paid' ? 'grn' : 'amb'">
              {{
                c.corp_alipay_reg.approval_status === 'approved_paid'
                  ? `✓ 财务已完成 T+1 审批打款 (${c.corp_alipay_reg.alipay_corp_receipt_no})`
                  : `⏳ 待财务审批 · ${c.corp_alipay_reg.expected_approve_at}`
              }}
            </span>
          </div>
          <div class="four-nums num">
            <div class="fn-box">
              <span>闲鱼整单全退关单</span>
              <b>{{ fmtYuan(c.corp_alipay_reg.original_paid_cents) }}</b>
              <small>单号：{{ c.corp_alipay_reg.platform_close_no }}</small>
            </div>
            <div class="fn-box hi">
              <span>支付宝对公应转卖家</span>
              <b>{{ fmtYuan(c.corp_alipay_reg.agreed_payout_cents) }}</b>
              <small>省下 {{ fmtYuan(c.corp_alipay_reg.bargain_saved_cents) }}</small>
            </div>
            <div class="fn-box">
              <span>卖家支付宝账号 & 实名</span>
              <b style="font-size:15px">{{ c.corp_alipay_reg.seller_alipay_name }}</b>
              <small>{{ c.corp_alipay_reg.seller_alipay_account }}</small>
            </div>
            <div class="fn-box floor">
              <span>财务审批规则</span>
              <b style="font-size:15px">次日 10:00 完成</b>
              <small>账单 T+1 核对无误后对公直转</small>
            </div>
          </div>
          <p class="muted" style="font-size:13px">{{ c.corp_alipay_reg.register_note }}</p>
        </div>

        <div v-if="c.ticket?.carrier_intercept_status === 'requested'" class="sub-card" style="border-color:var(--red)">
          <div class="sub-hd">
            <b>🚚 顺丰在途退回/召回阻断工单（拿到真实截回凭证前，锁死禁止恢复可售库存！）：</b>
            <span class="tag red">等待顺丰截回凭证</span>
          </div>
          <div class="agree-row">
            <input v-model="interceptReceipt" class="input mono" style="max-width:260px" placeholder="填顺丰截回单号 如 SF-INT-OK88" />
            <Lock
              :ok="canWarehouseAct && interceptReceipt.trim().length >= 4"
              :busy="busy"
              :reason="!canWarehouseAct ? '请切到【赵仓管】确认快递已截回' : '请输入顺丰拦截成功回执单号'"
              :fix-text="!canWarehouseAct ? '一键切到【赵仓管】' : ''"
              @fix="switchToRole('zhaocg')"
              @go="doConfirmIntercept"
            >
              ✓ 赵仓管确认包裹已物理截回仓库
            </Lock>
          </div>
        </div>

        <div class="banner amb">
          ⏰ <b>时效与 T+1 审批红线：</b>① 当天谈妥必须当天完成<b>订单登记</b>（<b>22:00 前</b>待验货与待议价列表清零）；② 因平台与对公账单是 <b>T+1</b> 结算，<b>支付宝对公支付统一在次日早上 10:00 由陈会计审批打款</b>（最迟次日 24:00 前钱货双清）；③ 若寄回退货，寄退次日 22:00 未到账升级报备。
        </div>

        <div class="dual-grid">
          <div class="sub-card">
            <div class="sub-hd">
              <b>① 钱清：陈会计核对真实收付款回执</b>
              <span class="tag" :class="unverifiedLedger.length === 0 ? 'grn' : 'red'">
                {{ unverifiedLedger.length === 0 ? '✓ 资金已全核实' : `还有 ${unverifiedLedger.length} 笔待核对` }}
              </span>
            </div>

            <div v-if="(c.ledger_entries || []).length === 0" class="muted" style="font-size:13.5px">
              请先在第 8 步提交留货补差或全额退货方案，系统会自动生成待核销账单。
            </div>

            <div v-for="le in c.ledger_entries" :key="le.entry_id" class="le-row">
              <div class="le-info">
                <b>{{ le.channel }} · {{ fmtYuan(le.amount_cents) }}</b>
                <small class="muted">{{ le.note }}</small>
              </div>
              <span v-if="le.status === 'verified'" class="tag grn">✓ 已核 ({{ le.receipt_id }})</span>
              <div v-else class="le-act">
                <input
                  v-model="finReceiptInputs[le.entry_id]"
                  class="input mono"
                  placeholder="填银行/支付宝/公司微信回执号"
                />
                <button
                  v-if="!canFinanceAct"
                  type="button"
                  class="btn sm"
                  @click="switchToRole('chenkj')"
                >
                  切【陈会计】核账
                </button>
                <button
                  v-else
                  type="button"
                  class="btn sm pri"
                  :disabled="busy"
                  @click="doVerifyReceipt(le.entry_id)"
                >
                  确认真实到账/已转款
                </button>
              </div>
            </div>
          </div>

          <div class="sub-card">
            <div class="sub-hd">
              <b>② 货清：赵仓管确认实物去向 & 开放销售自取</b>
              <span class="tag" :class="stockCleared ? 'grn' : 'red'">
                {{ stockCleared ? `✓ 已确认 (${stockLabel(c.ticket?.stock_disposition)})` : '待仓管确认去向' }}
              </span>
            </div>

            <label class="field">
              <span>选择实物最终入库/退回状态：</span>
              <select v-model="stockDispInput" class="select">
                <option value="restocked_good">已复检入可售库（ERP瑕疵图开放给销售直接上架）</option>
                <option value="defect_shelf">放次品整备架（待配齐原装配件后复检上架）</option>
                <option value="returned_to_seller">已顺丰保价退回原卖家</option>
              </select>
            </label>

            <div class="agree-row" style="margin-top: 8px">
              <Lock
                :ok="canWarehouseAct && c.ticket?.carrier_intercept_status !== 'requested'"
                :busy="busy"
                :reason="
                  c.ticket?.carrier_intercept_status === 'requested'
                    ? '顺丰半路拦截还没确认截回，严禁点入库！'
                    : '请切到【赵仓管】确认机器入库或退回状态'
                "
                :fix-text="!canWarehouseAct ? '一键切到【赵仓管】' : ''"
                @fix="switchToRole('zhaocg')"
                @go="doSaveStockDisp"
              >
                ✓ 确认实物去向并同步销售库存
              </Lock>
            </div>
          </div>
        </div>

        <div class="sub-card ok-tint">
          <div v-if="c.ticket?.stage === 'done'" class="banner grn">
            🎉 <b>本笔二次议价订单已钱货两清圆满完结！</b>单台真实净成本重算为 <b>{{ fmtYuan(c.prices?.net_cost_cents) }}</b>，瑕疵照片视频已沉淀 ERP 供销售自取，你的<b>两段各 10% 提成（合计 {{ fmtYuan(c.prices?.est_comm_cents) }}，独立计提零重算）</b> 已正式发放！
          </div>
          <Lock
            v-else
            :ok="unlocked && unverifiedLedger.length === 0 && stockCleared"
            :busy="busy"
            kind="ok"
            :reason="
              !unlocked
                ? '请先完成新手防踩坑练习'
                : unverifiedLedger.length > 0
                ? `还有 ${unverifiedLedger.length} 笔款项没经【陈会计】核实真实回执，不能提前关单`
                : '【赵仓管】还没确认实物最终去向，不能提前关单'
            "
            penalty="钱没实到或货没落位就关单，会导致账实穿孔与提成冻结！"
            @go="doCloseTicket"
          >
            🎉 钱货两清 · 正式完结移入「已经完结的」并发放到货 10% 提成
          </Lock>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { store, currentRole, setActor, isPracticeUnlocked, callAction, notify } from '../store.js';
import { fmtYuan, mkIdem } from '../api.js';
import Q from './Q.vue';
import Term from './Term.vue';
import Lock from './Lock.vue';

const props = defineProps({
  c: { type: Object, required: true },
  jumpStep: { type: Number, default: null },
});

const busy = ref(false);
const activeMode = ref('buying');
const viewStep = ref(1);

// Pre-buy form states
const initSellerYuan = ref(7450);
const initCond = ref('');
const initDecl = ref('');
const suppInputs = reactive({});

// Pre-buy Step 2: Secondary Bargaining Potential & Warehouse Focus Tagging
const evalWroteLikeNew = ref(true);
const evalPhotosBlurry = ref(true);
const evalFullyDisclosed = ref(false);
const evalSuspectTag = ref(true);
const evalFocusPoints = ref([]);
const evalNoteToWh = ref('');

const presetFocusOptions = [
  '强光查屏幕划痕/亮斑坏点',
  '查底壳与四角边框磕碰掉漆',
  '查键帽打油/摇杆/接口磨损',
  '核原盒内是否有原厂泡沫内衬',
  '核原装充电头/DP线/支架螺丝齐全',
  '核序列号/电池效率/快门硬盘是否虚标',
];

const chatDraft = ref('');
const agreedYuan = ref(0);
const pageObservedYuan = ref(0);
const paidYuan = ref(0);
const payReceiptNo = ref('');
const trackingNo = ref('');
const whNote = ref('');

// 9-Step Secondary Bargaining form states
const triageRoute = ref('bargain_keep');
const arrivalTrackInput = ref('sf_express_refuse');
const returnModeInput = ref('station_refuse');
const returnNoInput = ref('');
const waybillRefusedChecked = ref(true);
const sellerWechatAdded = ref(true);
const sellerWechatIdInput = ref('');
const sf95338Input = ref('station_hold');
const signalPick = ref('green_proactive');
const sellerSignalWords = ref('');
const sellerOfferYuan = ref(0);
const repairYuan = ref(80);
const pickedStyle = ref('urgent_cash');
const pickedObjIdx = ref(0);
const sellerReplyYuan = ref(0);
const sellerReplyNote = ref('');
const cooldownMinsInput = ref(35);
const rescuedYuanInput = ref(0);
const reluctantTokenWipeYuan = ref(50);
const settleMode = ref('corp_alipay_close');
const corpPayoutYuan = ref(800);
const platformCloseNoInput = ref('');
const sellerAlipayAccount = ref('');
const sellerAlipayName = ref('');
const corpRegNote = ref('');
const wechat4ElemChecked = ref(true);
const disclosureChecked = ref(true);
const interceptReceipt = ref('SF-INT-OK8801');
const finReceiptInputs = reactive({});
const stockDispInput = ref('restocked_good');
const firstCutMode = ref('half');
const pickedPsychCode = ref('G3');
const step6GameTab = ref('meso');

// 6-second silence trainer
const silenceLeft = ref(0);
const silenceDone = ref(false);
const fraudInterventionReason = ref('');
let silenceTimer = null;

const sellerStyles = {
  urgent_cash: '急回款个人卖家',
  defensive: '爱面子自用卖家',
  tough: '嘴硬强硬卖家',
  merchant: '数码同行商家',
};

const LEAK_WORDS = ['参考价', '目标价', '公司底价', '最高上限', '授权上限', '行情七折', '0.7M', '提成', '毛利', '到手刀', '二次议价', '加微信', '微信号', '退差价'];

const isStationRefuseMode = computed(() => returnModeInput.value === 'station_refuse');

const isIssueCase = computed(() => Boolean(props.c.ticket || props.c.warehouse_check_state === 'defect'));
const role = computed(() => currentRole());
const unlocked = computed(() => isPracticeUnlocked());
const bp = computed(() => props.c.bargain_plan || null);
const flowState = computed(() => bp.value?.flow_state || {});

const allAnchorsMap = computed(() => {
  const m = {};
  for (const a of bp.value?.psych_anchors || []) m[a.code] = a;
  for (const g of bp.value?.game_anchors || []) m[g.code] = g;
  return m;
});

function anchorByCode(code) {
  return allAnchorsMap.value[code] || null;
}

const preciseBreakdown = computed(() => anchorByCode('P3')?.breakdown || null);

const step5TacticOptions = computed(() => {
  const specs = [
    { code: 'G3', shortLabel: '柠檬市场推演（破重卖散客幻想）' },
    { code: 'P2', shortLabel: '先替卖家骂完（防炸毛喊到手刀）' },
    { code: 'P4', shortLabel: '具象三倍痛感（运费+二次战损+限流）' },
    { code: 'G1', shortLabel: '谢林默认退件锁（不行动自动亏运费）' },
  ];
  return specs
    .filter((s) => allAnchorsMap.value[s.code])
    .map((s) => ({ ...allAnchorsMap.value[s.code], shortLabel: s.shortLabel }));
});

const curStep5Tactic = computed(() => {
  return step5TacticOptions.value.find((x) => x.code === pickedPsychCode.value) || step5TacticOptions.value[0] || null;
});

const liveSellerDelta = computed(() => {
  if (signalPick.value === 'green_proactive') return '0.58';
  if (signalPick.value === 'amber_anxious') return '0.72';
  return '0.88';
});

const liveWaitBadge = computed(() => {
  if (signalPick.value === 'green_proactive') return '战略晾单 8–12 分钟压制';
  if (signalPick.value === 'amber_anxious') return '慢半拍 5 分钟节奏压制';
  return '冷却 35 分钟 + 封车截单通牒';
});

const liveWaitAdvice = computed(() => {
  if (signalPick.value === 'green_proactive') {
    return '卖家急于回血！严禁秒回讨价还价，故意晾他 8–12 分钟放大焦虑再甩「不用啦，谢谢」+ 重估价！';
  }
  if (signalPick.value === 'amber_anxious') {
    return '卖家嘴硬但频繁回信说明等钱用！每轮慢 5 分钟回复，进第 4–5 步用 P3 拆项精确锚 + G3 柠檬市场推演瓦解防线！';
  }
  return '卖家表面强硬！停止口舌拉锯，进第 7 步走「嫌弃式勉强收下（若有保底利润）」或「G5 顺丰封车截单通牒」！';
});

const canWarehouseAct = computed(() => ['warehouse', 'supervisor'].includes(role.value.role));
const canFinanceAct = computed(() => ['finance', 'supervisor'].includes(role.value.role));

const evalCanBargain = computed(() => Boolean(evalWroteLikeNew.value || evalPhotosBlurry.value || !evalFullyDisclosed.value));

const hitLeakWord = computed(() => {
  const txt = chatDraft.value || '';
  return LEAK_WORDS.find((w) => txt.includes(w)) || '';
});

const agreedCents = computed(() => Math.round((Number(agreedYuan.value) || 0) * 100));
const priceCheckedOk = computed(() =>
  Boolean(props.c.order && ['price_checked', 'manual_paid', 'shipped', 'completed'].includes(props.c.order.stage))
);
const paidReceiptValid = computed(() => {
  const r = payReceiptNo.value.trim();
  return r.length >= 5 && !['0', '00', '无', '未知'].includes(r) && Number(paidYuan.value) > 0;
});

const buyingSteps = computed(() => {
  if (props.c.step_progress?.mode === 'buying') {
    return props.c.step_progress.steps;
  }
  return [
    { n: 1, t: '看清货况锁快照', state: 'done' },
    { n: 2, t: '判二次议价·打标', state: 'done' },
    { n: 3, t: '按打法谈拢价格', state: 'done' },
    { n: 4, t: '核对改价付款', state: 'done' },
    { n: 5, t: '仓管按标重点验', state: 'done' },
    { n: 6, t: '已转入二次议价', state: 'done' },
  ];
});

const issueSteps = computed(() => {
  if (props.c.step_progress?.mode === 'issue') {
    return props.c.step_progress.steps;
  }
  return [
    { n: 1, t: '验货抓差判路线', state: 'cur' },
    { n: 2, t: '先锁退货防到手刀', state: 'todo' },
    { n: 3, t: '等卖家提·看信号', state: 'todo' },
    { n: 4, t: '算四组数·首刀定锚', state: 'todo' },
    { n: 5, t: '首通破局+沉默6秒', state: 'todo' },
    { n: 6, t: '顶嘴拆招·阶梯让步', state: 'todo' },
    { n: 7, t: '冷却重算·二次回拨', state: 'todo' },
    { n: 8, t: '整单退·对公登记', state: 'todo' },
    { n: 9, t: 'T+1审批·拿20%提成', state: 'todo' },
  ];
});

const displaySteps = computed(() => (activeMode.value === 'issue' ? issueSteps.value : buyingSteps.value));
const curStepInMode = computed(() => {
  const found = displaySteps.value.find((s) => s.state === 'cur');
  return found ? found.n : displaySteps.value.length;
});

const currentHelpKey = computed(() => {
  if (activeMode.value === 'issue') {
    if (viewStep.value <= 3) return 'iss-2';
    if (viewStep.value <= 7) return 'iss-3';
    return 'iss-4';
  }
  if (viewStep.value <= 2) return 'buy-1';
  if (viewStep.value === 3) return 'buy-2';
  if (viewStep.value === 4) return 'buy-3';
  return 'buy-4';
});

const standardReturnApplyText = computed(() => {
  const wh = (props.c.ticket?.evidence_warehouse || props.c.warehouse_check_note || '实物存在买前未说明差异')
    .replace('仓库质检实拍：', '')
    .replace('仓检实拍与连续视频：', '');
  return `您好，包裹到仓录制一镜到底开箱视频核验发现：${wh}，与下单前页面描述存在客观差异（实拍照片与视频已留档）。因平台有自动确认时限，先按规则提交退货退款申请备存，后续处理我们随时沟通，感谢理解。`;
});

const liveOfferCents = computed(() => Math.max(0, Math.round((Number(sellerOfferYuan.value) || 0) * 100)));
const liveRepairCents = computed(() => Math.max(0, Math.round((Number(repairYuan.value) || 0) * 100)));
const liveKeepCostCents = computed(() => (props.c.ticket?.paid_cents || 0) - liveOfferCents.value + liveRepairCents.value);
const liveKeepNet = computed(() => (props.c.ticket?.s_market_cents || 0) - liveKeepCostCents.value);
const liveReplaceNet = computed(() => (props.c.ticket?.s_market_cents || 0) - (props.c.ticket?.r_replace_cost_cents || 0));

const isCalcStale = computed(() => {
  if (!props.c.ticket) return false;
  if (!props.c.ticket.plan_b_calc_hash) return true;
  return props.c.ticket.k_keep_cost_cents !== liveKeepCostCents.value;
});

const curObj = computed(() => bp.value?.objection_routes?.[pickedObjIdx.value] || null);

const corpRegValid = computed(() => {
  const acc = sellerAlipayAccount.value.trim();
  const nm = sellerAlipayName.value.trim();
  const cls = platformCloseNoInput.value.trim();
  const bad = ['0', '00', '000', '无', '未知'];
  const py = Number(corpPayoutYuan.value) || 0;
  const maxYuan = Math.round((props.c.ticket?.paid_cents || 0) / 100);
  return (
    py > 0 &&
    (maxYuan === 0 || py < maxYuan) &&
    acc.length >= 5 &&
    !bad.includes(acc) &&
    nm.length >= 2 &&
    !bad.includes(nm) &&
    cls.length >= 4
  );
});

const canConfirmKeep = computed(() => {
  if (!unlocked.value) return false;
  if (props.c.ticket?.carrier_intercept_status === 'requested') return false;
  if (settleMode.value === 'zero_refund_keep') {
    return Number(sellerOfferYuan.value || 0) >= 0;
  }
  if (!props.c.ticket?.platform_return_no) return false;
  if (settleMode.value === 'corp_alipay_close') {
    return corpRegValid.value;
  }
  return !isCalcStale.value && liveKeepNet.value > liveReplaceNet.value;
});

const keepLockReason = computed(() => {
  if (!unlocked.value) return '请先完成顶部 2 分钟新手防踩坑练习';
  if (props.c.ticket?.carrier_intercept_status === 'requested') return '包裹正在顺丰半路拦截中，等第 9 步确认截回后才能操作留货';
  if (settleMode.value === 'zero_refund_keep') return '';
  if (!props.c.ticket?.platform_return_no) return '必须先在第 2 步填入闲鱼退货单号锁住 48 小时倒计时！';
  if (settleMode.value === 'corp_alipay_close') {
    const py = Number(corpPayoutYuan.value) || 0;
    const maxYuan = Math.round((props.c.ticket?.paid_cents || 0) / 100);
    if (py <= 0 || (maxYuan > 0 && py >= maxYuan)) return '请填写低于原单实付价的谈妥支付宝对公打款金额（如 800）';
    if (sellerAlipayAccount.value.trim().length < 5) return '请填写真实卖家收款支付宝账号（方便财务次日 10:00 T+1 审批直转）';
    if (sellerAlipayName.value.trim().length < 2) return '请填写卖家支付宝实名姓名（对公支付防转错必填）';
    if (platformCloseNoInput.value.trim().length < 4) return '请填写闲鱼整单全额退款关单号';
    return '';
  }
  if (isCalcStale.value) return '请先点「🔄 先刷新锁定此退差金额测算」校验留货比退货重买更划算';
  if (liveKeepNet.value <= liveReplaceNet.value) {
    return `退差 ${fmtYuan(liveOfferCents.value)} 低于底线 ${fmtYuan(bp.value?.floor_c_cents)}，留下来不如退掉重买划算！请回第 7 步二次回拨或直接退货`;
  }
  return '';
});

const unverifiedLedger = computed(() => (props.c.ledger_entries || []).filter((x) => x.status !== 'verified'));
const stockCleared = computed(() =>
  Boolean(props.c.ticket && !['pending', 'defect_hold'].includes(props.c.ticket.stock_disposition))
);

function syncFromCase() {
  const c = props.c;
  const mode = c.step_progress?.mode === 'issue' ? 'issue' : 'buying';
  activeMode.value = mode;
  viewStep.value = c.step_progress?.cur || 1;

  initSellerYuan.value = Math.round((c.prices?.seller_or_agreed_cents || 500000) / 100);
  initCond.value = c.condition_grade || '几乎全新';
  initDecl.value = c.lead?.title || c.title || '';

  const pe = c.prebuy_eval || {};
  evalWroteLikeNew.value = Boolean(pe.seller_wrote_like_new);
  evalPhotosBlurry.value = Boolean(pe.photos_blurry_incomplete);
  evalFullyDisclosed.value = Boolean(pe.defects_fully_disclosed);
  evalSuspectTag.value = Boolean(pe.suspect_condition_tag);
  evalFocusPoints.value = Array.isArray(pe.warehouse_focus_points) && pe.warehouse_focus_points.length
    ? [...pe.warehouse_focus_points]
    : ['强光查屏幕划痕/亮斑坏点', '查底壳与四角边框磕碰掉漆'];
  evalNoteToWh.value = pe.buyer_note_to_warehouse || '';

  const sugAgree = c.order?.agreed_cents || c.conversation?.agreed_price_cents || c.prices?.target_price_cents || 0;
  agreedYuan.value = Math.round(sugAgree / 100);
  pageObservedYuan.value = Math.round((c.order?.agreed_cents || sugAgree) / 100);
  paidYuan.value = Math.round((c.order?.paid_cents || c.order?.agreed_cents || sugAgree) / 100);
  payReceiptNo.value = c.order?.payment_receipt_no || '';
  trackingNo.value = c.order?.tracking_no || '';
  whNote.value = c.warehouse_check_state === 'passed'
    ? c.warehouse_check_note
    : '一镜到底核验：只有外纸箱无原厂泡沫内衬，缺原装DP线，且纯白亮屏右下角有3cm明显划痕（已拍3角度特写进ERP）';

  if (c.ticket) {
    const fs = c.bargain_plan?.flow_state || {};
    arrivalTrackInput.value = fs.arrival_track || (fs.return_mode === 'platform_return' ? 'signed_platform_return' : 'sf_express_refuse');
    returnModeInput.value = fs.return_mode || (arrivalTrackInput.value === 'signed_platform_return' ? 'platform_return' : 'station_refuse');
    returnNoInput.value = c.ticket.platform_return_no || '';
    waybillRefusedChecked.value = fs.waybill_refused_verified !== false;
    sellerWechatAdded.value = fs.seller_wechat_added !== false;
    sellerWechatIdInput.value = fs.seller_wechat_id || '';
    sf95338Input.value = fs.sf_95338_status || (c.ticket.carrier_intercept_status === 'requested' ? 'seller_called_95338_return' : 'station_hold');
    signalPick.value = fs.step3_signal || 'green_proactive';
    sellerSignalWords.value = fs.seller_proactive_words || '';

    const offerC = c.ticket.partial_refund_cents > 0
      ? c.ticket.partial_refund_cents
      : (c.bargain_plan?.target_b_cents || 30000);
    sellerOfferYuan.value = Math.round(offerC / 100);
    sellerReplyYuan.value = Math.round((c.bargain_plan?.target_b_cents || 30000) / 100);
    repairYuan.value = Math.round((c.bargain_plan?.repair_cost_cents ?? 8000) / 100);
    cooldownMinsInput.value = fs.cooldown_mins || 35;
    rescuedYuanInput.value = Math.round((c.bargain_plan?.floor_c_cents || 30000) / 100);
    reluctantTokenWipeYuan.value = 50;
    wechat4ElemChecked.value = fs.wechat_4elem_confirmed !== false;

    const reg = c.corp_alipay_reg;
    settleMode.value = 'corp_alipay_close';
    const defaultPayout = Math.max(50, Math.round(((c.ticket.paid_cents || 200000) - offerC) / 100));
    corpPayoutYuan.value = reg ? Math.round(reg.agreed_payout_cents / 100) : defaultPayout;
    platformCloseNoInput.value = reg?.platform_close_no || c.ticket.platform_return_no || '';
    sellerAlipayAccount.value = reg?.seller_alipay_account || (c.ticket.ticket_id === 'TK-2412' ? '00044706541' : '');
    sellerAlipayName.value = reg?.seller_alipay_name || (c.ticket.ticket_id === 'TK-2412' ? '周明远' : '');
    corpRegNote.value =
      reg?.register_note ||
      `闲鱼原单 ${fmtYuan(c.ticket.paid_cents)} 已整单全退关闭脱离管辖（防红标/防差评/防申诉），申请次日 10:00（T+1账单）支付宝对公支付 ¥${defaultPayout} 给卖家`;

    if (c.ticket.stock_disposition && !['pending', 'defect_hold'].includes(c.ticket.stock_disposition)) {
      stockDispInput.value = c.ticket.stock_disposition;
    }
    for (const le of c.ledger_entries || []) {
      if (!finReceiptInputs[le.entry_id]) {
        finReceiptInputs[le.entry_id] = le.entry_type === 'corp_alipay_payout'
          ? `ALI-CORP-T1-${le.entry_id.slice(-4)}`
          : `REF-GF-CLOSE-${le.entry_id.slice(-4)}`;
      }
    }
  }
}

watch(() => [props.c.case_id, props.c.step_progress?.cur, props.c.step_progress?.mode], syncFromCase, { immediate: true });

watch(
  () => props.jumpStep,
  (st) => {
    if (!st) return;
    const maxS = displaySteps.value.length;
    viewStep.value = Math.max(1, Math.min(maxS, Number(st)));
  },
  { immediate: true }
);

function onToggleEval(which) {
  if (which === 'like_new') {
    evalWroteLikeNew.value = !evalWroteLikeNew.value;
    if (evalWroteLikeNew.value) evalFullyDisclosed.value = false;
  } else if (which === 'blurry') {
    evalPhotosBlurry.value = !evalPhotosBlurry.value;
    if (evalPhotosBlurry.value) evalFullyDisclosed.value = false;
  } else if (which === 'disclosed') {
    evalFullyDisclosed.value = !evalFullyDisclosed.value;
    if (evalFullyDisclosed.value) {
      evalWroteLikeNew.value = false;
      evalPhotosBlurry.value = false;
      evalSuspectTag.value = false;
      return;
    }
  }
  evalSuspectTag.value = Boolean(evalWroteLikeNew.value || evalPhotosBlurry.value || !evalFullyDisclosed.value);
}

function toggleFocusPoint(fp) {
  const idx = evalFocusPoints.value.indexOf(fp);
  if (idx >= 0) {
    evalFocusPoints.value.splice(idx, 1);
  } else {
    evalFocusPoints.value.push(fp);
  }
}

function startSilenceTimer() {
  if (silenceTimer) clearInterval(silenceTimer);
  silenceLeft.value = 6;
  silenceTimer = setInterval(() => {
    silenceLeft.value -= 1;
    if (silenceLeft.value <= 0) {
      clearInterval(silenceTimer);
      silenceTimer = null;
      silenceDone.value = true;
      notify('👏 好样的！稳住 6 秒沉默不自砍，现在听卖家怎么接招！');
    }
  }, 1000);
}

onBeforeUnmount(() => {
  if (silenceTimer) clearInterval(silenceTimer);
});

function switchMode(m) {
  activeMode.value = m;
  viewStep.value = curStepInMode.value;
}

function switchToRole(actorId) {
  setActor(actorId);
  const r = store.dashboard.roles.find((x) => x.id === actorId);
  notify(`已为你切换到【${r?.name || actorId}】，现在可以直接点确认按钮了！`);
}

function stockLabel(s) {
  if (s === 'restocked_good') return '已入可售良品库（ERP瑕疵自取）';
  if (s === 'defect_shelf') return '次品整备架';
  if (s === 'returned_to_seller' || s === 'scrapped') return '已寄回卖家';
  return '待确认';
}

async function copyText(txt, msg = '话术已复制，直接发给卖家或打电话照念即可！') {
  try {
    await navigator.clipboard.writeText(txt);
  } catch {
    // ignore clipboard fallback
  }
  notify(msg);
}

function copyAskPhotoScript() {
  copyText('老板你好，请问这台具体型号配置后缀确认是标题写的这款对吧？（注意：只核型号，绝不追问划痕成色！）');
}

function fillPreScript(kind) {
  const f = Math.round((props.c.prices?.first_offer_cents || 450000) / 100);
  const t = Math.round((props.c.prices?.target_price_cents || 460000) / 100);
  if (kind === 'first') {
    chatDraft.value = `哥诚心要这台，不墨迹当天收货结清，${f} 元包顺丰保价能出的话我现在直接拍！`;
  } else if (kind === 'target') {
    chatDraft.value = `理解哥，我也再加一点凑个爽快数 ${t} 元，你改价我现在秒付款！`;
  } else {
    chatDraft.value = `好的哥，那咱们就定 ¥${agreedYuan.value}，麻烦点修改价格改好链接标价，我刷新核对完马上付款！`;
  }
}

function askBossOverCeiling() {
  store.ui.askBossOpen = true;
}

function fillDemoPayReceipt() {
  payReceiptNo.value = `PAY-ALI-${Date.now().toString().slice(-6)}`;
  if (!trackingNo.value) trackingNo.value = `SF1488${Date.now().toString().slice(-6)}`;
}

function fillDemoReturnNo() {
  returnNoInput.value = `SF-REFUSE-${Date.now().toString().slice(-5)}`;
  if (!sellerWechatIdInput.value) sellerWechatIdInput.value = 'laze_wx88';
  waybillRefusedChecked.value = true;
  sellerWechatAdded.value = true;
}

function onPickSignal(sigKey) {
  signalPick.value = sigKey;
  if (sigKey === 'red_hard_address') {
    sf95338Input.value = 'seller_called_95338_return';
  }
}

function copyReturnApplyText() {
  copyText(standardReturnApplyText.value, '合规客观退货说明已复制！去闲鱼提交退货退款后填单号');
}

async function doInitCase() {
  busy.value = true;
  try {
    await callAction(
      `/api/cases/${props.c.case_id}/step/init`,
      {
        model_code: props.c.model_code,
        condition_grade: initCond.value,
        seller_declaration: initDecl.value,
        seller_price_cents: Math.round((Number(initSellerYuan.value) || 0) * 100),
      },
      '商品页原始快照已锁死！现在进入第 2 步判二次议价空间'
    );
    viewStep.value = 2;
  } finally {
    busy.value = false;
  }
}

async function doSupplement(channel, unavailable) {
  busy.value = true;
  try {
    await callAction(
      `/api/cases/${props.c.case_id}/step/supplement`,
      { channel, unavailable, content: suppInputs[channel] || '' },
      unavailable ? '已诚实标记「暂时拿不到」，后续随时可补' : '快照留底已更新！'
    );
    suppInputs[channel] = '';
  } finally {
    busy.value = false;
  }
}

async function doSaveAssessBargain() {
  busy.value = true;
  try {
    await callAction(
      `/api/cases/${props.c.case_id}/step/assess-bargain`,
      {
        seller_wrote_like_new: evalWroteLikeNew.value,
        photos_blurry_incomplete: evalPhotosBlurry.value,
        defects_fully_disclosed: evalFullyDisclosed.value,
        suspect_condition_tag: evalSuspectTag.value,
        warehouse_focus_points: evalFocusPoints.value,
        buyer_note_to_warehouse: evalNoteToWh.value,
      },
      evalSuspectTag.value
        ? '🎯 已打上「质疑成色·仓管重点深检」标记！记住别追问成色，去第 3 步直接按链接标准谈价'
        : '已记录瑕疵全披露结论，去第 3 步严守上限谈价'
    );
    viewStep.value = 3;
  } finally {
    busy.value = false;
  }
}

async function doPauseAck() {
  if (!props.c.conversation) return;
  busy.value = true;
  try {
    await callAction(
      `/api/conversations/${props.c.conversation.conv_id}/pause-resolve`,
      { resolution: 'abort_inflight' },
      '自动助手已停稳，现在你可以放心发消息了'
    );
  } finally {
    busy.value = false;
  }
}

async function doSendMsg() {
  if (!props.c.conversation || !chatDraft.value.trim()) return;
  busy.value = true;
  try {
    await callAction(
      `/api/conversations/${props.c.conversation.conv_id}/send`,
      {
        text: chatDraft.value.trim(),
        expected_context_version: props.c.conversation.context_version,
        idempotency_key: mkIdem('msg'),
      },
      '消息已发出并记入谈价存档'
    );
    chatDraft.value = '';
  } finally {
    busy.value = false;
  }
}

async function doCreateOrderFromConv() {
  if (!props.c.conversation) return;
  busy.value = true;
  try {
    await callAction(
      '/api/orders/create',
      {
        conv_id: props.c.conversation.conv_id,
        agreed_cents: agreedCents.value,
        idempotency_key: mkIdem('po'),
      },
      '口头谈妥价已登记！现在去第 4 步核对闲鱼页面改价'
    );
    viewStep.value = 4;
  } finally {
    busy.value = false;
  }
}

async function doCheckPrice() {
  if (!props.c.order) return;
  busy.value = true;
  try {
    await callAction(
      `/api/orders/${props.c.order.po_id}/advance`,
      {
        target_stage: 'price_checked',
        platform_listed_cents: Math.round((Number(pageObservedYuan.value) || 0) * 100),
      },
      '闲鱼改价核对一致！实付单号登记已解锁'
    );
  } finally {
    busy.value = false;
  }
}

async function doManualPay() {
  if (!props.c.order) return;
  busy.value = true;
  try {
    await callAction(
      `/api/orders/${props.c.order.po_id}/advance`,
      {
        target_stage: 'manual_paid',
        paid_cents: Math.round((Number(paidYuan.value) || 0) * 100),
        payment_receipt_no: payReceiptNo.value.trim(),
      },
      '实付已登记，买前快照与仓管重点验机标已锁定推送仓库！'
    );
    viewStep.value = 5;
  } finally {
    busy.value = false;
  }
}

async function doCancelOrder() {
  if (!props.c.order) return;
  busy.value = true;
  try {
    await callAction('/api/orders/rpa-simulate', { scenario_code: 'W10-04' }, '未付款订单已取消，预留预算已退回池子');
  } finally {
    busy.value = false;
  }
}

async function doWarehouseInspect(result) {
  busy.value = true;
  try {
    await callAction(
      `/api/cases/${props.c.case_id}/step/warehouse-inspect`,
      { result, note: whNote.value.trim() },
      result === 'pass'
        ? '验机全对！已入良品库并确认 10% 基础提成'
        : '🎯 仓管抓出未披露瑕疵！已自动开启「9 步二次议价」陪跑（先锁退货防到手刀）'
    );
    if (result === 'defect') {
      activeMode.value = 'issue';
      viewStep.value = 2;
    } else {
      viewStep.value = 6;
    }
  } finally {
    busy.value = false;
  }
}

async function doStep1Triage() {
  if (!props.c.ticket) return;
  busy.value = true;
  try {
    await callAction(
      `/api/aftersales/${props.c.ticket.ticket_id}/step1-triage`,
      { route_choice: triageRoute.value, arrival_track: arrivalTrackInput.value },
      arrivalTrackInput.value === 'signed_platform_return'
        ? '已切换为【轨道② 已签收件 · 先提退货等卖家开口/Plan B】！进入第 2 步锁退货时效'
        : '已确认【轨道① 顺丰派送当场拒签闪电战】！进入第 2 步 10m 确认面单拒签+加微'
    );
    viewStep.value = 2;
  } finally {
    busy.value = false;
  }
}

async function doSaveReturnFirst() {
  if (!props.c.ticket) return;
  busy.value = true;
  try {
    await callAction(
      `/api/aftersales/${props.c.ticket.ticket_id}/submit-return`,
      {
        platform_return_no: returnNoInput.value.trim(),
        return_mode: returnModeInput.value,
        arrival_track: returnModeInput.value === 'platform_return' ? 'signed_platform_return' : 'sf_express_refuse',
        waybill_refused_verified: waybillRefusedChecked.value,
        seller_wechat_added: sellerWechatAdded.value,
        seller_wechat_id: sellerWechatIdInput.value.trim(),
        buyer_response_mins: 7,
      },
      '⚡ 已完成第 2 步卡位响应！现在进入第 3 步看卖家反应与 95338 状态'
    );
    viewStep.value = 3;
  } finally {
    busy.value = false;
  }
}

async function doSaveSignal() {
  if (!props.c.ticket) return;
  busy.value = true;
  try {
    await callAction(
      `/api/aftersales/${props.c.ticket.ticket_id}/observe-signal`,
      {
        signal: signalPick.value,
        sf_95338_status: sf95338Input.value,
        seller_words: sellerSignalWords.value.trim(),
      },
      '卖家反应与顺丰 95338 状态已记录！进入第 4 步首刀直接按半价大砍'
    );
    viewStep.value = 4;
  } finally {
    busy.value = false;
  }
}

async function doCalcBargain(advanceNext = false) {
  if (!props.c.ticket) return;
  busy.value = true;
  try {
    await callAction(
      `/api/aftersales/${props.c.ticket.ticket_id}/plan-b-calc`,
      {
        s_market_cents: props.c.ticket.s_market_cents,
        k_keep_cost_cents: liveKeepCostCents.value,
        r_replace_cost_cents: props.c.ticket.r_replace_cost_cents,
        partial_refund_cents: liveOfferCents.value,
      },
      advanceNext ? '四组底牌已锁定！进入第 5 步打首通电话破局' : '最新退差净赚对比已锁定！'
    );
    if (advanceNext) viewStep.value = 5;
  } finally {
    busy.value = false;
  }
}

async function doRound1Complete() {
  if (!props.c.ticket || !bp.value) return;
  const txt = bp.value.scripts?.round1?.by_style?.[pickedStyle.value] || '';
  await copyText(txt, '首通破局话术已复制！报完数字记得沉默 6 秒，进入第 6 步看卖家顶嘴拆招');
  busy.value = true;
  try {
    await callAction(`/api/aftersales/${props.c.ticket.ticket_id}/bargain-round`, {
      round_no: 1,
      role_side: 'buyer',
      seller_style: pickedStyle.value,
      ask_refund_cents: bp.value.anchor_a_cents,
      text: txt,
      silence_6s_done: true,
    });
    viewStep.value = 6;
  } finally {
    busy.value = false;
  }
}

async function copyAndLogRound(roundNo, roleSide, askCents, text) {
  if (!props.c.ticket || !text) return;
  await copyText(text, `第 ${roundNo} 轮拆招话术已复制并记入本单记录！`);
  busy.value = true;
  try {
    await callAction(`/api/aftersales/${props.c.ticket.ticket_id}/bargain-round`, {
      round_no: roundNo,
      role_side: roleSide,
      seller_style: pickedStyle.value,
      ask_refund_cents: askCents,
      text,
    });
  } finally {
    busy.value = false;
  }
}

async function copyAndLogTactic(anchor, roundNo = 2, askCents = 0) {
  if (!anchor?.script) return;
  await copyText(anchor.script, `已复制【${anchor.code} · ${anchor.name}】实战话术并记入博弈留痕！`);
  if (!props.c.ticket) return;
  busy.value = true;
  try {
    await callAction(`/api/aftersales/${props.c.ticket.ticket_id}/bargain-round`, {
      round_no: roundNo,
      role_side: 'buyer',
      seller_style: pickedStyle.value,
      ask_refund_cents: askCents || bp.value?.target_b_cents || 0,
      text: anchor.script,
      tactic_code: anchor.code,
    });
  } finally {
    busy.value = false;
  }
}

async function copyAndLogMeso(mo) {
  if (!props.c.ticket || !mo) return;
  await copyText(mo.script, `已复制「${mo.title}」话术！`);
  busy.value = true;
  try {
    await callAction(`/api/aftersales/${props.c.ticket.ticket_id}/bargain-round`, {
      round_no: 2,
      role_side: 'buyer',
      seller_style: pickedStyle.value,
      ask_refund_cents: bp.value?.target_b_cents || 20000,
      text: mo.script,
      selected_meso: mo.title,
    });
  } finally {
    busy.value = false;
  }
}

async function doLogSellerOffer() {
  if (!props.c.ticket) return;
  const offerC = Math.round((Number(sellerReplyYuan.value) || 0) * 100);
  busy.value = true;
  try {
    await callAction(
      `/api/aftersales/${props.c.ticket.ticket_id}/bargain-round`,
      {
        round_no: 2,
        role_side: 'seller',
        seller_style: pickedStyle.value,
        ask_refund_cents: offerC,
        text: sellerReplyNote.value.trim() || `卖家松口同意退差 ¥${sellerReplyYuan.value} 求留货确认收货`,
      },
      `已记下卖家松口退差 ¥${sellerReplyYuan.value}，净赚与 20% 提成已自动重算！`
    );
    sellerOfferYuan.value = Number(sellerReplyYuan.value);
    if (offerC >= (bp.value?.floor_c_cents || 0)) {
      viewStep.value = 7;
    }
  } finally {
    busy.value = false;
  }
}

async function doCooldownAction(outcome) {
  if (!props.c.ticket) return;
  busy.value = true;
  try {
    const agreedC = outcome === 'rescued_keep'
      ? Math.round((Number(rescuedYuanInput.value) || 0) * 100)
      : outcome === 'reluctant_salvage_keep'
      ? Math.max(0, Math.round((Number(reluctantTokenWipeYuan.value) || 0) * 100))
      : (props.c.ticket.partial_refund_cents || 0);
    await callAction(
      `/api/aftersales/${props.c.ticket.ticket_id}/cooldown-callback`,
      {
        outcome,
        cooldown_mins: Number(cooldownMinsInput.value) || 35,
        agreed_refund_cents: agreedC,
      },
      outcome === 'rescued_keep'
        ? `🎉 二次回拨救单成功！补差 ¥${rescuedYuanInput.value} 已锁定，去第 8 步对公登记`
        : outcome === 'reluctant_salvage_keep'
        ? `💎 已执行「嫌弃式勉强收下」保住保底利润！记得让卖家打 95338 撤回退回指令，去第 8/9 步收尾`
        : outcome === 'skip_already_agreed'
        ? '已进入第 8 步微信定案与对公支付登记！'
        : '已确认低于底线走退货（合格退出不扣罚），去第 8 步办退回'
    );
    if (outcome === 'rescued_keep') {
      sellerOfferYuan.value = Number(rescuedYuanInput.value);
      corpPayoutYuan.value = Math.max(50, Math.round((props.c.ticket.paid_cents - agreedC) / 100));
    } else if (outcome === 'reluctant_salvage_keep') {
      sellerOfferYuan.value = Number(reluctantTokenWipeYuan.value) || 0;
      corpPayoutYuan.value = Math.max(50, Math.round((props.c.ticket.paid_cents - agreedC) / 100));
      if (agreedC === 0) settleMode.value = 'platform';
    }
    viewStep.value = 8;
  } finally {
    busy.value = false;
  }
}

function fillDemoCorpAlipay() {
  if (!sellerAlipayAccount.value) sellerAlipayAccount.value = '00044706541';
  if (!sellerAlipayName.value) sellerAlipayName.value = '周明远';
  if (!platformCloseNoInput.value) platformCloseNoInput.value = props.c.ticket?.platform_return_no || `GF-CLOSE-${Date.now().toString().slice(-6)}`;
}

async function doSwitchSafeAccount() {
  busy.value = true;
  try {
    await callAction(
      `/api/cases/${props.c.case_id}/switch-safe-account`,
      { target_account_id: '闲鱼3号' },
      '🛡️ 已切换为低退款率安全号【闲鱼3号 (1.67%)】拍单，避免原号突破 5% 红标线！'
    );
  } finally {
    busy.value = false;
  }
}

async function doRequestIntervention() {
  if (!props.c.ticket) return;
  busy.value = true;
  try {
    await callAction(
      `/api/aftersales/${props.c.ticket.ticket_id}/request-intervention`,
      {
        severe_fraud_confirmed: true,
        reason: fraudInterventionReason.value.trim(),
      },
      '🛡️ 王主管已特批该重大诈骗单申请平台介入，并实时计入账号 5% 纠纷率监控！'
    );
  } finally {
    busy.value = false;
  }
}

async function doDecideAftersales(decision) {
  if (!props.c.ticket) return;
  busy.value = true;
  try {
    if (decision === 'return') {
      await callAction(
        `/api/aftersales/${props.c.ticket.ticket_id}/full-return`,
        {},
        '已登记顺丰保价退回！请确保当天发走不过夜，并在第 9 步盯退款到账'
      );
      viewStep.value = 9;
      return;
    }

    if (settleMode.value === 'zero_refund_keep') {
      const compCents = Math.max(0, Math.round((Number(sellerOfferYuan.value) || 0) * 100));
      await callAction(
        `/api/aftersales/${props.c.ticket.ticket_id}/zero-refund-keep`,
        {
          private_comp_cents: compCents,
          note: '原单正常确认收货不走平台退款（0%退款率 · 0%纠纷率），严守 5% 防红标红线',
        },
        '🛡️ 已启用零退款率保号留货（0%退款率·0%纠纷率占用）！去第 9 步核账入库'
      );
      viewStep.value = 9;
      return;
    }

    if (settleMode.value === 'corp_alipay_close') {
      const payoutCents = Math.round((Number(corpPayoutYuan.value) || 0) * 100);
      const savedRefundCents = Math.max(0, (props.c.ticket.paid_cents || 0) - payoutCents);
      await callAction(`/api/aftersales/${props.c.ticket.ticket_id}/plan-b-calc`, {
        s_market_cents: props.c.ticket.s_market_cents,
        k_keep_cost_cents: payoutCents,
        r_replace_cost_cents: props.c.ticket.r_replace_cost_cents,
        partial_refund_cents: savedRefundCents,
      });
      await callAction(
        `/api/aftersales/${props.c.ticket.ticket_id}/confirm-keep`,
        {
          s_market_cents: props.c.ticket.s_market_cents,
          k_keep_cost_cents: payoutCents,
          r_replace_cost_cents: props.c.ticket.r_replace_cost_cents,
          partial_refund_cents: savedRefundCents,
          settle_mode: 'corp_alipay_close',
          agreed_payout_cents: payoutCents,
          platform_close_no: platformCloseNoInput.value.trim(),
          seller_alipay_account: sellerAlipayAccount.value.trim(),
          seller_alipay_name: sellerAlipayName.value.trim(),
          register_note: corpRegNote.value.trim(),
          wechat_4elem_confirmed: wechat4ElemChecked.value,
          disclosure_complete: true,
        },
        `✅ 已登记整单全退关单 + 支付宝对公支付 ¥${corpPayoutYuan.value}！已进入陈会计「次日 10:00（T+1账单）审批」队列`
      );
    } else {
      if (isCalcStale.value) {
        await callAction(`/api/aftersales/${props.c.ticket.ticket_id}/plan-b-calc`, {
          s_market_cents: props.c.ticket.s_market_cents,
          k_keep_cost_cents: liveKeepCostCents.value,
          r_replace_cost_cents: props.c.ticket.r_replace_cost_cents,
          partial_refund_cents: liveOfferCents.value,
        });
      }
      await callAction(
        `/api/aftersales/${props.c.ticket.ticket_id}/confirm-keep`,
        {
          s_market_cents: props.c.ticket.s_market_cents,
          k_keep_cost_cents: liveKeepCostCents.value,
          r_replace_cost_cents: props.c.ticket.r_replace_cost_cents,
          partial_refund_cents: liveOfferCents.value,
          settle_mode: 'platform_partial',
          wechat_4elem_confirmed: wechat4ElemChecked.value,
          disclosure_complete: true,
        },
        '已确认平台退差留货并沉淀 ERP 材料！去第 9 步核账入库拿 20% 高提成'
      );
    }
    viewStep.value = 9;
  } finally {
    busy.value = false;
  }
}

async function doConfirmIntercept() {
  if (!props.c.ticket) return;
  busy.value = true;
  try {
    await callAction(
      `/api/aftersales/${props.c.ticket.ticket_id}/confirm-intercept`,
      {},
      '赵仓管已确认顺丰包裹截回仓库！现在可以回第 8 步定留货或直接在下面点入库'
    );
  } finally {
    busy.value = false;
  }
}

async function doVerifyReceipt(entryId) {
  busy.value = true;
  try {
    const rid = (finReceiptInputs[entryId] || '').trim();
    await callAction(
      '/api/finance/verify-receipt',
      { entry_id: entryId, receipt_id: rid },
      '陈会计已核实该笔真实资金回执！'
    );
  } finally {
    busy.value = false;
  }
}

async function doSaveStockDisp() {
  if (!props.c.ticket) return;
  busy.value = true;
  try {
    await callAction(
      `/api/aftersales/${props.c.ticket.ticket_id}/warehouse-dispose`,
      { stock_disposition: stockDispInput.value },
      '赵仓管已确认实物去向，ERP 瑕疵材料已同步开放给销售！'
    );
  } finally {
    busy.value = false;
  }
}

async function doCloseTicket() {
  if (!props.c.ticket) return;
  busy.value = true;
  try {
    await callAction(
      `/api/aftersales/${props.c.ticket.ticket_id}/close-ticket`,
      {},
      '🎉 钱货两清完结成功！已移入「已经完结的」，20% 高提成已正式发放！'
    );
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.flow-card {
  margin-top: 18px;
}
.fc-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.fc-tools {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.steps.steps-9 {
  grid-auto-columns: minmax(104px, 1fr);
  gap: 4px;
}
.steps.steps-9 li b {
  font-size: 12.5px;
}

.sub-card {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 16px 18px;
  display: grid;
  gap: 10px;
}
.sub-card.ok-tint {
  border-color: rgba(18, 138, 89, .38);
}
.sub-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.check3-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.chk-tile {
  text-align: left;
  padding: 14px 15px;
  border-radius: 14px;
  background: var(--panel);
  border: 2px solid var(--line);
  display: grid;
  gap: 6px;
  cursor: pointer;
  transition: border-color .14s, background .14s;
}
.chk-tile.hit {
  border-color: var(--red);
  background: var(--red-soft);
}
.chk-tile.safe {
  border-color: var(--grn);
  background: var(--grn-soft);
}
.chk-tile .ct-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  font-size: 14px;
}
.chk-tile p {
  font-size: 12.5px;
  color: var(--ink2);
  line-height: 1.45;
}

.focus-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.target-alert {
  padding: 15px 18px;
  border-radius: 16px;
  background: var(--red-soft);
  border: 2px solid var(--red);
  display: grid;
  gap: 8px;
}
.ta-hd {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ta-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ta-chip {
  padding: 5px 11px;
  border-radius: 999px;
  background: var(--panel);
  border: 1px solid var(--red);
  font-size: 13px;
  font-weight: 800;
  color: var(--red-ink);
}
.ta-note {
  font-size: 14px;
  font-weight: 700;
  color: var(--ink);
}

.silence-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 13px 16px;
  border-radius: 14px;
  background: var(--amb-soft);
  border: 1.5px solid var(--amb);
}
.silence-box.done {
  background: var(--grn-soft);
  border-color: var(--grn);
}

.ladder-bar {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.ld-step {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 11px 13px;
  display: grid;
  gap: 3px;
}
.ld-step span {
  font-size: 12px;
  font-weight: 700;
  color: var(--mute);
}
.ld-step b {
  font-size: 20px;
  font-weight: 900;
  color: var(--acc);
}
.ld-step small {
  font-size: 11.5px;
  color: var(--ink2);
  line-height: 1.35;
}

.chk-line {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  font-size: 13.5px;
  line-height: 1.55;
  cursor: pointer;
}
.chk-line input {
  margin-top: 4px;
  transform: scale(1.25);
}

.form-grid2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.form-grid3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.agree-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
.next-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 6px;
}

.ev-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.ev-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 13px 15px;
  display: grid;
  gap: 8px;
}
.ev-card.ok { border-left: 4px solid var(--grn); }
.ev-card.missing { border-left: 4px solid var(--red); }
.ev-card.unknown, .ev-card.partial { border-left: 4px solid var(--amb); }
.ev-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ev-detail {
  font-size: 13.5px;
  color: var(--ink2);
  line-height: 1.45;
}
.ev-acts { display: grid; gap: 8px; }
.ev-btn-row { display: flex; gap: 6px; flex-wrap: wrap; }

.chat-mini {
  max-height: 220px;
  overflow-y: auto;
  display: grid;
  gap: 8px;
  padding: 10px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
}
.cm-row { display: grid; gap: 2px; max-width: 86%; }
.cm-row.us { justify-self: end; text-align: right; }
.cm-row small { font-size: 11px; color: var(--mute); }
.cm-bub {
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--soft);
  font-size: 13.5px;
  line-height: 1.45;
  text-align: left;
}
.cm-row.us .cm-bub { background: var(--acc-soft); color: var(--ink); }
.quick-pills { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.send-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}

.compare-ev {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.cev-box {
  padding: 15px 16px;
  border-radius: 15px;
  background: var(--panel);
  border: 1.5px solid var(--line);
  display: grid;
  gap: 8px;
}
.cev-box.bad { border-color: var(--red); background: var(--red-soft); }
.cev-box p { font-size: 14.5px; font-weight: 700; line-height: 1.5; }

.script-quote {
  padding: 13px 15px;
  border-radius: 13px;
  background: var(--panel);
  border: 1.5px dashed var(--acc);
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink);
}

.sig-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.sig-item {
  padding: 12px 14px;
  border-radius: 13px;
  background: var(--panel);
  border: 1.5px solid var(--line);
  border-left: 5px solid var(--line);
  display: grid;
  gap: 6px;
  font-size: 13px;
  text-align: left;
}
.sig-btn { cursor: pointer; }
.sig-btn.picked { border-color: var(--acc); box-shadow: 0 0 0 3px var(--acc-soft); }
.sig-item.grn { border-left-color: var(--grn); }
.sig-item.amb { border-left-color: var(--amb); }
.sig-item.red { border-left-color: var(--red); }
.sig-item p { color: var(--ink2); line-height: 1.45; }

.style-row, .obj-btns {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.six-steps {
  background: var(--panel);
  border-radius: 13px;
  padding: 12px 16px;
  border: 1px solid var(--line);
  font-size: 13.5px;
}
.six-steps ol {
  margin: 6px 0 0;
  padding-left: 20px;
  display: grid;
  gap: 4px;
  line-height: 1.55;
}
.obj-detail { display: grid; gap: 8px; }

.blog-list {
  display: grid;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.blog-item {
  padding: 9px 12px;
  border-radius: 11px;
  background: var(--panel);
  font-size: 13px;
  display: grid;
  gap: 3px;
}
.blog-item.buyer { border-left: 4px solid var(--acc); }
.blog-item.seller { border-left: 4px solid var(--amb); }

.settle-mode { display: flex; gap: 10px; flex-wrap: wrap; }
.radio-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 6px 14px;
  border-radius: 12px;
  background: var(--panel);
  border: 1.5px solid var(--line);
  font-size: 13.5px;
  font-weight: 700;
  cursor: pointer;
}
.radio-pill.on { border-color: var(--acc); background: var(--acc-soft); }

.dual-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.le-row {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  display: grid;
  gap: 8px;
}
.le-info { display: grid; gap: 2px; font-size: 13.5px; }
.le-act { display: flex; gap: 8px; flex-wrap: wrap; }
.le-act .input { flex: 1; min-width: 150px; }

@media (max-width: 960px) {
  .check3-grid, .ladder-bar, .form-grid2, .form-grid3, .ev-grid, .compare-ev, .sig-grid, .dual-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .send-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
