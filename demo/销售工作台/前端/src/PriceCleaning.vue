<template>
  <div class="pc-page">
    <!-- 顶部全流程向导导航条（严格保留 Gallery -> 第1步洗价格 -> 第2步洗图片直发） -->
    <nav class="wizard-bar card">
      <button class="btn sm" @click="goGallery">← 返回 Gallery</button>

      <div class="wiz-steps">
        <button class="wstep done" @click="goGallery">
          <i>☷</i><span>Gallery 选品</span>
        </button>
        <span class="wsep">→</span>
        <button class="wstep cur">
          <i>1</i><span>① 洗价格（闲鱼快照去噪）</span>
        </button>
        <template v-if="!isPricebookItem">
          <span class="wsep">→</span>
          <button class="wstep" :class="{ done: c?.step === 'active' }" @click="goImageStep">
            <i>2</i><span>② 洗图片并上架</span>
          </button>
        </template>
      </div>

      <div class="wiz-switch" v-if="filteredQueueCases.length">
        <button class="btn sm" :class="{ pri: showQueueBar }" @click="showQueueBar = !showQueueBar">
          📋 队列 ({{ queueCounts.all || allCases.length }}) {{ showQueueBar ? '▴' : '▾' }}
        </button>
        <select class="sku-sel" :value="currentCode" @change="pickCode($event.target.value)" aria-label="切换待洗商品">
          <option v-for="it in filteredQueueCases" :key="it.code" :value="it.code">
            {{ it.step === 'active' ? '✓ ' : it.reviewOnly ? '⚠ ' : '① ' }}{{ it.brand ? it.brand + ' ' : '' }}{{ it.model }} ({{ it.code }})
          </option>
        </select>
      </div>
    </nav>

    <!-- xianyu-seller-pilot v0.2.0 五大任务队列与利润档位巡航条（默认折叠，点顶栏按钮按需展开） -->
    <section v-if="showQueueBar" class="card queue-cruise-bar">
      <div class="qcb-top">
        <div class="q-tabs">
          <button :class="{ on: activeQueue === 'all' }" @click="setQueue('all')">
            全部任务 <b>{{ queueCounts.all || allCases.length }}</b>
          </button>
          <button :class="{ on: activeQueue === 'failed' }" @click="setQueue('failed')">
            <i class="qdot red"></i>失败（无在售/倒挂/风控）<b>{{ queueCounts.failed || 0 }}</b>
          </button>
          <button :class="{ on: activeQueue === 'pending' }" @click="setQueue('pending')">
            <i class="qdot amb"></i>待采集 <b>{{ queueCounts.pending || 0 }}</b>
          </button>
          <button :class="{ on: activeQueue === 'review' }" @click="setQueue('review')">
            <i class="qdot pur"></i>待复核（触发门禁）<b>{{ queueCounts.review || 0 }}</b>
          </button>
          <button :class="{ on: activeQueue === 'success' }" @click="setQueue('success')">
            <i class="qdot grn"></i>成功分档 <b>{{ queueCounts.success || 0 }}</b>
          </button>
        </div>

        <button class="btn sm" @click="openCatModal">
          🗂 6大品类全局搜索策略（拆词/组合）
        </button>
      </div>

      <!-- 子档位细分条 + 快捷切换胶囊 -->
      <div v-if="activeQueue === 'success'" class="sub-band-row">
        <span class="sb-lbl">采购成本溢价分档：</span>
        <button class="sb-chip" :class="{ on: subBand === 'all' }" @click="subBand = 'all'">全部成功 ({{ queueCounts.success || 0 }})</button>
        <button class="sb-chip amb" :class="{ on: subBand === 'purchase_100_119' }" @click="subBand = 'purchase_100_119'">未满 120% 档 ({{ queueCounts.success_100_119 || 0 }})</button>
        <button class="sb-chip grn" :class="{ on: subBand === 'purchase_120_plus' }" @click="subBand = 'purchase_120_plus'">120%+ 正常档 ({{ queueCounts.success_120_plus || 0 }})</button>
        <button class="sb-chip grn" :class="{ on: subBand === 'purchase_150_plus' }" @click="subBand = 'purchase_150_plus'">150%+ 优质档 ({{ queueCounts.success_150_plus || 0 }})</button>
        <button class="sb-chip acc" :class="{ on: subBand === 'purchase_200_plus' }" @click="subBand = 'purchase_200_plus'">200%+ 高溢价档 ({{ queueCounts.success_200_plus || 0 }})</button>
      </div>
      <div v-else-if="activeQueue !== 'all' && filteredQueueCases.length" class="sub-band-row">
        <span class="sb-lbl">点选快速跳转处理：</span>
        <button
          v-for="row in filteredQueueCases.slice(0, 8)"
          :key="row.code"
          class="sb-chip"
          :class="{ on: row.code === currentCode }"
          @click="pickCode(row.code)"
        >
          {{ row.brand }} {{ row.model }} · {{ row.queueLabel || row.code }}
        </button>
      </div>
    </section>

    <div v-if="loading && !c" class="card pc-loading">正在读取闲鱼网页原始快照与 v0.2.0 机器筛选结果…</div>

    <template v-else-if="c">
      <!-- 核心决策面板：SPU 身份 + 四事实并列核价 + 三道门禁 + 候选价格单选 -->
      <section class="card decision-panel">
        <div class="dp-top">
          <div class="dp-sku">
            <div class="dp-badges">
              <span class="tag acc">货号 {{ c.code }}</span>
              <span class="tag">SPU <code>{{ c.spuCode }}</code></span>
              <span v-if="c.siblingCodes?.length" class="tag grn" :title="'同SPU共享多词策略与快照：' + c.siblingCodes.join(', ')">
                🔗 +{{ c.siblingCodes.length }} 兄弟件共享
              </span>
              <span class="tag" :class="c.step === 'active' ? 'grn' : cp.reviewOnly ? 'amb' : 'acc'">
                {{ c.step === 'active' ? `✓ 已生效 ¥${c.confirmedPrice}` : (cp.queueLabel || '机器已初筛 · 待确认') }}
              </span>
              <span v-if="c.stockAgeDays >= 15" class="tag" :class="c.stockAgeDays >= 28 ? 'red' : 'amb'">
                在库 {{ c.stockAgeDays }} 天
              </span>
              <span class="tag">成本 {{ c.cost ? `¥${c.cost}` : '无' }}</span>
              <span v-if="c.stats?.median" class="tag grn">中位 ¥{{ c.stats.median }} / 均 ¥{{ c.stats?.cleanedAverage || '—' }}</span>
              <span v-if="c.baselineEval?.sanityBlocked" class="tag red">🚨 假低价已拦（兜底 ¥{{ c.baselineEval.fallbackSalePrice }}）</span>
            </div>

            <h1>
              {{ c.spuPolicy?.localization?.displayName || ((c.brand ? c.brand + ' ' : '') + c.model) }}
              <small>WMS：{{ c.name }}</small>
            </h1>

            <!-- API 四字段严格隔离展示条（点击工具栏「API溯源」展开） -->
            <div v-if="showApiMeta" class="api-meta-strip">
              <div><span>1. 任务 SPU 编码</span><code>{{ c.spuPolicy?.apiMeta?.taskSpuCode || c.spuCode }}</code></div>
              <div><span>2. 上游 API SPU</span><code>{{ c.spuPolicy?.apiMeta?.apiSpuCode || '未绑定（待归并）' }}</code></div>
              <div><span>3. API 商品名原文</span><code>{{ c.spuPolicy?.apiMeta?.apiProductName || c.name }}</code></div>
              <div><span>4. API #型号清洗候选</span><code>{{ c.spuPolicy?.apiMeta?.apiCleanedAlias || c.model }}</code></div>
            </div>
          </div>

          <!-- 右上精简控制簇（四事实/门禁、策略与 AI 证据按需折叠展开，首屏优先露快照卡片） -->
          <div class="dp-top-acts">
            <button class="btn sm" :class="{ pri: factsOpen }" @click="factsOpen = !factsOpen">
              📊 {{ factsOpen ? '收起四事实与门禁' : '四事实与门禁详情 ▾' }}
            </button>
            <button
              v-if="c.aiSuggestion || c.aiWebSearchResults?.length || c.wmsWritebacks?.length"
              class="btn sm"
              :class="{ pri: aiOpen }"
              @click="aiOpen = !aiOpen"
            >
              🤖 {{ aiOpen ? '收起 AI 证据' : 'AI 证据/回写 ▾' }}
            </button>
            <button class="btn sm" :class="{ pri: toolsOpen }" @click="toolsOpen = !toolsOpen">
              ⚙ {{ toolsOpen ? '收起策略工具' : `策略工具 (${effectiveQueries.length}/12词) ▾` }}
            </button>
            <button class="btn sm amb-btn" :disabled="busy" @click="doInvalidateRecrawl('员工手动触发作废重爬')">
              ↺ 作废重爬
            </button>
          </div>
        </div>

        <div v-if="toolsOpen" class="dp-top-acts secondary-tools">
          <button class="btn sm" :class="{ pri: policyOpen }" @click="policyOpen = !policyOpen">
            ⚙ SPU 多关键词策略 ({{ effectiveQueries.length }}/12词)
          </button>
          <button class="btn sm" :disabled="busy" @click="runAiCorrect(false)">
            🤖 AI 型号纠改/找俗称
          </button>
          <button class="btn sm" :disabled="busy" @click="runWebEvidence">
            🌐 联网核查证据
          </button>
          <button class="btn sm" @click="openWmsModal">
            📝 回写 WMS 名称
          </button>
          <button class="btn sm" @click="showApiMeta = !showApiMeta">
            🔍 {{ showApiMeta ? '收起 API 四字段溯源' : 'API 四字段溯源' }}
          </button>
        </div>

        <!-- AI 型号纠改建议 + 联网核查证据面板（默认折叠，点击右上「AI 证据/回写」展开） -->
        <div v-if="aiOpen && (c.aiSuggestion || c.aiWebSearchResults?.length || c.wmsWritebacks?.length)" class="ai-evidence-box">
          <div v-if="c.aiSuggestion" class="ai-sug-card">
            <div class="asc-left">
              <span class="tag acc">🤖 AI 型号别名诊断（置信度 {{ Math.round((c.aiSuggestion.confidence || 0.94) * 100) }}%）</span>
              <b>{{ c.aiSuggestion.diagnosis }}</b>
              <p>
                建议中文显示名：<code>{{ c.aiSuggestion.suggestedDisplayName }}</code> ｜
                建议多关键词：<code>{{ (c.aiSuggestion.suggestedQueries || []).join(' , ') }}</code> ｜
                匹配别名：<code>{{ (c.aiSuggestion.suggestedAliases || []).join(' , ') }}</code>
              </p>
            </div>
            <button class="btn sm pri" :disabled="busy" @click="runAiCorrect(true)">
              ⚡ 一键采纳多词别名并重爬闲鱼快照
            </button>
          </div>

          <div v-if="c.aiWebSearchResults?.length" class="web-ev-grid">
            <div v-for="(ev, idx) in c.aiWebSearchResults" :key="idx" class="wev-item">
              <div class="wev-hd">
                <b>{{ ev.source }}</b>
                <code>{{ ev.domain }}</code>
              </div>
              <div class="wev-title">{{ ev.title }}</div>
              <p>{{ ev.snippet }}</p>
            </div>
          </div>

          <div v-if="c.wmsWritebacks?.length" class="wms-log-line">
            <span class="tag grn">✓ WMS GET 读回强校验已通过</span>
            <span>原名「{{ c.wmsWritebacks[0].beforeName }}」→ 回写并 GET 核实为「<b>{{ c.wmsWritebacks[0].verifiedGetName }}</b>」（{{ c.wmsWritebacks[0].operator }} @ {{ c.wmsWritebacks[0].verifiedAt }}）</span>
          </div>
        </div>

        <!-- 完整复刻 v0.2.0 SPU 独立搜索策略抽屉（inherit_category / explicit 12词 + 12别名 + 网页价格框RPA） -->
        <div v-if="policyOpen" class="policy-drawer">
          <div class="pd-head">
            <div>
              <b>SPU 级多关键词搜索与五重过滤策略（按 SPU <code>{{ c.spuCode }}</code> 持久化，同款多件共享）</b>
              <p class="muted sm">注：中文本地化显示名仅作界面阅读展示，绝不悄悄混入搜索词；人工指定模式支持最多 12 个搜索词，跨词按 itemId 自动去重。</p>
            </div>
            <span class="tag" :class="c.spuPolicy?.pageFilter?.evidenceStatus === 'page_filter_verified' ? 'grn' : 'amb'">
              {{ c.spuPolicy?.pageFilter?.evidenceStatus === 'page_filter_verified' ? '✓ 闲鱼网页价格框已核验' : '网页价格框未设限/关闭' }}
            </span>
          </div>

          <div class="pf-grid">
            <label>搜索词生成模式 (search.mode)
              <select class="inp" v-model="polDraft.searchMode">
                <option value="inherit_category">继承 6 大品类拆词/组合规则 + 自动叠加别名 (inherit_category)</option>
                <option value="explicit">人工指定专属多关键词列表 (explicit · 最多 12 个词)</option>
              </select>
            </label>

            <label>所属品类规则档
              <select class="inp" v-model="polDraft.categoryName">
                <option value="显示器">显示器</option>
                <option value="空气净化器">空气净化器</option>
                <option value="音响">音响</option>
                <option value="脱毛仪">脱毛仪</option>
                <option value="Apple产品">Apple产品</option>
                <option value="默认/其它">默认/其它</option>
              </select>
            </label>

            <label class="span-2">
              人工指定搜索词列表（逗号或换行分隔，支持最多 <b>12</b> 个闲鱼搜索词；跨词自动 URL/itemId 去重）
              <textarea
                class="inp area"
                rows="2"
                v-model="polDraft.queries"
                placeholder="例如：27M2N5510P, 飞利浦 27M2N5510P, Evnia 27寸2K180Hz, 飞利浦 27寸 180Hz（最多 12 个）"
              ></textarea>
            </label>

            <label>中文本地化显示名（仅展示，不混入搜索词）
              <input class="inp" v-model="polDraft.displayName" placeholder="例如：飞利浦 Evnia 27M2N5510P 27寸2K" />
            </label>

            <label>标题相关性匹配别名（逗号分隔，最多 <b>12</b> 个）
              <input class="inp" v-model="polDraft.searchAliases" placeholder="例如：27M2N5510P, Evnia5510P, 27M2N" />
            </label>

            <label>屏蔽词策略 (blacklist.mode)
              <select class="inp" v-model="polDraft.blacklistMode">
                <option value="append">默认全局屏蔽词 + 追加 SPU 专属词（append）</option>
                <option value="inherit">仅全局默认屏蔽词（inherit）</option>
                <option value="replace">仅使用下方自定义词（replace）</option>
              </select>
            </label>

            <label>SPU 专属屏蔽词（最多 100 词，配件/干扰词）
              <input class="inp" v-model="polDraft.blacklistTerms" placeholder="例如：底座, 支架, 电源板, 碎屏, 空盒" />
            </label>

            <div class="fence-pair">
              <label>SPU 挂牌最低价围栏 (¥)
                <input type="number" class="inp" v-model.number="polDraft.minListingPrice" placeholder="不限" />
              </label>
              <label>SPU 挂牌最高价围栏 (¥)
                <input type="number" class="inp" v-model.number="polDraft.maxListingPrice" placeholder="不限" />
              </label>
            </div>

            <label class="pf-chk">
              <input type="checkbox" v-model="polDraft.pageFilterEnabled" />
              <span>启用闲鱼网页端价格区间输入框 RPA 自动回填与核验 (<code>goofish-price-filter-rpa</code>)</span>
            </label>
          </div>

          <div v-if="c.spuPolicy?.fenceInvertedWarning" class="inv-warn">
            ⚠ {{ c.spuPolicy.fenceInvertedWarning }}
          </div>

          <div class="eff-preview">
            <span>当前生效抓取词（共 {{ effectiveQueries.length }} 个）：</span>
            <code v-for="(qItem, qi) in effectiveQueries" :key="qi">[词{{ qi + 1 }}] {{ qItem }}</code>
          </div>

          <div class="pf-btns">
            <button class="btn sm" :disabled="busy" @click="applyPolicyFilterOnly">保存策略并重筛当前快照</button>
            <button class="btn sm pri" :disabled="busy" @click="doInvalidateRecrawl('保存 SPU 多关键词与围栏策略后重爬闲鱼快照')">
              🚀 保存 SPU 多词策略并重新抓取闲鱼快照
            </button>
          </div>
        </div>

        <!-- 四事实 + 规格兜底 + 三道安全门禁详情（默认折叠，点右上按钮展开） -->
        <div v-if="factsOpen" class="facts-drawer">
          <!-- 四事实并列对比条（严格复刻 price-candidate.js：绝不把 API 价格混进闲鱼样本！） -->
          <div class="four-facts-strip">
            <div class="ff-card">
              <span>事实 1 · API 当前在售价</span>
              <b>{{ cp.fourFacts?.apiCurrentSalePrice ? `¥${cp.fourFacts.apiCurrentSalePrice}` : '暂未在售' }}</b>
              <small>WMS/闲管家在架同步值</small>
            </div>
            <div class="ff-card">
              <span>事实 2 · API 历史建议价</span>
              <b>{{ cp.fourFacts?.apiSuggestPrice ? `¥${cp.fourFacts.apiSuggestPrice}` : '—' }}</b>
              <small>仅并列参考 · 不混入样本</small>
            </div>
            <div class="ff-card">
              <span>事实 3 · 本件采购成本价</span>
              <b>{{ c.cost ? `¥${c.cost}` : '选品无成本' }}</b>
              <small>硬底线围栏（防亏损倒挂）</small>
            </div>
            <div class="ff-card highlight">
              <span>事实 4 · 闲鱼行情中位价 / 清洗均价</span>
              <b>
                {{ c.stats?.median ? `¥${c.stats.median}` : '—' }}
                <em v-if="c.stats?.cleanedAverage"> / 均 ¥{{ c.stats.cleanedAverage }}</em>
              </b>
              <small>有效同款 {{ c.stats?.validCount || 0 }} 条 · 离散度 {{ c.stats?.spreadPct ?? 0 }}%</small>
            </div>
          </div>

          <!-- 规格基准防呆尺 & 95%走量同档兜底核验条（一行结论 + 折叠看推演详情） -->
          <div
            v-if="c.baselineEval?.supported"
            class="baseline-sanity-strip"
            :class="c.baselineEval.sanityBlocked ? 'blocked' : c.baselineEval.track === 'highend_5' ? 'hi' : 'ok'"
          >
            <div class="bss-main">
              <span class="tag" :class="c.baselineEval.sanityBlocked ? 'red' : c.baselineEval.track === 'zowie_independent' ? 'amb' : c.baselineEval.track === 'highend_5' ? 'acc' : 'grn'">
                {{ c.baselineEval.trackLabel }}
              </span>
              <span class="tag" v-if="c.baselineEval.spec">
                {{ c.baselineEval.spec.size }}″ · {{ c.baselineEval.spec.res }} · {{ c.baselineEval.spec.hz }}Hz · {{ c.baselineEval.spec.panel }}
              </span>
              <span class="bss-meta" v-if="c.baselineEval.buyBaseline">收货基准：<b>¥{{ c.baselineEval.buyBaseline }}</b></span>
              <span class="bss-meta" v-if="c.baselineEval.bucketCrawledMedian">同档中位：<b>¥{{ c.baselineEval.bucketCrawledMedian }}</b></span>
              <span class="bss-meta" v-if="c.baselineEval.fallbackSalePrice">兜底：<b>¥{{ c.baselineEval.fallbackSalePrice }}</b></span>
              <details v-if="c.baselineEval.sanityReason" class="bss-fold">
                <summary>{{ c.baselineEval.sanityBlocked ? '🚨 拦截异常低价 · 展开推演' : '展开推演详情' }}</summary>
                <p class="bss-reason">{{ c.baselineEval.sanityReason }}</p>
              </details>
            </div>
          </div>

          <!-- 三道硬安全门禁条（24h新鲜度 · 有效样本≥3 · 离散度≤25%） -->
          <div v-if="c.samples?.length" class="gate-banner" :class="cp.reviewOnly ? 'locked' : 'ok'">
            <div class="gb-left">
              <span class="gb-id">预览单号 <code>{{ cp.previewId || 'PV-INIT' }}</code></span>
              <span class="gchip" :class="cp.gates?.fresh24h ? 'ok' : 'bad'">
                {{ cp.gates?.fresh24h ? '✓ 24h新鲜度达标' : '✕ 快照超24h' }}
              </span>
              <span class="gchip" :class="cp.gates?.samplesGe3 ? 'ok' : 'bad'">
                {{ cp.gates?.samplesGe3 ? `✓ 有效样本 ${cp.gates.validCount}≥3` : `✕ 有效样本仅 ${cp.gates?.validCount || 0}<3` }}
              </span>
              <span class="gchip" :class="cp.gates?.spreadLe25Pct ? 'ok' : 'bad'">
                {{ cp.gates?.spreadLe25Pct ? `✓ 离散度 ${cp.gates.spreadPct}%≤25%` : `✕ 离散度 ${cp.gates?.spreadPct}%>25%` }}
              </span>
              <span v-if="finalPrice && c.cost" class="verdict-chip" :class="purchaseVerdict.lvl">{{ purchaseVerdict.text }}</span>
            </div>

            <div v-if="cp.reviewOnly" class="gb-lock-box">
              <div class="gbl-warn">
                🔒 <b>待复核锁定 (review_only)：</b>{{ (cp.reviewReasons || []).join('；') }}
              </div>
              <label class="gbl-chk">
                <input type="checkbox" v-model="forceReviewOverride" />
                <span>我已人工核查下方闲鱼原版快照，确认放行采用选定售价：</span>
                <input
                  v-model="overrideReason"
                  class="gbl-inp"
                  placeholder="填写复核/放行说明（≥2字，如：成色跨度正常已核实）"
                />
              </label>
            </div>
          </div>
        </div>

        <!-- 折叠状态下如触发 review_only，保留一行紧凑复核放行栏 -->
        <div v-if="cp.reviewOnly && !factsOpen && c.samples?.length" class="review-inline-bar">
          <span class="rib-msg">🔒 <b>待复核：</b>{{ ((cp.reviewReasons || [])[0] || '触发安全门禁，请核查下方快照').slice(0, 48) }}… <button class="link-mini" @click="factsOpen = true">展开推演 ▾</button></span>
          <label class="gbl-chk">
            <input type="checkbox" v-model="forceReviewOverride" />
            <span>人工核实放行：</span>
            <input v-model="overrideReason" class="gbl-inp" placeholder="填放行说明（≥2字）" />
          </label>
        </div>

        <!-- 尚未抓取快照时的引导 -->
        <div v-if="!c.samples?.length" class="crawl-empty-box">
          <div>
            <b>当前型号处于「失败·无在售 / 待采集」队列，尚未抓回有效闲鱼快照</b>
            <p class="muted">
              当前生效检索词：<b>{{ effectiveQueries.join(' / ') }}</b>。可先点右上角「🤖 AI 型号纠改/找俗称」补充买家常用写法，或直接抓取闲鱼挂牌页。
            </p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button
              v-if="c.baselineEval?.fallbackSalePrice && c.baselineEval?.track !== 'highend_5'"
              class="btn ok"
              :disabled="busy"
              @click="adoptSpecFallback"
            >
              🛡 采用同档规格兜底价 ¥{{ c.baselineEval.fallbackSalePrice }}
            </button>
            <button class="btn" :disabled="busy" @click="runAiCorrect(true)">🤖 AI 补俗称并抓取</button>
            <button class="btn pri" :disabled="busy" @click="doInitialCrawl">⚡ 立即抓取闲鱼挂牌页（36 条）</button>
          </div>
        </div>

        <!-- 已抓回快照：候选价格单选确认区 -->
        <div v-else class="candidates-bar">
          <div class="cand-options">
            <label
              v-for="opt in priceOptions"
              :key="opt.key"
              class="p-opt"
              :class="{ active: !customMode && selectedKey === opt.key }"
              @click="selectCandidate(opt)"
            >
              <div class="po-top">
                <span class="rdot" :class="{ on: !customMode && selectedKey === opt.key }"></span>
                <span class="po-lbl">{{ opt.label }}</span>
                <span v-if="opt.recommended" class="rec-tag">主推</span>
              </div>
              <div class="po-price">¥{{ opt.price }}</div>
              <small>{{ opt.exact ? `精确值 ¥${opt.exact} · ` : '' }}{{ opt.desc }}</small>
            </label>

            <div class="p-opt custom-opt" :class="{ active: customMode }" @click="enableCustomMode">
              <div class="po-top">
                <span class="rdot" :class="{ on: customMode }"></span>
                <span class="po-lbl">✎ 手动修改价格</span>
              </div>
              <div v-if="customMode" class="custom-inp-wrap" @click.stop>
                <span>¥</span>
                <input ref="customInputEl" type="number" v-model.number="customPrice" placeholder="输入统一售价" />
              </div>
              <div v-else class="po-price muted-p">自定义微调</div>
              <small>机器算价不合预期时手动微调</small>
            </div>
          </div>

          <div class="confirm-cta-col">
            <div v-if="needsBelowCostReason && !cp.reviewOnly" class="below-cost-box">
              <span>⚠ 低于成本 ¥{{ c.cost }}，请填清仓原因：</span>
              <input v-model="overrideReason" placeholder="必填（如：满4周期滞销清仓）" />
            </div>

            <button
              v-if="!isPricebookItem"
              class="btn pri main-confirm-btn"
              :disabled="busy || !canConfirm"
              @click="confirmAndNext(true)"
            >
              ✓ 确认价格 ¥{{ finalPrice || '—' }} · 进入第 2 步洗图片 →
            </button>
            <button
              v-else
              class="btn pri main-confirm-btn"
              :disabled="busy || !canConfirm"
              @click="confirmAndNext(false)"
            >
              ✓ 确认采购参考价 ¥{{ finalPrice || '—' }} 生效
            </button>
          </div>
        </div>
      </section>

      <!-- 核心主区：闲鱼原版网页 DOM 快照 + 多关键词 Tab + 查看价格构成与判定日志 -->
      <section v-if="c.samples?.length" class="card snapshot-board">
        <header class="sb-head">
          <div>
            <h2>
              闲鱼搜索挂牌快照与过滤预览
              <small>第 {{ c.crawlBatch }} 轮 · 点图放大 · 底部剔除恢复</small>
            </h2>
          </div>

          <div class="sb-mode-tools">
            <div v-if="snapMode !== 'dom'" class="grid-subfilter">
              <button :class="{ on: viewFilter === 'all' }" @click="viewFilter = 'all'">全部 ({{ tabSamples.length }})</button>
              <button :class="{ on: viewFilter === 'included' }" @click="viewFilter = 'included'">✓ 有效 ({{ tabSamples.filter((x) => x.include).length }})</button>
              <button :class="{ on: viewFilter === 'excluded' }" @click="viewFilter = 'excluded'">✕ 已剔除 ({{ tabSamples.filter((x) => !x.include).length }})</button>
            </div>
            <button class="btn sm" @click="showComposition = !showComposition">
              {{ showComposition ? '▲ 收起价格构成' : '📊 价格构成与日志' }}
            </button>
            <div class="view-seg">
              <button :class="{ on: snapMode === 'dom' }" @click="snapMode = 'dom'">
                🐟 原版闲鱼网页 DOM 快照
              </button>
              <button :class="{ on: snapMode === 'grid' }" @click="snapMode = 'grid'">
                🃏 卡片快审网格
              </button>
            </div>
          </div>
        </header>

        <!-- 多搜索词独立快照切换页签（支持最多 12 个词逐词核查 + 合并去重总视图） -->
        <div class="kw-tabs-bar">
          <button :class="{ on: activeQueryTab === 'all' }" @click="activeQueryTab = 'all'">
            🔗 多词合并去重总览（{{ c.samples.length }} 条<template v-if="c.stats?.dedupedCount"> · 已跨词去重 {{ c.stats.dedupedCount }} 条</template>）
          </button>
          <button
            v-for="lg in perQueryLogs"
            :key="lg.queryIndex"
            :class="{ on: activeQueryTab === String(lg.queryIndex) }"
            @click="activeQueryTab = String(lg.queryIndex)"
          >
            🔍 词{{ lg.queryIndex + 1 }}「{{ lg.query }}」({{ lg.passedCount }}/{{ lg.cardCount }}通过)
          </button>
        </div>

        <!-- 折叠面板：复刻 MarketSnapshotDialog「查看价格构成」+「逐词判定日志表」 -->
        <div v-if="showComposition" class="composition-panel">
          <div class="comp-prices">
            <b>有效样本价格构成（由低到高排序，共 {{ sortedValidPrices.length }} 条）：</b>
            <div class="p-chips">
              <span v-for="(vp, vi) in sortedValidPrices" :key="vi" class="vp-chip" :class="{ med: isMedianChip(vi) }">
                ¥{{ vp }}
              </span>
            </div>
            <span class="comp-formula">
              算术均价 = <b>¥{{ c.stats?.cleanedAverage ?? '—' }}</b> ｜ 中位价 = <b>¥{{ c.stats?.median ?? '—' }}</b>
            </span>
          </div>

          <table class="log-tbl">
            <thead>
              <tr>
                <th>搜索词序号与关键词</th>
                <th>抓回卡片</th>
                <th>通过计入</th>
                <th>屏蔽词命中</th>
                <th>非目标型号</th>
                <th>SPU围栏外</th>
                <th>&lt;100引流价</th>
                <th>防拍异常价</th>
                <th>网页价格框证据</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="lg in perQueryLogs" :key="lg.queryIndex">
                <td><b>词{{ lg.queryIndex + 1 }}：{{ lg.query }}</b></td>
                <td>{{ lg.cardCount }}</td>
                <td class="grn-txt"><b>{{ lg.passedCount }}</b></td>
                <td>{{ lg.blacklistCount }}</td>
                <td>{{ lg.nonTargetCount }}</td>
                <td>{{ lg.fenceOutCount }}</td>
                <td>{{ lg.lowPriceCount }}</td>
                <td>{{ lg.overMaxCount }}</td>
                <td><code>{{ lg.pageFilterStatus }}</code></td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 视图 A（默认）：原版闲鱼网页 DOM 快照 iframe（含 .xianyu-blacklist-card 置灰斜纹遮罩 + 点击图片弹窗放大） -->
        <div v-if="snapMode === 'dom'" class="dom-iframe-wrap">
          <iframe
            :key="iframeSrc"
            :src="iframeSrc"
            class="gf-iframe"
            sandbox="allow-same-origin allow-scripts"
            title="闲鱼网页版原始搜索结果快照"
          ></iframe>
        </div>

        <!-- 视图 B：原生卡片快审网格（点击图片放大看清细节，点击底部按钮剔除/恢复，绝不误触！） -->
        <template v-else>
          <div class="xianyu-cards-grid">
            <article
              v-for="s in filteredSamples"
              :key="s.id"
              class="xy-card"
              :class="{ excluded: !s.include, touched: s.humanTouched }"
            >
              <div class="xyc-img" style="cursor:zoom-in" title="点击高清放大预览此闲鱼商品图" @click.stop="openZoomFromSample(s)">
                <img :src="s.img" :alt="s.title" loading="lazy" />
                <span class="xyc-seq">#{{ s.cardIdx }}</span>
                <span class="xyc-zoom-tip">🔍 放大看图</span>

                <span v-if="s.include && !s.machineInclude" class="xyc-badge restore">↺ 人工恢复</span>
                <span v-else-if="s.include" class="xyc-badge valid">✓ 计入均价</span>
                <span v-else class="xyc-badge rej">{{ s.humanTouched ? '人工剔除' : (s.rejectionBadge || '非目标商品') }}</span>

                <div v-if="!s.include" class="xyc-mask">
                  <span class="mask-stamp">非目标商品</span>
                  <span class="mask-sub">{{ s.humanTouched ? '人工标记去掉' : (s.rejectionBadge || '机器筛除') }}</span>
                </div>
              </div>

              <div class="xyc-body">
                <h4 class="xyc-title" :title="s.title">{{ s.title }}</h4>
                <div class="xyc-price-row">
                  <span class="xyc-price"><i>¥</i><b>{{ Math.floor(s.price) }}</b><small v-if="priceDec(s.price)">{{ priceDec(s.price) }}</small></span>
                  <span class="xyc-wants">{{ s.wants }}人想要</span>
                  <span class="xyc-cond">{{ s.condition }}</span>
                </div>
                <div class="xyc-seller">{{ s.seller }} · {{ s.city }}</div>
                <div class="xyc-reason" :class="s.include ? 'in' : 'out'">
                  {{ s.reason || s.machineReason }}
                </div>
                <button
                  class="xyc-toggle-btn"
                  :class="s.include ? 'to-drop' : 'to-keep'"
                  :disabled="busy"
                  @click.stop="toggleSample(s, !s.include)"
                >
                  {{ s.include ? '✕ 不合理 · 剔除此项' : '↺ 误杀 · 恢复计入均价' }}
                </button>
              </div>
            </article>
          </div>
        </template>

        <!-- 历史确认与作废重爬留痕 -->
        <details v-if="c.versions?.length || c.invalidatedHistory?.length" class="hist-fold">
          <summary>查看价格确认与作废重爬记录（生效 {{ c.versions?.length || 0 }} 次 · 作废 {{ c.invalidatedHistory?.length || 0 }} 次）</summary>
          <div class="hist-rows">
            <div v-for="v in [...(c.versions || [])].reverse()" :key="'v' + v.version" class="hrow">
              <span class="tag grn">v{{ v.version }} · ¥{{ v.price }}</span>
              <span>基于 {{ v.samplesCount }} 条有效闲鱼挂牌（当时均价 ¥{{ v.cleanedAverage ?? '—' }}）</span>
              <span class="muted">{{ v.confirmedBy }} @ {{ v.confirmedAt }} · {{ v.note }}</span>
            </div>
            <div v-for="(iv, idx) in [...(c.invalidatedHistory || [])].reverse()" :key="'iv' + idx" class="hrow">
              <span class="tag amb">第 {{ iv.batch }} 轮已作废</span>
              <span>原均价 ¥{{ iv.oldCleanedAverage ?? '—' }} · {{ iv.reason }}</span>
              <span class="muted">{{ iv.invalidatedBy }} @ {{ iv.invalidatedAt }}</span>
            </div>
          </div>
        </details>
      </section>

      <!-- 吸底确认栏 -->
      <footer v-if="c.samples?.length" class="sticky-foot">
        <div class="sf-metrics">
          <span>保留有效 <b>{{ c.stats?.validCount || 0 }}</b> 条 / 剔除 <b>{{ c.stats?.rejectedCount || 0 }}</b> 条</span>
          <span class="sep">|</span>
          <span>行情中位价：<b>¥{{ c.stats?.median ?? '—' }}</b></span>
          <span class="sep">|</span>
          <span>清洗后均价：<b class="acc-txt">¥{{ c.stats?.recommendedPrice || '—' }}</b></span>
          <span class="sep">|</span>
          <span>当前选定售价：<b class="grn-txt">¥{{ finalPrice || '—' }}</b></span>
        </div>
        <div class="sf-acts">
          <button class="btn sm amb-btn" :disabled="busy" @click="doInvalidateRecrawl('员工在快照底部触发作废重新爬')">
            ↺ 作废重爬
          </button>
          <button
            v-if="!isPricebookItem"
            class="btn pri"
            :disabled="busy || !canConfirm"
            @click="confirmAndNext(true)"
          >
            ✓ 确认价格 ¥{{ finalPrice || '—' }} → 下一步：去洗图片
          </button>
          <button
            v-else
            class="btn pri"
            :disabled="busy || !canConfirm"
            @click="confirmAndNext(false)"
          >
            ✓ 确认价格 ¥{{ finalPrice || '—' }} 生效
          </button>
        </div>
      </footer>
    </template>

    <!-- 高清商品大图预览 Lightbox（支持从原版闲鱼 DOM 快照 iframe 或卡片网格唤起，并在弹窗内直接剔除/恢复） -->
    <div v-if="zoomCard" class="pc-modal-mask" @click="zoomCard = null">
      <div class="pc-zoom-dialog" @click.stop>
        <div class="pzd-img">
          <img :src="zoomCard.img" alt="" />
        </div>
        <div class="pzd-info">
          <div class="pzd-badges">
            <span class="tag">#{{ zoomCard.cardIdx }} 闲鱼实拍卡片</span>
            <span class="tag" :class="zoomCard.include ? 'grn' : 'red'">
              {{ zoomCard.include ? '✓ 当前计入均价' : `✕ 已剔除 · ${zoomCard.badge || '非目标商品'}` }}
            </span>
            <span v-if="zoomCard.condition" class="tag">{{ zoomCard.condition }}</span>
          </div>
          <h3>{{ zoomCard.title }}</h3>
          <div class="pzd-price">¥{{ zoomCard.price }} <small>{{ zoomCard.seller }}</small></div>
          <p class="pzd-reason">{{ zoomCard.reason }}</p>
          <div class="pzd-acts">
            <button class="btn" :disabled="busy" @click="toggleZoomCard">
              {{ zoomCard.include ? '✕ 标记为非目标商品剔除' : '↺ 误杀恢复计入均价' }}
            </button>
            <button class="btn pri" @click="zoomCard = null">关闭高清预览</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 6大品类全局搜索策略配置弹窗（category-search.js） -->
    <div v-if="showCatModal" class="pc-modal-mask" @click.self="showCatModal = false">
      <div class="pc-cat-dialog">
        <h3>🗂 6 大品类全局搜索词拆分/组合策略 (category-search.js)</h3>
        <p class="muted sm">保存后，所有处于「继承品类规则 (inherit_category)」的 SPU 将自动按最新品类模式展开检索词。</p>
        <div class="cat-list">
          <div v-for="cm in catModes" :key="cm.category" class="cat-row">
            <div>
              <b>{{ cm.category }}</b>
              <small>{{ cm.example }}</small>
            </div>
            <select v-model="cm.mode" class="inp">
              <option value="split">split · 拆词双搜（先纯型号，再品牌+型号）</option>
              <option value="combined">combined · 组合精搜（品牌+品类+型号合并）</option>
            </select>
          </div>
        </div>
        <div class="pcd-foot">
          <button class="btn" @click="showCatModal = false">取消</button>
          <button class="btn pri" :disabled="busy" @click="saveCatModes">保存全局品类策略</button>
        </div>
      </div>
    </div>

    <!-- 回写 WMS 商品名称弹窗（带 GET 读回强校验） -->
    <div v-if="showWmsModal" class="pc-modal-mask" @click.self="showWmsModal = false">
      <div class="pc-cat-dialog">
        <h3>📝 回写修正 WMS 标准商品名称（含 GET 读回强校验）</h3>
        <p class="muted sm">当原商品名只有内部工厂码（如 ACM25SC / YJCC020）或型号拼写错误时，回写 WMS 并立即执行 GET 二次读回核验。</p>
        <label style="display:grid;gap:6px;margin:12px 0;font-size:13px;font-weight:700">
          当前 WMS 商品名称：<code>{{ c?.name }}</code>
          <span>修正后标准名称（建议保留 #型号 锚点）：</span>
          <input class="inp" v-model="wmsNewName" placeholder="输入新商品标准名称" />
        </label>
        <div class="pcd-foot">
          <button class="btn" @click="showWmsModal = false">取消</button>
          <button class="btn pri" :disabled="busy || !wmsNewName.trim()" @click="submitWmsWriteback">确认回写并执行 GET 校验</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { api, post } from './api.js'
import { loadAll } from './store.js'
import { toast } from './ui.js'
import { classifyPurchasePct } from './priceCleaning.js'

const props = defineProps({
  id: { type: String, default: '' },
  caseId: { type: String, default: '' }
})

const allCases = ref([])
const queueCounts = ref({})
const activeQueue = ref('all')
const subBand = ref('all')
const currentCode = ref('')
const c = ref(null)
const selectedKey = ref('cleaned_average')
const customMode = ref(false)
const customPrice = ref(null)
const customInputEl = ref(null)
const overrideReason = ref('')
const forceReviewOverride = ref(false)
const policyOpen = ref(false)
const toolsOpen = ref(false)
const aiOpen = ref(false)
const factsOpen = ref(false)
const showApiMeta = ref(false)
const showComposition = ref(false)
const showQueueBar = ref(false)
const snapMode = ref('grid')
const snapRefreshTick = ref(0)
const activeQueryTab = ref('all')
const viewFilter = ref('all')
const zoomCard = ref(null)
const showCatModal = ref(false)
const catModes = ref([])
const showWmsModal = ref(false)
const wmsNewName = ref('')
const loading = ref(false)
const busy = ref(false)

const polDraft = reactive({
  searchMode: 'inherit_category',
  categoryName: '显示器',
  queries: '',
  displayName: '',
  searchAliases: '',
  blacklistMode: 'append',
  blacklistTerms: '',
  minListingPrice: null,
  maxListingPrice: null,
  pageFilterEnabled: true
})

function readCodeFromPropOrHash() {
  const propCode = props.caseId || props.id
  if (propCode) return propCode
  const m = (location.hash || '').match(/^#\/price-cleaning\/([^?]+)/)
  return m ? decodeURIComponent(m[1]) : ''
}

const isPricebookItem = computed(() => String(currentCode.value || '').startsWith('PB-'))
const cp = computed(() => c.value?.candidatePreview || {})
const effectiveQueries = computed(() => c.value?.spuPolicy?.effectiveQueries || c.value?.spuPolicy?.queries || (c.value ? [c.value.model] : []))
const perQueryLogs = computed(() => c.value?.perQueryLogs || [])

const filteredQueueCases = computed(() => {
  return allCases.value.filter((it) => {
    if (activeQueue.value !== 'all' && it.queueBucket !== activeQueue.value) return false
    if (activeQueue.value === 'success' && subBand.value !== 'all' && it.subBucket !== subBand.value) return false
    return true
  })
})

function setQueue(qKey) {
  activeQueue.value = qKey
  subBand.value = 'all'
  const list = allCases.value.filter((it) => qKey === 'all' || it.queueBucket === qKey)
  if (list.length && !list.some((x) => x.code === currentCode.value)) {
    pickCode(list[0].code)
  }
}

const iframeSrc = computed(() => {
  if (!c.value?.snapshotUrl) return ''
  return `${c.value.snapshotUrl}?q=${encodeURIComponent(activeQueryTab.value)}&v=${snapRefreshTick.value}`
})

const sortedValidPrices = computed(() => {
  return (c.value?.samples || [])
    .filter((s) => s.include)
    .map((s) => Number(s.price))
    .sort((a, b) => a - b)
})

function isMedianChip(idx) {
  const n = sortedValidPrices.value.length
  if (!n) return false
  return idx === Math.floor(n / 2) || (n % 2 === 0 && idx === n / 2 - 1)
}

const priceOptions = computed(() => {
  const cands = c.value?.stats?.priceCandidates || []
  if (cands.length) return cands
  const st = c.value?.stats || {}
  return st.recommendedPrice
    ? [{ key: 'cleaned_average', label: '清洗后平均挂牌价（主推）', price: st.recommendedPrice, exact: st.cleanedAverage, desc: '同款有效挂牌均价', recommended: true }]
    : []
})

const finalPrice = computed(() => {
  if (customMode.value) return Number(customPrice.value) > 0 ? Math.round(Number(customPrice.value)) : 0
  const hit = priceOptions.value.find((o) => o.key === selectedKey.value) || priceOptions.value[0]
  return hit ? Math.round(Number(hit.price)) : 0
})

const purchaseVerdict = computed(() => classifyPurchasePct(finalPrice.value, c.value?.cost))
const needsBelowCostReason = computed(() => {
  const cost = Number(c.value?.cost || 0)
  return cost > 0 && finalPrice.value > 0 && finalPrice.value < cost
})

const canConfirm = computed(() => {
  if (!c.value?.samples?.some((s) => s.include)) return false
  if (finalPrice.value <= 0) return false
  if (needsBelowCostReason.value && overrideReason.value.trim().length < 2) return false
  if (cp.value.reviewOnly && !forceReviewOverride.value && overrideReason.value.trim().length < 2) return false
  return true
})

const tabSamples = computed(() => {
  const rows = c.value?.samples || []
  if (activeQueryTab.value === 'all') return rows
  const qi = Number(activeQueryTab.value)
  return rows.filter((s) => (s.queryHits || [0]).includes(qi))
})

const filteredSamples = computed(() => {
  const list = tabSamples.value
  if (viewFilter.value === 'included') return list.filter((s) => s.include)
  if (viewFilter.value === 'excluded') return list.filter((s) => !s.include)
  return list
})

function priceDec(v) {
  const n = Number(v || 0)
  const diff = Math.round((n - Math.floor(n)) * 100)
  return diff > 0 ? `.${String(diff).padStart(2, '0')}` : ''
}

function syncFromCase(data) {
  if (!data) return
  c.value = data
  snapRefreshTick.value += 1
  const pol = data.spuPolicy || {}
  const searchObj = pol.search || {}
  const locObj = pol.localization || {}
  polDraft.searchMode = searchObj.mode || 'inherit_category'
  polDraft.categoryName = pol.categoryName || '显示器'
  const qList = searchObj.mode === 'explicit' && (searchObj.queries || []).length ? searchObj.queries : (pol.effectiveQueries || pol.queries || [data.model])
  polDraft.queries = qList.join(', ')
  polDraft.displayName = locObj.displayName || ''
  polDraft.searchAliases = (locObj.searchAliases || pol.aliases || []).join(', ')
  polDraft.blacklistMode = pol.blacklistMode || 'append'
  polDraft.blacklistTerms = (pol.blacklistTerms || []).join(', ')
  polDraft.minListingPrice = pol.minListingPrice ?? null
  polDraft.maxListingPrice = pol.maxListingPrice ?? null
  polDraft.pageFilterEnabled = pol.pageFilter ? !!pol.pageFilter.enabled : true

  const opts = data.stats?.priceCandidates || []
  if (data.confirmedPrice) {
    const matchOpt = opts.find((o) => Math.round(Number(o.price)) === Math.round(Number(data.confirmedPrice)))
    if (matchOpt) {
      customMode.value = false
      selectedKey.value = matchOpt.key
    } else {
      customMode.value = true
      customPrice.value = Math.round(Number(data.confirmedPrice))
    }
  } else {
    customMode.value = false
    selectedKey.value = opts[0]?.key || 'cleaned_average'
    customPrice.value = data.stats?.recommendedPrice || null
  }
}

async function refreshQueue() {
  try {
    const res = await api('/price-clean/skus')
    allCases.value = res.items || []
    queueCounts.value = res.queueCounts || {}
  } catch {
    allCases.value = []
  }
}

async function loadCase(code) {
  if (!code) return
  currentCode.value = code
  loading.value = true
  activeQueryTab.value = 'all'
  viewFilter.value = 'all'
  forceReviewOverride.value = false
  try {
    const data = await api(`/price-clean/skus/${encodeURIComponent(code)}`)
    syncFromCase(data)
  } catch (e) {
    toast('读取价格快照失败：' + e.message)
  } finally {
    loading.value = false
  }
}

async function bootstrap() {
  await refreshQueue()
  const target =
    readCodeFromPropOrHash() ||
    allCases.value.find((x) => x.step !== 'active')?.code ||
    allCases.value[0]?.code ||
    '513211549229'
  await loadCase(target)
}

function selectCandidate(opt) {
  customMode.value = false
  selectedKey.value = opt.key
  customPrice.value = opt.price
}

function enableCustomMode() {
  if (!customMode.value) {
    customPrice.value = finalPrice.value || c.value?.stats?.recommendedPrice || null
    customMode.value = true
  }
  nextTick(() => customInputEl.value?.focus())
}

function pickCode(code) {
  if (!code || code === currentCode.value) return
  location.hash = '#/price-cleaning/' + encodeURIComponent(code)
}

function goGallery() {
  location.hash = '#/wash'
}

function goImageStep() {
  if (!currentCode.value) return goGallery()
  location.hash = '#/image-cleaning/' + encodeURIComponent(currentCode.value)
}

function buildPolicyPatch() {
  return {
    searchMode: polDraft.searchMode,
    categoryName: polDraft.categoryName,
    queries: polDraft.queries,
    displayName: polDraft.displayName,
    searchAliases: polDraft.searchAliases,
    blacklistMode: polDraft.blacklistMode,
    blacklistTerms: polDraft.blacklistTerms,
    minListingPrice: polDraft.minListingPrice,
    maxListingPrice: polDraft.maxListingPrice,
    pageFilterEnabled: polDraft.pageFilterEnabled
  }
}

async function doInitialCrawl() {
  busy.value = true
  try {
    const data = await post(`/price-clean/skus/${encodeURIComponent(currentCode.value)}/crawl`, {
      spuPolicy: buildPolicyPatch()
    })
    syncFromCase(data)
    await refreshQueue()
    toast(`已抓回闲鱼整页 ${data.samples.length} 条挂牌，清洗均价 ¥${data.stats?.recommendedPrice || '—'}`)
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function applyPolicyFilterOnly() {
  busy.value = true
  try {
    const r = await fetch(`/api/price-clean/skus/${encodeURIComponent(currentCode.value)}/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (localStorage.getItem('erp_token') || '')
      },
      body: JSON.stringify({ spuPolicy: buildPolicyPatch() })
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.detail || '更新过滤规则失败')
    syncFromCase(data)
    await refreshQueue()
    toast(`已保存 SPU 策略并重筛：有效 ${data.stats?.validCount} 条，新均价 ¥${data.stats?.recommendedPrice || '—'}`)
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function doInvalidateRecrawl(reason) {
  busy.value = true
  try {
    const data = await post(`/price-clean/skus/${encodeURIComponent(currentCode.value)}/invalidate-recrawl`, {
      reason,
      spuPolicy: buildPolicyPatch()
    })
    syncFromCase(data)
    await refreshQueue()
    toast(data.msg || '已按最新多词策略重新爬取闲鱼快照')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function runAiCorrect(applyAndRecrawl = false) {
  busy.value = true
  try {
    const data = await post(`/price-clean/skus/${encodeURIComponent(currentCode.value)}/ai-correct`, {
      applyAndRecrawl
    })
    syncFromCase(data)
    await refreshQueue()
    toast(data.msg || 'AI 型号别名诊断已完成')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function runWebEvidence() {
  busy.value = true
  try {
    const data = await post(`/price-clean/skus/${encodeURIComponent(currentCode.value)}/web-evidence`, {})
    syncFromCase(data)
    toast(data.msg || '已完成联网核查')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function openCatModal() {
  try {
    const res = await api('/price-clean/category-modes')
    catModes.value = res.items || []
    showCatModal.value = true
  } catch (e) {
    toast(e.message)
  }
}

async function saveCatModes() {
  busy.value = true
  try {
    const modesMap = Object.fromEntries(catModes.value.map((m) => [m.category, m.mode]))
    const r = await fetch('/api/price-clean/category-modes', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (localStorage.getItem('erp_token') || '')
      },
      body: JSON.stringify({ modes: modesMap })
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.detail || '保存失败')
    showCatModal.value = false
    await loadCase(currentCode.value)
    toast('已保存 6 大品类全局搜索策略，继承态 SPU 已实时同步')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

function openWmsModal() {
  wmsNewName.value = c.value?.aiSuggestion?.suggestedWmsName || c.value?.spuPolicy?.localization?.displayName || c.value?.name || ''
  showWmsModal.value = true
}

async function submitWmsWriteback() {
  busy.value = true
  try {
    const data = await post(`/price-clean/skus/${encodeURIComponent(currentCode.value)}/wms-writeback`, {
      newName: wmsNewName.value.trim()
    })
    syncFromCase(data)
    showWmsModal.value = false
    toast(data.msg || 'WMS 商品名称已回写并通过 GET 校验')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function toggleSampleById(sampleId, nextInclude) {
  busy.value = true
  try {
    const r = await fetch(
      `/api/price-clean/skus/${encodeURIComponent(currentCode.value)}/samples/${encodeURIComponent(sampleId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + (localStorage.getItem('erp_token') || '')
        },
        body: JSON.stringify({ include: nextInclude })
      }
    )
    const data = await r.json()
    if (!r.ok) throw new Error(data.detail || '切换失败')
    syncFromCase(data)
    await refreshQueue()
    toast(
      nextInclude
        ? `已恢复计入 → 新均价 ¥${data.stats?.recommendedPrice || '—'}`
        : `已剔除噪音卡片 → 新均价 ¥${data.stats?.recommendedPrice || '—'}`
    )
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

function toggleSample(s, nextInclude) {
  return toggleSampleById(s.id, nextInclude)
}

function openZoomFromSample(s) {
  zoomCard.value = {
    id: s.id,
    cardIdx: s.cardIdx,
    img: s.img,
    title: s.title,
    price: s.price,
    seller: `${s.seller} · ${s.city}`,
    condition: s.condition,
    include: s.include,
    badge: s.rejectionBadge,
    reason: s.reason || s.machineReason
  }
}

async function toggleZoomCard() {
  if (!zoomCard.value) return
  const targetInc = !zoomCard.value.include
  await toggleSampleById(zoomCard.value.id, targetInc)
  const fresh = (c.value?.samples || []).find((x) => x.id === zoomCard.value.id)
  if (fresh) openZoomFromSample(fresh)
}

function onIframeMessage(ev) {
  const msg = ev?.data
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'xy-zoom') {
    zoomCard.value = msg
  } else if (msg.type === 'xy-card-click' && msg.id) {
    const hit = (c.value?.samples || []).find((s) => s.id === msg.id)
    if (hit) toggleSampleById(hit.id, !hit.include)
  }
}

async function adoptSpecFallback() {
  const fb = c.value?.baselineEval?.fallbackSalePrice
  if (!fb) return
  busy.value = true
  try {
    const data = await post(`/price-clean/skus/${encodeURIComponent(currentCode.value)}/confirm`, {
      price: fb,
      overrideReason: '闲鱼无有效在售样本，采用95%走量同规格桶兜底价',
      forceReviewOverride: true,
      note: `采用同档规格兜底价 ¥${fb}`
    })
    syncFromCase(data)
    loadAll().catch(() => {})
    await refreshQueue()
    toast(`已采用同档规格兜底价 ¥${fb} 生效`)
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function confirmAndNext(jumpToStep2) {
  if (!canConfirm.value) return
  busy.value = true
  try {
    const data = await post(`/price-clean/skus/${encodeURIComponent(currentCode.value)}/confirm`, {
      price: finalPrice.value,
      overrideReason: overrideReason.value.trim(),
      forceReviewOverride: forceReviewOverride.value,
      note: customMode.value ? `手动微调售价 ¥${finalPrice.value}` : `确认采用${selectedKey.value === 'market_median' ? '行情中位价' : '清洗均价'} ¥${finalPrice.value}`
    })
    syncFromCase(data)
    loadAll().catch(() => {})
    await refreshQueue()
    toast(data.msg || `已确认售价 ¥${finalPrice.value}`)
    if (jumpToStep2 && !isPricebookItem.value) {
      location.hash = '#/image-cleaning/' + encodeURIComponent(currentCode.value)
    }
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

watch(
  () => [props.id, props.caseId],
  () => {
    const next = readCodeFromPropOrHash()
    if (next && next !== currentCode.value) loadCase(next)
  }
)

onMounted(() => {
  window.addEventListener('message', onIframeMessage)
  bootstrap()
})

onUnmounted(() => {
  window.removeEventListener('message', onIframeMessage)
})
</script>

<style scoped>
.pc-page { padding: 12px 24px 86px; max-width: 1720px; margin: 0 auto; display: grid; gap: 8px; }
.pc-loading { padding: 64px 24px; text-align: center; color: var(--mute); font-weight: 700; }

.wizard-bar { padding: 8px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.wiz-steps { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wstep { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--soft); color: var(--mute); font-weight: 700; font-size: 12.5px; cursor: pointer; }
.wstep i { width: 19px; height: 19px; border-radius: 99px; background: rgba(15,23,42,.1); font-style: normal; font-size: 11px; font-weight: 900; display: inline-flex; align-items: center; justify-content: center; }
.wstep.cur { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.wstep.cur i { background: var(--acc); color: #fff; }
.wstep.done { background: #ecfdf5; color: #15803d; border-color: #bbf7d0; }
.wstep.done i { background: #16a34a; color: #fff; }
.wsep { color: var(--mute); font-weight: 800; }
.wiz-switch { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.sku-sel { height: 30px; border-radius: 9px; border: 1px solid var(--line); background: var(--panel); padding: 0 9px; font-weight: 700; font-size: 12px; max-width: 210px; }

/* 5大队列巡航条 */
.queue-cruise-bar { padding: 8px 14px; display: grid; gap: 6px; }
.qcb-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.q-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.q-tabs button { height: 30px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--line); background: var(--soft); font-size: 12px; font-weight: 800; color: var(--ink); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.q-tabs button.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.qdot { width: 8px; height: 8px; border-radius: 99px; display: inline-block; }
.qdot.red { background: #ef4444; }
.qdot.amb { background: #f59e0b; }
.qdot.pur { background: #8b5cf6; }
.qdot.grn { background: #22c55e; }
.sub-band-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding-top: 6px; border-top: 1px dashed var(--line); }
.sb-lbl { font-size: 12px; font-weight: 700; color: var(--mute); }
.sb-chip { height: 26px; padding: 0 9px; border-radius: 8px; border: 1px solid var(--line); background: #fff; font-size: 12px; font-weight: 700; cursor: pointer; }
.sb-chip.on { background: var(--acc-soft); border-color: var(--acc); color: var(--acc); }

.decision-panel { padding: 9px 14px; display: grid; gap: 6px; }
.dp-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: nowrap; }
.dp-sku { flex: 1; min-width: 0; }
.dp-badges { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 3px; }
.link-mini { border: 0; background: none; color: var(--acc); font-size: 12px; font-weight: 800; cursor: pointer; text-decoration: underline; }
.dp-sku h1 { margin: 0; font-size: 20px; font-weight: 900; letter-spacing: -.02em; }
.dp-sku h1 small { font-size: 12.5px; font-weight: 600; color: var(--mute); margin-left: 8px; }
.dp-top-acts { display: flex; gap: 6px; flex-wrap: wrap; }
.secondary-tools { padding-top: 4px; border-top: 1px dashed var(--line); }
.amb-btn { background: #fffbeb; border-color: #fde68a; color: #92400e; font-weight: 800; }

.api-meta-strip { margin-top: 8px; padding: 9px 12px; border-radius: 10px; background: #f8fafc; border: 1px solid var(--line); display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; font-size: 12px; }
.api-meta-strip div { display: grid; gap: 2px; }
.api-meta-strip span { color: var(--mute); font-weight: 700; }
.api-meta-strip code { font-family: ui-monospace, SFMono-Regular, monospace; color: var(--ink); font-weight: 700; }

.ai-evidence-box { display: grid; gap: 10px; padding: 12px 14px; border-radius: 14px; background: #f0f9ff; border: 1px solid #bae6fd; }
.ai-sug-card { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.asc-left { display: grid; gap: 4px; font-size: 13px; }
.asc-left p { margin: 0; font-size: 12px; color: #334155; }
.asc-left code { background: #fff; padding: 1px 6px; border-radius: 5px; font-weight: 700; }
.web-ev-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
.wev-item { background: #fff; border-radius: 10px; padding: 10px 12px; border: 1px solid #e0f2fe; font-size: 12px; }
.wev-hd { display: flex; justify-content: space-between; margin-bottom: 4px; }
.wev-title { font-weight: 800; color: #0f172a; margin-bottom: 4px; }
.wev-item p { margin: 0; color: #475569; line-height: 1.45; }
.wms-log-line { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: #166534; }

/* SPU 12词策略抽屉 */
.policy-drawer { padding: 16px; border-radius: 14px; background: var(--soft); border: 1px solid var(--line); display: grid; gap: 12px; }
.pd-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.pf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 11px; }
.pf-grid label { display: grid; gap: 5px; font-size: 12px; font-weight: 700; color: var(--mute); }
.pf-grid label.span-2 { grid-column: 1 / -1; }
.pf-chk { display: flex !important; align-items: center; gap: 8px !important; color: var(--ink) !important; grid-column: 1 / -1; }
.fence-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.inp { height: 36px; border-radius: 9px; border: 1px solid var(--line); background: #fff; padding: 0 11px; font-size: 13px; color: var(--ink); width: 100%; }
.inp.area { height: auto; padding: 8px 11px; font-family: inherit; }
.eff-preview { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
.eff-preview code { background: #fff; border: 1px solid var(--line); padding: 2px 8px; border-radius: 6px; font-weight: 700; color: var(--acc); }
.inv-warn { font-size: 12.5px; font-weight: 800; color: #b45309; background: #fef3c7; padding: 6px 10px; border-radius: 8px; }
.pf-btns { display: flex; gap: 8px; flex-wrap: wrap; }

/* 四事实并列对比条 */
.four-facts-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.ff-card { padding: 6px 11px; border-radius: 10px; background: #f8fafc; border: 1px solid var(--line); display: grid; gap: 1px; }
.ff-card.highlight { background: #f0fdf4; border-color: #86efac; }
.ff-card span { font-size: 11px; font-weight: 700; color: var(--mute); }
.ff-card b { font-size: 16px; font-weight: 900; color: var(--ink); }
.ff-card b em { font-style: normal; font-size: 12.5px; color: #15803d; }
.ff-card small { display: none; }

/* 三道安全门禁条 */
.gate-banner { padding: 7px 12px; border-radius: 10px; border: 1px solid #bbf7d0; background: #f0fdf4; display: grid; gap: 5px; }
.gate-banner.locked { background: #fffbeb; border-color: #fcd34d; }
.gb-left { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 12px; }
.gb-id code { font-family: ui-monospace, SFMono-Regular, monospace; font-weight: 800; }
.gchip { padding: 2px 8px; border-radius: 999px; font-weight: 800; font-size: 11px; }
.gchip.ok { background: #dcfce7; color: #166534; }
.gchip.bad { background: #fee2e2; color: #b91c1c; }
.verdict-chip { padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 800; }
.verdict-chip.grn { background: #dcfce7; color: #15803d; }
.verdict-chip.amb { background: #fef3c7; color: #92400e; }
.verdict-chip.red { background: #fee2e2; color: #b91c1c; }
.gb-lock-box { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding-top: 5px; border-top: 1px dashed #fcd34d; font-size: 12px; }
.gbl-warn { color: #b45309; }
.gbl-chk { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 700; }
.gbl-inp { height: 28px; min-width: 240px; border-radius: 7px; border: 1px solid #d97706; padding: 0 9px; font-size: 12px; background: #fff; }

.facts-drawer { display: grid; gap: 6px; padding-top: 4px; border-top: 1px dashed var(--line); }
.review-inline-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 6px 12px; border-radius: 10px; background: var(--amb-soft); color: var(--amb-ink); font-size: 12px; }
.crawl-empty-box { padding: 14px 18px; border-radius: 12px; background: #fffbeb; border: 1.5px dashed #f59e0b; display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; }
.candidates-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding-top: 2px; }
.cand-options { flex: 1; min-width: 320px; display: grid; grid-template-columns: repeat(auto-fit, minmax(122px, 1fr)); gap: 8px; }
.p-opt { padding: 7px 11px; border-radius: 11px; border: 2px solid var(--line); background: var(--soft); cursor: pointer; display: grid; gap: 1px; }
.p-opt.active { border-color: var(--acc); background: #eff6ff; }
.po-top { display: flex; align-items: center; gap: 6px; }
.rdot { width: 13px; height: 13px; border-radius: 99px; border: 2px solid #94a3b8; display: inline-block; position: relative; flex-shrink: 0; }
.rdot.on { border-color: var(--acc); }
.rdot.on::after { content: ''; position: absolute; inset: 2px; border-radius: 99px; background: var(--acc); }
.po-lbl { font-size: 12px; font-weight: 800; }
.rec-tag { margin-left: auto; font-size: 10px; font-weight: 900; padding: 1px 6px; border-radius: 99px; background: var(--acc); color: #fff; }
.po-price { font-size: 19px; font-weight: 900; letter-spacing: -.02em; }
.po-price.muted-p { font-size: 14px; color: var(--mute); }
.p-opt small { display: none; }
.custom-inp-wrap { display: flex; align-items: center; gap: 4px; background: #fff; border: 1.5px solid var(--acc); border-radius: 8px; padding: 0 8px; height: 28px; }
.custom-inp-wrap input { border: 0; outline: none; width: 100%; font-size: 15px; font-weight: 900; background: none; }
.confirm-cta-col { display: flex; flex-direction: column; justify-content: center; gap: 6px; min-width: 220px; }
.main-confirm-btn { height: 42px; padding: 0 16px; font-size: 13.5px; font-weight: 900; justify-content: center; border-radius: 11px; }
.below-cost-box { display: grid; gap: 4px; padding: 8px 10px; border-radius: 10px; background: #fef2f2; border: 1px solid #fecaca; font-size: 12px; color: #b91c1c; font-weight: 700; }
.below-cost-box input { height: 30px; border-radius: 7px; border: 1px solid #fca5a5; padding: 0 8px; background: #fff; }

/* 快照主面板 */
.snapshot-board { padding: 10px 16px; display: grid; gap: 8px; }
.sb-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.sb-head h2 { margin: 0; font-size: 16.5px; font-weight: 900; }
.sb-head h2 small { font-size: 12px; font-weight: 600; color: var(--mute); margin-left: 8px; }
.sb-mode-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.view-seg { display: inline-flex; background: var(--soft); padding: 3px; border-radius: 9px; gap: 3px; }
.view-seg button { border: 0; background: transparent; padding: 5px 10px; border-radius: 7px; font-size: 12px; font-weight: 800; color: var(--mute); cursor: pointer; }
.view-seg button.on { background: #fff; color: var(--ink); box-shadow: 0 1px 5px rgba(0,0,0,.08); }

.kw-tabs-bar { display: flex; gap: 6px; flex-wrap: nowrap; overflow-x: auto; padding-bottom: 4px; border-bottom: 1px solid var(--line); scrollbar-width: thin; }
.kw-tabs-bar button { height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--soft); font-size: 12px; font-weight: 800; color: var(--ink); cursor: pointer; white-space: nowrap; flex-shrink: 0; }
.kw-tabs-bar button.on { background: #ffe60f; border-color: #111; color: #111; }

.composition-panel { padding: 14px; border-radius: 13px; background: #f8fafc; border: 1px solid var(--line); display: grid; gap: 12px; }
.comp-prices { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.p-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.vp-chip { padding: 2px 7px; border-radius: 6px; background: #fff; border: 1px solid #cbd5e1; font-size: 12px; font-weight: 700; }
.vp-chip.med { background: #dcfce7; border-color: #22c55e; color: #15803d; font-weight: 900; }
.log-tbl { width: 100%; border-collapse: collapse; font-size: 12px; background: #fff; border-radius: 8px; overflow: hidden; }
.log-tbl th, .log-tbl td { padding: 7px 10px; border-bottom: 1px solid #e2e8f0; text-align: left; }
.log-tbl th { background: #f1f5f9; color: #475569; font-weight: 800; }

.dom-iframe-wrap { border-radius: 16px; overflow: hidden; border: 2px solid #e2e8f0; background: #f5f6f9; }
.gf-iframe { width: 100%; height: 760px; border: 0; display: block; }

.grid-subfilter { display: flex; gap: 5px; flex-wrap: wrap; }
.grid-subfilter button { height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--soft); font-size: 11.5px; font-weight: 700; color: var(--ink); cursor: pointer; }
.grid-subfilter button.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }

.xianyu-cards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 13px; }
.xy-card { background: #fff; border-radius: 15px; border: 2px solid #86efac; overflow: hidden; display: flex; flex-direction: column; }
.xy-card.excluded { border-color: #cbd5e1; background: #f8fafc; }
.xyc-img { position: relative; aspect-ratio: 1 / 1; background: #e2e8f0; overflow: hidden; }
.xyc-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.xyc-seq { position: absolute; left: 8px; top: 8px; z-index: 3; background: rgba(15,23,42,.74); color: #fff; font-size: 11px; font-weight: 800; padding: 2px 7px; border-radius: 999px; }
.xyc-zoom-tip { position: absolute; right: 8px; bottom: 8px; z-index: 4; background: rgba(15,23,42,.75); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
.xyc-badge { position: absolute; right: 8px; top: 8px; z-index: 3; font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 999px; }
.xyc-badge.valid { background: #dcfce7; color: #15803d; }
.xyc-badge.restore { background: #dbeafe; color: #1d4ed8; }
.xyc-badge.rej { background: #fee2e2; color: #b91c1c; }
.xyc-mask { position: absolute; inset: 0; z-index: 2; background: repeating-linear-gradient(-45deg, rgba(15,23,42,.26), rgba(15,23,42,.26) 10px, rgba(220,38,38,.22) 10px, rgba(220,38,38,.22) 20px); backdrop-filter: grayscale(.5); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; pointer-events: none; }
.mask-stamp { background: rgba(220,38,38,.94); color: #fff; font-weight: 900; font-size: 13px; padding: 3px 11px; border-radius: 7px; border: 1.5px solid #fff; }
.mask-sub { background: rgba(15,23,42,.82); color: #fde68a; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; }
.xyc-body { padding: 10px 11px 11px; display: flex; flex-direction: column; gap: 5px; flex: 1; }
.xyc-title { margin: 0; font-size: 12.5px; line-height: 1.38; font-weight: 700; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 34px; }
.xyc-price-row { display: flex; align-items: baseline; gap: 6px; }
.xyc-price { color: #ff3b30; font-weight: 900; }
.xyc-price b { font-size: 19px; }
.xy-card.excluded .xyc-price { color: #94a3b8; text-decoration: line-through; }
.xyc-wants { font-size: 11px; color: var(--mute); }
.xyc-cond { margin-left: auto; font-size: 11px; font-weight: 700; background: #f1f5f9; padding: 1px 6px; border-radius: 5px; }
.xyc-seller { font-size: 11.5px; color: var(--mute); }
.xyc-reason { font-size: 11px; font-weight: 700; padding: 4px 7px; border-radius: 7px; }
.xyc-reason.in { background: #f0fdf4; color: #166534; }
.xyc-reason.out { background: #fef2f2; color: #991c1c; }
.xyc-toggle-btn { margin-top: auto; height: 30px; border-radius: 8px; border: 1px solid transparent; font-size: 12px; font-weight: 800; cursor: pointer; }
.xyc-toggle-btn.to-drop { background: #f1f5f9; color: #475569; border-color: #cbd5e1; }
.xyc-toggle-btn.to-keep { background: #dbeafe; color: #1d4ed8; border-color: #93c5fd; }

.hist-fold { padding-top: 8px; border-top: 1px solid var(--line); font-size: 13px; }
.hist-rows { margin-top: 8px; display: grid; gap: 6px; }
.hrow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 6px 10px; border-radius: 9px; background: var(--soft); font-size: 12.5px; }

.sticky-foot { position: fixed; left: 240px; right: 0; bottom: 0; z-index: 40; background: rgba(255,255,255,.96); backdrop-filter: blur(10px); border-top: 1px solid var(--line); padding: 11px 28px; display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; box-shadow: 0 -6px 20px rgba(15,23,42,.06); }
.sf-metrics { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13.5px; }
.sep { color: #cbd5e1; }
.acc-txt { color: var(--acc); font-size: 16px; }
.grn-txt { color: #15803d; font-size: 17px; }
.sf-acts { display: flex; gap: 10px; align-items: center; }

/* 弹窗：高清预览 + 6大品类 + WMS回写 */
.pc-modal-mask { position: fixed; inset: 0; z-index: 95; background: rgba(10, 15, 28, .82); display: grid; place-items: center; padding: 20px; }
.pc-zoom-dialog { background: #fff; border-radius: 20px; padding: 20px; width: min(880px, 95vw); display: grid; grid-template-columns: 1.1fr 1fr; gap: 20px; align-items: center; }
.pzd-img { background: #f8fafc; border-radius: 14px; overflow: hidden; display: grid; place-items: center; }
.pzd-img img { width: 100%; max-height: 68vh; object-fit: contain; }
.pzd-info { display: grid; gap: 10px; }
.pzd-badges { display: flex; gap: 6px; flex-wrap: wrap; }
.pzd-info h3 { margin: 0; font-size: 18px; line-height: 1.4; }
.pzd-price { font-size: 26px; font-weight: 900; color: #ff3b30; }
.pzd-price small { font-size: 13px; color: var(--mute); font-weight: 600; margin-left: 8px; }
.pzd-reason { margin: 0; padding: 10px 12px; border-radius: 10px; background: #f8fafc; font-size: 13px; color: #334155; }
.pzd-acts { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; }

.pc-cat-dialog { background: #fff; border-radius: 20px; padding: 22px 24px; width: min(640px, 94vw); display: grid; gap: 12px; }
.pc-cat-dialog h3 { margin: 0; font-size: 18px; }
.cat-list { display: grid; gap: 10px; max-height: 55vh; overflow: auto; }
.cat-row { display: grid; grid-template-columns: 1fr 270px; gap: 12px; align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--soft); }
.cat-row div { display: grid; gap: 2px; }
.cat-row small { font-size: 11.5px; color: var(--mute); }
.pcd-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
.baseline-sanity-strip { padding: 7px 12px; border-radius: 10px; background: #f0fdf4; border: 1px solid #bbf7d0; display: grid; gap: 4px; margin-bottom: 2px; }
.baseline-sanity-strip.blocked { background: #fef2f2; border: 1.5px solid #ef4444; }
.baseline-sanity-strip.hi { background: #eff6ff; border: 1px solid #bfdbfe; }
.bss-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.bss-meta { color: #334155; }
.bss-fold { margin-left: auto; }
.bss-fold summary { cursor: pointer; font-size: 12px; font-weight: 800; color: var(--red-ink, #b91c1c); }
.bss-reason { margin: 6px 0 0; font-size: 12.5px; line-height: 1.5; font-weight: 600; color: #1e293b; }
.baseline-sanity-strip.blocked .bss-reason { color: #b91c1c; }
</style>
