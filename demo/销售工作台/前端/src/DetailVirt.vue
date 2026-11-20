<template>
  <div class="dpage">
    <div class="dbar">
      <button class="btn" @click="$emit('back')"><Icon name="back" />返回</button>
      <span class="crumb">{{ p ? p.path.join(' › ') : '' }}</span><span style="margin-left: auto; display: flex; gap: 8px"><button class="btn pri" @click="goVirtNew">+ 新增虚拟商品</button><button class="btn" @click="openHelp(p?.kind === 'svc' ? 'service' : 'virtstock')"><Icon name="help" />怎么用</button><button class="btn" @click="openHelp('stages')">产品卡 8 步</button></span>
    </div>
    <p v-if="err" class="errbox">{{ err }}</p>
    <div v-else-if="!p" class="muted" style="padding: 80px 0; text-align: center">读取中…</div>

    <template v-else>
      <!-- ===== 顶部：这张产品卡现在怎么样 ===== -->
      <section class="hero" :class="{ zoom }">
        <div class="pic">
          <div class="big" :class="lvl" title="点一下放大/缩小" @click="zoom = !zoom"><img :src="`/api/demo-img/V-${p.cover}.jpg`" alt="" /></div>
        </div>
        <div class="info">
          <div class="row1">
            <span class="badge-l" :class="lvl">{{ LV[lvl].icon }} {{ LV[lvl].text }}</span>
            <span class="tag dark">{{ p.kind === 'svc' ? '服务' : '虚拟商品' }}</span>
            <span class="tag acc">{{ p.listing_type === 'follow' ? '跟卖型' : '路测型' }}</span>
            <span class="tag">{{ p.delivery_label }}</span>
            <span class="tag" :class="LAW[p.compliance.lawyer].cls">律师：{{ LAW[p.compliance.lawyer].t }}</span>
          </div>
          <h1>{{ p.name }}</h1>
          <p class="codes">{{ p.code }}　{{ p.face }}　{{ p.platforms.join(' / ') }}　{{ p.region }}　有效期：{{ p.valid }}　负责人 {{ p.owner }}</p>

          <div class="issuebox" :class="lvl">
            <div class="t">{{ issues.length ? `现在有 ${issues.length} 件事要看` : '这张产品卡没有要处理的事' }}<Q k="v-issues" /></div>
            <ul v-if="issues.length"><li v-for="(it, i) in issues" :key="i"><i class="dot" :class="it.lvl"></i><span>{{ it.text }}</span><a v-if="it.go" @click="jump(it.go)">去看 ›</a></li></ul>
            <p v-else class="okline">库存、发货检查、退款率、价格、成熟度都正常。</p>
          </div>

          <div class="facts">
            <div><span>售价</span><b>{{ p.price ? '¥' + money(p.price) : '待定' }}</b><small>进价 ¥{{ money(p.cost) }} · 底线 {{ p.floor_pct }}%</small> <button class="btn sm" @click="togglePr(p)">调价/改成本</button></div>
            <div><span>单笔毛利</span><b>{{ p.price ? '¥' + profit(p) : '—' }}</b><small>已扣平台费和售后预留</small></div>
            <div v-if="prOpen" style="grid-column:1/-1;background:var(--soft);padding:10px;border-radius:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
              <label style="font-size:12px;display:grid;gap:3px">售价(¥)<input type="number" v-model.number="prForm.price" style="width:90px;height:32px;border:1px solid var(--line);border-radius:8px;padding:0 6px" /></label>
              <label style="font-size:12px;display:grid;gap:3px">进价(¥)<input type="number" v-model.number="prForm.cost" style="width:90px;height:32px;border:1px solid var(--line);border-radius:8px;padding:0 6px" /></label>
              <label style="font-size:12px;display:grid;gap:3px">底线(%)<input type="number" v-model.number="prForm.floor_pct" style="width:76px;height:32px;border:1px solid var(--line);border-radius:8px;padding:0 6px" /></label>
              <label v-if="prForm.cost && prForm.price < prForm.cost * prForm.floor_pct / 100" style="font-size:12px;display:grid;gap:3px;color:var(--red-ink)">低于底线原因<input type="text" v-model="prForm.override_reason" placeholder="必填原因(>=3字)" style="width:160px;height:32px;border:1px solid var(--red);border-radius:8px;padding:0 6px" /></label>
              <button class="btn pri sm" @click="saveVirtPricing(p)">确认直接生效</button>
            </div>
            <div><span>{{ p.stock ? '库存' : p.capacity ? '本周产能' : '交付' }}</span><b>{{ p.stock ? p.stock.avail + ' 张' : p.capacity ? p.capacity.booked + '/' + p.capacity.week_limit : '实时' }}</b><small>{{ p.stock ? '提醒线 ' + p.stock.warn_at + ' 张' : '' }}</small></div>
            <div><span>本周销量</span><b>{{ p.week_sales }} 单</b><small>退款率 {{ (p.refund_rate * 100).toFixed(1) }}%</small></div>
          </div>
        </div>
      </section>

      <Fold v-model="extrasOpen" title="经营验收 · 交付条件 · 复盘" help="pe-stages">
        <template #chips><span class="chip">五阶段提交/验收</span><span class="chip">票券交付条件</span><span class="chip">复盘与机会池</span><span class="chip">程序化交付</span></template>
        <ProductExtras :p="p" />
      </Fold>

      <Fold v-model="more" data-tour="dt-fold" title="更多详情" help="p-more">
        <template #chips>
          <span class="chip" :class="stockLvl">{{ p.stock ? '库存 ' + p.stock.avail + ' 张' : p.capacity ? '本周产能 ' + p.capacity.booked + '/' + p.capacity.week_limit : '实时交付' }}</span>
          <span class="chip" :class="p.refund_rate >= 0.1 ? 'red' : p.refund_rate >= 0.05 ? 'amb' : ''">退款率 {{ (p.refund_rate * 100).toFixed(1) }}%</span>
          <span class="chip" :class="LAW[p.compliance.lawyer].cls">律师：{{ LAW[p.compliance.lawyer].t }}</span>
          <span v-if="p.decision" class="chip">本周结论：{{ p.decision }}</span>
        </template>
        <div class="secs">

        <!-- ===== 卡券库存 / 产能 ===== -->
        <section id="stock" class="card">
          <h3>{{ p.stock ? '卡券库存与台账' : p.delivery === 'topup' ? '代充货源' : '产能与交付' }}<Q :k="p.stock ? 'v-stock' : 'svc-queue'" /> <small v-if="p.stock">有卡券：卖一张少一张，每单发不同的码</small></h3>
          <template v-if="p.stock">
            <div v-if="p.stock.avail <= p.stock.stop_at && p.step >= 8" class="banner red">卡券用完，已自动暂停上架；补货后恢复。</div>
            <div v-else-if="p.stock.avail <= p.stock.warn_at && p.step >= 8" class="banner amb">低于提醒线 {{ p.stock.warn_at }} 张，快补货。</div>
            <div class="bar" style="height: 18px; margin: 12px 0 8px">
              <i :style="{ width: seg(p.stock.avail) + '%', background: 'var(--grn)' }"></i><i :style="{ width: seg(p.stock.locked) + '%', background: 'var(--amb)' }"></i>
              <i :style="{ width: seg(p.stock.sold) + '%', background: 'var(--acc)' }"></i><i :style="{ width: seg(p.stock.void) + '%', background: 'var(--red)' }"></i>
            </div>
            <p class="legend"><i class="dot grn"></i>可用 {{ p.stock.avail }}　<i class="dot amb"></i>占用 {{ p.stock.locked }}　<i class="dot" style="background: var(--acc)"></i>已售 {{ p.stock.sold }}　<i class="dot red"></i>作废 {{ p.stock.void }}</p>
            <p v-if="p.stock.last_dedup" class="muted" style="margin-top: 6px; font-size: 13px">最近一次机器洗重入库：粘贴 {{ p.stock.last_dedup.raw_lines }} 行 → 过滤空行/重复 {{ p.stock.last_dedup.empty_removed + p.stock.last_dedup.duplicates_removed }} 条 → 净入库 <b>{{ p.stock.last_dedup.net_imported }}</b> 张</p>
            <div class="restock"><input v-model.number="rs.n" type="number" min="1" /><input v-model="rs.supplier" placeholder="供应商（可不填）" /><button class="btn pri" @click="restock">补货入库</button></div>
            <div class="tblwrap"><table class="tbl" style="margin-top: 12px"><tr><th>批次</th><th>来源</th><th>进价</th><th>入库</th><th>剩余</th><th>有效期至</th></tr>
              <tr v-for="b in p.stock.batches" :key="b.id"><td>{{ b.id }}<br /><span class="muted">{{ b.date }}</span></td><td>{{ b.supplier }}</td><td class="num">¥{{ b.cost }}</td><td class="num">{{ b.qty }}</td><td class="num"><b>{{ b.left }}</b></td><td>{{ b.expire }}</td></tr></table></div>
          </template>
          <template v-else-if="p.delivery === 'nocard'">
            <dl class="kv"><dt>交付形态</dt><dd>无卡密·固定内容（所有买家自动发送同一份网盘链接/口令，无限循环）</dd><dt>自动发内容</dt><dd><code>{{ p.fixed_payload || '已配置固定网盘链接载荷' }}</code></dd></dl>
          </template>
          <template v-else-if="p.delivery === 'topup'">
            <dl class="kv"><dt>货源</dt><dd>{{ p.topup_cfg?.upstream || p.sourcing.main }}</dd><dt>备用</dt><dd>{{ p.sourcing.backup }}</dd><dt>买家必填提示</dt><dd>{{ p.topup_cfg?.buyer_prompt || '买家提供充值账号，严禁索要密码与验证码' }}</dd><dt>下单方式</dt><dd>来一单向货源下一单，不囤货；货源失败或涨价超 {{ p.topup_cfg?.price_hike_stop_pct || 5 }}% 跳红并暂停上架</dd><dt>进价</dt><dd>¥{{ p.cost }}</dd></dl>
          </template>
          <template v-else>
            <template v-if="p.capacity">
              <div class="bar" style="height: 16px; margin: 4px 0 8px"><i :style="{ width: (p.capacity.booked / p.capacity.week_limit) * 100 + '%', background: p.capacity.booked / p.capacity.week_limit >= 0.9 ? 'var(--amb)' : 'var(--grn)' }"></i></div>
              <p class="legend">本周已排 <b>{{ p.capacity.booked }}</b> / 上限 {{ p.capacity.week_limit }} 单</p>
              <ol class="flow4"><li>接单</li><li>约时间</li><li>交付</li><li>买家确认完成</li></ol>
              <div class="tblwrap"><table class="tbl"><tr><th>买家</th><th>时间 / 时效</th><th>进度</th><th>下一步</th></tr>
                <tr v-for="q in p.capacity.queue" :key="q.id" :class="{ hit: ['new', 'accepted'].includes(q.state) && q.due_min <= 10 }">
                  <td>{{ q.buyer }}</td><td>{{ q.slot }}<br /><span class="muted">一小时时效：还剩 {{ q.due_min }} 分钟</span></td><td><span class="tag acc">{{ QS[q.state] }}</span></td>
                  <td><template v-if="NEXT[q.state]"><Lock :ok="!locked" reason="先做完练习" @go="svc(q, NEXT[q.state][0])">{{ NEXT[q.state][1] }}</Lock> <button v-if="!['delivered', 'done', 'handoff'].includes(q.state)" class="btn sm" @click="svc(q, 'handoff')">转给同行</button></template><span v-else class="muted">{{ q.state === 'done' ? '已完成' : '已转同行' }}</span></td></tr>
                <tr v-if="!p.capacity.queue.length"><td colspan="4" class="muted">现在没有进行中的服务订单</td></tr></table></div>
            </template>
            <dl v-if="p.points" class="kv" style="margin-top: 14px"><dt>协议版本</dt><dd>{{ p.points.agreement }}</dd><dt>参与账号</dt><dd>{{ p.points.accounts }} 个</dd><dt>月积分产出</dt><dd>{{ p.points.monthly.toLocaleString() }} 分</dd><dt>兑换比例</dt><dd>{{ p.points.ratio }}</dd><dt>退出规则</dt><dd>{{ p.points.exit_rule }}</dd></dl>
            <p v-if="p.delivery === 'selfserve'" class="muted" style="margin-top: 10px">程序自助：买家拿到「预约码」，自己进预约页面填信息（预约页待程序员开发）。</p>
          </template>
        </section>


        <!-- ===== 算账与提成 ===== -->
        <section id="money" class="card">
          <h3>算账与提成<Q k="v-money" /> <small>单笔贡献 = 售价 − 进价 − 平台费 − 售后预留</small></h3>
          <dl class="kv">
            <dt>售价</dt><dd class="num">¥{{ p.price }}</dd><dt>进价</dt><dd class="num">− ¥{{ p.cost }}</dd>
            <dt>平台费</dt><dd class="num">− ¥{{ (p.price * p.platform_fee_rate).toFixed(2) }}（{{ (p.platform_fee_rate * 100).toFixed(1) }}%）</dd><dt>售后预留</dt><dd class="num">− ¥{{ p.after_sale_reserve }}</dd>
            <dt><b>单笔毛利</b></dt><dd class="num"><b>¥{{ profit(p) }}</b></dd>
          </dl>
          <div class="gauge" style="margin-top: 22px">
            <div class="track"><div class="z red" :style="{ left: 0, width: fz + '%' }"></div><div class="z grn" :style="{ left: fz + '%', width: (95.57 - fz) + '%' }"></div><div class="z amb" style="left: 95.57%; width: 4.43%"></div>
              <div class="pt" :class="pl" :style="{ left: gx(pct) + '%' }">{{ pct }}</div></div>
            <div class="ticks"><span style="left: 0">进价 100%</span><span :style="{ left: fz + '%' }">{{ p.floor_pct }}% 底线</span><span style="left: 95.57%">500%</span></div>
          </div>
          <p class="muted" style="margin-bottom: 10px">售价是进价的 {{ pct }}%：{{ pl === 'red' ? '低于 ' + p.floor_pct + '% 底线，要报预警（默认 130%；码券类利润薄，先按 105%，待负责人确认）' : pl === 'amb' ? '高于 500%，可以发，请确认没输错' : '在正常范围' }}</p>
          <h4 style="margin: 16px 0 8px">提成怎么分（负责人已拍板）</h4>
          <div class="tblwrap"><table class="tbl"><tr><th>谁</th><th>怎么算</th><th>这张卡</th></tr>
            <tr><td>交付人</td><td>成交提成 {{ rate * 100 }}%（{{ p.kind === 'svc' ? '服务类' : '码券类' }}）</td><td class="num"><b>¥{{ (profit(p) * rate).toFixed(2) }} / 单</b></td></tr>
            <tr><td>建卡人</td><td>上架后 6 个月内，毛利的 5%</td><td class="num"><b>¥{{ (profit(p) * 0.05).toFixed(2) }} / 单</b></td></tr>
            <tr><td>上新奖</td><td>{{ p.listing_type === 'follow' ? '跟卖型：上架后 30 天内出首单' : '路测型：实测复现通过发一半，首单再发一半' }}</td><td class="num"><b>¥{{ p.listing_type === 'follow' ? 20 : 200 }}</b></td></tr></table></div>
          <p class="muted" style="margin-top: 8px">本周 {{ p.week_sales }} 单 → 交付人合计约 ¥{{ (p.week_sales * profit(p) * rate).toFixed(0) }}，建卡人约 ¥{{ (p.week_sales * profit(p) * 0.05).toFixed(0) }}。退款、纠纷会扣回该单提成。</p>
        </section>

        <!-- ===== 需求信号 ===== -->
        <section id="signals" class="card wide">
          <h3>需求信号<Q k="v-signals" /> <small>来源口径：{{ p.source_tag }}；闲鱼 / 淘宝 / 京东三个榜，各带日期</small></h3>
          <div class="sigs">
            <div v-for="(v, k) in p.signals" :key="k" class="sig">
              <b>{{ k }}</b>
              <template v-if="v.sales"><p class="sn2">{{ v.sales.toLocaleString() }}<small> 销量</small></p><p>价格带 ¥{{ v.price_lo }}–{{ v.price_hi }}</p><p>卖家 {{ v.sellers }} 个 · 榜内第 {{ v.rank }}</p><p class="muted">截图日期 {{ v.date }}</p></template>
              <p v-else class="muted" style="margin-top: 8px">无（这个平台没有这类商品）</p>
            </div>
          </div>
          <h4 style="margin: 20px 0 8px">同行在售（{{ p.listing_type === 'follow' ? '跟卖证据' : '没有同行链接，只能走路测' }}）</h4>
          <div v-if="p.peers.length" class="tblwrap"><table class="tbl"><tr><th>平台</th><th>店铺</th><th>价格</th><th>销量</th><th>链接</th></tr><tr v-for="x in p.peers" :key="x.url"><td>{{ x.platform }}</td><td>{{ x.shop }}</td><td class="num">¥{{ x.price }}</td><td class="num">{{ x.sales.toLocaleString() }}</td><td><a>查看链接</a></td></tr></table></div>
          <p v-else class="banner amb">没有填有效的同行在售链接，程序强制走路测通道（8 步全走）。</p>
        </section>

        <!-- ===== 取得路径 + 交付售后 ===== -->
        <section id="delivery" class="card wide">
          <h3>取得路径与售后<Q k="v-source" /></h3>
          <div class="two">
            <div><h4>取得路径</h4><dl class="kv" style="margin-top: 8px"><dt>主路径</dt><dd>{{ p.sourcing.main }}</dd><dt>备路径</dt><dd>{{ p.sourcing.backup }}</dd><dt>进价</dt><dd>¥{{ p.sourcing.cost }}</dd><dt>资格要求</dt><dd>{{ p.sourcing.qualify }}</dd><dt>额度频次</dt><dd>{{ p.sourcing.quota }}</dd></dl></div>
            <div><h4>交付与售后</h4><dl class="kv" style="margin-top: 8px"><dt>话术</dt><dd>{{ p.notes.script }}</dd><dt>使用指引</dt><dd>{{ p.notes.guide }}</dd><dt>退改规则</dt><dd>{{ p.notes.refund }}</dd><dt>停止条件</dt><dd>{{ p.notes.stop }}</dd></dl></div>
          </div>
        </section>

        <!-- ===== 合规与律师 ===== -->
        <section id="law" class="card">
          <h3>合规与律师审核<Q k="v-law" /> <small>全量做，合规由律师统一审核</small></h3>
          <p>合规等级 <span class="tag" :class="p.compliance.level === 'A' ? 'grn' : p.compliance.level === 'B' ? 'amb' : 'red'">{{ p.compliance.level }} 级</span></p>
          <ol class="law">
            <li :class="lawAt >= 0 ? 'on' : ''">未审</li><li :class="lawAt >= 1 ? 'on' : ''">审核中</li><li :class="lawAt >= 2 ? (p.compliance.lawyer === 'risk' ? 'risk' : 'on') : ''">已出意见</li>
          </ol>
          <p class="muted" style="margin-top: 12px">{{ p.compliance.note || '暂无备注。' }}</p>
        </section>

        <!-- ===== 周复盘 ===== -->
        <section id="review" class="card">
          <h3>周复盘<Q k="v-review" /> <small>继续 · 扩大 · 调整 · 暂停 · 退出</small></h3>
          <div v-if="p.review.length" class="tblwrap"><table class="tbl"><tr><th>周</th><th>销量</th><th>退款</th><th>成本变化</th></tr><tr v-for="r in p.review" :key="r.week"><td>{{ r.week }}</td><td class="num">{{ r.sales }}</td><td class="num">{{ r.refunds }}</td><td class="num">{{ r.cost_delta }}</td></tr></table></div>
          <p v-else class="muted">还没上架，没有复盘数据。</p>
          <p style="margin-top: 12px">本周结论：<span class="tag" :class="{ 调整: 'amb', 暂停: 'red' }[p.decision] || 'grn'">{{ p.decision }}</span></p>
        </section>
        </div>
      </Fold>

      <div class="secs">
        <!-- ===== 成熟度：8 步引导 ===== -->
        <ServiceFlow v-if="p.learn" :p="p" @changed="load" />
        <section v-else id="stages" class="card wide">
          <h3>成熟度 <small>{{ p.listing_type === 'follow' ? '跟卖型：同行已经在卖，第 5、6 步免做，首单就是实测' : '路测型：没有同行在卖，8 步全走，实测和复现都通过才能上架' }}</small></h3>
          <ol class="steps">
            <li v-for="s in p.steps" :key="s.n" :class="s.state"><i>{{ s.state === 'done' ? '✓' : s.state === 'skip' ? '–' : s.n }}</i><span>{{ s.title }}<Q :k="'v-' + s.n" /></span></li>
          </ol>
          <div v-if="cur" class="curstep">
            <div class="cs-l">
              <p class="muted">现在在第 {{ cur.n }} 步</p>
              <h4>{{ cur.title }}</h4>
              <dl class="kv" style="margin-top: 10px"><dt>要交什么</dt><dd>{{ cur.give }}</dd><dt>完成标准</dt><dd>{{ cur.done_when }}</dd></dl>
            </div>
            <div class="cs-r">
              <div v-if="p.step < 8" class="evf"><b>这一步要交的东西</b>
                <label v-for="f in EVID[p.step]" :key="f.k" class="f2">{{ f.k }}<input v-model="ev[f.k]" :placeholder="f.ph" /></label></div>
              <Lock v-if="p.step < 8" :ok="evOk.ok && !locked" :reason="locked ? '先做完练习' : evOk.why" @go="advance">{{ p.step === 7 ? '二审确认并直接上架' : '交上去，进入下一步' }}</Lock>
              <p class="muted" style="margin-top: 8px">必填、格式服务端同样校验；缺的写「待核」，不要空着，也不要填 0。</p>
            </div>
          </div>
          <p v-else class="muted">已经在售，每周做一次复盘。</p>
          <div v-if="(p.evidence_log || []).length" class="evlog"><b>已交的证据</b><div v-for="(e, i) in p.evidence_log" :key="i" class="el"><span class="tag">第 {{ e.step }} 步</span>{{ e.who }} · {{ e.t }}：{{ Object.entries(e.data).map(([k, v]) => k + '＝' + v).join('；') }}</div></div>
        </section>

        <!-- ===== 发货与检查 ===== -->
        <section id="orders" class="card wide">
          <h3>发货与检查<Q k="v-checks" /> <small>参考阿奇索的做法</small>
            <label class="sw"><input type="checkbox" :checked="p.auto_delivery" @change="toggleAuto($event.target.checked)" /><i></i>自动发货</label></h3>
          <div class="checks">
            <div v-if="p.shop_matrix?.shops?.length"><b>多号分发（闲管家）</b><span>{{ p.shop_matrix.shops.map((s) => s.label).join(' 、 ') }}（售出自动补库存重发：{{ p.shop_matrix.auto_relist ? '开' : '关' }}）</span><em class="tag grn">已绑</em></div>
            <div><b>退款累计</b><span>≥ {{ p.checks.refund_limit }} 次，暂停自动发</span><em class="tag grn">开</em></div>
            <div><b>黑名单</b><span>在名单里，暂停自动发</span><em class="tag grn">开</em></div>
            <div><b>上一单没确认收货</b><span>先不发新卡，防连拍多单再退{{ p.checks.max_per_buyer ? `（单买家日限 ${p.checks.max_per_buyer} 单）` : '' }}</span><em class="tag grn">开</em></div>
          </div>
          <div class="tblwrap"><table class="tbl" style="margin-top: 12px"><tr><th>订单</th><th>金额</th><th>付款</th><th>状态</th><th></th></tr>
            <tr v-for="o in p.orders" :key="o.id" :class="{ hit: o.status === 'held' && o.paid_ago_min >= 1, wait: o.status === 'waiting' }">
              <td>{{ o.id }}<br /><span class="muted">{{ o.buyer }}</span><template v-if="p.delivery === 'card' && o.status === 'delivered'"><br /><button class="link" @click="reveal(o)">{{ codes[o.id] ? codes[o.id] : '卡密 ●●●●●●  显示（留痕）' }}</button></template></td><td class="num">¥{{ o.amount }}</td><td class="num">{{ o.paid_ago_min }} 分钟前</td>
              <td><span class="tag" :class="o.status === 'delivered' ? 'grn' : 'red'">{{ ST[o.status] }}</span><template v-if="o.refund"> <span class="tag">已退款</span></template><br v-if="o.hit.length" /><span v-for="h in o.hit" :key="h" class="hitline">{{ h }}</span></td>
              <td><Lock v-if="o.status === 'held'" kind="ok" :ok="!locked" reason="先做完练习" penalty="放行前先确认买家上一单的状态；放行错了会扣当单提成（示意）" @go="release(o)">人工放行</Lock><button v-else-if="o.status === 'waiting'" class="btn sm" @click="jump('stock')">去补货</button></td></tr>
            <tr v-if="!p.orders.length"><td colspan="5" class="muted">还没有订单</td></tr></table></div>
          <h4 style="margin: 20px 0 8px">退款处理 <small class="muted">参考阿奇索：未发货的退款自动同意，已发货的转人工</small></h4>
          <label class="sw" style="margin: 0 0 6px"><input type="checkbox" :checked="p.auto_refund" @change="act('auto-refund', { on: $event.target.checked }, $event.target.checked ? '已打开：未发货退款自动同意，已发货转人工' : '已关闭：所有退款转人工')" /><i></i>未发货退款自动同意</label>
          <p class="muted" style="margin-bottom: 10px">已发货的退款一律转人工核实；确认退款后提成账本将自动扣回对应提成。</p>
          <h4 style="margin: 14px 0 8px">退款名单</h4>
          <div v-if="p.refund_list.length" class="tblwrap"><table class="tbl"><tr><th>买家</th><th>退款累计</th><th>加入方式</th><th>加入日期</th></tr><tr v-for="r in p.refund_list" :key="r.buyer"><td>{{ r.buyer }}</td><td class="num">{{ r.count }} 次</td><td><span class="tag">{{ r.source }}</span></td><td>{{ r.since }}</td></tr></table></div>
          <p v-else class="muted">名单是空的。退款累计到线的买家会自动进来。</p>
          <button class="btn sm" style="margin-top: 10px" @click="addRefund">手动加一个买家进名单</button>
        </section>
      </div>
    </template>
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<script setup>
import Q from './Q.vue'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import Icon from './Icon.vue'
import Lock from './Lock.vue'
import Fold from './Fold.vue'
import ServiceFlow from './ServiceFlow.vue'
import ProductExtras from './ProductExtras.vue'
import { openHelp, toast as toast2 } from './ui.js'
import { api, post } from './api.js'
import { LV, state, loadAll, money, profit, pctOfCost, virtIssues, worst } from './store.js'

const props = defineProps({ id: String })
defineEmits(['back'])
const p = ref(null)
const err = ref('')
const toast = ref('')
const rs = reactive({ n: 20, supplier: '' })
const LAW = { unsubmitted: { t: '未审', cls: '' }, reviewing: { t: '审核中', cls: 'amb' }, passed: { t: '已出意见 · 通过', cls: 'grn' }, risk: { t: '已出意见 · 有风险', cls: 'red' } }
const QS = { new: '新单', accepted: '已接单', scheduled: '已约时间', delivered: '已交付', done: '买家已确认', handoff: '转给同行' }
const NEXT = { new: ['accept', '接单'], accepted: ['schedule', '约时间'], scheduled: ['deliver', '交付（先验证原始报错）'], delivered: ['confirm', '确认完成'] }
const locked = computed(() => !state.me?.practice_done)
const ST = { delivered: '已发货', held: '发货检查拦住', waiting: '缺货，没码可发' }
async function svc(q, action) { await act(`svc/${q.id}/${action}`, action === 'schedule' ? { slot: '周六 10:00' } : {}, action === 'handoff' ? '已转给同行，带着原始现象、已做动作、环境和材料' : '已推进（演示）') }
const codes = reactive({})
async function reveal(o) { try { const r = await post(`/virtual/products/${encodeURIComponent(props.id)}/orders/${o.id}/reveal`, {}); codes[o.id] = r.code; flash('已显示，这次查看已留痕：' + r.log.length + ' 条记录') } catch (e) { flash(e.message) } }
const flash = (m) => { toast.value = m; setTimeout(() => (toast.value = ''), 2200) }

const issues = computed(() => (p.value ? virtIssues(p.value) : []))
const lvl = computed(() => worst(issues.value))
const cur = computed(() => p.value?.steps.find((s) => s.state === 'cur'))
const pct = computed(() => (p.value ? pctOfCost(p.value) : 0))
const pl = computed(() => (pct.value < p.value.floor_pct ? 'red' : pct.value > 500 ? 'amb' : 'grn'))
const fz = computed(() => gx(p.value.floor_pct))
const rate = computed(() => (p.value?.kind === 'svc' ? 0.2 : 0.1))
const lawAt = computed(() => ({ unsubmitted: 0, reviewing: 1, passed: 2, risk: 2 }[p.value?.compliance.lawyer] ?? 0))
const seg = (n) => { const s = p.value.stock; const t = s.avail + s.locked + s.sold + s.void || 1; return (n / t) * 100 }
const gx = (v) => Math.max(0, Math.min(100, ((v - 100) / 450) * 100))
const more = ref(false)
const extrasOpen = ref(false)
const zoom = ref(false)
const stockLvl = computed(() => { const k = p.value?.stock; if (!k) return ''; return k.avail <= (k.stop_at ?? 0) ? 'red' : k.avail <= k.warn_at ? 'amb' : 'grn' })
const jump = (id) => { if (id !== 'stages' && id !== 'orders' && id !== 'learn') more.value = true; nextTick(() => setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)) }

async function load() {
  err.value = ''
  try { p.value = await api('/virtual/products/' + encodeURIComponent(props.id)) } catch (e) { err.value = '读取产品卡失败：' + e.message; p.value = null }
}
async function act(path, body, msg) {
  try { p.value = await post(`/virtual/products/${encodeURIComponent(props.id)}/${path}`, body); flash(msg); loadAll() } catch (e) { flash('没办成：' + e.message) }
}
const restock = () => act('restock', { n: rs.n, supplier: rs.supplier }, `已入库 ${rs.n} 张，缺货等着的单已自动发出`)
const release = (o) => act(`orders/${o.id}/release`, {}, `订单 ${o.id} 已放行并发货`)
const addRefund = () => act('refund-list', { buyer: '买家 · 新增' }, '已加入退款名单')
const toggleAuto = (on) => act('auto-delivery', { on }, on ? '自动发货已打开' : '自动发货已关闭，所有单转人工')
const EVID = {
  1: [{ k: '领取说明', ph: '例如：从线索池领了「台州中盛餐饮优惠」，查过没有重复' }],
  2: [{ k: '闲鱼榜', ph: '销量、价格带、卖家数，没有写「无」' }, { k: '淘宝榜', ph: '同上' }, { k: '京东榜', ph: '同上' }],
  3: [{ k: '主路径', ph: '怎么拿到货' }, { k: '备路径', ph: '没有写「无」' }, { k: '进价', ph: '数字；不知道写「待核」' }, { k: '来源证据', ph: '链接或截图名' }],
  4: [{ k: '单笔贡献算式', ph: '售价 − 进价 − 平台费 − 售后预留 = ?' }],
  5: [{ k: '实测凭证', ph: '买 1 份、交付、核销的截图名' }],
  6: [{ k: '复现人', ph: '另一位员工' }, { k: '复现结果', ph: '不看原作者能不能做成' }],
  7: [{ k: '上架文案 / 图', ph: '文案和图的位置' }]
}
const ev = reactive({})
const evOk = computed(() => {
  const need = EVID[p.value?.step] || []
  const miss = need.filter((f) => !String(ev[f.k] || '').trim()).map((f) => f.k)
  if (miss.length) return { ok: false, why: '还缺：' + miss.join('、') }
  const zero = need.filter((f) => ['0', '0.0', '0.00'].includes(String(ev[f.k]).trim())).map((f) => f.k)
  return zero.length ? { ok: false, why: `「${zero.join('、')}」填了 0：缺数据写「待核」` } : { ok: true }
})
async function advance() { const data = {}; for (const f of EVID[p.value.step] || []) data[f.k] = ev[f.k]; await act('advance', { evidence: data }, '已交上去，进入下一步'); for (const k of Object.keys(ev)) delete ev[k] }
const goVirtNew = () => { location.hash = '#/virt-new' }
onMounted(load)
watch(() => props.id, load)
void state
const prOpen = ref(false)
const prForm = ref({ price: 0, cost: 0, floor_pct: 130, override_reason: '' })
function togglePr(prod) {
  prOpen.value = !prOpen.value
  if (prOpen.value && prod) {
    prForm.value = { price: Number(prod.price || 0), cost: Number(prod.cost || 0), floor_pct: Number(prod.floor_pct || 130), override_reason: '' }
  }
}
async function saveVirtPricing(prod) {
  try {
    const r = await fetch('/api/virtual/products/' + encodeURIComponent(prod.id) + '/pricing', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('erp_token') || ''), 'Content-Type': 'application/json' },
      body: JSON.stringify(prForm.value)
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.detail || '保存失败')
    Object.assign(prod, d)
    prOpen.value = false
    if (typeof toast === 'function') toast('定价已二审直接生效并重算提成')
  } catch (e) {
    if (typeof toast === 'function') toast(e.message); else alert(e.message)
  }
}
</script>

<style scoped>
.evf { display: grid; gap: 8px; margin-bottom: 12px; } .f2 { display: grid; gap: 4px; font-size: 12.5px; font-weight: 600; color: var(--mute); } .f2 input { height: 38px; border: 1px solid var(--line); border-radius: 10px; padding: 0 12px; background: var(--panel); color: var(--ink); font-weight: 400; min-width: 280px; }
.link { color: var(--acc); font-size: 12.5px; font-weight: 600; margin-top: 4px; }
.errbox { color: var(--red-ink); background: var(--red-soft); padding: 14px 18px; border-radius: 14px; }
.evlog { margin-top: 14px; font-size: 13px; display: grid; gap: 6px; } .el { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.steps { list-style: none; display: flex; gap: 0; margin: 4px 0 20px; padding: 0; overflow-x: auto; }
.steps li { flex: 1; min-width: 96px; display: flex; flex-direction: column; align-items: center; gap: 8px; position: relative; font-size: 13px; font-weight: 600; color: var(--mute); text-align: center; }
.steps li::before { content: ''; position: absolute; top: 17px; left: -50%; width: 100%; height: 3px; background: var(--line); z-index: 0; } .steps li:first-child::before { display: none; }
.steps li i { position: relative; z-index: 1; width: 36px; height: 36px; border-radius: 50%; background: var(--soft); border: 3px solid var(--line); display: flex; align-items: center; justify-content: center; font-style: normal; font-weight: 800; }
.steps li.done { color: var(--grn-ink); } .steps li.done i { background: var(--grn); border-color: var(--grn); color: #fff; } .steps li.done::before { background: var(--grn); }
.steps li.cur { color: var(--acc); } .steps li.cur i { background: var(--acc); border-color: var(--acc); color: #fff; box-shadow: 0 0 0 6px var(--acc-soft); }
.steps li.skip i { border-style: dashed; background: none; } .steps li.skip span { text-decoration: line-through; opacity: .6; }
.curstep { display: flex; gap: 30px; justify-content: space-between; align-items: center; background: var(--acc-soft); border-radius: 18px; padding: 20px 24px; flex-wrap: wrap; }
.curstep h4 { font-size: 22px; margin-top: 2px; } .cs-l { flex: 1; min-width: 300px; }
.banner { padding: 11px 15px; border-radius: 12px; font-weight: 600; font-size: 14px; } .banner.red { background: var(--red-soft); color: var(--red-ink); } .banner.amb { background: var(--amb-soft); color: var(--amb-ink); }
.legend { font-size: 13.5px; color: var(--ink2); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.restock { display: flex; gap: 8px; margin-top: 14px; }
.restock input { height: 38px; border: 1px solid var(--line); border-radius: 12px; padding: 0 12px; background: var(--panel); width: 100px; } .restock input + input { flex: 1; width: auto; }
.flow4 { display: flex; list-style: none; padding: 0; margin: 14px 0; gap: 8px; } .flow4 li { flex: 1; text-align: center; background: var(--soft); border-radius: 12px; padding: 9px 4px; font-weight: 600; font-size: 13.5px; } .flow4 li + li::before { content: ''; }
.sw { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
.sw input { display: none; } .sw i { width: 42px; height: 24px; border-radius: 999px; background: var(--line); position: relative; transition: background .15s; }
.sw i::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 3px rgba(0, 0, 0, .3); }
.sw input:checked + i { background: var(--grn); } .sw input:checked + i::after { transform: translateX(18px); }
.checks { display: grid; gap: 8px; } .checks div { display: flex; align-items: center; gap: 12px; background: var(--soft); border-radius: 14px; padding: 11px 14px; } .checks b { min-width: 120px; } .checks span { color: var(--mute); font-size: 13.5px; flex: 1; }
.hitline { display: block; margin-top: 3px; color: var(--red-ink); font-size: 12.5px; font-weight: 600; }
.sigs { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; } .sig { background: var(--soft); border-radius: 18px; padding: 16px 18px; } .sig b { font-size: 16px; }
.sig p { margin-top: 5px; font-size: 14px; } .sn2 { font-size: 30px; font-weight: 800; letter-spacing: -.02em; } .sn2 small { font-size: 13px; font-weight: 500; color: var(--mute); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; } @media (max-width: 1100px) { .two { grid-template-columns: 1fr; } }
.law { display: flex; list-style: none; padding: 0; margin: 16px 0 0; gap: 8px; } .law li { flex: 1; text-align: center; padding: 11px 0; border-radius: 12px; background: var(--soft); color: var(--mute); font-weight: 700; font-size: 14px; }
.law li.on { background: var(--grn-soft); color: var(--grn-ink); } .law li.risk { background: var(--red-soft); color: var(--red-ink); }
</style>
