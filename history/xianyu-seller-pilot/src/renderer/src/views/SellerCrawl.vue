<template>
  <div class="seller-page">
    <header class="page-head">
      <div>
        
        <h1>卖家主页采集</h1>
        <div class="domain-badge"><el-tag type="success" effect="plain" size="small">主页队列专用</el-tag></div>
      </div>
      <div class="head-actions">
        <el-button :icon="Refresh" :loading="summaryLoading" @click="refreshVisible">刷新证据</el-button>
        <el-button :icon="Document" @click="showRules = true">主页采集规则.md</el-button>
        <el-button :icon="Upload" :loading="importing" @click="importFile">导入卖家 Excel</el-button>
        <el-button v-if="!summary.running" type="primary" :icon="VideoPlay" :loading="starting" @click="start">继续未完成任务</el-button>
        <template v-else>
          <el-button v-if="summary.paused" type="primary" plain :icon="VideoPlay" :loading="starting" @click="resume">恢复采集</el-button>
          <el-button v-else type="warning" plain :icon="VideoPause" :loading="pausing" @click="pause">暂停并保留断点</el-button>
          <el-button type="danger" plain :icon="VideoPause" :loading="stopping" @click="stop">安全停止并保存断点</el-button>
        </template>
      </div>
    </header>

    <el-dialog v-model="showRules" title="主页采集规则.md" width="720px"><pre class="rules-markdown">{{ sellerRulesMarkdown }}</pre></el-dialog>

    <el-alert v-if="summaryError" class="local-alert" type="error" :closable="false" show-icon>
      <template #title>统计刷新失败，已保留上次成功数据</template>{{ summaryError }}
    </el-alert>

    <section class="evidence-panel" aria-labelledby="evidence-title">
      <div class="section-head">
        <div><h2 id="evidence-title">可信证据轨道</h2><p>更新时间 {{ fmt(summary.updatedAt) }} · 点击数字只筛选队列，不会启动采集。</p></div>
        <el-skeleton v-if="summaryLoading && !hasSummary" animated :rows="1" class="summary-skeleton" />
      </div>
      <div class="group-track" aria-label="卖家采集主筛选">
        <button v-for="card in groupCards" :key="card.key" type="button" class="group-card" :class="{ selected: selection.group === card.key }" :aria-pressed="selection.group === card.key" @click="selectQueue(card.key)">
          <span>{{ card.label }}</span><strong>{{ card.count }}</strong><small>{{ card.predicate }}</small>
        </button>
      </div>
      <div class="status-track" aria-label="卖家采集状态细分">
        <button v-for="card in statusCards" :key="card.key" type="button" class="status-card" :class="{ selected: selection.dimension === 'status' && selection.status === card.key }" :aria-pressed="selection.dimension === 'status' && selection.status === card.key" @click="selectStatus(card.key)">
          <span>{{ card.label }}</span><strong>{{ card.count }}</strong><small>{{ card.predicate }}</small>
        </button>
      </div>
      <el-alert v-if="hasSummary && !partitionConsistent" class="consistency-alert" type="warning" :closable="false" show-icon title="队列统计暂不一致，请点击刷新证据后再导出" />
    </section>

    <section class="run-panel" aria-labelledby="run-title">
      <div class="section-head">
        <div><h2 id="run-title">当前运行</h2><p v-if="summary.running">切换菜单不会中断</p><p v-else>{{ nextRunCopy }}</p></div>
        <el-tag :type="summary.running ? 'success' : 'info'" effect="plain">{{ summary.running ? '运行中' : '当前空闲' }}</el-tag>
      </div>
      <div v-if="summary.running" class="run-grid">
        <div><span>当前账号</span><b>{{ currentRun.accountName || '等待账号证据' }}</b></div>
        <div><span>卖家</span><b :title="currentRun.sellerUrl">{{ currentRun.sellerId || '等待下一条进度' }}</b></div>
        <div><span>当前分支</span><b>{{ branchLabel(currentRun.branch) }}</b></div>
        <div><span>已采 / 期望</span><b>{{ countPair(currentRun.collected, currentRun.expected) }}</b></div>
        <div><span>安全节流</span><b>{{ throttleCountdown }}</b></div>
        <div><span>最近持久写入</span><b>{{ fmt(currentRun.lastDurableWriteAt) }}</b></div>
        <div v-if="runAccountStats.length || runInactiveAccounts.length" class="run-account-stats">
          <span>账号进度（运行中 / 已暂停）</span>
          <div class="run-account-list">
            <span v-for="account in runAccountStats" :key="`active-${account.accountId}`" class="run-account-pill run-account-pill--active">
              {{ account.accountName }} {{ account.finished }}/{{ account.claimed }}
            </span>
            <span v-for="account in runInactiveAccounts" :key="`blocked-${account.id}`" class="run-account-pill run-account-pill--blocked">
              {{ account.name || account.id }} · {{ accountState(account) }}<small v-if="account.safety?.coolingUntil">至 {{ fmt(account.safety.coolingUntil) }}</small>
            </span>
          </div>
        </div>
        <p class="run-reason">{{ currentRun.throttleReason || `卖家间隔 ${intervalCopy}。` }}</p>
      </div>
      <div v-else class="idle-strip">
        <el-select v-model="sample" aria-label="本次采集范围" class="sample-select"><el-option label="全部符合条件的卖家" value="all" /><el-option label="20 个小样本（测试）" value="canary20" /></el-select>
      </div>
    </section>

    <section class="queue-panel" aria-labelledby="queue-title">
      <div class="section-head queue-heading">
        <div><h2 id="queue-title">{{ selectedMeta.label }} · {{ queueTotal }}</h2><p>{{ selectedMeta.predicate }}</p></div>
        <div class="queue-actions"><el-input v-model="query" clearable placeholder="筛选卖家 ID、名称或主页" aria-label="筛选当前卖家队列" @keyup.enter="applyQuery" /><el-button :icon="Search" :disabled="queueLoading" @click="applyQuery">筛选</el-button><el-button :icon="Download" :loading="exporting" :disabled="queueLoading || !partitionConsistent" @click="exportQueue('summary')">导出队列概览</el-button><el-button type="primary" plain :icon="Download" :loading="exportingDetail" :disabled="queueLoading || !partitionConsistent" @click="exportQueue('detail')">导出详细 Excel</el-button></div>
      </div>
      <el-alert v-if="queueError" class="local-alert" type="error" :closable="false" show-icon><template #title>队列刷新失败，已保留上次成功数据</template>{{ queueError }}</el-alert>
      <el-table v-loading="queueLoading" :data="queueRows" class="queue-table" height="360" empty-text="当前筛选没有记录">
        <el-table-column label="卖家" min-width="220"><template #default="{ row }"><a v-if="safeGoofishUrl(row.url)" class="seller-link" :href="safeGoofishUrl(row.url)" target="_blank" rel="noopener noreferrer" :title="safeGoofishUrl(row.url)">{{ row.sellerName || row.sellerId || '未命名卖家' }}</a><span v-else class="seller-name">{{ row.sellerName || row.sellerId || '未命名卖家' }}</span><small>{{ row.sellerId }}</small></template></el-table-column>
        <el-table-column label="来源定位" min-width="280"><template #default="{ row }"><div class="source-context"><span>分类：{{ categoryLabel(row) }}</span><span v-if="row.mainType">主类型：{{ row.mainType }}</span><span v-if="row.mainContent">主内容：{{ row.mainContent }}</span></div><small v-if="row.boardName || row.board">来源榜单：{{ row.boardName || row.board }}</small><small v-if="row.sourceBoardRanks" :title="row.sourceBoardRanks">{{ row.sourceBoardRanks }}</small><small v-else-if="row.sourceRank || row.rank || row.sourceOrdinal">第 {{ row.sourceRank || row.rank || row.sourceOrdinal }} 位<span v-if="row.sourceSlotCount"> / {{ row.sourceSlotCount }} 槽</span></small><small v-else-if="row.excelRow">Excel 第 {{ row.excelRow }} 行</small><small v-else class="metadata-missing">未带榜单元数据</small></template></el-table-column>
        <el-table-column label="状态" width="104"><template #default="{ row }"><el-tag :type="tagType(row.status)" effect="plain" size="small">{{ statusLabel(row.status, row) }}</el-tag></template></el-table-column>
        <el-table-column label="在售 / 已售" width="130"><template #default="{ row }">{{ countPair(row.activeCount, row.expectedActive) }} · {{ countPair(row.soldCount, row.expectedSold) }}</template></el-table-column>
        <el-table-column label="正式尝试" width="82" prop="attemptCount" />
        <el-table-column label="原因与证据" min-width="220"><template #default="{ row }"><div class="reason" :title="reasonText(row)">{{ reasonText(row) }}</div><small>{{ fmt(row.lastDurableWriteAt || row.updatedAt) }}</small></template></el-table-column>
        <el-table-column label="证据操作" width="172" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openSellerDetail(row)">看明细</el-button><el-button v-if="snapshotPathFor(row)" link type="primary" @click="openSnapshot(row)">看快照</el-button><span v-else class="snapshot-muted">暂无快照</span></template></el-table-column>
      </el-table>
      <div v-if="!queueLoading && !queueRows.length && summary.indexed === 0" class="first-empty"><h3>还没有卖家任务</h3><p>导入包含卖家主页链接的 Excel；系统会去重并建立可恢复队列。</p><el-button type="primary" :icon="Upload" @click="importFile">导入卖家 Excel</el-button></div>
      <div v-else-if="!queueLoading && !queueRows.length && selection.dimension === 'group' && selection.group === 'pending'" class="small-empty">当前没有未闭合卖家；请查看已完成或失败队列。</div>
      <div v-else-if="!queueLoading && !queueRows.length && selection.dimension === 'status'" class="small-empty">当前状态没有卖家记录；请刷新证据或查看其它状态。</div>
      <div class="pager"><el-pagination background layout="total, prev, pager, next" :disabled="queueLoading" :total="queueTotal" :page-size="pageSize" :current-page="page" @current-change="changePage" /></div>
    </section>

    <el-drawer v-model="detailVisible" title="卖家采集详情" size="min(94vw, 1120px)" destroy-on-close class="seller-detail-drawer">
      <div v-if="detailSeller" class="detail-content">
        <div class="detail-hero">
          <div>
            <div class="detail-kicker">SELLER EVIDENCE DETAIL</div>
            <h2>{{ detailSeller.sellerName || detailSeller.name || detailSeller.sellerId || '未命名卖家' }}</h2>
            <p>{{ detailSeller.sellerId || '—' }}<span v-if="safeGoofishUrl(detailSeller.url)"> · <a :href="safeGoofishUrl(detailSeller.url)" target="_blank" rel="noopener noreferrer">打开主页</a></span></p>
          </div>
          <div class="detail-hero-actions"><el-tag :type="tagType(detailSeller.status)" effect="plain">{{ statusLabel(detailSeller.status, detailSeller) }}</el-tag><el-button v-if="snapshotPathFor(detailSeller)" size="small" :icon="Document" @click="openSnapshot(detailSeller)">查看最新快照</el-button></div>
        </div>
        <el-alert v-if="detailError" class="local-alert" type="warning" :closable="false" show-icon :title="detailError" />
        <div class="detail-kpis">
          <div><span>在售商品</span><b>{{ countPair(detailSeller.activeCount, detailSeller.expectedActive) }}</b></div>
          <div><span>已售商品</span><b>{{ countPair(detailSeller.soldCount, detailSeller.expectedSold) }}</b></div>
          <div><span>正式尝试</span><b>{{ detailSeller.attemptCount || 0 }}</b></div>
          <div><span>商品明细</span><b>{{ detailItems.length }}</b></div>
          <div><span>最近写入</span><b>{{ fmt(detailSeller.lastDurableWriteAt || detailSeller.updatedAt) }}</b></div>
        </div>
        <div class="detail-context"><span>分类：{{ categoryLabel(detailSeller) }}</span><span v-if="detailSeller.mainType">主类型来源：{{ detailSeller.mainType }}</span><span v-if="detailSeller.mainContent">主内容来源：{{ detailSeller.mainContent }}</span><span v-if="detailSeller.boardName || detailSeller.board">来源榜单：{{ detailSeller.boardName || detailSeller.board }}</span><span v-if="detailSeller.sourceBoardRanks">{{ detailSeller.sourceBoardRanks }}</span><span v-else-if="detailSeller.sourceRank || detailSeller.rank">第 {{ detailSeller.sourceRank || detailSeller.rank }} 位</span><span v-if="detailSeller.reason">{{ reasonText(detailSeller) }}</span></div>

        <el-tabs v-model="detailTab" class="detail-tabs">
          <el-tab-pane label="商品明细" name="items">
            <div class="detail-toolbar"><el-input v-model="detailItemQuery" clearable size="small" placeholder="筛选商品标题或商品 ID" aria-label="筛选卖家商品明细" /></div>
            <el-table v-loading="detailLoading" :data="filteredDetailItems" border stripe size="small" max-height="430" empty-text="暂没有商品明细">
              <el-table-column label="商品" min-width="280"><template #default="{ row }"><a v-if="safeGoofishUrl(itemUrl(row))" class="item-link" :href="safeGoofishUrl(itemUrl(row))" target="_blank" rel="noopener noreferrer" :title="safeGoofishUrl(itemUrl(row))">{{ row.title || row.name || row.itemTitle || '未命名商品' }}</a><div v-else class="item-title">{{ row.title || row.name || row.itemTitle || '未命名商品' }}</div><small>{{ row.itemId || row.id || '无商品 ID' }}</small></template></el-table-column>
              <el-table-column label="分类" width="130"><template #default="{ row }"><el-tag class="item-category" effect="plain" size="small">{{ itemCategoryLabel(row) }}</el-tag></template></el-table-column>
              <el-table-column label="分支" width="86"><template #default="{ row }">{{ branchLabel(row.status || row.branch || row.statusBranch || row.source) }}</template></el-table-column>
              <el-table-column label="价格" width="100"><template #default="{ row }">{{ row.price == null ? '—' : `¥${row.price}` }}</template></el-table-column>
              <el-table-column label="商品状态" width="110"><template #default="{ row }">{{ itemStatusLabel(row.status || row.itemStatus) }}</template></el-table-column>
              <el-table-column label="采集时间" width="170"><template #default="{ row }">{{ fmt(row.capturedAt || row.observedAt || row.collectedAt || row.updatedAt || row.at) }}</template></el-table-column>
              <el-table-column label="来源" min-width="190" show-overflow-tooltip><template #default="{ row }"><a v-if="safeGoofishUrl(itemUrl(row))" class="item-source-link" :href="safeGoofishUrl(itemUrl(row))" target="_blank" rel="noopener noreferrer" :title="safeGoofishUrl(itemUrl(row))">打开商品链接</a><span v-else>—</span></template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="采集证据" name="evidence">
            <div class="evidence-detail-grid"><div class="evidence-detail-card"><span>最近原因</span><strong>{{ reasonText(detailSeller) }}</strong><small>{{ fmt(detailSeller.lastDurableWriteAt || detailSeller.updatedAt) }}</small></div><div class="evidence-detail-card"><span>边界判断</span><strong>{{ boundaryLabel(detailSeller) }}</strong><small>{{ detailSeller.boundaryReason || detailSeller.reasonCode || '暂无单独边界证据' }}</small></div></div>
            <div class="detail-section-title">正式尝试与页面边界</div>
            <el-table :data="detailAttempts" border size="small" max-height="360" empty-text="暂无尝试明细"><el-table-column label="开始" width="170"><template #default="{ row }">{{ fmt(row.startedAt || row.started || row.at) }}</template></el-table-column><el-table-column label="结束" width="170"><template #default="{ row }">{{ fmt(row.finishedAt || row.endedAt || row.completedAt) }}</template></el-table-column><el-table-column label="账号" width="130"><template #default="{ row }">{{ row.accountName || row.accountId || '—' }}</template></el-table-column><el-table-column label="分支" width="86"><template #default="{ row }">{{ branchLabel(row.branch) }}</template></el-table-column><el-table-column label="商品数" width="90"><template #default="{ row }">{{ row.itemCount ?? row.collected ?? row.count ?? '—' }}</template></el-table-column><el-table-column label="结果/边界" min-width="240"><template #default="{ row }">{{ row.reason || row.reasonCode || row.boundary || row.outcome || '—' }}</template></el-table-column></el-table>
            <div class="detail-section-title">原始证据摘要</div><pre class="evidence-json">{{ prettyEvidence(detailData) }}</pre>
          </el-tab-pane>
          <el-tab-pane label="页面快照" name="snapshot">
            <div class="snapshot-card"><div><strong>{{ snapshotPathFor(detailSeller) ? (detailSeller.snapshotComplete === false ? '已保存部分商品证据快照（未完成）' : '已保存完整商品证据快照') : '暂无商品证据快照' }}</strong><p>{{ snapshotPathFor(detailSeller) ? `包含本次已采商品 · 保存时间：${fmt(detailSeller.snapshotAt || detailSeller.updatedAt)}` : '正式尝试尚未保存页面证据。' }}</p></div><el-button v-if="snapshotPathFor(detailSeller)" type="primary" plain :icon="Document" @click="openSnapshot(detailSeller)">打开快照预览</el-button></div>
            <el-alert type="info" :closable="false" show-icon title="快照是采集时保存的页面证据，不会重新访问闲鱼，也不会触发新的采集任务。" />
          </el-tab-pane>
        </el-tabs>
      </div>
      <el-skeleton v-else-if="detailLoading" animated :rows="8" />
      <el-empty v-else description="未找到该卖家的详情证据" />
    </el-drawer>

    <el-dialog v-model="snapshotVisible" :title="snapshotMeta.complete === false ? '部分商品证据快照（未完成）' : '完整商品证据快照'" width="92%" top="4vh" destroy-on-close>
      <div class="snapshot-meta"><span>{{ snapshotMeta.sellerName || snapshotMeta.name || snapshotMeta.sellerId || '卖家主页' }}</span><span v-if="snapshotMeta.sellerId">卖家 ID：{{ snapshotMeta.sellerId }}</span><span v-if="snapshotMeta.snapshotAt || snapshotMeta.updatedAt">抓取时间：{{ fmt(snapshotMeta.snapshotAt || snapshotMeta.updatedAt) }}</span></div>
      <div v-loading="snapshotLoading" class="snapshot-wrap"><div v-if="snapshotUrl" class="snapshot-html-shell"><div class="snapshot-html-note">{{ snapshotMeta.complete === false ? '部分商品证据快照（未完成）' : '完整商品证据快照' }} · 包含本次已采商品；这是抓取时保存的真实网页 DOM，不会重新访问闲鱼。</div><iframe :src="snapshotUrl" :style="snapshotFrameStyle" class="snapshot-html-frame" :title="snapshotMeta.complete === false ? '部分商品证据快照（未完成）' : '完整商品证据快照'" scrolling="yes" sandbox="allow-same-origin allow-popups" /></div><div v-else-if="snapshotHtml" class="snapshot-html-shell"><div class="snapshot-html-note">{{ snapshotMeta.complete === false ? '部分商品证据快照（未完成）' : '完整商品证据快照' }} · 包含本次已采商品；这是旧版 DOM 快照，页面资源可能仍依赖闲鱼线上地址。</div><iframe :srcdoc="snapshotHtml" :style="snapshotFrameStyle" class="snapshot-html-frame" :title="snapshotMeta.complete === false ? '部分商品证据快照（未完成）' : '完整商品证据快照'" scrolling="yes" sandbox="allow-same-origin allow-popups" /></div><img v-else-if="snapshotSrc" :src="snapshotSrc" class="snapshot-image" :alt="snapshotMeta.complete === false ? '部分商品证据快照（未完成）' : '完整商品证据快照'" /><el-empty v-else description="这条历史记录没有保存商品证据快照" :image-size="90" /></div>
    </el-dialog>

    <section class="history-settings">
      <el-card shadow="never" class="history-card">
        <template #header><div class="section-head"><div><h2>运行历史</h2></div><el-button text :loading="historyLoading" @click="loadRuns">刷新</el-button></div></template>
        <el-alert v-if="historyError" type="error" :closable="false" show-icon :title="historyError" />
        <button v-for="run in runs" :key="`${run.type}-${run.at}-${run.runId}`" type="button" class="run-row" @click="showRun(run)"><span><b>{{ runTypeLabel(run) }}</b><small>{{ fmt(run.at || run.scheduledAt) }}</small></span><span>{{ run.trigger || run.outcome || '—' }}</span><span>{{ run.total == null ? '—' : `${run.total} 个卖家` }} <small>查看结构化证据 ›</small></span></button>
        <div v-if="!historyLoading && !runs.length" class="small-empty">还没有可显示的运行历史。</div>
      </el-card>
      <el-collapse class="settings-card"><el-collapse-item title="计划与安全间隔设置" name="settings">
        <p class="schedule-copy">每周一 02:00 自动继续，错过后 24 小时内补跑一次。</p>
        <el-form label-position="top"><div class="settings-grid">
          <el-form-item label="每周自动继续"><el-switch v-model="schedule.weeklyEnabled" :loading="scheduleSaving" @change="saveSchedule" /></el-form-item>
          <el-form-item label="星期"><el-select v-model="schedule.weeklyDay" :disabled="settingsLoading || scheduleSaving" @change="saveSchedule"><el-option v-for="day in days" :key="day.value" :label="day.label" :value="day.value" /></el-select></el-form-item>
          <el-form-item label="时间"><el-time-picker v-model="schedule.weeklyTime" :disabled="settingsLoading || scheduleSaving" format="HH:mm" value-format="HH:mm" @change="saveSchedule" /></el-form-item>
          <el-form-item label="主页随机间隔（秒）"><div class="interval-row"><el-input-number v-model="settings.throttleMinSeconds" :disabled="settingsLoading || intervalSaving" :min="15" :max="3600" :step="1" /><span>至</span><el-input-number v-model="settings.throttleMaxSeconds" :disabled="settingsLoading || intervalSaving" :min="15" :max="3600" :step="1" /><span>秒</span><el-button size="small" :loading="intervalSaving" @click="saveIntervals">保存</el-button></div></el-form-item>
        </div></el-form>
        <div class="schedule-evidence">时区 {{ schedule.timezone }} · 最近结果 {{ scheduleOutcomeLabel(schedule.lastOutcome) }} · {{ fmt(schedule.lastScheduledAt) }}</div>
        <div class="account-list"><span v-for="account in accounts" :key="account.id" class="account-pill">{{ account.name || account.id }} · {{ accountState(account) }}</span></div>
      </el-collapse-item></el-collapse>
    </section>

    <el-dialog v-model="runDetailVisible" title="运行历史 · 结构化证据" width="960px" top="6vh" destroy-on-close>
      <div v-if="runDetail" class="run-detail-content">
        <el-alert v-if="runDetailError" type="warning" :closable="false" show-icon :title="runDetailError" />
        <div class="run-detail-kpis"><div><span>运行编号</span><b>{{ runDetail.runId || '—' }}</b></div><div><span>触发方式</span><b>{{ runDetail.trigger || runDetail.type || '—' }}</b></div><div><span>结果</span><b>{{ runDetail.outcome || runDetail.status || '—' }}</b></div><div><span>卖家数</span><b>{{ runDetail.total ?? runDetail.sellerCount ?? runDetail.sellers?.length ?? '—' }}</b></div></div>
        <div class="detail-section-title">卖家结果</div>
        <el-table :data="runDetailEntries" border size="small" max-height="380" empty-text="该运行没有逐卖家证据"><el-table-column label="卖家" min-width="220"><template #default="{ row }">{{ row.sellerName || row.name || row.sellerId || '—' }}<small>{{ row.sellerId || '' }}</small></template></el-table-column><el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="tagType(row.status)" size="small" effect="plain">{{ statusLabel(row.status, row) }}</el-tag></template></el-table-column><el-table-column label="在售 / 已售" width="140"><template #default="{ row }">{{ countPair(row.activeCount, row.expectedActive) }} · {{ countPair(row.soldCount, row.expectedSold) }}</template></el-table-column><el-table-column label="边界/原因" min-width="260" show-overflow-tooltip><template #default="{ row }">{{ row.reason || row.reasonCode || row.boundary || row.outcome || '—' }}</template></el-table-column></el-table>
        <el-collapse class="run-raw-collapse"><el-collapse-item title="运行元数据与事件摘要" name="metadata"><pre class="evidence-json">{{ prettyEvidence(runDetail) }}</pre></el-collapse-item></el-collapse>
      </div>
      <el-skeleton v-else-if="runDetailLoading" animated :rows="7" />
      <el-empty v-else description="暂无运行证据" />
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Document, Download, Refresh, Search, Upload, VideoPause, VideoPlay } from '@element-plus/icons-vue'
import { createRequestGeneration } from '../request-generation.js'
import sellerRulesMarkdown from '../docs/seller-rules.md?raw'

const STATUS_META = Object.freeze({
  pending: { label: '待采集', mark: '○', predicate: '已进入索引，尚未持有正式运行或终态证据。' },
  running: { label: '正在抓取', mark: '▶', predicate: '主进程已经持有当前卖家的正式尝试租约。' },
  completed: { label: '已完成', mark: '✓', predicate: '小卖家数量严格满足；大卖家超过 1,500 条时按平台策略接受完成。' },
  no_active: { label: '无在售', mark: '0', predicate: '可信在售期望为 0，已售分支也已完整核对。' },
  incomplete: { label: '部分采集', mark: '!', predicate: '页面未完成、滚动未推进，或页面证据判定已到读取边界；具体原因见每行证据。' },
  needs_review: { label: '需复核', mark: '?', predicate: '期望数量未知、页面结构异常或商品重复冲突。' },
  failed: { label: '失败', mark: '×', predicate: '持久写入或有界网络重试失败，未伪装成完成。' },
  login_expired: { label: '登录失效', mark: '↗', predicate: '账号登录已失效；修复登录前不会自动换号继续。' },
  risk_cooldown: { label: '风控冷却', mark: '⏸', predicate: '检测到验证、429 或公共主页回退，账号至少冷却 6 小时。' }
})
const GROUP_META = Object.freeze({
  all: { label: '全部', predicate: '当前索引中已校验的全部卖家。' },
  pending: { label: '未闭合', predicate: '包含待启动、运行中、部分采集、需复核、登录失效和风控冷却。' },
  completed: { label: '已完成', predicate: '包含已完成和无在售，证据边界已经闭合。' },
  failed: { label: '失败', predicate: '正式采集失败，保留失败原因与后续重试入口。' }
})
const GROUP_STATUS_KEYS = Object.freeze({ pending: ['pending', 'running', 'incomplete', 'needs_review', 'login_expired', 'risk_cooldown'], completed: ['completed', 'no_active'], failed: ['failed'] })
const STATUS_FILTER_KEYS = Object.freeze(Object.keys(STATUS_META))
const days = [{ value: 1, label: '周一' }, { value: 2, label: '周二' }, { value: 3, label: '周三' }, { value: 4, label: '周四' }, { value: 5, label: '周五' }, { value: 6, label: '周六' }, { value: 0, label: '周日' }]
const summary = reactive({ indexed: 0, loaded: 0, crawled: 0, groupCounts: {}, statuses: Object.fromEntries(Object.keys(STATUS_META).map((key) => [key, 0])), accountStats: {}, updatedAt: null, running: false, currentRun: null })
const schedule = reactive({ weeklyEnabled: true, weeklyDay: 1, weeklyTime: '02:00', timezone: 'Asia/Shanghai', catchUpHours: 24, lastOutcome: null, lastScheduledAt: null })
const MIN_INTERVAL_SECONDS = 15
const MAX_INTERVAL_SECONDS = 3600
const settings = reactive({ throttleMinSeconds: 15, throttleMaxSeconds: 30 })
const showRules = ref(false)
const selection = reactive({ dimension: 'group', group: 'all', status: null })
const summaryLoading = ref(false), queueLoading = ref(false), historyLoading = ref(false), settingsLoading = ref(false)
const exporting = ref(false), exportingDetail = ref(false), importing = ref(false), starting = ref(false), pausing = ref(false), stopping = ref(false), scheduleSaving = ref(false), intervalSaving = ref(false)
const summaryError = ref(''), queueError = ref(''), historyError = ref('')
const queueRows = ref([]), queueTotal = ref(0), page = ref(1), query = ref(''), appliedQuery = ref(''), runs = ref([]), accounts = ref([]), sample = ref('all'), nowMs = ref(Date.now())
const detailVisible = ref(false), detailLoading = ref(false), detailError = ref(''), detailRow = ref(null), detailData = ref(null), detailTab = ref('items'), detailItemQuery = ref('')
const snapshotVisible = ref(false), snapshotLoading = ref(false), snapshotSrc = ref(''), snapshotUrl = ref(''), snapshotHtml = ref(''), snapshotMeta = ref({})
const runDetailVisible = ref(false), runDetailLoading = ref(false), runDetailError = ref(''), runDetail = ref(null)
const pageSize = 50
let off = null, timer = null, eventRefreshTimer = null, eventRefreshSummaryDirty = false, eventRefreshQueueDirty = false, eventRefreshRunsDirty = false, disposed = false
let summaryRequestId = 0, queueRequestId = 0, historyRequestId = 0
const settingsRequests = createRequestGeneration()

const hasSummary = computed(() => summary.indexed > 0 || Boolean(summary.updatedAt))
const groupCounts = computed(() => {
  const source = summary.groupCounts && typeof summary.groupCounts === 'object' ? summary.groupCounts : {}
  const statuses = summary.statuses || {}
  const fallback = {
    all: Number(summary.indexed || 0),
    pending: GROUP_STATUS_KEYS.pending.reduce((sum, key) => sum + Number(statuses[key] || 0), 0),
    completed: GROUP_STATUS_KEYS.completed.reduce((sum, key) => sum + Number(statuses[key] || 0), 0),
    failed: Number(statuses.failed || 0)
  }
  const read = (key, aliases = []) => {
    const candidates = [key, `${key}Count`, ...aliases]
    const value = candidates.map((candidate) => source[candidate]).find((candidate) => candidate != null && Number.isFinite(Number(candidate)))
    return value == null ? fallback[key] : Number(value)
  }
  return {
    all: read('all', ['indexed']),
    pending: read('pending', ['to_collect', '待采集']),
    completed: read('completed', ['done', '已完成']),
    failed: read('failed', ['error', '失败'])
  }
})
const groupCards = computed(() => Object.entries(GROUP_META).map(([key, meta]) => ({ key, ...meta, count: groupCounts.value[key] })))
const statusCards = computed(() => STATUS_FILTER_KEYS.map((key) => ({ key, ...STATUS_META[key], count: Number(summary.statuses?.[key] || 0) })))
const groupTotal = computed(() => ['pending', 'completed', 'failed'].reduce((sum, key) => sum + Number(groupCounts.value[key] || 0), 0))
const partitionConsistent = computed(() => groupTotal.value === Number(summary.indexed || 0) && Number(groupCounts.value.all || 0) === Number(summary.indexed || 0))
const selectedMeta = computed(() => selection.dimension === 'status' && selection.status && STATUS_META[selection.status]
  ? { label: `状态：${STATUS_META[selection.status].label}`, predicate: STATUS_META[selection.status].predicate }
  : GROUP_META[selection.group] || GROUP_META.all)
const currentRun = computed(() => summary.currentRun || {})
const runAccountStats = computed(() => Object.values(currentRun.value.accountStats || summary.accountStats || {}).filter((account) => account && account.accountId))
const runAccountIds = computed(() => new Set(runAccountStats.value.map((account) => String(account.accountId))))
const runInactiveAccounts = computed(() => accounts.value.filter((account) => account?.enabled && !runAccountIds.value.has(String(account.id || ''))))
const nextRunCopy = computed(() => `每周${days.find((day) => day.value === schedule.weeklyDay)?.label?.slice(1) || '一'} ${schedule.weeklyTime || '02:00'}（${schedule.timezone || 'Asia/Shanghai'}）；错过后 ${schedule.catchUpHours || 24} 小时内补跑。`)
const intervalCopy = computed(() => settings.throttleMinSeconds === settings.throttleMaxSeconds ? `${settings.throttleMinSeconds} 秒固定间隔` : `${settings.throttleMinSeconds}–${settings.throttleMaxSeconds} 秒随机间隔`)
const throttleCountdown = computed(() => { const due = Date.parse(currentRun.value.throttleEarliestAt || ''); if (!Number.isFinite(due)) return intervalCopy.value; const seconds = Math.max(0, Math.ceil((due - nowMs.value) / 1000)); return seconds > 0 ? `最早 ${seconds} 秒后` : '已达到最早安全时间' })
const detailSeller = computed(() => {
  const source = detailData.value?.seller || detailData.value || detailRow.value || null
  if (!source) return null
  const expected = source.expected || source.expectation || {}
  return {
    ...source,
    expectedActive: source.expectedActive ?? expected.active ?? expected.activeCount ?? null,
    expectedSold: source.expectedSold ?? expected.sold ?? expected.soldCount ?? null
  }
})
const detailItems = computed(() => asArray(detailData.value?.items || detailData.value?.itemRows || detailData.value?.products || detailSeller.value?.items))
const filteredDetailItems = computed(() => {
  const needle = detailItemQuery.value.trim().toLowerCase()
  if (!needle) return detailItems.value
  return detailItems.value.filter((row) => [row.title, row.name, row.itemTitle, row.itemId, row.id, row.url, row.itemUrl].some((value) => String(value || '').toLowerCase().includes(needle)))
})
const detailAttempts = computed(() => asArray(detailData.value?.attempts || detailData.value?.tries || detailSeller.value?.attempts))
const runDetailEntries = computed(() => asArray(runDetail.value?.sellers || runDetail.value?.sellerResults || runDetail.value?.rows || runDetail.value?.results))
const snapshotFrameStyle = computed(() => { const viewport = snapshotMeta.value.snapshotViewport || {}; const width = Math.max(720, Number(viewport.width) || 1280); const height = Math.max(720, Number(viewport.height) || 900); return { width: `${width}px`, minWidth: '100%', height: `${height}px` } })

function fmt(value) { const time = Date.parse(value || ''); return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '—' }
function branchLabel(value) { return value === 'sold' ? '已售' : value === 'active' ? '在售' : '等待分支证据' }
function countPair(actual, expected) { return `${actual == null ? '—' : actual} / ${expected == null ? '未知' : expected}` }
function isPlatformBoundary(row) { return ['PLATFORM_BOUNDARY_REACHED', 'PLATFORM_CAP_REACHED'].includes(row?.reasonCode) }
function statusLabel(value, row = null) { return isPlatformBoundary(row) ? '读取边界' : (STATUS_META[value]?.label || '需复核') }
function tagType(value) { return ['completed', 'no_active'].includes(value) ? 'success' : value === 'failed' ? 'danger' : ['incomplete', 'needs_review'].includes(value) ? 'warning' : 'info' }
function reasonText(row) {
  if (row.reason) return row.reason
  if (row.reasonCode === 'LARGE_SELLER_POLICY_ACCEPTED') {
    return '主页统计超过 1500 条；按大卖家平台策略接受本次采集成功，数量仅作参考。'
  }
  if (isPlatformBoundary(row)) {
    const actual = Number(row.activeCount || 0) + Number(row.soldCount || 0)
    const expected = Number(row.expectedActive || 0) + Number(row.expectedSold || 0)
    const expectedCopy = expected > 0 ? `，主页统计约 ${expected} 条` : ''
    return `已采 ${actual} 条${expectedCopy}；页面持续处于底部加载状态，代码判定读取边界，已暂停并保存断点，后续可按商品 ID 续采。`
  }
  if (row.reasonCode === 'TRUSTED_COUNT_SHORT') {
    return `在售 ${row.activeCount ?? 0} / ${row.expectedActive ?? '未知'}，已售 ${row.soldCount ?? 0} / ${row.expectedSold ?? '未知'}；页面证据尚未采满，仍需复核滚动或续采。`
  }
  return row.reasonCode || STATUS_META[row.status]?.predicate || '暂无原因说明'
}
function scheduleOutcomeLabel(value) { return ({ scheduled: '准时触发', catch_up: '窗口内补跑', missed: '已记录漏跑', skipped_overlap: '运行重叠已跳过', duplicate: '同周期已处理' })[value] || '暂无记录' }
function accountState(account) { if (account.safety?.status === 'cooling') return '风控冷却'; if (account.safety?.status === 'login_required' || !account.loggedIn) return '需要登录'; return account.enabled ? '可用' : '已停用' }
function runTypeLabel(run) { return run.type === 'schedule' ? '计划周期' : run.type === 'recovery_start' ? '断点恢复' : '采集运行' }
function errorText(error, fallback) { const raw = error?.message || error?.reason || (typeof error === 'string' ? error : ''); const match = String(raw).match(/\{\"code\":\"[^\"]+\",\"message\":\"[^\"]*\",\"context\":\"[^\"]+\"\}/); if (match) { try { return JSON.parse(match[0]).message || fallback } catch { /* cleaned below */ } } return String(raw || fallback).replace(/^Error invoking remote method '[^']+': Error: /, '') || fallback }
function asArray(value) { return Array.isArray(value) ? value : [] }
function snapshotPathFor(row) { return row?.snapshotPath || row?.latestSnapshotPath || row?.snapshot?.path || row?.latestSnapshot?.path || row?.evidence?.snapshotPath || '' }
function boundaryLabel(row) { if (isPlatformBoundary(row)) return '已到读取边界'; if (row?.boundaryReached || row?.pageBoundary) return '页面已报告边界'; if (row?.boundaryReason) return '有边界证据'; return '未判定边界' }
function itemStatusLabel(value) { return ({ active: '在售', sold: '已售', unknown: '未知', unavailable: '不可用' })[value] || value || '—' }
function prettyEvidence(value) { if (!value) return '暂无证据'; try { return JSON.stringify(value, null, 2) } catch { return String(value) } }
function safeGoofishUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    if (parsed.protocol !== 'https:' || !['goofish.com', 'www.goofish.com'].includes(parsed.hostname.toLowerCase()) || parsed.port) return ''
    for (const key of parsed.searchParams.keys()) if (/(token|secret|password|passwd|authorization|auth|session|cookie|api[_-]?key|access[_-]?key)/i.test(key)) return ''
    return parsed.toString()
  } catch { return '' }
}
function categoryLabel(row) { return String(row?.category || '').trim() || '未分类' }
function itemCategoryLabel(row) { return String(row?.category || '').trim() || '未分类' }
function itemUrl(row) { return row?.url || row?.itemUrl || row?.source || '' }

async function loadSummary() { const requestId = ++summaryRequestId; summaryLoading.value = true; try { const result = await window.erp.getSellerSummary(); if (requestId !== summaryRequestId || disposed) return; Object.assign(summary, result, { groupCounts: result?.groupCounts || {} }); summaryError.value = '' } catch (error) { if (requestId === summaryRequestId && !disposed) summaryError.value = errorText(error, '无法读取卖家统计') } finally { if (requestId === summaryRequestId && !disposed) summaryLoading.value = false } }
async function loadQueue() { const requestId = ++queueRequestId; queueLoading.value = true; try { const filter = { dimension: selection.dimension, page: page.value, pageSize, q: appliedQuery.value }; if (selection.dimension === 'status') filter.status = selection.status; else filter.group = selection.group; const result = await window.erp.querySellerQueues(filter); if (requestId !== queueRequestId || disposed) return; queueRows.value = result.items || []; queueTotal.value = Number(result.total) || 0; queueError.value = '' } catch (error) { if (requestId === queueRequestId && !disposed) queueError.value = errorText(error, '无法读取当前队列') } finally { if (requestId === queueRequestId && !disposed) queueLoading.value = false } }
async function loadRuns() { const requestId = ++historyRequestId; historyLoading.value = true; try { const result = await window.erp.querySellerRuns({ page: 1, pageSize: 20, q: '' }); if (requestId !== historyRequestId || disposed) return; runs.value = result.items || []; historyError.value = '' } catch (error) { if (requestId === historyRequestId && !disposed) historyError.value = errorText(error, '无法读取运行历史') } finally { if (requestId === historyRequestId && !disposed) historyLoading.value = false } }
function millisecondsToSeconds(value) { return Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, Math.round((Number(value) || MIN_INTERVAL_SECONDS * 1000) / 1000))) }
function secondsToMilliseconds(value) { return Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, Math.round(Number(value) || MIN_INTERVAL_SECONDS))) * 1000 }
function applyIntervalSettings(value = {}) { settings.throttleMinSeconds = millisecondsToSeconds(value.throttleMinMs); settings.throttleMaxSeconds = Math.max(settings.throttleMinSeconds, millisecondsToSeconds(value.throttleMaxMs)) }
async function loadSettings() { const request = settingsRequests.begin(); settingsLoading.value = true; try { const [scheduleResult, settingResult, accountResult] = await Promise.all([window.erp.getSellerSchedule(), window.erp.getSellerSettings(), window.erp.getSellerAccountsStatus()]); if (!settingsRequests.canApply(request)) return; Object.assign(schedule, scheduleResult); applyIntervalSettings(settingResult); accounts.value = accountResult || [] } catch (error) { if (settingsRequests.canApply(request)) ElMessage.warning(errorText(error, '无法读取计划设置')) } finally { if (settingsRequests.isLatestRequest(request)) settingsLoading.value = false } }
async function refreshVisible() { const core = Promise.all([loadSummary(), loadQueue(), loadRuns()]); void loadSettings(); await core }
async function selectQueue(group) { selection.dimension = 'group'; selection.group = group; selection.status = null; page.value = 1; await loadQueue() }
async function selectStatus(status) { selection.dimension = 'status'; selection.status = status; selection.group = ''; page.value = 1; await loadQueue() }
function changePage(value) { page.value = value; void loadQueue() }
function applyQuery() { appliedQuery.value = query.value.trim(); page.value = 1; void loadQueue() }
async function exportQueue(mode = 'summary') {
  if (!partitionConsistent.value) return ElMessage.warning('队列统计不一致，请刷新后再导出')
  const detail = mode === 'detail'
  if (detail) exportingDetail.value = true
  else exporting.value = true
  try {
    const filter = { dimension: selection.dimension, q: appliedQuery.value, mode, detail }
    if (selection.dimension === 'status') filter.status = selection.status
    else filter.group = selection.group
    const result = await window.erp.sellerQueuesExport(filter)
    if (result.canceled) return
    if (!detail && Number(result.rowCount) !== Number(queueTotal.value)) return ElMessage.warning('导出行数与当前队列不一致，请先刷新后再试')
    const rowCount = Number(result.rowCount) || 0
    const itemCount = Number(result.itemCount)
    ElMessage.success(detail ? `已导出 ${result.sellerCount || queueTotal.value} 个卖家、${Number.isFinite(itemCount) ? itemCount : rowCount} 条商品明细` : `已导出 ${rowCount} 行卖家队列概览`)
  } catch (error) { ElMessage.error(errorText(error, '导出失败')) } finally { if (detail) exportingDetail.value = false; else exporting.value = false }
}
async function importFile() { importing.value = true; try { const result = await window.erp.importSellerFile(); if (result?.canceled) return; if (!result?.ok) return ElMessage.error(result?.reason || '导入失败'); ElMessage.success(`已新增 ${result.added || 0} 个卖家主页`); await refreshVisible() } catch (error) { ElMessage.error(errorText(error, '导入失败')) } finally { importing.value = false } }
async function start() { starting.value = true; try { const result = await window.erp.startSellerCrawl({ trigger: 'resume', sample: sample.value }); if (!result?.ok) return ElMessage.warning(result?.reason || '当前无法开始'); ElMessage.success('已继续未完成任务'); await loadSummary() } catch (error) { ElMessage.error(errorText(error, '无法开始卖家任务')) } finally { starting.value = false } }
async function pause() { pausing.value = true; try { const result = await window.erp.pauseSellerCrawl(); ElMessage.info(`已暂停 ${result?.paused || 0} 个卖家任务，断点保留在服务器`); await loadSummary() } catch (error) { ElMessage.error(errorText(error, '无法暂停卖家任务')) } finally { pausing.value = false } }
async function resume() { starting.value = true; try { const result = await window.erp.resumeSellerCrawl(); ElMessage.success(`已恢复 ${result?.resumed || 0} 个卖家任务`) ; await loadSummary() } catch (error) { ElMessage.error(errorText(error, '无法恢复卖家任务')) } finally { starting.value = false } }
async function stop() { stopping.value = true; try { await window.erp.stopSellerCrawl(); ElMessage.info('已请求安全停止；当前页面证据写入后保存断点') } catch (error) { ElMessage.error(errorText(error, '无法停止')) } finally { stopping.value = false } }
async function saveSchedule() { if (scheduleSaving.value) return; scheduleSaving.value = true; settingsRequests.mutate(); try { const result = await window.erp.setSellerSchedule({ weeklyEnabled: schedule.weeklyEnabled, weeklyDay: schedule.weeklyDay, weeklyTime: schedule.weeklyTime, timezone: 'Asia/Shanghai' }); settingsRequests.mutate(); if (!disposed) Object.assign(schedule, result); ElMessage.success('周计划已保存') } catch (error) { ElMessage.error(errorText(error, '周计划保存失败')); await loadSettings() } finally { scheduleSaving.value = false } }
async function saveIntervals() { if (intervalSaving.value) return; settings.throttleMinSeconds = Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, Math.round(Number(settings.throttleMinSeconds) || MIN_INTERVAL_SECONDS))); settings.throttleMaxSeconds = Math.max(settings.throttleMinSeconds, Math.min(MAX_INTERVAL_SECONDS, Math.round(Number(settings.throttleMaxSeconds) || settings.throttleMinSeconds))); intervalSaving.value = true; settingsRequests.mutate(); try { const result = await window.erp.setSellerSettings({ throttleMinMs: secondsToMilliseconds(settings.throttleMinSeconds), throttleMaxMs: secondsToMilliseconds(settings.throttleMaxSeconds) }); settingsRequests.mutate(); if (!disposed) applyIntervalSettings(result); ElMessage.success('安全间隔已保存') } catch (error) { ElMessage.error(errorText(error, '安全间隔保存失败')); await loadSettings() } finally { intervalSaving.value = false } }
async function openSellerDetail(row) {
  detailRow.value = row
  detailData.value = row
  detailTab.value = 'items'
  detailItemQuery.value = ''
  detailError.value = ''
  detailVisible.value = true
  detailLoading.value = true
  const getter = window.erp.getSellerQueueDetail || window.erp.getSellerDetail
  if (typeof getter !== 'function') {
    detailError.value = '当前版本尚未提供卖家详情 IPC；已显示队列中的基础证据。'
    detailLoading.value = false
    return
  }
  try {
    const result = await getter({ sellerId: row.sellerId, sourceId: row.id || row.sourceId || null, runId: row.runId || null })
    if (result?.ok === false) throw new Error(result.reason || '卖家详情读取失败')
    detailData.value = result?.detail || (result?.seller ? result : result || row)
  } catch (error) {
    detailError.value = errorText(error, '卖家详情读取失败；已显示队列中的基础证据。')
  } finally { detailLoading.value = false }
}

async function openSnapshot(row) {
  const path = snapshotPathFor(row)
  if (!path) return ElMessage.info('这条记录还没有保存页面快照')
  snapshotMeta.value = row || {}
  snapshotSrc.value = ''; snapshotUrl.value = ''; snapshotHtml.value = ''; snapshotVisible.value = true; snapshotLoading.value = true
  try {
    const getter = window.erp.getSellerSnapshot || window.erp.getTaskSnapshot
    if (typeof getter !== 'function') throw new Error('当前版本未提供快照读取 IPC')
    const result = await getter(path)
    if (!result?.ok) throw new Error(result?.reason || '快照读取失败')
    snapshotMeta.value = { ...snapshotMeta.value, ...result }
    if (result.kind === 'html') snapshotUrl.value = result.url || ''
    else if (result.kind === 'html-srcdoc') snapshotHtml.value = result.html || ''
    else snapshotSrc.value = result.dataUrl || ''
    if (!snapshotUrl.value && !snapshotHtml.value && !snapshotSrc.value) throw new Error('快照内容为空')
  } catch (error) { snapshotVisible.value = false; ElMessage.warning(errorText(error, '快照读取失败')) } finally { snapshotLoading.value = false }
}

async function showRun(run) {
  if (!run.runId) return ElMessage.info('该计划记录没有独立运行编号')
  runDetail.value = null; runDetailError.value = ''; runDetailVisible.value = true; runDetailLoading.value = true
  try {
    const result = await window.erp.getSellerRun(run.runId)
    runDetail.value = result?.detail || result || run
    if (result?.ok === false) throw new Error(result.reason || '运行证据读取失败')
  } catch (error) { runDetailError.value = errorText(error, '运行证据读取失败'); runDetail.value = run } finally { runDetailLoading.value = false }
}

function queueEventRefresh(type) {
  const summaryTypes = ['seller-start', 'seller-progress', 'seller-counters', 'seller-result', 'seller-account-safety', 'seller-account-blocked', 'seller-risk-control', 'seller-done', 'seller-error', 'seller-weekly-trigger']
  const queueTypes = ['seller-result', 'seller-done', 'seller-error', 'seller-account-safety', 'seller-account-blocked', 'seller-risk-control']
  const runTypes = ['seller-done', 'seller-error', 'seller-weekly-trigger']
  if (!summaryTypes.includes(type)) return
  eventRefreshSummaryDirty = true
  if (queueTypes.includes(type)) eventRefreshQueueDirty = true
  if (runTypes.includes(type)) eventRefreshRunsDirty = true
  if (eventRefreshTimer) window.clearTimeout(eventRefreshTimer)
  eventRefreshTimer = window.setTimeout(() => {
    eventRefreshTimer = null
    const refreshSummary = eventRefreshSummaryDirty
    const refreshQueue = eventRefreshQueueDirty
    const refreshRuns = eventRefreshRunsDirty
    eventRefreshSummaryDirty = false
    eventRefreshQueueDirty = false
    eventRefreshRunsDirty = false
    if (refreshSummary) void loadSummary()
    if (refreshQueue) void loadQueue()
    if (refreshRuns) void loadRuns()
  }, type === 'seller-progress' ? 250 : 50)
}
onMounted(async () => { timer = window.setInterval(() => { nowMs.value = Date.now() }, 1000); off = window.erp.onSellerEvent(({ type }) => queueEventRefresh(type)); await refreshVisible() })
onUnmounted(() => { disposed = true; summaryRequestId += 1; queueRequestId += 1; historyRequestId += 1; settingsRequests.dispose(); if (off) off(); if (timer) window.clearInterval(timer); if (eventRefreshTimer) window.clearTimeout(eventRefreshTimer); eventRefreshSummaryDirty = false; eventRefreshQueueDirty = false; eventRefreshRunsDirty = false })
</script>

<style scoped>
.seller-page { --workbench-canvas: #f6f9f7; --workbench-surface: #fff; --workbench-ink: #21352b; --workbench-muted: #6f7f77; --workbench-line: rgba(39, 76, 57, .13); --workbench-accent: #2f7e55; min-width: 0; padding: 16px; color: var(--workbench-ink); background: var(--workbench-canvas); font-size: 13px; -webkit-font-smoothing: antialiased; }
.domain-badge { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; color: var(--workbench-muted); font-size: 11px; }
.page-head, .section-head, .head-actions, .queue-actions, .idle-strip, .interval-row, .account-list { display: flex; align-items: center; }.page-head { justify-content: space-between; gap: 24px; margin-bottom: 16px; }.page-head h1 { margin: 2px 0 4px; font-size: 24px; line-height: 1.2; letter-spacing: -.02em; }.page-head p, .section-head p { margin: 0; color: var(--workbench-muted); line-height: 1.5; text-wrap: pretty; }.eyebrow { color: var(--workbench-accent); font-size: 10px; font-weight: 700; letter-spacing: .12em; }.head-actions { justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.evidence-panel, .run-panel, .queue-panel { margin-bottom: 16px; padding: 16px; border: 1px solid var(--workbench-line); border-radius: 10px; background: var(--workbench-surface); }.section-head { justify-content: space-between; gap: 16px; }.section-head h2 { margin: 0 0 2px; font-size: 16px; line-height: 1.3; }.summary-skeleton { width: 220px; }.local-alert { margin: 0 0 12px; }
.group-track { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }.group-card { min-height: 92px; padding: 12px 14px; text-align: left; color: var(--workbench-ink); border: 1px solid var(--workbench-line); border-radius: 8px; background: #fbfdfc; cursor: pointer; transition: transform 140ms cubic-bezier(.23,1,.32,1), border-color 140ms, background-color 140ms; }.group-card:hover { border-color: rgba(47,126,85,.4); }.group-card:active { transform: scale(.98); }.group-card.selected { border-color: var(--workbench-accent); background: #f0f7f3; box-shadow: inset 3px 0 0 var(--workbench-accent); }.group-card span, .group-card small { display: block; }.group-card strong { display: block; margin: 2px 0 5px; font-size: 28px; line-height: 1; font-variant-numeric: tabular-nums; }.group-card small { color: var(--workbench-muted); line-height: 1.4; }.status-track { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; margin-top: 10px; }.status-card { min-height: 64px; padding: 8px 10px; text-align: left; color: var(--workbench-ink); border: 1px solid rgba(39, 76, 57, .1); border-radius: 7px; background: #fff; cursor: pointer; }.status-card:hover { border-color: rgba(47,126,85,.35); }.status-card.selected { border-color: var(--workbench-accent); background: #f0f7f3; box-shadow: inset 2px 0 0 var(--workbench-accent); }.status-card span, .status-card small { display: block; }.status-card strong { display: inline-block; margin-left: 5px; font-size: 17px; line-height: 1; font-variant-numeric: tabular-nums; }.status-card small { margin-top: 4px; overflow: hidden; color: var(--workbench-muted); text-overflow: ellipsis; white-space: nowrap; }
.consistency-alert { margin-top: 10px; }
.run-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }.run-grid > div { min-width: 0; padding: 10px; border-radius: 7px; background: #f7faf8; }.run-grid span, .run-grid b { display: block; }.run-grid span { color: var(--workbench-muted); font-size: 11px; }.run-grid b { margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-variant-numeric: tabular-nums; }.run-account-stats { grid-column: 1 / -1; }.run-account-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }.run-account-pill { display: inline-flex; align-items: baseline; gap: 4px; padding: 5px 8px; border-radius: 999px; font-size: 11px; line-height: 1.35; }.run-account-pill--active { color: #276d4c; background: #eaf6ee; }.run-account-pill--blocked { color: #8b5d1c; background: #fff6df; }.run-account-pill small { display: inline; color: inherit; font-size: 10px; }.run-reason { grid-column: 1 / -1; margin: 0; color: #556b7a; font-size: 11px; }.idle-strip { justify-content: space-between; gap: 16px; margin-top: 12px; padding: 10px 12px; border-radius: 7px; background: #f7faf8; color: var(--workbench-muted); }.sample-select { width: 210px; }
.queue-heading { align-items: flex-start; }.queue-actions { gap: 8px; width: min(760px, 70%); }.queue-actions :deep(.el-input) { min-width: 180px; }.queue-table { width: 100%; margin-top: 12px; }.queue-table :deep(.el-table__row) { height: 48px; }.seller-link, .seller-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.seller-link { color: var(--workbench-accent); text-decoration: none; }.seller-link:hover { text-decoration: underline; }.queue-table small { display: block; overflow: hidden; color: var(--workbench-muted); text-overflow: ellipsis; white-space: nowrap; }.source-context { display: flex; flex-wrap: wrap; gap: 3px 8px; overflow: hidden; color: var(--workbench-ink); font-weight: 600; line-height: 1.35; }.source-context span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.metadata-missing { color: #b88634; }.reason { display: -webkit-box; overflow: hidden; line-height: 1.35; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }.snapshot-muted { color: #a8b2ac; font-size: 12px; }.item-link, .item-source-link { color: var(--workbench-accent); text-decoration: none; }.item-link { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.item-link:hover, .item-source-link:hover { text-decoration: underline; }.item-category { max-width: 118px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.pager { display: flex; justify-content: flex-end; margin-top: 12px; }.first-empty, .small-empty { padding: 24px 16px; text-align: center; color: var(--workbench-muted); }.first-empty h3 { margin: 0 0 4px; color: var(--workbench-ink); }.first-empty p { margin: 0 0 12px; }
.detail-content { min-height: 680px; }.detail-hero { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; padding: 4px 0 16px; border-bottom: 1px solid var(--workbench-line); }.detail-kicker { color: var(--workbench-accent); font-size: 10px; font-weight: 700; letter-spacing: .12em; }.detail-hero h2 { margin: 4px 0 5px; font-size: 22px; }.detail-hero p { margin: 0; color: var(--workbench-muted); }.detail-hero p a { color: var(--workbench-accent); }.detail-hero-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }.detail-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin: 14px 0 10px; }.detail-kpis > div, .evidence-detail-card { min-width: 0; padding: 11px; border-radius: 8px; background: #f7faf8; }.detail-kpis span, .detail-kpis b, .evidence-detail-card span, .evidence-detail-card strong, .evidence-detail-card small { display: block; }.detail-kpis span, .evidence-detail-card span { color: var(--workbench-muted); font-size: 11px; }.detail-kpis b { margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }.detail-context { display: flex; flex-wrap: wrap; gap: 7px; color: var(--workbench-muted); font-size: 11px; }.detail-context span { padding: 4px 8px; border-radius: 999px; background: #eef3f0; }.detail-tabs { margin-top: 16px; }.detail-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 10px; }.detail-toolbar :deep(.el-input) { width: 260px; }.item-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.detail-section-title { margin: 16px 0 8px; color: var(--workbench-ink); font-size: 13px; font-weight: 700; }.evidence-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }.evidence-detail-card strong { margin: 5px 0 3px; color: var(--workbench-ink); line-height: 1.45; }.evidence-detail-card small { overflow: hidden; color: var(--workbench-muted); text-overflow: ellipsis; white-space: nowrap; }.evidence-json { max-height: 260px; margin: 0; padding: 12px; overflow: auto; border: 1px solid var(--workbench-line); border-radius: 8px; background: #f7faf8; color: #4f655a; font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }.snapshot-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 96px; margin-bottom: 14px; padding: 14px; border: 1px solid var(--workbench-line); border-radius: 8px; background: #f7faf8; }.snapshot-card strong, .snapshot-card p { display: block; }.snapshot-card p { margin: 5px 0 0; color: var(--workbench-muted); font-size: 12px; }.snapshot-meta { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 12px; color: #718078; font-size: 12px; }.snapshot-wrap { min-height: 360px; padding: 10px; overflow: auto; border: 1px solid #e4ebe6; border-radius: 10px; background: #f7faf8; }.snapshot-html-shell { width: max-content; min-width: 100%; }.snapshot-html-note { margin-bottom: 8px; color: #8b9991; font-size: 11px; }.snapshot-html-frame { display: block; border: 1px solid #dce6df; border-radius: 6px; background: #fff; box-shadow: 0 8px 24px rgba(37, 71, 53, .08); }.snapshot-image { display: block; max-width: 100%; height: auto; margin: 0 auto; border: 1px solid #dce6df; border-radius: 6px; box-shadow: 0 8px 24px rgba(37, 71, 53, .08); }
.run-row small { margin-top: 2px; color: var(--workbench-muted); }.run-detail-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }.run-detail-kpis > div { min-width: 0; padding: 10px; border-radius: 7px; background: #f7faf8; }.run-detail-kpis span, .run-detail-kpis b { display: block; }.run-detail-kpis span { color: var(--workbench-muted); font-size: 11px; }.run-detail-kpis b { margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.run-detail-content :deep(.el-table small) { display: block; color: var(--workbench-muted); }.run-raw-collapse { margin-top: 12px; }
.history-settings { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(320px, .8fr); gap: 16px; }.history-card, .settings-card { border: 1px solid var(--workbench-line); border-radius: 10px; background: #fff; }.history-card :deep(.el-card__header) { padding: 14px 16px; }.history-card :deep(.el-card__body) { padding: 0 16px 12px; }.run-row { display: grid; grid-template-columns: 1.4fr 1fr .7fr; align-items: center; width: 100%; min-height: 48px; padding: 8px 0; text-align: left; color: var(--workbench-ink); border: 0; border-bottom: 1px solid var(--workbench-line); background: transparent; cursor: pointer; }.run-row:hover { background: #f8fbf9; }.run-row b, .run-row small { display: block; }.run-row small { margin-top: 2px; color: var(--workbench-muted); }.settings-card { padding: 0 16px; }.settings-card :deep(.el-collapse-item__header) { min-height: 52px; font-weight: 650; }.schedule-copy, .schedule-evidence { color: var(--workbench-muted); line-height: 1.5; }.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 12px; }.interval-row { gap: 6px; }.interval-row :deep(.el-input-number) { width: 132px; }.account-list { flex-wrap: wrap; gap: 6px; margin: 10px 0 4px; }.account-pill { padding: 5px 8px; border-radius: 999px; background: #eef3f0; color: #556b7a; font-size: 11px; }
.rules-markdown { max-height: 58vh; margin: 0; overflow: auto; white-space: pre-wrap; color: var(--workbench-ink); font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; }
:deep(.el-button), :deep(.el-input__wrapper), :deep(.el-select__wrapper) { min-height: 40px; }:deep(button:focus-visible), .group-card:focus-visible, .run-row:focus-visible, .seller-link:focus-visible, .item-link:focus-visible, .item-source-link:focus-visible { outline: 3px solid rgba(47,126,85,.28); outline-offset: 2px; }
@media (max-width: 1120px) { .group-track { grid-template-columns: repeat(2, minmax(0, 1fr)); }.status-track { grid-template-columns: repeat(3, minmax(0, 1fr)); }.run-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }.queue-heading { display: block; }.queue-actions { width: 100%; margin-top: 10px; }.history-settings { grid-template-columns: 1fr; }.detail-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 760px) { .page-head { display: block; }.head-actions { justify-content: flex-start; margin-top: 12px; }.group-track, .status-track { grid-template-columns: 1fr; }.run-grid { grid-template-columns: 1fr 1fr; }.queue-actions { flex-wrap: wrap; }.settings-grid { grid-template-columns: 1fr; }.detail-hero, .detail-toolbar, .snapshot-card { display: block; }.detail-hero-actions, .detail-toolbar :deep(.el-input), .snapshot-card .el-button { margin-top: 10px; }.detail-toolbar :deep(.el-input) { width: 100%; }.detail-kpis, .run-detail-kpis, .evidence-detail-grid { grid-template-columns: 1fr 1fr; } }
@media (prefers-reduced-motion: reduce) { .group-card { transition: none; } }
</style>
