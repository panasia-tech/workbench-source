<template>
  <div class="page vi-page">
    <!-- 单行紧凑顶栏：保证首屏两排 Gallery 卡片尽快露头 -->
    <header class="vi-head">
      <div class="vi-title-row">
        <h1>虚拟外部情报与盈利赛马中心<Q k="selvirt" /></h1>
        <span class="tag acc">闲鱼 {{ data.meta?.xianyuCount || 30 }} 券 · QQ {{ data.meta?.qqTotalMessages || 1513 }} 消息</span>
        <span v-if="offlineFallback" class="tag amb">离线持久化模式</span>
      </div>
      <div class="vi-actions">
        <button class="btn sm" @click="showFlywheel = !showFlywheel">盈利 6 步飞轮 {{ showFlywheel ? '▴' : '▾' }}</button>
        <button class="btn pri sm" @click="openNewClue">＋ 录入线索</button>
        <button class="btn sm" @click="thresholdModal = true">⚙ 门禁（毛利≥{{ thresholds.minMarginPct }}% · 退款≥{{ thresholds.haltRefundPct }}%停售）</button>
        <button class="btn sm" @click="goHash('#/tutorials?scope=sales')">📚 教程台账</button>
        <button class="btn sm" @click="resetDemo" title="恢复初始真实样本库">↻ 重置</button>
      </div>
    </header>

    <div v-if="showFlywheel" class="flywheel-bar" aria-label="盈利六步飞轮">
      <button v-for="st in FLYWHEEL" :key="st.id" class="fw-pill" :class="{ on: activeTab === st.tab }" @click="setTab(st.tab)">
        <b>{{ st.step }}</b><span>{{ st.label }}</span>
      </button>
    </div>

    <!-- 双入口切换 + 四联视图导航 -->
    <div class="vi-toolbar">
      <div class="entry-switch">
        <button :class="{ on: entryMode === 'business' }" @click="setEntryMode('business')">按业务分类看</button>
        <button :class="{ on: entryMode === 'source' }" @click="setEntryMode('source')">按来源 / 平台看</button>
      </div>
      <div class="view-tabs" role="tablist">
        <button v-for="t in TABS" :key="t.k" class="vt" :class="{ on: activeTab === t.k }" @click="setTab(t.k)">
          <span>{{ t.label }}</span>
          <em>{{ t.count }}</em>
        </button>
      </div>
      <label class="vi-search">
        <Icon name="search" />
        <input v-model="kw" placeholder="搜索标题、卖家、DWG、群号或工作流…" />
      </label>
    </div>

    <!-- 主工作区：左分类树 + 右四联画布 -->
    <div class="vi-body">
      <aside class="vi-sidebar card">
        <template v-if="entryMode === 'business'">
          <div class="sb-sec">
            <p class="sb-cap">业务分类树（点击按节点联动四视图）</p>
            <button class="tree-node root" :class="{ on: selectedNode === 'all' }" @click="pickNode('all')">
              <span>全部虚拟方向</span><em>{{ data.listings.length }}</em>
            </button>
            <div v-for="grp in treeGroups" :key="grp.id" class="tree-grp">
              <button class="tree-node grp-hd" :class="{ on: selectedNode === grp.id }" @click="pickNode(grp.id)">
                <span>{{ grp.label }}</span><em>{{ nodeTotalCount(grp.id) }}</em>
              </button>
              <button v-for="ch in grp.childrenNodes" :key="ch.id" class="tree-node child" :class="{ on: selectedNode === ch.id }" @click="pickNode(ch.id)">
                <span>{{ ch.label }}</span><em>{{ nodeTotalCount(ch.id) }}</em>
              </button>
            </div>
          </div>
          <div class="sb-note">
            <b>挂载口径</b>：综合群只留顶层记录，涉及 CAD / 风控的具体消息按精确 <code>messageRef</code> 挂入细分节点，避免杂音干扰选品。
          </div>
        </template>

        <template v-else>
          <div class="sb-sec">
            <p class="sb-cap">线索外部来源（X / QQ / 工作流）</p>
            <button class="tree-node root" :class="{ on: selectedSource === 'all' }" @click="pickSource('all', 'clue')">
              <span>全部线索来源</span><em>{{ data.clues.length }}</em>
            </button>
            <button v-for="s in data.sourceTree.cluePlatforms" :key="s.id" class="tree-node child" :class="{ on: selectedSource === 'clue:' + s.id }" @click="pickSource('clue:' + s.id, 'clues')">
              <span>{{ s.label }}</span><em>{{ clueCountByPlatform(s.id) }}</em>
            </button>
          </div>
          <div class="sb-sec">
            <p class="sb-cap">同行在售平台（跨平台可比核价）</p>
            <button v-for="p in data.sourceTree.listingPlatforms" :key="p.id" class="tree-node child" :class="{ on: selectedSource === 'plat:' + p.id }" @click="pickSource('plat:' + p.id, 'listings')">
              <span>{{ p.label }}</span><em>{{ listingCountByPlatform(p.id) }}</em>
            </button>
          </div>
        </template>
      </aside>

      <section class="vi-content">
        <!-- ================= 视图 1：线索 Gallery ================= -->
        <div v-if="activeTab === 'clues'" class="vi-pane">
          <div class="subbar">
            <div class="pills-row">
              <button v-for="f in CLUE_FILTERS" :key="f.k" class="fchip" :class="{ on: clueFilter === f.k }" @click="clueFilter = f.k">{{ f.t }}</button>
            </div>
            <span class="muted sm">点击卡片在右侧查看原链接 / QQ 群消息游标与关联群文件</span>
          </div>

          <div class="gallery-grid cols-3">
            <article v-for="c in filteredClues" :key="c.id" class="g-card" :class="{ sel: drawerClue?.id === c.id }" @click="openClueDrawer(c)">
              <div class="g-thumb">
                <img :src="c.image" :alt="c.title" />
                <span class="badge-tl">{{ c.platformLabel }}</span>
                <span class="badge-tr tag" :class="evidenceClass(c.evidenceLevel)">{{ c.evidenceLabel }}</span>
              </div>
              <div class="g-body">
                <h3>{{ c.title }}</h3>
                <p class="g-summary">{{ c.summary }}</p>
                <div class="g-meta">
                  <span>{{ c.author }}</span>
                  <span>{{ c.date }}</span>
                </div>
                <div class="g-foot">
                  <span class="tag">{{ nodeLabel(c.nodeId) }}</span>
                  <span class="tag" :class="c.nodeId === 'pending-triage' ? 'red' : 'grn'">{{ c.status }}</span>
                </div>
              </div>
            </article>
          </div>
          <div v-if="!filteredClues.length" class="empty-card card">当前筛选条件下暂无外部线索，可点击右上角「＋ 录入线索」补充或切回全部方向。</div>
        </div>

        <!-- ================= 视图 2：在售商品 Gallery ================= -->
        <div v-else-if="activeTab === 'listings'" class="vi-pane">
          <!-- 单行可比价格带 + 分组下拉：首屏直接露两排商品卡 -->
          <div class="comp-bar">
            <label class="comp-select">
              <span>可比商品组</span>
              <select v-model="selectedCompGroup">
                <option value="all">全部可比组 ({{ baseListingsForNode.length }})</option>
                <option v-for="cg in comparableGroups" :key="cg" :value="cg">
                  {{ cg }} ({{ baseListingsForNode.filter(x => x.comparableGroup === cg).length }})
                </option>
              </select>
            </label>
            <div class="comp-kpis">
              <span class="tag grn">中位价 <b>{{ comparableStats.median !== null ? '¥' + comparableStats.median : '引流价单列' }}</b></span>
              <span class="tag">{{ comparableStats.validCount }}件可比</span>
              <span class="tag amb">卖家主页 0/{{ data.meta?.sellerCount || 27 }}</span>
            </div>
            <label class="chk-inline">
              <input type="checkbox" v-model="showOffShelf" /> 含已下架留证
            </label>
          </div>

          <div class="gallery-grid cols-4">
            <article v-for="item in filteredListings" :key="item.id" class="g-card prod-card" :class="{ offshelf: item.status !== '在售', sel: drawerListing?.id === item.id }" @click="openListingDrawer(item)">
              <div class="g-thumb sq">
                <img :src="item.image" :alt="item.title" />
                <span class="badge-tl plat-badge">{{ item.platformLabel }}</span>
                <span class="badge-tr tag" :class="item.status === '在售' ? 'grn' : 'red'">{{ item.status }}</span>
                <span v-if="item.isHookPrice" class="badge-bl tag red">引流起价 · 不入均价</span>
              </div>
              <div class="g-body">
                <div class="price-row">
                  <strong class="p-num">{{ item.priceText }}</strong>
                  <span class="unit-pill">{{ item.pricingUnit }}</span>
                </div>
                <h3>{{ item.title }}</h3>
                <div class="g-meta">
                  <span>{{ item.sellerName }}</span>
                  <span>{{ item.comparableGroup }}</span>
                </div>
                <div class="g-foot">
                  <span class="tag">{{ item.trackType }}</span>
                  <span class="muted sm">{{ item.capturedAt.slice(0, 10) }}</span>
                </div>
              </div>
            </article>
          </div>
          <div v-if="!filteredListings.length" class="empty-card card">该业务节点下暂无匹配的可比在售商品，可切换到「全部虚拟方向」查看 30 件真闲鱼餐饮券与 CAD/AI 服务全集。</div>
        </div>

        <!-- ================= 视图 3：同行与渠道 ================= -->
        <div v-else-if="activeTab === 'channels'" class="vi-pane">
          <div class="sec-grid-2">
            <div class="card">
              <div class="card-h">
                <h3>同行主体聚合（跨平台 1:N 关联）</h3>
                <button class="btn sm" @click="goHash('#/crm')">打开群/渠道统筹 (CRM) →</button>
              </div>
              <div class="peer-list">
                <div v-for="p in data.peers" :key="p.id" class="peer-item">
                  <div class="pi-top">
                    <b>{{ p.name }}</b>
                    <span class="tag acc">{{ p.trustStatus }}</span>
                  </div>
                  <dl class="kv compact">
                    <dt>业务方向</dt><dd>{{ p.focusNodes.join(' · ') }}</dd>
                    <dt>X 线索</dt><dd>{{ p.xHandle }}</dd>
                    <dt>关联站/群</dt><dd>{{ [...p.websites, ...p.groups].join(' ； ') }}</dd>
                    <dt>关联店铺</dt><dd>{{ p.shops.slice(0, 4).join(' · ') }}</dd>
                  </dl>
                </div>
              </div>
              <details class="seller-fold">
                <summary>查看闲鱼票券 27 家卖家实体清单（详情 30/30 已核 · 主页待补抓 0/27）</summary>
                <table class="tbl compact-tbl">
                  <thead><tr><th>卖家名</th><th>关联在售数</th><th>样例商品</th><th>主页抓取进度</th></tr></thead>
                  <tbody>
                    <tr v-for="s in data.sellers" :key="s.sellerId">
                      <td><b>{{ s.sellerName }}</b></td>
                      <td>{{ s.listedCount }} 件</td>
                      <td class="muted">{{ s.sampleTitles[0] }}</td>
                      <td><span class="tag amb">{{ s.homeCollectionStatus }}</span></td>
                    </tr>
                  </tbody>
                </table>
              </details>
            </div>

            <div class="card">
              <div class="card-h">
                <h3>授权 QQ / 企微每小时增量游标看板</h3>
                <span class="tag grn">断线必显缺口 · 不伪造零新增</span>
              </div>
              <div class="ch-list">
                <div v-for="ch in data.channels" :key="ch.id" class="ch-item">
                  <div class="ch-top">
                    <div>
                      <b>{{ ch.name }}</b>
                      <p class="muted sm">{{ ch.stableId }} · {{ ch.mountLevel }}</p>
                    </div>
                    <span class="tag" :class="ch.cursorColor">{{ ch.cursorState }}</span>
                  </div>
                  <dl class="kv compact">
                    <dt>执行设备</dt><dd>{{ ch.runnerDevice }}（{{ ch.scheduleFreq }}）</dd>
                    <dt>历史/本轮</dt><dd>累计 <b>{{ ch.totalMessages }}</b> 条 · 本轮新增 <b>+{{ ch.lastAdded }}</b> 条 · 群文件 <b>{{ ch.fileCount }}</b> 份</dd>
                    <dt>游标截止</dt><dd><code>{{ ch.lastCutoff }}</code></dd>
                    <dt>备注状态</dt><dd>{{ ch.backfillNote }}</dd>
                  </dl>
                  <div class="ch-acts">
                    <button class="btn sm pri" @click="runBackfill(ch, 'tick')">从游标增量补拉 (+6条)</button>
                    <button class="btn sm bad" @click="runBackfill(ch, 'simulate_gap')">模拟断线标记缺口</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ================= 视图 4：同题赛马与盈利建卡 ================= -->
        <div v-else class="vi-pane">
          <div class="subbar">
            <div class="pills-row">
              <button class="fchip" :class="{ on: raceSubTab === 'workflow' }" @click="raceSubTab = 'workflow'">工作流同题赛马 &amp; 双轨建卡 ({{ filteredRaces.length }})</button>
              <button class="fchip" :class="{ on: raceSubTab === 'direction' }" @click="raceSubTab = 'direction'">主管·产品方向赛马（盈利 ROI 与 ≥8% 停售熔断）</button>
            </div>
            <button class="btn sm" @click="goHash('#/virt-new')">前往独立三步建卡页 (#/virt-new) →</button>
          </div>

          <template v-if="raceSubTab === 'workflow'">
            <div class="race-picker">
              <button v-for="r in filteredRaces" :key="r.id" class="rp-btn" :class="{ on: currentRace?.id === r.id }" @click="pickRace(r)">
                <span class="tag" :class="r.trackType === '跟卖型' ? 'grn' : 'amb'">{{ r.trackType }}</span>
                <b>{{ r.title }}</b>
              </button>
            </div>

            <div v-if="currentRace" class="race-stage">
              <div class="race-brief card">
                <div class="rb-row">
                  <span class="tag acc">统一测试输入</span>
                  <b>{{ currentRace.inputSample }}</b>
                </div>
                <div class="rb-meta">
                  <span>市场基准：<b>{{ currentRace.comparableRef }}</b></span>
                  <span>实验结论：<b>{{ currentRace.testStatus }}</b></span>
                  <span>备用方案：{{ currentRace.backupPlan }}</span>
                </div>
              </div>

              <div class="cand-grid">
                <article v-for="cand in currentRace.candidates" :key="cand.id" class="cand-card card" :class="{ winner: cand.winner }">
                  <div class="cand-hd">
                    <span class="tag" :class="cand.winner ? 'grn' : 'red'">{{ cand.winner ? '胜出方案' : '对比淘汰' }}</span>
                    <span class="muted sm">{{ cand.tool }}</span>
                  </div>
                  <h3>{{ cand.name }}</h3>
                  <dl class="kv compact">
                    <dt>单单耗时</dt><dd><b>{{ cand.durationMin }} 分钟</b>（人工折算 ¥{{ cand.laborCost }}）</dd>
                    <dt>API/直接费</dt><dd><b>¥{{ cand.apiCost }}</b></dd>
                    <dt>成品质量</dt><dd>{{ cand.qualityScore }}</dd>
                    <dt>预计返工</dt><dd>{{ cand.reworkRate }}</dd>
                    <dt>结论评估</dt><dd><b>{{ cand.verdict }}</b></dd>
                    <dt>停手边界</dt><dd>{{ cand.boundary }}</dd>
                  </dl>
                  <button class="btn sm" :class="{ pri: cand.winner }" @click="loadCandToCalc(cand)">代入右侧盈利算账器 →</button>
                </article>
              </div>

              <!-- 双轨制盈利算账与建卡器 -->
              <div class="calc-grid">
                <div class="card calc-box">
                  <h3>双轨制盈利算账与产品卡门禁 <small>{{ form.trackType === '跟卖型' ? '跟卖通道：核完 1–4 步即准首单实测' : '路测通道：须小额实测 + 第二人独立复现' }}</small></h3>
                  <div class="form-grid">
                    <label class="fg-wide">我方产品卡名称<input v-model="form.title" /></label>
                    <label>赛道模式
                      <select v-model="form.trackType">
                        <option value="跟卖型">跟卖型（4步绿色通道 · 首单即实测）</option>
                        <option value="路测型">路测型（自研新品 · 强制双人复现）</option>
                      </select>
                    </label>
                    <label>拟定售价 (¥)<input v-model.number="form.price" type="number" step="0.5" /></label>
                    <label>进价 / API 成本 (¥)<input v-model.number="form.directCost" type="number" step="0.1" /></label>
                    <label>平台费率 (%)<input v-model.number="form.feePct" type="number" step="0.5" /></label>
                    <label>人工复核/交付工时 (分钟)<input v-model.number="form.durationMin" type="number" step="1" /></label>
                    <label>关联 Codex Skill<input v-model="form.skillName" /></label>
                  </div>
                  <div v-if="form.trackType === '路测型'" class="repro-gate">
                    <label class="chk-inline">
                      <input type="checkbox" v-model="form.reproConfirmed" />
                      已完成小额实测并由第二位同事按工作台文档独立复现通过（缺此项将硬拦截上架）
                    </label>
                  </div>
                  <div class="calc-result" :class="calcVerdict.cls">
                    <div>
                      <span>单笔预估净毛利</span>
                      <strong>¥{{ liveEcon.netProfit }}</strong>
                    </div>
                    <div>
                      <span>净毛利率</span>
                      <strong>{{ liveEcon.marginPct }}%</strong>
                    </div>
                    <div>
                      <span>销售剩余工时时薪 ROI</span>
                      <strong>¥{{ liveEcon.roiPerHour }}/h</strong>
                    </div>
                    <div class="verdict-pill">{{ calcVerdict.text }}</div>
                  </div>
                  <div class="calc-acts">
                    <button class="btn pri" @click="promoteToProductCard">按门禁校验并生成我方产品卡</button>
                  </div>
                </div>

                <div class="card my-cards-box">
                  <h3>我方已立项虚拟产品卡（{{ data.productCards.length }}）</h3>
                  <div class="my-card-list">
                    <div v-for="pc in data.productCards" :key="pc.cardId" class="mc-item">
                      <div class="mc-top">
                        <b>{{ pc.title }}</b>
                        <span class="tag" :class="pc.status.includes('熔断') ? 'red' : pc.status.includes('预警') ? 'amb' : 'grn'">{{ pc.status }}</span>
                      </div>
                      <p class="muted sm">售价 ¥{{ pc.price }} · 直接成本 ¥{{ pc.directCost }} · 净毛利 <b>{{ pc.marginPct }}%</b> (¥{{ pc.netProfit }}) · 退款率 {{ pc.refundRatePct }}%</p>
                      <p class="muted sm">Skill：<code>{{ pc.skillName }}</code> · 停手线：{{ pc.stopBoundary }}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="card">
              <div class="card-h">
                <h3>主管视角｜产品方向赛马（按周期投入工时与净毛利 ROI 优胜劣汰）</h3>
                <span class="muted sm">当前规则：毛利 &lt; {{ thresholds.minMarginPct }}% 预警 · 退款 ≥ {{ thresholds.warnRefundPct }}% 预警 · 退款 ≥ {{ thresholds.haltRefundPct }}% 自动熔断停售</span>
              </div>
              <table class="tbl dir-tbl">
                <thead>
                  <tr>
                    <th class="col-dir">虚拟产品方向</th>
                    <th>赛道</th>
                    <th>询/成</th>
                    <th>均价</th>
                    <th>净毛利</th>
                    <th>时薪 ROI</th>
                    <th>毛利率</th>
                    <th>退款</th>
                    <th>当前策略</th>
                    <th>回传测试</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="d in data.directionRaces" :key="d.directionId">
                    <td class="col-dir">
                      <b>{{ d.name }}</b>
                      <p class="muted sm">{{ d.note }}</p>
                    </td>
                    <td><span class="tag">{{ d.trackType }}</span></td>
                    <td class="nowrap">{{ d.inquiries }}/<b>{{ d.paidOrders }}</b></td>
                    <td class="nowrap">¥{{ d.avgPrice }}</td>
                    <td class="nowrap"><b>¥{{ d.netProfit }}</b></td>
                    <td class="nowrap">{{ d.laborHours }}h · <b>¥{{ d.roiPerHour }}/h</b></td>
                    <td class="nowrap"><span class="tag" :class="d.marginPct < thresholds.minMarginPct ? 'red' : 'grn'">{{ d.marginPct }}%</span></td>
                    <td class="nowrap"><b>{{ d.refundRatePct }}%</b></td>
                    <td><span class="tag" :class="d.strategyTone">{{ d.strategy }}</span></td>
                    <td>
                      <div class="row-acts">
                        <button class="btn sm" @click="simulateFeedback(d, d.refundRatePct + 2.5)">+2.5%</button>
                        <button class="btn sm" @click="simulateFeedback(d, 2.8)">复常</button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </div>
      </section>

      <!-- 右侧渐进披露详情抽屉（点击线索或商品卡弹出） -->
      <aside v-if="drawerClue || drawerListing" class="vi-drawer card">
        <div class="dr-head">
          <b>{{ drawerClue ? '外部线索详情与证据' : '在售商品详情与观察历史' }}</b>
          <button class="btn sm" @click="closeDrawer">关闭</button>
        </div>

        <template v-if="drawerClue">
          <img class="dr-img" :src="drawerClue.image" :alt="drawerClue.title" />
          <h3>{{ drawerClue.title }}</h3>
          <p class="muted sm">{{ drawerClue.author }} · {{ drawerClue.date }} · <span class="tag" :class="evidenceClass(drawerClue.evidenceLevel)">{{ drawerClue.evidenceLabel }}</span></p>
          <dl class="kv compact">
            <dt>归属节点</dt><dd>{{ nodeLabel(drawerClue.nodeId) }}</dd>
            <dt>原始定位</dt><dd><code>{{ drawerClue.messageRef }}</code></dd>
            <dt>可复用做法</dt><dd>{{ drawerClue.reusableMethod }}</dd>
            <dt>待核缺口</dt><dd>{{ drawerClue.openQuestions }}</dd>
            <dt v-if="drawerClue.attachedFiles?.length">关联群文件</dt>
            <dd v-if="drawerClue.attachedFiles?.length">{{ drawerClue.attachedFiles.join('、') }}</dd>
          </dl>
          <div class="dr-acts">
            <a v-if="drawerClue.sourceUrl && drawerClue.sourceUrl.startsWith('http')" :href="drawerClue.sourceUrl" target="_blank" rel="noopener" class="btn sm">打开原链接 ↗</a>
            <button class="btn sm pri" @click="jumpRaceByNode(drawerClue.nodeId)">进入该节点同题赛马 →</button>
          </div>
        </template>

        <template v-else-if="drawerListing">
          <img class="dr-img sq" :src="drawerListing.image" :alt="drawerListing.title" />
          <h3>{{ drawerListing.title }}</h3>
          <div class="dr-price-bar">
            <strong>{{ drawerListing.priceText }}</strong>
            <span class="tag">{{ drawerListing.pricingUnit }}</span>
            <span class="tag" :class="drawerListing.status === '在售' ? 'grn' : 'red'">{{ drawerListing.status }}</span>
          </div>
          <dl class="kv compact">
            <dt>卖家实体</dt><dd>{{ drawerListing.sellerName }}（{{ drawerListing.platformLabel }}）</dd>
            <dt>可比分组</dt><dd>{{ drawerListing.comparableGroup }}</dd>
            <dt>交付范围</dt><dd>{{ drawerListing.deliveryScope }}</dd>
            <dt>详情摘要</dt><dd>{{ drawerListing.description }}</dd>
          </dl>
          <div class="dr-obs">
            <h4>商品观察与历史价格状态</h4>
            <div v-for="(ob, idx) in drawerListing.observations" :key="idx" class="ob-row">
              <b>{{ ob.price }}</b> · <span>{{ ob.status }}</span>
              <p class="muted sm">{{ ob.time }} · {{ ob.source }}</p>
            </div>
          </div>
          <div class="dr-acts col">
            <button class="btn pri sm" @click="applyListingToCalc(drawerListing)">按跟卖通道代入盈利算账建卡 →</button>
            <div class="dr-row-2">
              <button class="btn sm" @click="toggleListingStatus(drawerListing)">
                {{ drawerListing.status === '在售' ? '模拟下架（保留历史证据）' : '恢复为在售状态' }}
              </button>
              <a v-if="drawerListing.itemUrl" :href="drawerListing.itemUrl" target="_blank" rel="noopener" class="btn sm">原商品页 ↗</a>
            </div>
          </div>
        </template>
      </aside>
    </div>

    <!-- 弹窗：录入新线索 -->
    <div v-if="clueModal" class="vi-modal-bg" @click.self="clueModal = false">
      <div class="vi-modal card">
        <div class="dr-head"><h3>登记外部情报线索</h3><button class="btn sm" @click="clueModal = false">取消</button></div>
        <div class="form-grid">
          <label class="fg-wide">线索标题 *<input v-model="newClue.title" placeholder="例如：某 X 博主分享 PDF 转 DWG 工作流" /></label>
          <label>来源平台
            <select v-model="newClue.platform">
              <option value="X">X (Twitter)</option>
              <option value="QQ">QQ 授权群</option>
              <option value="WeCom">企微试点群</option>
              <option value="Workflow">公开工作流 (n8n/Comfy)</option>
              <option value="Web">独立站 / 小红书</option>
            </select>
          </label>
          <label>归属业务节点
            <select v-model="newClue.nodeId">
              <option value="cad-trace">CAD 描图</option>
              <option value="ecom-photo">AI 商品图制作</option>
              <option value="dining-double">连锁餐饮套餐券</option>
              <option value="delta-force">三角洲游戏排障</option>
              <option value="pending-triage">待归类新线索池</option>
            </select>
          </label>
          <label>证据可信度
            <select v-model="newClue.evidenceLevel">
              <option value="verified">已核实测 / 挂牌证据</option>
              <option value="group_log">群实测原始记录</option>
              <option value="self_claimed">博主自述（待补证核实）</option>
            </select>
          </label>
          <label>原链接 / 群消息定位 *<input v-model="newClue.sourceUrl" placeholder="https://... 或 messageRef" /></label>
          <label class="fg-wide">关键做法与待核点<textarea v-model="newClue.summary" rows="3" placeholder="简述客户输入、交付结果和成本证据"></textarea></label>
        </div>
        <div class="calc-acts">
          <button class="btn pri" @click="submitNewClue">保存并入库（关联业务节点）</button>
        </div>
      </div>
    </div>

    <!-- 弹窗：盈利门禁阈值配置（主管可调） -->
    <div v-if="thresholdModal" class="vi-modal-bg" @click.self="thresholdModal = false">
      <div class="vi-modal card">
        <div class="dr-head"><h3>主管可调｜双轨算账与自动熔断阈值</h3><button class="btn sm" @click="thresholdModal = false">关闭</button></div>
        <div class="form-grid">
          <label>预估净毛利率预警线 (%)<input v-model.number="thDraft.minMarginPct" type="number" /></label>
          <label>售后退款率预警线 (%)<input v-model.number="thDraft.warnRefundPct" type="number" /></label>
          <label>售后退款率自动熔断停售线 (%)<input v-model.number="thDraft.haltRefundPct" type="number" /></label>
          <label>剩余工时内部核算基准 (¥/小时)<input v-model.number="thDraft.hourlyLaborCost" type="number" /></label>
          <label class="fg-wide chk-inline"><input type="checkbox" v-model="thDraft.followTrackFastPass" /> 允许跟卖型走 4 步绿色通道（首单即实测）</label>
          <label class="fg-wide chk-inline"><input type="checkbox" v-model="thDraft.roadTestRequireDualRepro" /> 路测型强制要求「小额实测 + 第二人独立复现」才准上架</label>
        </div>
        <div class="calc-acts">
          <button class="btn pri" @click="saveThresholds">保存门禁配置并生效</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import Q from './Q.vue'
import Icon from './Icon.vue'
import { cloneSeed, computeEconomics } from './virtIntelData.js'
import { toast } from './ui.js'

const LS_KEY = 'panasia_virt_intel_offline_v1'
const data = reactive(cloneSeed())
const offlineFallback = ref(false)
const activeTab = ref('listings')
const raceSubTab = ref('workflow')
const entryMode = ref('business')
const selectedNode = ref('all')
const selectedSource = ref('all')
const kw = ref('')
const clueFilter = ref('all')
const selectedCompGroup = ref('all')
const showOffShelf = ref(true)
const drawerClue = ref(null)
const drawerListing = ref(null)
const clueModal = ref(false)
const thresholdModal = ref(false)
const showFlywheel = ref(false)

const FLYWHEEL = [
  { id: 1, step: '1', label: '外部情报', tab: 'clues' },
  { id: 2, step: '2', label: '可比核价', tab: 'listings' },
  { id: 3, step: '3', label: '同行与群增量', tab: 'channels' },
  { id: 4, step: '4', label: '同题赛马', tab: 'racing' },
  { id: 5, step: '5', label: '双轨盈利建卡', tab: 'racing' },
  { id: 6, step: '6', label: '方向 ROI 扩利', tab: 'racing' },
]

const CLUE_FILTERS = [
  { k: 'all', t: '全部证据' },
  { k: 'verified', t: '已核实测/挂牌' },
  { k: 'group_log', t: 'QQ群原始记录' },
  { k: 'self_claimed', t: '自述待补证' },
]

const newClue = reactive({ title: '', platform: 'X', nodeId: 'cad-trace', evidenceLevel: 'self_claimed', sourceUrl: '', summary: '' })
const currentRace = ref(null)
const form = reactive({
  title: 'CAD 标准平面图转 DWG（含尺寸复核）',
  trackType: '跟卖型',
  nodeId: 'cad-trace',
  raceId: 'RACE-CAD-CEILING',
  price: 68,
  directCost: 0.5,
  feePct: 1,
  durationMin: 6,
  skillName: 'cad-paper-to-dwg-check',
  reproConfirmed: true,
})
const thDraft = reactive({ ...data.thresholds })

const thresholds = computed(() => data.thresholds || {})

const NODE_NAME_MAP = computed(() => {
  const m = {}
  for (const n of data.businessTree || []) m[n.id] = n.label
  return m
})
function nodeLabel (nid) { return NODE_NAME_MAP.value[nid] || nid }

const treeGroups = computed(() => {
  const roots = (data.businessTree || []).filter(n => n.parent === 'root')
  return roots.map(r => ({
    ...r,
    childrenNodes: (data.businessTree || []).filter(c => c.parent === r.id),
  }))
})

function expandNodeIds (nid) {
  if (!nid || nid === 'all') return null
  const item = (data.businessTree || []).find(x => x.id === nid)
  if (item?.children?.length) return new Set([nid, ...item.children])
  return new Set([nid])
}

function nodeTotalCount (nid) {
  const set = expandNodeIds(nid)
  const l = data.listings.filter(x => set.has(x.nodeId)).length
  const c = data.clues.filter(x => set.has(x.nodeId)).length
  return l + c
}
function clueCountByPlatform (pid) { return data.clues.filter(c => c.platform === pid).length }
function listingCountByPlatform (pid) { return data.listings.filter(l => l.platform === pid).length }

const filteredClues = computed(() => {
  const w = kw.value.trim().toLowerCase()
  const nodeSet = entryMode.value === 'business' ? expandNodeIds(selectedNode.value) : null
  return data.clues.filter(c => {
    if (entryMode.value === 'business' && nodeSet && !nodeSet.has(c.nodeId)) return false
    if (entryMode.value === 'source' && selectedSource.value.startsWith('clue:')) {
      if (c.platform !== selectedSource.value.slice(5)) return false
    }
    if (clueFilter.value !== 'all' && c.evidenceLevel !== clueFilter.value) return false
    if (w && !`${c.title} ${c.summary} ${c.author} ${c.messageRef}`.toLowerCase().includes(w)) return false
    return true
  })
})

const baseListingsForNode = computed(() => {
  const w = kw.value.trim().toLowerCase()
  const nodeSet = entryMode.value === 'business' ? expandNodeIds(selectedNode.value) : null
  return data.listings.filter(item => {
    if (!showOffShelf.value && item.status !== '在售') return false
    if (entryMode.value === 'business' && nodeSet && !nodeSet.has(item.nodeId)) return false
    if (entryMode.value === 'source' && selectedSource.value.startsWith('plat:')) {
      if (item.platform !== selectedSource.value.slice(5)) return false
    }
    if (w && !`${item.title} ${item.sellerName} ${item.comparableGroup} ${item.itemId}`.toLowerCase().includes(w)) return false
    return true
  })
})

const comparableGroups = computed(() => [...new Set(baseListingsForNode.value.map(x => x.comparableGroup))])

const filteredListings = computed(() => {
  if (selectedCompGroup.value === 'all') return baseListingsForNode.value
  return baseListingsForNode.value.filter(x => x.comparableGroup === selectedCompGroup.value)
})

const comparableStats = computed(() => {
  const all = filteredListings.value
  const valid = all.filter(x => !x.isHookPrice && x.numericPrice > 0)
  const prices = valid.map(x => x.numericPrice).sort((a, b) => a - b)
  const hookExcluded = all.filter(x => x.isHookPrice).length
  if (!prices.length) {
    return { median: null, validCount: 0, hookExcluded, rangeLabel: hookExcluded ? '当前组为引流起价单，不参与均价计算' : '暂无有效价格' }
  }
  const mid = Math.floor(prices.length / 2)
  const median = prices.length % 2 ? prices[mid] : ((prices[mid - 1] + prices[mid]) / 2).toFixed(2)
  return {
    median,
    validCount: prices.length,
    hookExcluded,
    rangeLabel: `区间 ¥${prices[0]} – ¥${prices[prices.length - 1]}（同交付口径）`,
  }
})

const filteredChannels = computed(() => data.channels || [])
const filteredPeers = computed(() => data.peers || [])
const filteredRaces = computed(() => {
  if (entryMode.value !== 'business' || selectedNode.value === 'all') return data.races
  const set = expandNodeIds(selectedNode.value)
  const sub = data.races.filter(r => set.has(r.nodeId))
  return sub.length ? sub : data.races
})

const TABS = computed(() => [
  { k: 'clues', label: '线索 Gallery', count: filteredClues.value.length },
  { k: 'listings', label: '在售商品 Gallery', count: filteredListings.value.length },
  { k: 'channels', label: '同行与渠道', count: filteredChannels.value.length },
  { k: 'racing', label: '赛马与盈利建卡', count: filteredRaces.value.length },
])

const liveEcon = computed(() =>
  computeEconomics(form.price, form.directCost, (Number(form.feePct) || 0) / 100, (Number(form.durationMin) || 0) / 60, thresholds.value.hourlyLaborCost || 50)
)

const calcVerdict = computed(() => {
  const th = thresholds.value
  if (form.trackType === '路测型' && th.roadTestRequireDualRepro && !form.reproConfirmed) {
    return { cls: 'bad', text: '门禁拦截：路测型须先勾选「小额实测 + 第二人复现」' }
  }
  if (liveEcon.value.netProfit <= 0 || liveEcon.value.marginPct < (th.minMarginPct || 30)) {
    return { cls: 'amb', text: `黄灯预警：净毛利 ${liveEcon.value.marginPct}% 低于基准 ${th.minMarginPct || 30}%` }
  }
  return { cls: 'ok', text: `绿灯准入（${form.trackType} · 净毛利达标）` }
})

function evidenceClass (lvl) {
  if (lvl === 'verified') return 'grn'
  if (lvl === 'group_log') return 'acc'
  return 'amb'
}
function setTab (k) { activeTab.value = k }
function setEntryMode (m) {
  entryMode.value = m
  selectedCompGroup.value = 'all'
}
function pickNode (nid) {
  selectedNode.value = nid
  selectedCompGroup.value = 'all'
  if (nid === 'cad-trace' && activeTab.value === 'listings') {
    // Keep current tab user chose, ensure race syncs
  }
  if (!filteredRaces.value.some(r => r.id === currentRace.value?.id)) {
    currentRace.value = filteredRaces.value[0] || null
  }
}
function pickSource (srcKey, targetTab) {
  selectedSource.value = srcKey
  selectedCompGroup.value = 'all'
  if (targetTab === 'clues' || targetTab === 'listings') activeTab.value = targetTab
}
function openClueDrawer (c) { drawerListing.value = null; drawerClue.value = c }
function openListingDrawer (l) { drawerClue.value = null; drawerListing.value = l }
function closeDrawer () { drawerClue.value = null; drawerListing.value = null }
function goHash (h) { location.hash = h }

function pickRace (r) {
  currentRace.value = r
  const w = r.candidates?.find(c => c.winner) || r.candidates?.[0]
  if (w) loadCandToCalc(w, r)
}
function loadCandToCalc (cand, raceObj = currentRace.value) {
  const r = raceObj || currentRace.value
  form.title = r ? `${r.title.split('｜')[0]}·标准交付卡` : form.title
  form.nodeId = r?.nodeId || 'cad-trace'
  form.raceId = r?.id || ''
  form.trackType = r?.trackType || '跟卖型'
  form.price = r?.referencePrice || 68
  form.directCost = cand.apiCost || 0
  form.durationMin = cand.durationMin || 10
  form.skillName = cand.tool || 'verified-workflow-skill'
  form.reproConfirmed = form.trackType === '跟卖型'
}
function jumpRaceByNode (nid) {
  selectedNode.value = nid || 'all'
  activeTab.value = 'racing'
  raceSubTab.value = 'workflow'
  closeDrawer()
  const match = data.races.find(r => r.nodeId === nid) || data.races[0]
  if (match) pickRace(match)
}
function applyListingToCalc (item) {
  form.title = `${item.title.slice(0, 26)}（我方对标卡）`
  form.nodeId = item.nodeId || 'dining-double'
  form.trackType = item.trackType || '跟卖型'
  form.price = item.numericPrice || 39
  form.directCost = item.estCost || 0
  form.feePct = Math.round((item.estFeeRate || 0.01) * 100)
  form.durationMin = Math.max(1, Math.round((item.estHours || 0.05) * 60))
  form.reproConfirmed = form.trackType === '跟卖型'
  activeTab.value = 'racing'
  raceSubTab.value = 'workflow'
  closeDrawer()
  toast('已按同行可比价带入盈利算账器')
}

function saveOfflineCache () {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)) } catch { /* ignore */ }
}

async function apiCall (url, body = null) {
  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const js = await res.json()
    return { ok: res.ok, status: res.status, data: js }
  } catch {
    return null
  }
}

async function loadBootstrap () {
  const res = await apiCall('/api/virt-intel/bootstrap')
  if (res?.ok && res.data?.ok) {
    Object.assign(data, res.data)
    Object.assign(thDraft, res.data.thresholds || {})
    offlineFallback.value = false
  } else {
    offlineFallback.value = true
    try {
      const cached = localStorage.getItem(LS_KEY)
      if (cached) Object.assign(data, JSON.parse(cached))
    } catch { /* ignore */ }
  }
  if (!currentRace.value && data.races?.length) pickRace(data.races[0])
}

async function submitNewClue () {
  if (!newClue.title.trim() || !newClue.sourceUrl.trim()) {
    toast('请填写线索标题及原链接/消息定位')
    return
  }
  const res = await apiCall('/api/virt-intel/clue', newClue)
  if (res?.ok && res.data?.clues) {
    data.clues = res.data.clues
  } else {
    const id = 'CLUE-OFF-' + Date.now()
    data.clues.unshift({
      id,
      nodeId: newClue.nodeId,
      platform: newClue.platform,
      platformLabel: newClue.platform,
      title: newClue.title,
      author: '当前坐席演示',
      date: new Date().toISOString().slice(0, 16).replace('T', ' '),
      evidenceLevel: newClue.evidenceLevel,
      evidenceLabel: newClue.evidenceLevel === 'verified' ? '已核实测/挂牌' : '博主自述·待核',
      status: '待核实进入',
      messageRef: newClue.sourceUrl,
      sourceUrl: newClue.sourceUrl,
      image: 'virt-intel-thumbs/cad-ceiling-pdf.png',
      summary: newClue.summary || newClue.title,
      reusableMethod: '待运营核对输入与可比定价。',
      openQuestions: '待入同题赛马对比。',
      attachedFiles: [],
      linkedListingIds: [],
    })
    saveOfflineCache()
  }
  clueModal.value = false
  newClue.title = ''
  newClue.sourceUrl = ''
  newClue.summary = ''
  activeTab.value = 'clues'
  toast('线索已登记并挂入对应业务节点')
}

async function toggleListingStatus (item) {
  const nextStatus = item.status === '在售' ? '已下架' : '在售'
  const res = await apiCall('/api/virt-intel/listing/status', { id: item.id, status: nextStatus })
  if (res?.ok && res.data?.listings) {
    data.listings = res.data.listings
    drawerListing.value = data.listings.find(x => x.id === item.id) || null
  } else {
    item.status = nextStatus
    item.observations = [{ time: new Date().toISOString().slice(0, 19).replace('T', ' '), price: item.priceText, status: `${nextStatus}（保留历史快照）`, source: '离线状态切换' }, ...(item.observations || [])]
    saveOfflineCache()
  }
  toast(`已切换状态为「${nextStatus}」，历史观察证据保留`)
}

async function runBackfill (ch, mode) {
  const res = await apiCall('/api/virt-intel/channel/backfill', { id: ch.id, mode })
  if (res?.ok && res.data?.channels) {
    data.channels = res.data.channels
  } else {
    if (mode === 'simulate_gap') {
      ch.cursorState = '断线待补拉（缺口已标记，未漏报成零新增）'
      ch.cursorColor = 'red'
    } else {
      ch.totalMessages += 6
      ch.lastAdded += 6
      ch.cursorState = '正常增量（游标补拉完成 +6 条）'
      ch.cursorColor = 'grn'
    }
    saveOfflineCache()
  }
  toast(mode === 'simulate_gap' ? '已标记采集断线缺口' : '已从上次游标完成断点补拉')
}

async function promoteToProductCard () {
  const payload = {
    title: form.title,
    trackType: form.trackType,
    nodeId: form.nodeId,
    raceId: form.raceId,
    price: form.price,
    directCost: form.directCost,
    platformFeeRate: (Number(form.feePct) || 0) / 100,
    laborHours: (Number(form.durationMin) || 0) / 60,
    skillName: form.skillName,
    reproConfirmed: form.reproConfirmed,
  }
  const res = await apiCall('/api/virt-intel/race/select-winner', payload)
  if (res && !res.ok) {
    toast(res.data?.error || '门禁校验未通过')
    return
  }
  if (res?.ok && res.data?.productCards) {
    data.productCards = res.data.productCards
    toast(res.data.lowMarginWarning ? '已建卡（注意：净毛利低于预警线，标为黄灯预警）' : '双轨门禁通过，已生成正式虚拟产品卡！')
    return
  }
  if (form.trackType === '路测型' && thresholds.value.roadTestRequireDualRepro && !form.reproConfirmed) {
    toast('双轨门禁拦截：路测型自研品必须勾选小额实测+第二人复现！')
    return
  }
  const low = liveEcon.value.marginPct < (thresholds.value.minMarginPct || 30)
  data.productCards.unshift({
    cardId: 'VP-OFF-' + Date.now(),
    nodeId: form.nodeId,
    title: form.title,
    trackType: form.trackType,
    price: form.price,
    directCost: form.directCost,
    marginPct: liveEcon.value.marginPct,
    netProfit: liveEcon.value.netProfit,
    refundRatePct: 0,
    status: low ? '黄灯预警（毛利未达 30% 基准）' : '已上架盈利中',
    skillName: form.skillName,
    stopBoundary: '超出 Skill 范围或缺失材料立即触发人工兜底',
  })
  saveOfflineCache()
  toast(low ? '已建卡（黄灯毛利预警）' : '已生成正式虚拟产品卡')
}

async function simulateFeedback (d, nextRefund) {
  const res = await apiCall('/api/virt-intel/feedback', { directionId: d.directionId, refundRatePct: nextRefund })
  if (res?.ok && res.data?.directionRaces) {
    data.directionRaces = res.data.directionRaces
    if (res.data.productCards) data.productCards = res.data.productCards
  } else {
    d.refundRatePct = Number(nextRefund.toFixed(1))
    const halt = thresholds.value.haltRefundPct || 8
    const warn = thresholds.value.warnRefundPct || 5
    d.strategyTone = d.refundRatePct >= halt ? 'red' : d.refundRatePct >= warn ? 'amb' : 'grn'
    d.strategy = d.refundRatePct >= halt ? `已熔断停售（退款 ${d.refundRatePct}% ≥ ${halt}%）` : d.refundRatePct >= warn ? `黄灯预警（退款 ${d.refundRatePct}%）` : '主力扩量'
    saveOfflineCache()
  }
  toast(`方向《${d.name.slice(0, 12)}》售后回传已更新：退款率 ${Number(nextRefund).toFixed(1)}%`)
}

async function saveThresholds () {
  const res = await apiCall('/api/virt-intel/thresholds', thDraft)
  if (res?.ok && res.data?.thresholds) {
    data.thresholds = res.data.thresholds
  } else {
    data.thresholds = { ...thDraft }
    saveOfflineCache()
  }
  thresholdModal.value = false
  toast('盈利门禁与熔断阈值已保存')
}

async function resetDemo () {
  localStorage.removeItem(LS_KEY)
  const res = await apiCall('/api/virt-intel/reset', {})
  if (res?.ok && res.data?.listings) {
    Object.assign(data, res.data)
  } else {
    Object.assign(data, cloneSeed())
  }
  closeDrawer()
  toast('已重置为初始真实样本库')
}

function openNewClue () { clueModal.value = true }

function syncQueryFromHash () {
  if (!location.hash.startsWith('#/virt-intel')) return
  const qs = new URLSearchParams(location.hash.split('?')[1] || '')
  if (qs.get('tab') && ['clues', 'listings', 'channels', 'racing'].includes(qs.get('tab'))) {
    activeTab.value = qs.get('tab')
  }
  if (qs.get('node')) pickNode(qs.get('node'))
}

onMounted(async () => {
  await loadBootstrap()
  syncQueryFromHash()
  window.addEventListener('hashchange', syncQueryFromHash)
})

onUnmounted(() => {
  window.removeEventListener('hashchange', syncQueryFromHash)
})
</script>

<style scoped>
.vi-page { padding: 12px 24px 48px; max-width: 1580px; }
.vi-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.vi-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; min-width: 0; }
.vi-title-row h1 { font-size: 22px; font-weight: 800; letter-spacing: -.02em; white-space: nowrap; }
.flywheel-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
.fw-pill { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 999px; background: var(--soft); border: 1px solid var(--line); font-size: 12px; color: var(--ink2); }
.fw-pill b { width: 16px; height: 16px; border-radius: 50%; background: var(--acc-soft); color: var(--acc); font-size: 11px; display: inline-grid; place-items: center; }
.fw-pill.on { border-color: var(--acc); color: var(--acc); font-weight: 600; }
.vi-actions { display: flex; gap: 6px; align-items: center; flex-wrap: nowrap; flex: none; }

.vi-toolbar { display: flex; align-items: center; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 6px 10px; margin-bottom: 10px; }
.comp-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 6px 12px; margin-bottom: 10px; }
.comp-select { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 700; color: var(--ink2); }
.comp-select select { height: 28px; padding: 0 8px; border-radius: 7px; border: 1px solid var(--line); background: var(--soft); color: var(--ink); font-size: 12.5px; font-weight: 600; }
.comp-kpis { display: flex; gap: 6px; align-items: center; flex: 1; min-width: 0; overflow: hidden; }
.entry-switch { display: inline-flex; background: var(--soft); padding: 3px; border-radius: 9px; gap: 3px; flex: none; }
.entry-switch button { height: 30px; padding: 0 12px; border-radius: 7px; font-size: 13px; font-weight: 600; color: var(--mute); }
.entry-switch button.on { background: var(--panel); color: var(--ink); box-shadow: 0 1px 3px rgba(0, 0, 0, .08); }
.view-tabs { display: flex; gap: 6px; flex: 1; }
.vt { height: 32px; padding: 0 13px; border-radius: 8px; font-size: 13.5px; font-weight: 600; color: var(--ink2); display: inline-flex; align-items: center; gap: 6px; background: var(--soft); }
.vt em { font-style: normal; font-size: 11.5px; background: var(--panel); border: 1px solid var(--line); padding: 0 6px; border-radius: 999px; color: var(--mute); }
.vt.on { background: var(--acc); color: #fff; }
.vt.on em { background: rgba(255, 255, 255, .2); color: #fff; border-color: transparent; }
.vi-search { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--soft); width: 195px; flex: none; }
.vi-search svg { width: 15px; height: 15px; color: var(--mute); flex: none; }
.vi-search input { border: 0; background: none; outline: none; width: 100%; font-size: 13px; }

.vi-body { display: grid; grid-template-columns: 214px minmax(0, 1fr) auto; gap: 14px; align-items: start; }
.vi-sidebar { padding: 14px; position: sticky; top: 10px; }
.sb-sec + .sb-sec { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
.sb-cap { font-size: 11.5px; font-weight: 700; color: var(--mute); margin-bottom: 8px; padding: 0 6px; }
.tree-grp { margin-top: 4px; }
.tree-node { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 6px 8px; border-radius: 8px; font-size: 13px; color: var(--ink2); text-align: left; }
.tree-node:hover { background: var(--soft); }
.tree-node.grp-hd { font-weight: 700; color: var(--ink); }
.tree-node.child { padding-left: 18px; font-size: 12.5px; }
.tree-node em { font-style: normal; font-size: 11px; color: var(--mute); }
.tree-node.on { background: var(--acc-soft); color: var(--acc); font-weight: 700; }
.sb-note { margin-top: 14px; padding: 10px; border-radius: 9px; background: var(--soft); border: 1px solid var(--line); font-size: 11.5px; color: var(--mute); line-height: 1.5; }

.vi-content { min-width: 0; }
.subbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.pills-row { display: flex; gap: 6px; flex-wrap: wrap; }
.fchip { height: 28px; padding: 0 11px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); font-size: 12.5px; font-weight: 600; color: var(--ink2); }
.fchip.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.chk-inline { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ink2); cursor: pointer; }

.band-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; margin-bottom: 12px; }
.bs-kpi span { display: block; font-size: 11.5px; color: var(--mute); }
.bs-kpi b { font-size: 18px; font-weight: 800; color: var(--ink); }
.bs-kpi small { display: block; font-size: 11.5px; color: var(--mute); margin-top: 1px; }

.gallery-grid { display: grid; gap: 12px; }
.gallery-grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.gallery-grid.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.g-card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; cursor: pointer; transition: transform .12s, box-shadow .12s, border-color .12s; display: flex; flex-direction: column; }
.g-card:hover { transform: translateY(-2px); box-shadow: var(--sh-up); border-color: var(--acc); }
.g-card.sel { border: 2px solid var(--acc); }
.g-card.offshelf { opacity: .82; }
.g-thumb { position: relative; aspect-ratio: 16 / 10; background: var(--soft); overflow: hidden; }
.g-thumb.sq { aspect-ratio: 1 / 1; }
.g-thumb img { width: 100%; height: 100%; object-fit: cover; }
.badge-tl { position: absolute; left: 8px; top: 8px; background: rgba(15, 23, 42, .78); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; backdrop-filter: blur(4px); }
.badge-tr { position: absolute; right: 8px; top: 8px; height: 22px; font-size: 11px; }
.badge-bl { position: absolute; left: 8px; bottom: 8px; height: 22px; font-size: 11px; }
.g-body { padding: 11px 12px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
.g-body h3 { font-size: 13.5px; font-weight: 700; line-height: 1.38; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.g-summary { font-size: 12px; color: var(--mute); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.price-row { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.p-num { font-size: 18px; font-weight: 800; color: var(--red); white-space: nowrap; }
.unit-pill { font-size: 11px; color: var(--mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 115px; }
.g-meta { display: flex; justify-content: space-between; gap: 6px; font-size: 11.5px; color: var(--mute); margin-top: auto; }
.g-meta span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.g-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding-top: 6px; border-top: 1px solid var(--line); }

.sec-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.card-h { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.card-h h3 { font-size: 16px; font-weight: 700; margin: 0; }
.peer-list, .ch-list, .my-card-list { display: grid; gap: 10px; }
.peer-item, .ch-item, .mc-item { padding: 12px; border-radius: 10px; background: var(--soft); border: 1px solid var(--line); }
.pi-top, .ch-top, .mc-top { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-bottom: 8px; }
.kv.compact { grid-template-columns: 76px 1fr; gap: 5px 10px; font-size: 12.5px; }
.ch-acts { display: flex; gap: 8px; margin-top: 10px; }
.seller-fold { margin-top: 12px; background: var(--soft); border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; }
.seller-fold summary { cursor: pointer; font-size: 13px; font-weight: 700; }
.compact-tbl th, .compact-tbl td { padding: 7px 8px; font-size: 12.5px; }
.row-acts { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
.row-acts .btn.sm { height: 24px; min-height: 24px; padding: 0 8px; font-size: 11px; white-space: nowrap; }
.dir-tbl { table-layout: auto; }
.dir-tbl th, .dir-tbl td { padding: 7px 5px; font-size: 12px; }
.dir-tbl .col-dir { width: 225px; max-width: 240px; }
.dir-tbl .nowrap { white-space: nowrap; }

.race-picker { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.rp-btn { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 10px; background: var(--panel); border: 1px solid var(--line); font-size: 13px; text-align: left; }
.rp-btn.on { border-color: var(--acc); background: var(--acc-soft); }
.race-brief { padding: 14px 16px; margin-bottom: 12px; }
.rb-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; font-size: 14px; }
.rb-meta { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12.5px; color: var(--mute); }
.cand-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-bottom: 14px; }
.cand-card { padding: 15px; display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--line); }
.cand-card.winner { border: 2px solid var(--grn); }
.cand-hd { display: flex; justify-content: space-between; align-items: center; }
.cand-card h3 { font-size: 14.5px; margin: 0; line-height: 1.35; }
.cand-card button { margin-top: auto; }

.calc-grid { display: grid; grid-template-columns: 1.25fr 1fr; gap: 14px; align-items: start; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--mute); }
.form-grid label.fg-wide { grid-column: 1 / -1; }
.form-grid input, .form-grid select, .form-grid textarea { border: 1px solid var(--line); border-radius: 8px; background: var(--soft); padding: 7px 10px; font-size: 13.5px; color: var(--ink); font-weight: 500; }
.repro-gate { margin-top: 10px; padding: 9px 12px; border-radius: 9px; background: var(--amb-soft); color: var(--amb-ink); }
.calc-result { display: grid; grid-template-columns: repeat(3, 1fr) auto; gap: 10px; align-items: center; margin-top: 12px; padding: 12px; border-radius: 10px; border: 1px solid var(--line); }
.calc-result.ok { background: var(--grn-soft); border-color: var(--grn); }
.calc-result.amb { background: var(--amb-soft); border-color: var(--amb); }
.calc-result.bad { background: var(--red-soft); border-color: var(--red); }
.calc-result span { display: block; font-size: 11.5px; color: var(--mute); }
.calc-result strong { font-size: 20px; font-weight: 800; }
.verdict-pill { font-size: 12.5px; font-weight: 700; padding: 6px 10px; border-radius: 8px; background: var(--panel); }
.calc-acts { margin-top: 12px; display: flex; justify-content: flex-end; gap: 8px; }

.vi-drawer { width: 350px; padding: 16px; position: sticky; top: 10px; max-height: calc(100vh - 96px); overflow-y: auto; display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--line); }
.dr-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dr-img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 10px; background: var(--soft); }
.dr-img.sq { aspect-ratio: 1 / 1; max-height: 240px; }
.dr-price-bar { display: flex; align-items: baseline; gap: 8px; }
.dr-price-bar strong { font-size: 22px; color: var(--red); }
.dr-obs { padding-top: 8px; border-top: 1px solid var(--line); }
.dr-obs h4 { font-size: 12.5px; color: var(--mute); margin-bottom: 6px; }
.ob-row { padding: 6px 8px; border-radius: 7px; background: var(--soft); margin-bottom: 5px; font-size: 12px; }
.dr-acts { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 6px; }
.dr-acts.col { flex-direction: column; }
.dr-row-2 { display: flex; gap: 6px; flex-wrap: wrap; }

.empty-card { padding: 36px; text-align: center; color: var(--mute); }
.vi-modal-bg { position: fixed; inset: 0; background: rgba(15, 23, 42, .45); display: grid; place-items: center; z-index: 60; }
.vi-modal { width: 560px; max-width: calc(100vw - 32px); display: flex; flex-direction: column; gap: 12px; }
</style>
