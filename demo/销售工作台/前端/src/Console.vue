<template>
  <div class="page cs">
    <header class="head">
      <div><p class="eyebrow">{{ isPhys ? '实物 · 外包客服在回，我们随时接管' : '虚拟 · 服务 · 自己接待' }}</p>
        <h1>{{ isPhys ? '实物接管台' : '接待台' }}<Q :k="isPhys ? 'as-main' : 'rc-main'" /></h1>
        <p class="sub">{{ isPhys
          ? '实物的聊天已经外包，外包客服负责回。需要时我们直接接管这个会话：看得到完整对话和这件货的信息页，一键把 WMS 里的实拍、商品卡、仓库位置发给买家。'
          : '闲鱼、小红书、淘宝、京东的买家消息聚在这里。每个会话绑一个 Codex 会话带着买家走，卡住了、有风险了才轮到人；人随时接管，接管前智能体先交接，接管后答应了什么都记下来。' }}</p></div>
      <div class="plats">
        <span v-if="doorbell" class="pl db-pill" :title="doorbell.desc">🔔 AdsPower 门铃<small>{{ doorbell.online }}/{{ doorbell.total }} 窗秒级监听</small></span>
        <button v-if="isPhys" type="button" class="btn sm pri" @click="goCsWorkbench">打开并入的外部客服工作台 V3 →</button>
        <span v-for="p in platforms" :key="p.k" class="pl" :class="{ off: !p.connected }" :title="p.rule">{{ p.name }}<small>{{ p.connected ? '已接入' : '未接入·演示' }}</small></span>
        <button v-if="!isPhys && isAdmin" class="btn" :class="{ pri: kill }" @click="toggleKill">{{ kill ? '恢复智能体' : '暂停所有智能体' }}</button>
      </div>
    </header>

    <div v-if="kill" class="killbar"><b>总开关已打开：</b>所有智能体 / 机器人暂停自动回复，全部由人回。处理完点「恢复智能体」。</div>
    <p v-if="REAL && isPhys" class="realnote"><b>真实数据 · 只读：</b>左边是真 ERP「正在等回复的会话」，指标是真的「按员工统计消息响应」；看货、实拍、同款、最低价都读真 WMS。真正接管和发送要接上群控（真 ERP 已有），这里不写入。</p>

    <section class="mets">
      <template v-if="isPhys">
        <div v-for="m in physMets" :key="m.k" class="met"><span>{{ m.label }}</span><b :class="m.cls">{{ m.v }}</b><small>{{ m.hint }}</small></div>
      </template>
      <template v-else><div v-for="m in (metrics.kpis || [])" :key="m.k" class="met" :class="{ live: m.live }"><span>{{ m.label }}</span><b>{{ m.v }}</b><small>{{ m.hint }}</small></div></template>
      <span v-if="metrics.demo && !REAL" class="tag mdm">演示值</span>
    </section>
    <details v-if="isPhys && (metrics.items || []).length" class="bystaff"><summary>按员工看回复率（{{ REAL ? '真实' : '演示' }}）</summary>
      <table class="tb"><thead><tr><th>负责人</th><th>会话</th><th>已读</th><th>已回</th><th>回复率</th><th>读超时</th><th>回超时</th><th>还没回</th><th>平均回复</th></tr></thead>
        <tbody><tr v-for="r in metrics.items" :key="r.staff_id + r.name"><td>{{ r.name }}</td><td>{{ r.cycles }}</td><td>{{ r.read }}</td><td>{{ r.replied }}</td><td :class="rate(r) < 80 ? 'redt' : ''">{{ rate(r) }}%</td><td>{{ r.late_read }}</td><td>{{ r.late_reply }}</td><td>{{ r.open }}</td><td>{{ mins(r.avg_reply_sec) }}</td></tr></tbody></table></details>
    <details v-if="!isPhys && metrics.by_platform" class="bystaff"><summary>按平台看（演示值）</summary>
      <table class="tb"><thead><tr><th>平台</th><th>回复率</th><th>首响</th><th>自动处理率</th></tr></thead><tbody><tr v-for="r in metrics.by_platform" :key="r.k"><td>{{ pname(r.k) }}</td><td>{{ r.reply }}</td><td>{{ r.first }}</td><td>{{ r.auto }}</td></tr></tbody></table></details>

    <div class="g3">
      <!-- 左：队列 -->
      <aside class="cs-q card">
        <div class="tabs2"><button v-for="t in TABS" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.t }}<em>{{ counts[t.k] || 0 }}</em></button></div>
        <div class="pf"><button v-for="f in PF" :key="f.k" :class="{ on: plat === f.k }" @click="plat = f.k">{{ f.t }}</button></div>
        <button v-for="c in shown" :key="c.id" class="cv" :class="[c.state, { on: c.id === sel }]" @click="pick(c.id)">
          <span class="cb"><b><i class="pb" :class="c.platform">{{ c.platform_name }}</i>{{ c.buyer }}</b><em>{{ c.item_title || '（没有商品信息）' }}</em><span class="lm">{{ c.last }}</span></span>
          <span class="cr"><span class="tag" :class="ST[c.state].cls">{{ ST[c.state].t }}</span><small>{{ c.last_t || (c.waited_sec ? '等了 ' + waited(c.waited_sec) : '') }}</small>
            <small v-if="c.owner && c.owner.type !== 'none'">{{ OWN(c) }}</small><span v-if="c.due_min != null" class="tag" :class="c.due_min <= 15 ? 'red' : 'amb'">时效 {{ c.due_min }} 分</span></span>
        </button>
        <p v-if="!shown.length" class="muted pad">这一类现在没有会话。</p>
      </aside>

      <!-- 中：对话 -->
      <section v-if="d" class="th card">
        <div class="thh"><div class="tit"><b><i class="pb" :class="d.platform">{{ d.platform_name }}</i>{{ d.buyer }}<small>{{ d.account }}</small></b>
            <span class="ln" :class="lnCls(d.item)" @click="rtab = isPhys ? 'info' : 'id'">{{ d.item && d.item.platform_name ? d.item.platform_name : '' }}{{ d.item && d.item.kind_name ? ' ' + d.item.kind_name : '链接' }} → <u>{{ d.item && d.item.matched ? ((d.item.product && d.item.product.name) || d.item.sku) : (d.item_title || '对不上我们的商品') }}</u></span></div>
          <span class="tag" :class="ST[d.state].cls">{{ ST[d.state].t }}</span><span class="tag">{{ OWN(d) }}</span><span v-if="d.order" class="tag acc">{{ d.order.status }}</span></div>

        <!-- #109 聊天里的商品卡：真实图 / 价 / 成色 / 在售 / 库位 / 编号；点开站内详情；前往链接独立 -->
        <div v-if="d.item" class="pv" :class="{ miss: !peek.matched }">
          <button class="pvi" :class="{ ph: !peek.img }" @click="peekOpen = true"><img v-if="peek.img" :src="peek.img" alt="" /><span v-else>待补图</span></button>
          <div class="pvb">
            <b>{{ peek.name }}</b>
            <p v-if="peek.matched" class="pvm"><span v-if="peek.price">¥{{ peek.price }}</span><span v-if="peek.grade">{{ peek.grade }}</span><span v-if="peek.status" class="tag" :class="peek.statusCls">{{ peek.status }}</span><span v-if="peek.location">库位 {{ peek.location }}</span><span v-if="peek.code">编号 {{ peek.code }}</span></p>
            <p v-else class="pvm"><span class="tag amb">商品信息待补全</span><span class="muted">这条链接还没对上我们的商品</span></p>
            <p class="pvn">{{ d.item.platform_name }} · {{ d.item.kind_name }} · {{ d.item.host }}</p>
          </div>
          <div class="pva">
            <button class="btn sm" @click="peekOpen = true">站内详情</button>
            <button v-if="peek.matched" class="btn sm" @click="goLink">前往链接</button>
            <button v-else class="btn sm pri" @click="peekOpen = true; peekFix = true">补录 / 匹配</button>
          </div>
        </div>

        <div v-if="d.triggers && d.triggers.length" class="ban red"><b>为什么轮到你：</b><span v-for="t in d.triggers" :key="t.code">{{ t.text }}</span></div>
        <div v-if="d.danger" class="ban amb"><b>安全红线：</b>聊天里出现了「{{ d.danger }}」，不要记录、不要转发、不要截图进教程；让客户撤回。</div>
        <div v-if="d.handoff && d.owner.type !== 'agent'" class="hand"><h4>交接摘要<small>智能体停手时自动写的，接管不用从头翻</small></h4>
          <dl><dt>买家</dt><dd>{{ d.handoff.who }}</dd><dt>要什么</dt><dd>{{ d.handoff.ask }}</dd><dt>已做</dt><dd>{{ d.handoff.done.join('；') }}</dd><dt>卡在</dt><dd>{{ d.handoff.stuck }}</dd><dt>建议下一步</dt><dd>{{ d.handoff.next }}</dd></dl></div>
        <div v-if="d.commitments && d.commitments.length" class="cmt"><b>人已经答应的（智能体 / 外包必须照办）</b><span v-for="(c, i) in d.commitments" :key="i" class="tag" :class="c.note ? '' : 'amb'">{{ c.text }}</span></div>

        <div class="msgs" ref="box">
          <div v-for="(m, i) in d.msgs" :key="i" class="m" :class="[m.who, m.dir]">
            <span class="mw">{{ WHO[m.who] }}<template v-if="m.by"> · {{ m.by }}</template><template v-if="m.tag"> · {{ m.tag }}</template> <i>{{ m.t }}</i><b v-if="m.status === 'queued'" class="st q">排队中</b><b v-else-if="m.status === 'failed'" class="st f">没发出去</b></span>
            <p v-if="m.text">{{ m.text }}</p>
            <div v-if="m.card" class="mcard">{{ m.card.title }} {{ m.card.grade }} <b>¥{{ m.card.price }}</b></div>
            <div v-if="m.media" class="mimgs"><img v-for="u in m.media" :key="u" :src="u" alt="" /></div>
            <div v-if="m.video" class="mvid">🎬 <b>{{ m.video.title || '实拍视频.mp4' }}</b><span>时长 {{ m.video.duration || '00:15' }} · ERP 原片高清直发</span></div>
            <div v-if="m.location" class="mloc">📍 {{ m.location }}</div>
            <small v-if="m.hint" class="mhint">{{ m.hint }}</small>
            <span v-for="l in linksOf(m)" :key="l.url" class="lk" :class="lnCls(l)">{{ l.platform_name || l.host }} · {{ l.kind_name }}<template v-if="l.matched"> → {{ (l.product && l.product.name) || l.sku }}</template></span>
          </div>
        </div>

        <div v-if="d.draft" class="dfc"><h4>智能体起草了一条回复<small>把握 {{ Math.round(d.draft.conf * 100) }}%</small></h4>
          <p class="why">{{ d.draft.why }}</p>
          <textarea v-model="draftText" :disabled="!mine"></textarea>
          <p class="bas"><span v-for="b in d.draft.basis" :key="b" class="tag">依据：{{ b }}</span></p>
          <div v-if="mine" class="rw"><button class="btn pri" @click="draftAct('approve')">发送</button><button class="btn" @click="draftAct('edit', { text: draftText })">改了再发</button>
            <input v-model="rejWhy" placeholder="驳回原因（≥4 字）" class="cin" /><button class="btn" @click="draftAct('reject', { reason: rejWhy })">驳回</button>
            <input v-model="rwIns" placeholder="让它重写：怎么改（≥4 字）" class="cin" /><button class="btn" @click="draftAct('rewrite', { instruction: rwIns })">重写</button></div>
          <p v-else class="muted">先点下面「我来接」，再审草稿：不然两个人同时审会发两遍。</p></div>

        <div class="ctabs"><button :class="{ on: ctab === 'buyer' }" @click="ctab = 'buyer'">对买家说</button><button v-if="!isPhys" :class="{ on: ctab === 'int' }" @click="ctab = 'int'">内部 · 和智能体对话<small>买家看不到</small></button></div>
        <div v-if="ctab === 'buyer'" class="comp">
          <div v-if="d.state === 'done'" class="off">这个会话已经处理完了。</div>
          <div v-else-if="REAL && isPhys" class="off">真实环境只读：这里可以看、可以查货、可以预览要发的内容，不会真的发出去。</div>
          <div v-else-if="!mine" class="off"><span>{{ d.owner.type === 'human' ? d.owner.who + ' 正在处理这个会话；同一时间只能一个人操作，不然会重复回复买家。' : isPhys ? '现在是外包客服在回。要自己来，点「我来接管」：外包客服会收到提示先停手。' : '现在是' + (d.agent && d.agent.status === 'paused' ? '智能体已暂停，等人' : '智能体在回') + '。要自己来，先接管：接管后智能体暂停，不会和你同时回买家。' }}</span><button v-if="d.owner.type !== 'human'" class="btn pri" @click="act('claim')">{{ isPhys ? '我来接管' : '我来接' }}</button></div>
          <template v-else>
            <div class="qk"><button v-for="q in d.quick" :key="q.k" class="chip" :title="q.text" @click="text = q.text">{{ q.k }}</button></div>
            <textarea v-model="text" placeholder="写给买家的话。不要要密码、验证码，不要留微信 / 手机号，不要发外链。"></textarea>
            <div class="cf">
              <button type="button" class="btn plus-toggle" :class="{ on: plusOpen }" @click="plusOpen = !plusOpen">＋ 闲鱼 10 宫格工具箱</button>
              <button class="btn pri" @click="act('send', { text })">发送</button>
              <button class="btn" @click="relOpen = !relOpen">交还…</button>
              <input v-model="note" class="cin" placeholder="处理结果（结案才需要，≥6 字）" />
              <button class="btn" @click="act('resolve', { note })">已处理，结案</button>
            </div>

            <!-- 群控聚合聊天需求：仿闲鱼底部「＋」号 10 宫格业务功能（阉割复杂发货，直调 ERP 高清原图/视频/10仓地址池） -->
            <div v-if="plusOpen" class="plus-grid-wrap">
              <div class="pg-head">
                <b>＋ 聚合聊天 10 宫格快捷动作（直调 ERP 高清素材，不走微信压缩 · 发货已剥离至订单页）</b>
                <span class="muted">右侧已勾实拍 {{ pickedN }}/{{ MAXI }} 张</span>
              </div>
              <div class="plus-grid">
                <button type="button" class="pg-btn" @click="plusFixedScript"><i>💬</i><b>1. 固定话术</b><span>成色/当天发</span></button>
                <button type="button" class="pg-btn" @click="plusImgPack"><i>🗂</i><b>2. 图片包</b><span>配件全家福</span></button>
                <button type="button" class="pg-btn" @click="plusOrigImg"><i>🖼</i><b>3. 商品原图</b><span>高清无水印</span></button>
                <button type="button" class="pg-btn" @click="plusRealImg"><i>📷</i><b>4. 商品实拍图</b><span>一机一码实拍</span></button>
                <button type="button" class="pg-btn" @click="plusVideo"><i>🎬</i><b>5. 实拍视频</b><span>15s通电原片</span></button>
                <button type="button" class="pg-btn" :class="{ on: addrOpen }" @click="addrOpen = !addrOpen"><i>📍</i><b>6. 地址池</b><span>10个默认仓点</span></button>
                <button type="button" class="pg-btn" @click="act('send', { location: true, tag: '自提地址' })"><i>🏢</i><b>7. 自提地址</b><span>富阳主仓指引</span></button>
                <button type="button" class="pg-btn" @click="plusShippingNote"><i>🚚</i><b>8. 运费说明</b><span>固定邮费¥12</span></button>
                <button type="button" class="pg-btn" @click="plusPriceNote"><i>🏷</i><b>9. 价格说明</b><span>行情核定实价</span></button>
                <button type="button" class="pg-btn" @click="plusQcReport"><i>🛡</i><b>10. 质检/验机图</b><span>ERP核验报告</span></button>
              </div>
              <div v-if="addrOpen" class="addr-pool">
                <p class="muted sm">点击任一预设仓点地址立即发送给买家（共 {{ (d.address_pool || addrPool).length }} 个默认地址池）：</p>
                <div class="addr-list">
                  <button v-for="ad in (d.address_pool || addrPool)" :key="ad.id" type="button" class="addr-item" @click="sendAddrPool(ad)">
                    <b>{{ ad.label }}</b><span>{{ ad.addr }}</span>
                  </button>
                </div>
              </div>
            </div>
            <div v-if="relOpen" class="rel"><p class="muted">交还给{{ isPhys ? '外包客服' : '智能体' }}前，写清楚：你决定了什么、答应了买家什么、后面不能做什么。接着做的人要照这个办。</p>
              <textarea v-model="relNote" placeholder="交还备注（≥6 字）"></textarea><input v-model="relCm" class="cin" placeholder="人答应了买家的事（可选，一条一行不用写满，例如：今天发货前再拍一段视频）" />
              <button class="btn pri" @click="act('release', { note: relNote, commitments: relCm ? [relCm] : [] })">确认交还</button></div>
          </template>
        </div>
        <div v-else class="comp int">
          <div class="imsgs"><p v-if="!d.internal.length" class="muted">这里是你和这个会话绑定的 Codex 会话的对话，买家看不到。你可以给它下指令（「下一条先问机型」「别报价」），它会在这里告诉你它做了什么。</p>
            <div v-for="(m, i) in d.internal" :key="i" class="im" :class="m.who"><span>{{ m.who === 'agent' ? 'Codex 会话' : (m.by || '你') }} <i>{{ m.t }}</i></span><p>{{ m.text }}</p></div></div>
          <div class="cf"><input v-model="ins" class="cin" placeholder="给智能体的指令，例如：下一条先问清楚是什么机型" @keyup.enter="act('internal', { text: ins })" /><button class="btn pri" @click="act('internal', { text: ins })">发给智能体</button></div>
          <p class="muted">正式版：每个会话对应一个 Codex thread，这里发的话就是发给那个 thread；演示里智能体的回复是写死的。</p>
        </div>
        <p v-if="err" class="errbox">{{ err }}</p>
        <div v-if="peekOpen" class="pmask" @click.self="peekOpen = false"><div class="pmodal">
          <div class="pmh"><h3>{{ peek.name }}</h3><button class="btn sm" @click="peekOpen = false">返回聊天</button></div>
          <div class="pmb">
            <div class="pmpic" :class="{ ph: !peek.img }"><img v-if="peek.img" :src="peek.img" alt="" /><span v-else>这件货还没有图</span></div>
            <dl class="kv"><dt>商品编号</dt><dd>{{ peek.code || '待补' }}</dd><dt>价格</dt><dd>{{ peek.price ? '¥' + peek.price : '待补' }}</dd><dt>成色</dt><dd>{{ peek.grade || '待补' }}</dd><dt>在售状态</dt><dd>{{ peek.status || '待补' }}</dd><dt>库位</dt><dd>{{ peek.location || '待补' }}</dd><dt>平台</dt><dd>{{ d.item.platform_name }} · {{ d.item.host }}</dd></dl>
          </div>
          <p class="muted sm">{{ d.item.note }}。站内详情保留聊天位置；「前往链接」才跳平台，两个动作分开。</p>
          <div v-if="peekFix || !peek.matched" class="pfix"><input v-model="fixCode" placeholder="输入我们的货号 / 商品编号" /><button class="btn sm pri" @click="doFix">补录 / 匹配</button><span class="muted sm">演示：正式版写平台商品 ID → 产品映射。</span></div>
          <div class="pmf"><button class="btn" @click="peekOpen = false">返回聊天</button><button v-if="peek.matched" class="btn pri" @click="goLink">前往链接</button></div>
        </div></div>
      </section>
      <section v-else class="th card"><p class="muted pad">选一个会话。</p></section>

      <!-- 右：识别 / 智能体 / 信息页 / 客户 / 规则 -->
      <aside v-if="d" class="rp card">
        <div class="rtabs"><button v-for="t in RT" :key="t.k" :class="{ on: rtab === t.k }" @click="rtab = t.k">{{ t.t }}</button></div>

        <div v-if="rtab === 'id'" class="pn">
          <h4>这条链接是什么<Q k="rc-link" /></h4>
          <div class="lcard" :class="lnCls(d.item)"><b>{{ d.item.platform_name || '未知' }} · {{ d.item.kind_name }}</b><span>{{ d.item.host }}</span>
            <template v-if="d.item.matched && d.item.product"><p><b>{{ d.item.product.name }}</b></p><p class="muted">{{ d.item.product.kind === 'svc' ? '服务' : '卡券' }} · {{ (d.item.product.path || []).slice(1).join(' › ') }}</p><a @click="goProduct(d.item.product)">打开产品页 ›</a></template>
            <p class="muted">{{ d.item.note }}</p></div>
          <p class="k">粘贴一条链接，看它是什么</p>
          <div class="rw"><input v-model="lurl" class="cin" placeholder="粘贴买家发的链接" @keyup.enter="resolveUrl" /><button class="btn" @click="resolveUrl">识别</button></div>
          <div v-if="lres" class="lcard" :class="lnCls(lres)"><b>{{ lres.platform_name || '未知' }} · {{ lres.kind_name }}</b><span>{{ lres.host }}</span><p v-if="lres.matched && lres.product"><b>→ {{ lres.product.name }}</b></p><p class="muted">{{ lres.note }}</p></div>
          <p class="k">这个会话里出现过的链接</p>
          <p v-if="!d.links.length" class="muted">没有。</p>
          <div v-for="(l, i) in d.links" :key="i" class="lcard" :class="lnCls(l)"><b>{{ l.platform_name || l.host }} · {{ l.kind_name }}</b><p class="muted">{{ l.note }}</p></div>
          <p class="muted sm">系统只看链接长什么样，不会自动打开任何链接。商品登记是演示登记；真环境要从各平台的发布记录同步「平台商品 ID → 产品」。</p>
        </div>

        <div v-else-if="rtab === 'agent'" class="pn">
          <h4>绑定的 Codex 会话<Q k="rc-agent" /></h4>
          <div v-if="d.agent" class="acard"><dl><dt>会话</dt><dd>{{ d.agent.session }}（演示）</dd><dt>运行环境</dt><dd>{{ d.agent.runner }}</dd><dt>专属 Skill</dt><dd>{{ d.agent.skill }}</dd><dt>状态</dt><dd><span class="tag" :class="AST[d.agent.status].cls">{{ AST[d.agent.status].t }}</span></dd><dt>上一步</dt><dd>{{ d.agent.last }}</dd></dl>
            <button class="btn sm" disabled>在 Codex 里打开（还没接）</button></div>
          <template v-if="d.agent && d.agent.steps"><p class="k">接入进度</p><ol class="stp"><li v-for="(s, i) in d.agent.steps" :key="i" :class="{ done: d.agent.step > i, cur: d.agent.step === i }"><i>{{ d.agent.step > i ? '✓' : i + 1 }}</i>{{ s }}</li></ol></template>
          <p class="k">智能体怎么回（模式）</p>
          <label v-for="(m, k) in modes" :key="k" class="md" :class="{ on: d.mode === k }"><input type="radio" :checked="d.mode === k" @change="setMode(k)" /><span><b>{{ m.t }}</b><small>{{ m.d }}</small></span></label>
          <p class="k">什么时候自动转人</p>
          <ul><li>退款、投诉、差评 / 举报 / 平台介入</li><li>卡密已用、客户要真人</li><li>密码、验证码、银行卡等敏感信息</li><li>超出 Skill 范围（Mac、机型不支持）</li><li>讲解两次客户仍不会</li><li>远控连不上 3 次、工具失败</li><li>来路不明的链接</li><li>一小时时效只剩 15 分钟</li><li>把握低于阈值（演示按 70%）</li></ul>
        </div>

        <div v-else-if="rtab === 'info'" class="pn">
          <h4>这件货的信息页<Q k="as-find" /></h4>
          <div class="rw"><input v-model="q" class="cin" placeholder="货号 / 型号 / 品牌，例如 27M2N5510P" @keyup.enter="search" /><button class="btn" @click="search">查</button></div>
          <div v-if="hits.length > 1" class="hits"><button v-for="h in hits" :key="h.code" :class="{ on: info && info.code === h.code }" @click="useSku(h)"><b>{{ h.code }}</b><span>{{ h.name }}</span></button></div>
          <template v-if="info">
            <div class="facts"><div><span>货</span><b>{{ info.name }}</b></div><div><span>货号</span><b>{{ info.code }}</b></div><div><span>成色</span><b>{{ info.grade || '没录' }}</b></div><div><span>库位</span><b>{{ info.location || '—' }}<template v-if="info.short_code"> · #{{ info.short_code }}</template></b></div>
              <div><span>建议价</span><b>{{ info.suggest_price ? '¥' + info.suggest_price : '—' }}</b></div><div><span>最低能卖</span><b>{{ info.floor ? '¥' + info.floor : '缺成本，问主管' }}</b></div></div>
            <p class="muted sm">最低价 = 成本 × 130%（示例，以管理端批准规则为准）；不展示成本。低于它要先找主管。</p>
            <p class="k">能发给买家的实拍<Q k="as-media" /></p>
            <div v-if="info.real.length || info.defect.length" class="pics"><label v-for="u in [...info.real, ...info.defect]" :key="u" class="pic"><img :src="u" alt="" /><input v-model="picked" type="checkbox" :value="u" :disabled="!picked.includes(u) && picked.length >= MAXI" /><small :class="{ d: info.defect.includes(u) }">{{ info.defect.includes(u) ? '瑕疵' : '实拍' }}</small></label></div>
            <p v-else class="warn">这件货还没有验货实拍图：不能拿别的图顶。请仓管补拍。<button class="btn sm" @click="askWh">请仓管补拍</button></p>
            <p class="muted sm">一次最多 {{ MAXI }} 张（闲鱼选图上限）。库位照、订单截图、议价取证不会出现。</p>
            <p class="k">同款在库，按成色<Q k="as-slot" /></p>
            <table v-if="info.slots.length" class="tb"><tbody><tr v-for="s in info.slots" :key="s.code" :class="{ me: s.me }"><td>{{ s.code }}</td><td>{{ s.grade }}</td><td>{{ s.location }}</td><td><span v-if="s.me" class="tag acc">这件</span></td></tr></tbody></table>
            <p class="k">仓库位置（自提）</p><p class="muted">{{ d.pickup || '（真环境取自「发送仓库位置」设置）' }}</p>
          </template>
          <p v-else class="muted">会话对上了的货会自动显示；对不上就在上面查。</p>
          <p class="k">只把结论告诉外包客服（不接管）<Q k="as-note" /></p>
          <div class="rw"><input v-model="onote" class="cin" placeholder="例如：有 3 张实拍；最低 ¥1020，不能再低" /><button class="btn" :disabled="REAL" @click="sendNote">发给外包</button></div>
          <div v-for="(n, i) in d.notes" :key="i" class="nt"><b>{{ n.by }}</b> {{ n.t }}　{{ n.text }}</div>
        </div>

        <div v-else-if="rtab === 'cust'" class="pn">
          <h4>客户和订单</h4>
          <dl class="kv"><dt>订单</dt><dd>{{ d.order ? d.order.status + (d.order.amount ? ' · ¥' + d.order.amount : '') : '—' }}</dd><dt>历史订单</dt><dd>{{ d.buyer_stats.orders }} 单</dd><dt>退款</dt><dd>{{ d.buyer_stats.refunds }} 次</dd><dt>聊过</dt><dd>{{ d.buyer_stats.talk }} 次</dd><dt>标签</dt><dd><span v-for="t in d.tags" :key="t" class="tag">{{ t }}</span><template v-if="!d.tags.length">—</template></dd></dl>
          <p class="muted sm">演示数据。真环境要接订单库和各平台的买家资料；退款过的客户要标出来，回复前先看。</p>
        </div>

        <div v-else class="pn">
          <h4>外发守卫（每个平台都查）<Q k="rc-guard" /></h4>
          <ul><li>不索要 / 转述密码、验证码、银行卡、身份证号</li><li>不留微信 / QQ / 手机号，不说「加我」（站外引流）</li><li>外链只放行远控官方站（向日葵 / ToDesk）</li><li>一次最多 {{ MAXI }} 张图；库位照 / 订单截图 / 议价取证不发</li><li>同一个号两次操作至少隔 {{ d.gap_sec || 30 }} 秒（真群控规则），超了自动排队</li></ul>
          <h4>时限<Q k="as-list" /></h4>
          <ul><li>读：5 分钟；回：15 分钟；23 点到次日 9 点静默不计（真 ERP 考核）</li><li>外包客服 24 小时内必须回</li><li v-if="!isPhys">服务一小时时效；卡券付款 1 分钟内发货</li></ul>
          <h4>{{ d.platform_name }} 的规矩</h4><p class="muted">{{ (platforms.find((p) => p.k === d.platform) || {}).rule }}</p>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import Q from './Q.vue'
import { api, post, REAL } from './api.js'
import { state, imageKinds } from './store.js'
import { toast } from './ui.js'

const props = defineProps({ domain: String })   // 'vs' 虚拟 / 服务；'phys' 实物
const isPhys = computed(() => props.domain === 'phys')
const isAdmin = (localStorage.getItem('erp_user') || '') === 'admin'
const MAXI = 9
const items = ref([]), counts = ref({}), platforms = ref([]), modes = ref({}), kill = ref(false), metrics = ref({}), sel = ref(''), d = ref(null)
const doorbell = ref(null), addrPool = ref([]), plusOpen = ref(true), addrOpen = ref(false)
const tab = ref(isPhys.value ? 'queue' : 'queue'), plat = ref('all'), ctab = ref('buyer'), rtab = ref(isPhys.value ? 'info' : 'id')
const text = ref(''), note = ref(''), err = ref(''), box = ref(null), draftText = ref(''), rejWhy = ref(''), rwIns = ref(''), ins = ref(''), relOpen = ref(false), relNote = ref(''), relCm = ref('')
const lurl = ref(''), lres = ref(null), q = ref(''), hits = ref([]), info = ref(null), picked = ref([]), onote = ref('')
const peekOpen = ref(false), peekFix = ref(false), fixCode = ref('')
const TABS = computed(() => (isPhys.value ? [{ k: 'queue', t: '要接管' }, { k: 'outsource', t: '外包在回' }, { k: 'human', t: '我们在处理' }, { k: 'all', t: '全部' }]
  : [{ k: 'queue', t: '兜底队列' }, { k: 'agent', t: '智能体' }, { k: 'bot', t: '机器人' }, { k: 'human', t: '人在处理' }, { k: 'done', t: '已处理' }, { k: 'all', t: '全部' }]))
const PF = [{ k: 'all', t: '全部平台' }, { k: 'xianyu', t: '闲鱼' }, { k: 'xhs', t: '小红书' }, { k: 'taobao', t: '淘宝' }, { k: 'jd', t: '京东' }]
const ST = { need: { t: '要人', cls: 'red' }, draft: { t: '草稿待审', cls: 'amb' }, agent: { t: '智能体', cls: 'grn' }, bot: { t: '机器人', cls: 'grn' }, human: { t: '人在处理', cls: 'acc' }, outsource: { t: '外包在回', cls: '' }, done: { t: '已处理', cls: '' } }
const AST = { running: { t: '运行中', cls: 'grn' }, draft_ready: { t: '草稿等人审', cls: 'amb' }, paused: { t: '已暂停', cls: 'red' }, stuck: { t: '卡住了', cls: 'red' }, idle: { t: '空闲', cls: '' } }
const WHO = { buyer: '买家', bot: '机器人（自动）', agent: '智能体（Codex）', staff: '员工', sys: '系统', outsource: '外包客服' }
const RT = computed(() => (isPhys.value ? [{ k: 'info', t: '信息页' }, { k: 'cust', t: '客户订单' }, { k: 'rule', t: '规则' }] : [{ k: 'id', t: '识别' }, { k: 'agent', t: '智能体' }, { k: 'cust', t: '客户订单' }, { k: 'rule', t: '规则' }]))
const OWN = (c) => (c.owner?.type === 'human' ? '👤 ' + c.owner.who : c.owner?.type === 'outsource' ? '外包 ' + (c.owner.who || '').replace('外包客服', '') : c.domain === 'phys' ? '' : '🤖 ' + (c.agent_status === 'paused' ? '已暂停' : c.domain === 'svc' ? 'Codex 带着' : '机器人'))
const pname = (k) => platforms.value.find((p) => p.k === k)?.name || k
const mine = computed(() => !!d.value?.mine)
const lnCls = (l) => (l?.matched ? 'grn' : l?.safe ? 'amb' : 'red')
const waited = (s) => { const m = Math.round((s || 0) / 60); return m < 60 ? m + ' 分钟' : m < 1440 ? Math.floor(m / 60) + ' 小时' : Math.floor(m / 1440) + ' 天' }
const mins = (s) => (s ? (s >= 3600 ? (s / 3600).toFixed(1) + ' 小时' : Math.round(s / 60) + ' 分钟') : '—')
const rate = (r) => (r.cycles ? Math.round((r.replied / r.cycles) * 100) : 0)
const pickedN = computed(() => picked.value.length)
const linksOf = (m) => (d.value?.links || []).filter((l) => l.in_msg === (m.text || '').slice(0, 24))
const shown = computed(() => items.value.filter((c) => (tab.value === 'all' || (tab.value === 'queue' ? ['need', 'draft'].includes(c.state) : c.state === tab.value)) && (plat.value === 'all' || c.platform === plat.value))
  .sort((a, b) => (tab.value === 'queue' ? a.urgent - b.urgent : 0) || (b.waited_sec || 0) - (a.waited_sec || 0)))
const physMets = computed(() => {
  const its = metrics.value.items || [], t = (k) => its.reduce((s, r) => s + (r[k] || 0), 0), cy = t('cycles')
  if (!cy) return []
  const wr = its.reduce((s, r) => s + (r.avg_reply_sec || 0) * (r.replied || 0), 0), rp = t('replied')
  return [{ k: 'rate', label: '回复率', v: Math.round((rp / cy) * 100) + '%', cls: rp / cy < 0.8 ? 'redt' : '', hint: `已回 ${rp} / 会话 ${cy}（近 7 天）` },
    { k: 'lr', label: '回复超时', v: t('late_reply') + ' 次', cls: t('late_reply') ? 'redt' : '', hint: '超过回复 15 分钟' }, { k: 'ld', label: '阅读超时', v: t('late_read') + ' 次', hint: '超过读 5 分钟' },
    { k: 'op', label: '还没回', v: t('open') + ' 个', cls: t('open') ? 'redt' : '', hint: '现在还在等的会话' }, { k: 'av', label: '平均回复', v: mins(rp ? wr / rp : 0), hint: '已回的会话平均用时' }]
})

let timer
async function load(keep) {
  try {
    if (isPhys.value && REAL) {
      const d7 = new Date(), d0 = new Date(Date.now() - 7 * 864e5), f = (x) => x.toISOString().slice(0, 10)
      const [w, st] = await Promise.all([api('/gc-ops/chat-sla/waiting'), api(`/gc-ops/chat-sla/stats?date_from=${f(d0)}&date_to=${f(d7)}`).catch(() => null)])
      platforms.value = [{ k: 'xianyu', name: '闲鱼', connected: true, rule: '真数据，只读' }, { k: 'xhs', name: '小红书', connected: false, rule: '' }, { k: 'taobao', name: '淘宝', connected: false, rule: '' }, { k: 'jd', name: '京东', connected: false, rule: '' }]
      items.value = (w.items || []).slice(0, 80).map((x) => ({ id: x.conversation_id, domain: 'phys', platform: 'xianyu', platform_name: '闲鱼', account: x.account, buyer: x.buyer, state: x.escalated ? 'need' : 'outsource', owner: { type: 'outsource', who: x.read_by || '外包客服' }, need: x.escalated ? '已超过回复 15 分钟' : '', last: x.last_message || '', last_t: '', waited_sec: x.waited_sec, escalated: x.escalated, item_title: x.item_title || '', urgent: 15 - (x.waited_sec || 0) / 60, read_by: x.read_by, owners: x.owners || [], item_url: '' }))
      const c = { all: items.value.length, queue: items.value.filter((i) => i.state === 'need').length, outsource: items.value.filter((i) => i.state === 'outsource').length, human: 0 }
      counts.value = c; metrics.value = st || {}
    } else {
      const r = await api(`/demo/inbox?domain=${props.domain}`); items.value = r.items; counts.value = r.counts; platforms.value = r.platforms; modes.value = r.modes; kill.value = r.kill
      doorbell.value = r.doorbell || null; addrPool.value = r.address_pool || []
      metrics.value = await api(`/demo/inbox-metrics?domain=${props.domain}`).catch(() => ({}))
    }
  } catch { /* 读不到就空着 */ }
  if (!keep || !sel.value) { const f = shown.value[0] || items.value[0]; if (f) await pick(f.id) } else await pick(sel.value, true)
}
async function pick(id, quiet) {
  sel.value = id; if (!quiet) { err.value = ''; text.value = ''; note.value = ''; picked.value = []; relOpen.value = false; lres.value = null }
  const c = items.value.find((x) => x.id === id)
  try {
    if (isPhys.value && REAL) { d.value = { ...c, msgs: [{ dir: 'in', who: 'buyer', text: c.last, t: '' }], internal: [], draft: null, agent: null, commitments: [], handoff: null, order: null, buyer_stats: { orders: 0, refunds: 0, talk: 0 }, tags: [], triggers: c.need ? [{ code: 'sla', text: c.need }] : [], item: { matched: false, safe: true, kind_name: '没有链接', host: '', note: '真实的「等回复」列表里没有商品链接；用右边「信息页」自己查货。' }, links: [], quick: [], info: null, pickup: '', mine: false, notes: [], gap_sec: 30, modes: {} }; info.value = null }
    else { d.value = await api('/demo/inbox/' + id); if (d.value.info && !quiet) info.value = d.value.info; modes.value = d.value.modes || modes.value; if (d.value.draft && !quiet) draftText.value = d.value.draft.text }
  } catch { d.value = null }
  if (!quiet && d.value && !isPhys.value) rtab.value = d.value.item?.matched ? 'agent' : 'id'
  await nextTick(); if (box.value) box.value.scrollTop = box.value.scrollHeight
}
async function act(a, body = {}) {
  err.value = ''
  try { await post(`/demo/inbox/${sel.value}/${a}`, body); if (a === 'send') { text.value = ''; picked.value = [] } if (a === 'internal') ins.value = ''; if (a === 'resolve') { note.value = ''; toast('已结案') } if (a === 'release') { relOpen.value = false; relNote.value = ''; relCm.value = ''; toast('已交还') } await load(true) } catch (e) { err.value = e.message }
}
const sendMedia = () => act('send', { media: [...picked.value], text: '' })
const plusFixedScript = () => act('send', { text: '亲，这件在库的，仓库已完成全套通电功能测试，原图实拍所见即所得，今天 17:00 前拍下当天打包发出～', tag: '固定话术' })
const plusImgPack = () => {
  const imgs = (info.value?.real || info.value?.orig || ['/api/demo-img/MON1-1.jpg', '/api/demo-img/MON1-2.jpg']).slice(0, 3)
  act('send', { media: imgs, text: '附上本件商品与配件全家福图片包供您核对：', tag: '图片包' })
}
const plusOrigImg = () => {
  const imgs = (info.value?.orig?.length ? info.value.orig : (info.value?.real?.length ? [info.value.real[0]] : ['/api/demo-img/MON1-1.jpg'])).slice(0, 2)
  act('send', { media: imgs, text: '这是 ERP 高清无水印商品原图（未经过微信压缩）：', tag: '商品原图' })
}
const plusRealImg = () => {
  const imgs = picked.value.length ? [...picked.value] : (info.value?.real?.length ? info.value.real.slice(0, 2) : ['/api/demo-img/DYS-1.jpg'])
  act('send', { media: imgs, text: '这是仓库本件一机一码验货实拍图：', tag: '商品实拍图' })
}
const plusVideo = () => {
  const v = info.value?.videos?.[0] || { title: `${peek.value.name || '在库商品'} · 15秒通电成色实拍视频.mp4`, duration: '00:15' }
  act('send', { video: v, text: '已为您调取 ERP 绑定的高清实拍开机视频：', tag: '实拍视频' })
}
const sendAddrPool = (ad) => { addrOpen.value = false; act('send', { location_text: `${ad.label}：${ad.addr}`, tag: '地址池' }) }
const plusShippingNote = () => act('send', { text: info.value?.shipping_note || '亲，本店默认走不包邮模板：顺丰/京东加固防震固定运费 ¥12，当天 17:00 前拍下当天发出；杭州地区也支持预约到仓自提。', tag: '运费说明' })
const plusPriceNote = () => act('send', { card: !!info.value, text: info.value?.price_note || '亲，本店价格均对照最新闲鱼同成色成交行情实价核定，签收 48 小时功能异常包退换。', tag: '价格说明' })
const plusQcReport = () => act('send', { media: [info.value?.qc_report || '/api/demo-img/GC-QC-REPORT.jpg'], text: '附上该件入库真机质检与功能核验报告单：', tag: '质检/验机图' })
async function draftAct(a, body = {}) {
  err.value = ''
  try { await post(`/demo/inbox/${sel.value}/draft/${a}`, body); rejWhy.value = ''; rwIns.value = ''; await load(true); if (d.value?.draft) draftText.value = d.value.draft.text } catch (e) { err.value = e.message }
}
async function setMode(m) { err.value = ''; try { await post(`/demo/inbox/${sel.value}/mode`, { mode: m }); await load(true) } catch (e) { err.value = e.message; toast(e.message) } }
async function toggleKill() { try { await post('/demo/inbox-kill', { on: !kill.value }); await load(true) } catch (e) { toast(e.message) } }
async function resolveUrl() { try { lres.value = await api('/demo/link-resolve?url=' + encodeURIComponent(lurl.value)) } catch (e) { toast(e.message) } }
const goProduct = (p) => { location.hash = `#/item/${p.kind === 'svc' ? 'svc' : 'virt'}/${encodeURIComponent(p.id)}` }
const goCsWorkbench = () => { location.hash = '#/cs-workbench' }
async function sendNote() { try { await post(`/demo/inbox/${sel.value}/note`, { text: onote.value }); onote.value = ''; await load(true); toast('已发给外包客服') } catch (e) { err.value = e.message } }
async function askWh() { try { await post('/demo/exceptions', { text: `接管请求（${d.value.buyer}）：请仓管给 ${info.value.code} 补拍验货实拍图` }); toast('已发给主管 / 仓管') } catch (e) { toast(e.message) } }

// ---- 实物信息页：查货（两种模式都读 WMS 里的货；演示模式会话对上的货由后端直接给）
const SAFE = (u) => !/_order_|\/location|location_images|negotiat|redispatch/i.test(decodeURIComponent(String(u)))
const physItems = computed(() => state.items.filter((i) => i.kind === 'phys'))
function buildInfo(it) {
  const r = it.raw || {}, k = imageKinds(r), cost = Number(r.cost_price) || 0, key = (x) => (x.raw?.spu?.code || '') + '|' + (x.raw?.model || x.raw?.product_name || '') + '|' + (x.raw?.spec || '')
  return { code: it.code, name: it.name, grade: r.condition_grade || '', location: r.location_code || '', short_code: r.short_code || '', status: r.status, suggest_price: Number(r.suggest_price) || null, floor: cost ? Math.ceil(cost * 1.3) : 0,
    real: k.real.filter(SAFE), defect: k.defect.filter(SAFE), videos: [], slots: physItems.value.filter((x) => key(x) === key(it) && x.raw?.status === 'IN_STOCK').slice(0, 8).map((x) => ({ code: x.code, grade: x.raw?.condition_grade || '未分级', location: x.raw?.location_code || '', me: x.code === it.code })) }
}
function search() {
  const t = q.value.trim().toLowerCase(); picked.value = []
  hits.value = t ? physItems.value.filter((i) => [i.code, i.name, i.raw?.model, i.raw?.brand, i.raw?.product_name].some((x) => String(x || '').toLowerCase().includes(t))).slice(0, 6) : []
  const ex = hits.value.find((h) => String(h.code).toLowerCase() === t)
  if (ex) useSku(ex); else if (hits.value.length === 1) useSku(hits.value[0])
}
const useSku = (h) => { info.value = buildInfo(h); picked.value = [] }
const peek = computed(() => {
  const it = d.value?.item
  if (!it) return { matched: false, name: '（没有商品信息）' }
  const prod = it.product || null
  const si = state.items.find((x) => (it.sku && x.code === it.sku) || (prod && x.kind !== 'phys' && x.id === prod.id))
  const inf = si && si.kind === 'phys' ? buildInfo(si) : (info.value && info.value.code === it.sku ? info.value : null)
  const matched = !!(prod || inf)
  const price = inf?.suggest_price || si?.price || prod?.price || null
  const status = si?.raw?.status === 'IN_STOCK' ? '在售' : si?.lvl === 'red' ? '有红灯' : si ? '在库' : (prod ? '在架' : '')
  return { matched, name: prod?.name || inf?.name || si?.name || it.platform_name || '未对上', img: si?.img || (prod?.cover ? `/api/demo-img/V-${prod.cover}.jpg` : ''), price, grade: inf?.grade || si?.raw?.condition_grade || '', status, statusCls: si?.lvl === 'red' ? 'red' : si?.lvl === 'amb' ? 'amb' : 'grn', location: inf?.location || si?.raw?.location_code || '', code: inf?.code || it.sku || '' }
})
function goLink() { toast('演示：正式版只打开这条平台商品链接；站内详情不跳转') }
function doFix() { if (!fixCode.value.trim()) return toast('先写我们的货号'); toast('已提交匹配 ' + fixCode.value + '（演示），等商品档案同步'); peekFix.value = false; fixCode.value = '' }
watch(() => physItems.value.length, () => { if (isPhys.value && REAL && q.value && !info.value) search() })
watch(() => d.value?.id, () => { if (isPhys.value && d.value?.info) info.value = d.value.info })
onMounted(() => { load(); timer = setInterval(() => load(true), 15000) })
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.cs { padding: 24px 40px 70px; max-width: 1700px; } .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; } .cs h1 { font-size: 32px; margin: 6px 0; letter-spacing: -.02em; } .eyebrow { margin: 0; font-size: 13px; font-weight: 700; color: var(--acc); } .sub { margin: 0; color: var(--mute); max-width: 860px; line-height: 1.7; }
.plats { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .pl { display: inline-flex; flex-direction: column; padding: 5px 12px; border-radius: 12px; background: var(--grn-soft); color: var(--grn-ink); font-weight: 700; font-size: 13.5px; line-height: 1.25; } .pl small { font-weight: 500; font-size: 11.5px; opacity: .85; } .pl.off { background: var(--soft); color: var(--mute); }
.killbar { margin: 12px 0 0; padding: 10px 16px; border-radius: 12px; background: var(--red-soft); color: var(--red-ink); font-size: 14px; } .realnote { margin: 12px 0 0; padding: 10px 16px; border-radius: 12px; background: var(--grn-soft); color: var(--grn-ink); font-size: 13.5px; line-height: 1.6; }
.mets { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0 6px; align-items: stretch; } .met { background: var(--panel); border-radius: 14px; padding: 9px 14px; min-width: 128px; display: grid; gap: 1px; box-shadow: var(--sh); } .met span { font-size: 12.5px; color: var(--mute); } .met b { font-size: 22px; letter-spacing: -.02em; } .met small { font-size: 11.5px; color: var(--mute); max-width: 170px; } .met.live { outline: 2px solid var(--amb); } .mdm { align-self: center; }
.bystaff { margin: 4px 0 10px; font-size: 13.5px; } .bystaff summary { cursor: pointer; color: var(--acc); font-weight: 600; } .tb { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; } .tb th { text-align: left; color: var(--mute); font-weight: 700; padding: 6px 8px; } .tb td { padding: 6px 8px; border-top: 1px solid var(--line); } .tb tr.me td { background: var(--acc-soft); } .redt { color: var(--red); font-weight: 700; }
.g3 { display: grid; grid-template-columns: 360px minmax(0, 1fr) 360px; gap: 16px; align-items: start; margin-top: 10px; } @media (max-width: 1400px) { .g3 { grid-template-columns: 330px 1fr; } .rp { grid-column: 1 / -1; } } @media (max-width: 900px) { .g3 { grid-template-columns: 1fr; } }
.cs-q { padding: 10px; max-height: calc(100vh - 150px); overflow-y: auto; position: sticky; top: 10px; } .tabs2 { display: flex; gap: 3px; background: var(--soft); padding: 3px; border-radius: 12px; flex-wrap: wrap; } .tabs2 button { height: 30px; padding: 0 8px; border-radius: 9px; font-weight: 700; font-size: 12.5px; color: var(--ink2); display: inline-flex; align-items: center; gap: 4px; } .tabs2 button.on { background: var(--panel); color: var(--ink); box-shadow: var(--sh); } .tabs2 em { font-style: normal; font-size: 11.5px; color: var(--mute); }
.pf { display: flex; gap: 5px; flex-wrap: wrap; margin: 8px 2px; } .pf button { height: 26px; padding: 0 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; background: var(--soft); color: var(--ink2); } .pf button.on { background: var(--acc-soft); color: var(--acc); }
.cv { display: grid; grid-template-columns: 1fr auto; gap: 8px; width: 100%; text-align: left; padding: 9px 10px; border-radius: 13px; border-left: 4px solid transparent; } .cv:hover { background: var(--soft); } .cv.on { background: var(--acc-soft); } .cv.need { border-left-color: var(--red); } .cv.draft { border-left-color: var(--amb); } .cv.agent, .cv.bot { border-left-color: var(--grn); } .cv.human { border-left-color: var(--acc); }
.cb { min-width: 0; display: grid; gap: 2px; } .cb b { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .cb em { font-style: normal; font-size: 12px; color: var(--mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .lm { font-size: 12.5px; color: var(--ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .cr { display: grid; gap: 3px; justify-items: end; align-content: start; } .cr small { color: var(--mute); font-size: 11.5px; } .pad { padding: 12px; }
.pb { font-style: normal; font-size: 11px; font-weight: 800; padding: 1px 6px; border-radius: 6px; margin-right: 6px; background: var(--soft); color: var(--ink2); } .pb.xianyu { background: #ffe9a8; color: #6a4a00; } .pb.xhs { background: #ffd1d6; color: #8a1c2b; } .pb.taobao { background: #ffd9bd; color: #8a3b00; } .pb.jd { background: #ffc9c9; color: #8a0f0f; }
.th { padding: 0; display: grid; align-content: start; min-height: 560px; } .thh { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; } .tit { flex: 1; min-width: 220px; display: grid; gap: 3px; } .tit b small { color: var(--mute); font-weight: 400; margin-left: 8px; font-size: 12.5px; } .ln { font-size: 13px; cursor: pointer; padding: 2px 8px; border-radius: 8px; width: fit-content; } .ln.grn { background: var(--grn-soft); color: var(--grn-ink); } .ln.amb { background: var(--amb-soft); color: var(--amb-ink); } .ln.red { background: var(--red-soft); color: var(--red-ink); }
.ban { margin: 10px 16px 0; padding: 9px 13px; border-radius: 12px; font-size: 13.5px; line-height: 1.6; display: grid; gap: 2px; } .ban.red { background: var(--red-soft); color: var(--red-ink); } .ban.amb { background: var(--amb-soft); color: var(--amb-ink); }
.hand { margin: 10px 16px 0; padding: 10px 14px; border-radius: 12px; background: var(--soft); } .hand h4 { margin: 0 0 4px; font-size: 14px; } .hand h4 small { color: var(--mute); font-weight: 400; margin-left: 8px; font-size: 12px; } .hand dl { display: grid; grid-template-columns: 90px 1fr; gap: 3px 10px; margin: 0; font-size: 13px; } .hand dt { color: var(--mute); } .hand dd { margin: 0; } .cmt { margin: 8px 16px 0; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 13px; }
.msgs { padding: 12px 16px; display: grid; gap: 9px; align-content: start; max-height: 380px; overflow-y: auto; } .m { max-width: 80%; } .m p { margin: 3px 0 0; padding: 8px 12px; border-radius: 14px; background: var(--soft); font-size: 14px; line-height: 1.6; white-space: pre-wrap; } .mw { font-size: 11.5px; color: var(--mute); } .mw i { font-style: normal; margin-left: 6px; } .st { white-space: nowrap; margin-left: 6px; font-size: 11px; padding: 0 6px; border-radius: 6px; } .st.q { background: var(--amb-soft); color: var(--amb-ink); } .st.f { background: var(--red-soft); color: var(--red-ink); }
.m.out { justify-self: end; text-align: right; } .m.bot p, .m.agent p { background: var(--grn-soft); color: var(--grn-ink); text-align: left; } .m.staff p { background: var(--acc-soft); color: var(--ink); text-align: left; } .m.outsource p { background: var(--soft); text-align: left; } .m.sys { justify-self: center; text-align: center; max-width: 92%; } .m.sys p { background: none; color: var(--mute); font-size: 12.5px; padding: 2px; }
.mcard, .mloc { margin-top: 4px; padding: 6px 10px; border-radius: 10px; background: var(--panel); border: 1px solid var(--line); font-size: 13px; text-align: left; } .mimgs { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; justify-content: flex-end; } .mimgs img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; } .mhint { display: block; color: var(--amb-ink); font-size: 11.5px; } .lk { display: inline-block; margin: 3px 4px 0 0; padding: 1px 8px; border-radius: 8px; font-size: 11.5px; } .lk.grn { background: var(--grn-soft); color: var(--grn-ink); } .lk.amb { background: var(--amb-soft); color: var(--amb-ink); } .lk.red { background: var(--red-soft); color: var(--red-ink); }
.dfc { margin: 4px 16px 10px; padding: 12px 14px; border-radius: 14px; border: 2px solid var(--amb); background: var(--amb-soft); color: var(--ink); } .dfc h4 { margin: 0 0 4px; font-size: 14.5px; } .dfc h4 small { color: var(--mute); font-weight: 500; margin-left: 8px; } .dfc .why { margin: 0 0 6px; font-size: 12.5px; color: var(--ink2); } .dfc textarea { width: 100%; min-height: 70px; border: 1px solid var(--line); border-radius: 10px; padding: 8px; background: var(--panel); color: var(--ink); font: inherit; } .bas { margin: 6px 0; display: flex; gap: 6px; flex-wrap: wrap; }
.ctabs { display: flex; gap: 2px; border-top: 1px solid var(--line); padding: 8px 16px 0; } .ctabs button { height: 34px; padding: 0 14px; border-radius: 10px 10px 0 0; font-weight: 700; font-size: 13.5px; color: var(--mute); } .ctabs button.on { background: var(--soft); color: var(--ink); } .ctabs small { margin-left: 6px; font-weight: 500; font-size: 11.5px; }
.comp { padding: 12px 16px; display: grid; gap: 8px; background: var(--soft); border-radius: 0 0 16px 16px; } .off { display: flex; align-items: center; gap: 12px; justify-content: space-between; color: var(--ink2); font-size: 14px; } .qk { display: flex; gap: 6px; flex-wrap: wrap; } .chip { height: 26px; padding: 0 11px; border-radius: 999px; background: var(--panel); font-size: 12.5px; font-weight: 600; color: var(--ink2); } .chip:hover { background: var(--acc-soft); color: var(--acc); }
.oneclick { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 8px 10px; border-radius: 12px; background: var(--panel); font-size: 13px; } .comp textarea { width: 100%; min-height: 66px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--ink); padding: 9px; font: inherit; } .cf, .rw { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .cin { flex: 1; min-width: 180px; height: 36px; border: 1px solid var(--line); border-radius: 10px; padding: 0 10px; background: var(--panel); color: var(--ink); font: inherit; }
.rel { padding: 10px; border-radius: 12px; background: var(--panel); display: grid; gap: 8px; } .imsgs { display: grid; gap: 6px; max-height: 220px; overflow-y: auto; } .im { max-width: 85%; } .im.agent { justify-self: start; } .im.staff { justify-self: end; text-align: right; } .im span { font-size: 11.5px; color: var(--mute); } .im p { margin: 2px 0 0; padding: 7px 11px; border-radius: 12px; background: var(--panel); font-size: 13.5px; } .im.agent p { background: var(--grn-soft); color: var(--grn-ink); }
.errbox { margin: 0 16px 12px; } .btn.sm { font-size: 12.5px; }
.pv { display: flex; gap: 10px; align-items: center; margin: 10px 16px 0; padding: 10px; border-radius: 14px; background: var(--soft); border: 1px solid var(--line); }
.pv.miss { border-color: var(--amb); background: var(--amb-soft); }
.pvi { width: 64px; height: 64px; border-radius: 12px; overflow: hidden; flex: none; background: var(--panel); display: flex; align-items: center; justify-content: center; color: var(--mute); font-size: 11px; } .pvi img { width: 100%; height: 100%; object-fit: cover; } .pvi.ph { border: 1px dashed var(--line); }
.pvb { flex: 1; min-width: 0; display: grid; gap: 3px; } .pvb b { font-size: 14px; } .pvm { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 12.5px; } .pvn { font-size: 11.5px; color: var(--mute); }
.pva { display: flex; flex-direction: column; gap: 5px; flex: none; }
.pmask { position: fixed; inset: 0; z-index: 80; background: rgba(8, 12, 22, .55); display: flex; align-items: center; justify-content: center; padding: 18px; }
.pmodal { width: min(680px, 100%); max-height: 90vh; overflow: auto; background: var(--panel); border-radius: 20px; padding: 20px 22px; box-shadow: var(--sh-up); } .pmh { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; } .pmh h3 { margin: 0; font-size: 20px; }
.pmb { display: grid; grid-template-columns: 200px 1fr; gap: 16px; margin: 12px 0; align-items: start; } @media (max-width: 700px) { .pmb { grid-template-columns: 1fr; } .pv { flex-wrap: wrap; } .pva { flex-direction: row; } }
.pmpic { width: 100%; aspect-ratio: 1 / 1; border-radius: 16px; overflow: hidden; background: var(--soft); display: flex; align-items: center; justify-content: center; color: var(--mute); font-size: 12px; } .pmpic img { width: 100%; height: 100%; object-fit: cover; } .pmpic.ph { border: 1px dashed var(--line); }
.pfix { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0; padding: 10px; border-radius: 12px; background: var(--amb-soft); } .pfix input { flex: 1; min-width: 160px; height: 34px; border: 1px solid var(--line); border-radius: 9px; padding: 0 9px; background: var(--panel); color: var(--ink); }
.pmf { display: flex; justify-content: flex-end; gap: 8px; }

.rp { padding: 12px 14px; } .rtabs { display: flex; gap: 3px; background: var(--soft); padding: 3px; border-radius: 12px; margin-bottom: 8px; flex-wrap: wrap; } .rtabs button { flex: 1; height: 30px; padding: 0 8px; border-radius: 9px; font-weight: 700; font-size: 12.5px; color: var(--ink2); } .rtabs button.on { background: var(--panel); color: var(--ink); box-shadow: var(--sh); }
.pn h4 { margin: 8px 0 6px; font-size: 14.5px; } .pn .k { margin: 12px 0 4px; font-size: 12.5px; font-weight: 800; color: var(--ink2); } .pn ul { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.7; color: var(--ink2); } .sm { font-size: 12px; } .lcard { padding: 9px 12px; border-radius: 12px; margin: 6px 0; display: grid; gap: 2px; font-size: 13px; } .lcard span { color: var(--mute); font-size: 12px; } .lcard p { margin: 2px 0; } .lcard a { color: var(--acc); cursor: pointer; } .lcard.grn { background: var(--grn-soft); color: var(--grn-ink); } .lcard.amb { background: var(--amb-soft); color: var(--amb-ink); } .lcard.red { background: var(--red-soft); color: var(--red-ink); } .lcard .muted { color: inherit; opacity: .85; }
.acard { padding: 10px 12px; border-radius: 12px; background: var(--soft); display: grid; gap: 6px; } .acard dl, .kv { display: grid; grid-template-columns: 78px 1fr; gap: 5px 10px; margin: 0; font-size: 13px; } .acard dt, .kv dt { color: var(--mute); } .acard dd, .kv dd { margin: 0; } .md { display: flex; gap: 8px; align-items: flex-start; padding: 7px 10px; border-radius: 11px; margin: 4px 0; cursor: pointer; } .md.on { background: var(--acc-soft); } .md small { display: block; color: var(--mute); font-size: 12px; font-weight: 400; } .md b { font-size: 13.5px; }
.stp { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; } .stp li { display: flex; gap: 9px; font-size: 13px; color: var(--mute); } .stp i { flex: none; width: 22px; height: 22px; border-radius: 50%; background: var(--soft); border: 2px solid var(--line); display: flex; align-items: center; justify-content: center; font-style: normal; font-weight: 800; font-size: 11px; } .stp li.done { color: var(--grn-ink); } .stp li.done i { background: var(--grn); border-color: var(--grn); color: #fff; } .stp li.cur { color: var(--acc); font-weight: 700; } .stp li.cur i { background: var(--acc); border-color: var(--acc); color: #fff; }
.hits { display: grid; gap: 4px; margin: 6px 0; } .hits button { display: flex; gap: 10px; padding: 7px 10px; border-radius: 10px; background: var(--soft); text-align: left; font-size: 13px; } .hits button.on { background: var(--acc-soft); } .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 8px 0; } .facts div { background: var(--soft); border-radius: 10px; padding: 6px 10px; display: grid; } .facts span { font-size: 11.5px; color: var(--mute); } .facts b { font-size: 13.5px; }
.pics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; } .pic { position: relative; display: block; } .pic img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 9px; display: block; background: var(--soft); } .pic input { position: absolute; left: 5px; top: 5px; width: 17px; height: 17px; } .pic small { position: absolute; right: 4px; bottom: 4px; background: rgba(0, 0, 0, .6); color: #fff; padding: 0 6px; border-radius: 6px; font-size: 11px; } .pic small.d { background: var(--red); }
.warn { margin: 6px 0; padding: 9px 12px; border-radius: 12px; background: var(--red-soft); color: var(--red-ink); font-size: 13px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .nt { padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px; }
.db-pill { background: var(--acc-soft) !important; color: var(--acc) !important; }
.mvid { margin-top: 4px; padding: 8px 12px; border-radius: 12px; background: #0f172a; color: #fff; font-size: 13px; text-align: left; display: grid; gap: 2px; }
.mvid span { font-size: 11.5px; color: #94a3b8; }
.plus-toggle.on { background: var(--ink); color: #fff; }
.plus-grid-wrap { padding: 12px; border-radius: 14px; background: var(--panel); border: 1px solid var(--line); display: grid; gap: 10px; }
.pg-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.plus-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
@media (max-width: 820px) { .plus-grid { grid-template-columns: repeat(2, 1fr); } }
.pg-btn { padding: 9px 8px; border-radius: 12px; background: var(--soft); border: 1.5px solid transparent; display: grid; gap: 2px; text-align: center; transition: all .12s; }
.pg-btn:hover, .pg-btn.on { background: var(--acc-soft); border-color: var(--acc); }
.pg-btn i { font-style: normal; font-size: 18px; }
.pg-btn b { font-size: 12.5px; color: var(--ink); }
.pg-btn span { font-size: 11px; color: var(--mute); }
.addr-pool { padding: 10px; border-radius: 12px; background: var(--soft); display: grid; gap: 6px; }
.addr-list { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; max-height: 190px; overflow-y: auto; }
@media (max-width: 820px) { .addr-list { grid-template-columns: 1fr; } }
.addr-item { text-align: left; padding: 7px 10px; border-radius: 9px; background: var(--panel); border: 1px solid var(--line); display: grid; gap: 2px; }
.addr-item:hover { border-color: var(--acc); }
.addr-item b { font-size: 12px; color: var(--acc); }
.addr-item span { font-size: 11.5px; color: var(--ink2); }
</style>
