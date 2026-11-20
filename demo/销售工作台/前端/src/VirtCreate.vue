<template>
  <div class="vc-page">
    <!-- 顶部全流程向导导航条（一步一个大页面 + 同行工具软件调研对标切换） -->
    <nav class="wizard-bar card">
      <button class="btn sm" @click="goBack">← 返回虚拟商品 Gallery</button>

      <div class="wiz-steps">
        <button class="wstep" :class="{ cur: step === 1, done: step1Ok && step !== 1 }" @click="step = 1">
          <i>1</i><span>第 1 步：分类挂点 &amp; 抄同行（判通道）</span>
        </button>
        <span class="wsep">→</span>
        <button class="wstep" :class="{ cur: step === 2, done: step2Ok && step !== 2 }" @click="goStep(2)">
          <i>2</i><span>第 2 步：取得路径 &amp; 算账底线（防倒挂）</span>
        </button>
        <span class="wsep">→</span>
        <button class="wstep" :class="{ cur: step === 3 }" @click="goStep(3)">
          <i>3</i><span>第 3 步：卡密洗重 &amp; 阿奇索防骗直发</span>
        </button>
      </div>

      <button class="btn sm" :class="{ 'bench-on': step === 'bench' }" @click="step = step === 'bench' ? 1 : 'bench'">
        📊 {{ step === 'bench' ? '返回新增向导' : '同行工具软件调研对标（REA）' }}
      </button>
    </nav>

    <!-- 一键载入真实业务样板条（4 种核心虚拟商品形态） -->
    <section v-if="step !== 'bench'" class="tpl-bar card">
      <div class="tpl-left">
        <b>⚡ 一键填入样板（快速体验 4 类典型场景）：</b>
        <span class="muted">也可以直接在下方从零填写；机器会自动做通道初审、底线核算与卡密去重。</span>
      </div>
      <div class="tpl-btns">
        <button
          v-for="t in meta.templates"
          :key="t.id"
          class="tpl-chip"
          :class="{ on: activeTpl === t.id }"
          @click="applyTemplate(t)"
        >
          <span>{{ t.label }}</span>
        </button>
      </div>
    </section>

    <!-- ==================== 独立大面板：同行工具软件深度调研对标（REA） ==================== -->
    <template v-if="step === 'bench'">
      <section class="card bench-hero">
        <div class="bh-head">
          <div>
            <p class="eyebrow">COMPETITOR SOFTWARE RESEARCH · 同行虚拟商品工具栈全景调研</p>
            <h1>同行都在用什么工具卖虚拟商品？我们吸收什么、补齐什么？</h1>
            <p class="sub">
              闲鱼/淘宝头部虚拟卖家并非手工发码，标准工具栈是<b>「闲管家（30号矩阵铺货+售出自动重发） + 阿奇索/91卡券（毫秒发卡+三大防白嫖拦截） + 福禄/橙券（零库存直充货源）」</b>。
              但外部工具<b>只管发卡、不管选品算账与合规</b>——我们在本工作台把两头彻底打通闭环。
            </p>
          </div>
          <button class="btn pri" @click="step = 1">回到向导立即建卡 →</button>
        </div>

        <div class="absorb-grid">
          <div class="ab-box grn">
            <b>✓ 已直接照搬进工作台的同行杀手锏</b>
            <ul>
              <li><b>阿奇索 91卡券洗重入库</b>：批量粘贴卡密当场自动剔除空行与重复码，设低库存提醒线、售罄自动停发。</li>
              <li><b>阿奇索三大防白嫖闸门</b>：历史退款 ≥N 次转人工、黑名单拦截、<b>上一笔未确认收货禁发新卡密（防连拍套卡）</b>。</li>
              <li><b>智能退单分流</b>：未发码退款秒同意保权重；已发码退款一律转人工核查核销状态。</li>
              <li><b>闲管家多号分发 + 售出重发</b>：勾选多闲鱼号铺货，开启「卖出自动补库存重新上架」，不断流。</li>
              <li><b>福禄/橙券直充规范</b>：来一单充一单 0 库存，强制禁索要买家密码/验证码，上游涨价超阈值自动熔断。</li>
            </ul>
          </div>
          <div class="ab-box acc">
            <b>🛡 同行软件缺失、我们工作台独有的风控护城河</b>
            <ul>
              <li><b>机器自动分流「跟卖直发」vs「8 步路测」</b>：有同行在售证据免实测直发；无同行新券强制锁定第 5 步小额实测 + 第 6 步他人复现。</li>
              <li><b>C01 优惠取得路径硬约束</b>：必须交代清楚低价券源从哪来（批采/银行活动/积分池/AI提效），杜绝灰产黑卡。</li>
              <li><b>单笔净贡献与底线倍数防倒挂</b>：自动扣除 1.6% 平台费与售后预留，低于 105%/130% 底线标红拦截。</li>
              <li><b>建卡人 + 交付人提成自动绑定</b>：交付 10%/20% + 建卡人 6 个月 5% + 上新奖（跟卖 ¥20 / 路测 ¥200），退单自动回冲。</li>
              <li><b>零官僚审批卡点</b>：机器初审做完筛重与底线校验，业务员人工核对确认即直接上架，不走层层主管审批流。</li>
            </ul>
          </div>
        </div>
      </section>

      <div class="tool-grid">
        <article v-for="t in meta.tools" :key="t.id" class="card tool-card">
          <div class="tc-top">
            <div>
              <span class="tag acc">{{ t.badge }}</span>
              <h3>{{ t.name }}</h3>
            </div>
            <div class="tc-plats">
              <span v-for="pl in t.platforms" :key="pl" class="tag">{{ pl }}</span>
            </div>
          </div>
          <div class="tc-sec">
            <b>同行核心强项</b>
            <ul>
              <li v-for="(s, idx) in t.strengths" :key="idx">{{ s }}</li>
            </ul>
          </div>
          <div class="tc-sec warn">
            <b>单买它的业务盲区</b>
            <p>{{ t.blindspots }}</p>
          </div>
          <div class="tc-sec ok">
            <b>本工作台吸收落点</b>
            <p>{{ t.our_absorption }}</p>
          </div>
        </article>
      </div>
    </template>

    <!-- ==================== 第 1 步（独立大页面）：分类挂点 & 抄同行（自动判通道） ==================== -->
    <template v-else-if="step === 1">
      <div class="step-banner" :class="hasValidPeers ? 'grn' : 'amb'">
        <div>
          <span class="sb-pill">{{ hasValidPeers ? '✓ 机器初审：走【跟卖型直发通道】' : '⚠ 机器初审：走【8 步路测通道】' }}</span>
          <h2>
            {{ hasValidPeers
              ? `已核验 ${validPeers.length} 条同行在售价格锚点（同行中位价 ¥${peerMedian}）—— 免做第 5/6 步实测，核对后直接上架！`
              : '当前无有效同行在售链接 —— 系统强制锁定第 5 步「小额实测」与第 6 步「他人复现」，验证真能核销后才可上架！' }}
          </h2>
          <p>
            {{ hasValidPeers
              ? '规则依据：同行已经在卖且跑通核销闭环，首单就是实测；上架 30 天内出首单发上新奖 ¥20。'
              : '规则依据：自研新组合或地方新活动券没有同行验证过，严禁跳步直接挂牌；实测复现过关发 ¥100，出首单再发 ¥100（共 ¥200）。' }}
          </p>
        </div>
        <button class="btn pri lg" @click="goStep(2)">下一步：核取得路径与算账底线 →</button>
      </div>

      <div class="two-col">
        <!-- 左卡：分类节点与基础身份 -->
        <section class="card pane">
          <div class="pane-head">
            <span class="step-num">1A</span>
            <div>
              <h3>挂到虚拟选品 Gallery 节点 &amp; 商品身份</h3>
              <p class="muted">先选大类与子类，系统自动联动推荐交付形态、默认底线倍数与封面图。</p>
            </div>
          </div>

          <div class="cat-big-row">
            <button
              v-for="c in meta.categories"
              :key="c.big"
              type="button"
              class="big-cat-btn"
              :class="{ on: form.cat_big === c.big }"
              @click="selectBigCat(c)"
            >
              <b>{{ c.big }}</b>
              <span>{{ c.desc }}</span>
            </button>
          </div>

          <div class="sub-cat-row" v-if="currentBigCat">
            <span class="lbl">细分子类：</span>
            <button
              v-for="s in currentBigCat.subs"
              :key="s.code"
              type="button"
              class="sub-pill"
              :class="{ on: form.cat_sub === s.name }"
              @click="selectSubCat(s)"
            >
              {{ s.name }}
            </button>
          </div>

          <div class="form-grid">
            <label class="full">
              <span>商品卡名称 <em>*（写清品牌 + 面值规格 + 交付特征，至少 4 字）</em></span>
              <input class="inp" v-model="form.name" placeholder="例如：星巴克 大杯手工调制饮品通兑电子券（全国门店秒发）" />
            </label>
            <label>
              <span>品牌 / 发行方 <em>*</em></span>
              <input class="inp" v-model="form.brand" placeholder="例如：星巴克 / 哔哩哔哩 / 自营" />
            </label>
            <label>
              <span>三级细分品类（选填）</span>
              <input class="inp" v-model="form.cat_leaf" :placeholder="currentSubCat?.leaf_hint || '例如：连锁咖啡茶饮'" />
            </label>
            <label>
              <span>面值 / 规格说明 <em>*</em></span>
              <input class="inp" v-model="form.face" placeholder="例如：大杯 38 元档通兑 · 全国直营可用" />
            </label>
            <label>
              <span>适用地区</span>
              <input class="inp" v-model="form.region" placeholder="全国 / 浙江·杭州" />
            </label>
            <label>
              <span>有效期口径</span>
              <input class="inp" v-model="form.valid" placeholder="例如：出码后 30 天内有效" />
            </label>
            <label>
              <span>合规初判等级（异步交律师审，不卡建卡）</span>
              <select class="inp" v-model="form.compliance_level">
                <option value="A">A 级 · 标准商超餐饮券/自有原创（转让无限制）</option>
                <option value="B">B 级 · 常规平台权益/技术服务（注意说明边界）</option>
                <option value="C">C 级 · 地方抢券/账号代充类（同步推律师重点核查）</option>
              </select>
            </label>
          </div>

          <div class="cover-picker">
            <span class="lbl">选择卡片封面图（直接选用本地高清功能封面，杜绝空图断图）：</span>
            <div class="cover-grid">
              <button
                v-for="cv in meta.covers"
                :key="cv.id"
                type="button"
                class="cv-item"
                :class="{ on: form.cover === cv.id }"
                @click="form.cover = cv.id"
              >
                <img :src="`/api/demo-img/V-${cv.id}.jpg`" :alt="cv.label" />
                <span>{{ cv.label }}</span>
              </button>
            </div>
          </div>
        </section>

        <!-- 右卡：同行在售摸底与三榜信号 -->
        <section class="card pane">
          <div class="pane-head">
            <span class="step-num">1B</span>
            <div>
              <h3>同行在售链接摸底 &amp; 三榜信号（对标鱼店长/闲管家）</h3>
              <p class="muted">填至少 1 条真实同行挂牌与售价即可走「跟卖直发」；若全网没人卖则清空同行走路测。</p>
            </div>
          </div>

          <div class="peer-toolbar">
            <button type="button" class="btn sm pri" @click="addPeer">+ 添加一条同行在售记录</button>
            <button v-if="form.peers.length" type="button" class="btn sm" @click="clearPeers">清空同行（切换模拟无同行路测）</button>
          </div>

          <div v-if="form.peers.length" class="peer-list">
            <div v-for="(pr, idx) in form.peers" :key="idx" class="peer-row">
              <select class="inp plat-sel" v-model="pr.platform">
                <option value="闲鱼">闲鱼</option>
                <option value="淘宝">淘宝</option>
                <option value="拼多多">拼多多</option>
                <option value="京东">京东</option>
              </select>
              <input class="inp" v-model="pr.shop" placeholder="同行店铺名或闲鱼挂牌号（必填）" />
              <input class="inp num-inp" type="number" step="0.1" v-model.number="pr.price" placeholder="同行价 ¥" />
              <input class="inp num-inp" type="number" v-model.number="pr.sales" placeholder="销量/想要" />
              <input class="inp" v-model="pr.url" placeholder="同行商品链接（选填）" />
              <button type="button" class="btn sm del-btn" @click="form.peers.splice(idx, 1)">删除</button>
            </div>
          </div>
          <div v-else class="empty-peers">
            <b>当前未录入任何同行在售记录</b>
            <p>如果闲鱼/淘宝已有同行在卖同款，请点上方「+ 添加一条同行在售记录」直接走跟卖直发；若确实是全网首发或本地独家新券，保持为空即可进入 8 步路测流程。</p>
          </div>

          <div class="sig-box">
            <h4>闲鱼行情价格带汇总（随上方同行记录自动推算，也可微调）</h4>
            <div class="form-grid cols-4">
              <label>
                <span>样本挂牌条数</span>
                <input class="inp" type="number" v-model.number="form.xianyu_signal.sales" />
              </label>
              <label>
                <span>最低挂牌价 (¥)</span>
                <input class="inp" type="number" step="0.1" v-model.number="form.xianyu_signal.price_lo" />
              </label>
              <label>
                <span>最高挂牌价 (¥)</span>
                <input class="inp" type="number" step="0.1" v-model.number="form.xianyu_signal.price_hi" />
              </label>
              <label>
                <span>同行中位价 (¥)</span>
                <input class="inp" type="number" step="0.1" v-model.number="form.xianyu_signal.median" />
              </label>
            </div>
            <p class="muted sm" style="margin-top: 8px">注：淘宝榜、京东榜爬虫（B11）尚未接入，系统自动按真实情况标「未采集」，绝不伪造填 0。</p>
          </div>

          <!-- 实时卡片外观小预览 -->
          <div class="mini-preview">
            <img :src="`/api/demo-img/V-${form.cover || 'starbucks'}.jpg`" alt="封面预览" />
            <div>
              <div class="mp-tags">
                <span class="tag" :class="hasValidPeers ? 'grn' : 'amb'">{{ hasValidPeers ? '跟卖直发' : '8步路测' }}</span>
                <span class="tag">{{ form.cat_sub }}</span>
                <span class="tag">{{ form.compliance_level }} 级合规</span>
              </div>
              <h4>{{ form.name || '（待填写虚拟商品标题）' }}</h4>
              <p class="muted">{{ form.brand || '品牌' }} · {{ form.face || '规格' }} · {{ form.region || '全国' }}</p>
            </div>
          </div>
        </section>
      </div>

      <footer class="step-foot card">
        <span class="muted">第 1 / 3 步：确认分类挂点与同行在售情况</span>
        <button class="btn pri lg" @click="goStep(2)">下一步：核取得路径与算账底线 →</button>
      </footer>
    </template>

    <!-- ==================== 第 2 步（独立大页面）：C01 取得路径 & 算账底线（防倒挂 + 分账） ==================== -->
    <template v-else-if="step === 2">
      <div class="two-col">
        <!-- 左卡：C01 优惠取得路径 -->
        <section class="card pane">
          <div class="pane-head">
            <span class="step-num">2A</span>
            <div>
              <h3>C01 优惠取得路径与利润锚点（说不清货源不准建卡）</h3>
              <p class="muted">所有可盈利虚拟品必有合法的「价格差 / 渠道差 / 效率差」，严禁接入来路不明的盗刷黑卡。</p>
            </div>
          </div>

          <span class="lbl">利润来源锚点类型（必选其一）：</span>
          <div class="anchor-grid">
            <button
              v-for="an in ANCHORS"
              :key="an.t"
              type="button"
              class="anchor-card"
              :class="{ on: form.profit_anchor === an.t }"
              @click="form.profit_anchor = an.t"
            >
              <b>{{ an.t }}</b>
              <span>{{ an.d }}</span>
            </button>
          </div>

          <div class="form-grid" style="margin-top: 16px">
            <label class="full">
              <span>主取得路径（必填：具体从哪个券商/平台/活动拿货） <em>*</em></span>
              <input class="inp" v-model="form.sourcing_main" placeholder="例如：91卡券认证一级券商批采 / 福禄开放平台 API 直充" />
            </label>
            <label class="full">
              <span>备选兜底路径（主渠道断货或涨价时切哪里，没有填「无」）</span>
              <input class="inp" v-model="form.sourcing_backup" placeholder="例如：橙券直充后台手动补发 / 无" />
            </label>
            <label>
              <span>买家使用资格限制</span>
              <input class="inp" v-model="form.sourcing_qualify" placeholder="例如：全国直营可用，无需新户资格" />
            </label>
            <label>
              <span>拿货额度与频次上限</span>
              <input class="inp" v-model="form.sourcing_quota" placeholder="例如：每周稳定 200 张 / API 不限量" />
            </label>
          </div>
        </section>

        <!-- 右卡：机器算账底线校验与拍板提成预览 -->
        <section class="card pane">
          <div class="pane-head">
            <span class="step-num">2B</span>
            <div>
              <h3>机器算账初审 &amp; 提成分账试算</h3>
              <p class="muted">单笔净贡献 = 售价 − 进价 − 平台技术服务费(1.6%) − 售后损耗预留。</p>
            </div>
          </div>

          <div class="form-grid">
            <label>
              <span>单张/单次进价 Cost (¥) <em>*</em></span>
              <input class="inp big-num" type="number" step="0.1" v-model.number="form.cost" />
            </label>
            <label>
              <span>
                拟定统一售价 Price (¥) <em>*</em>
                <button v-if="peerMedian > 0" type="button" class="inline-fill" @click="form.price = +(peerMedian - 0.4).toFixed(1)">
                  按同行中位价 ¥{{ peerMedian }} 减 ¥0.4
                </button>
              </span>
              <input class="inp big-num" type="number" step="0.1" v-model.number="form.price" />
            </label>
            <label>
              <span>平台费率（闲鱼/淘宝常规 1.6%）</span>
              <input class="inp" type="number" step="0.001" v-model.number="form.platform_fee_rate" />
            </label>
            <label>
              <span>单笔售后损耗预留 (¥)</span>
              <input class="inp" type="number" step="0.1" v-model.number="form.after_sale_reserve" />
            </label>
            <label>
              <span>机器防倒挂底线倍数 (%)</span>
              <input class="inp" type="number" v-model.number="form.floor_pct" />
            </label>
          </div>

          <!-- 机器实时核算仪表盘 -->
          <div class="calc-board" :class="priceGuard.lvl">
            <div class="cb-metrics">
              <div>
                <span>单笔净贡献毛利</span>
                <b :class="{ bad: unitProfit <= 0 }">¥{{ unitProfit.toFixed(2) }}</b>
                <small>平台费 ¥{{ platformFee.toFixed(2) }} · 预留 ¥{{ Number(form.after_sale_reserve || 0).toFixed(2) }}</small>
              </div>
              <div>
                <span>售价占进价倍数</span>
                <b>{{ costPct }}%</b>
                <small>底线要求 ≥ {{ form.floor_pct }}%（¥{{ floorPrice.toFixed(2) }}）</small>
              </div>
              <div>
                <span>同行中位价对照</span>
                <b>{{ peerMedian ? '¥' + peerMedian : '无同行' }}</b>
                <small>{{ peerMedian && form.price ? (form.price <= peerMedian ? '✓ 具备价格竞争力' : '高于同行中位价，注意转化') : '路测自主定价' }}</small>
              </div>
            </div>
            <p class="cb-verdict">{{ priceGuard.msg }}</p>
            <label v-if="needOverrideReason" class="override-box">
              <span>⚠ 低于机器底线特批说明（必填 ≥3 字方可继续，留痕备查，无需等主管审批）：</span>
              <input class="inp" v-model="form.override_reason" placeholder="例如：店铺引流首单款，带动店内高毛利套餐连带成交" />
            </label>
          </div>

          <!-- 提成账本实时预览 -->
          <div class="comm-preview">
            <h4>💰 提成分账实时预览（负责人已拍板规则，退单自动扣回）</h4>
            <table class="tbl">
              <tr><th>角色</th><th>计算口径</th><th>本卡预计收益</th></tr>
              <tr>
                <td><b>交付人提成</b></td>
                <td>净贡献毛利 × {{ isSvcKind ? '20%（服务类）' : '10%（码券/权益类）' }}</td>
                <td class="num"><b>¥{{ Math.max(0, unitProfit * (isSvcKind ? 0.2 : 0.1)).toFixed(2) }} / 单</b></td>
              </tr>
              <tr>
                <td><b>建卡人长期分成</b></td>
                <td>上架后 6 个月内享净贡献毛利 × 5%</td>
                <td class="num"><b>¥{{ Math.max(0, unitProfit * 0.05).toFixed(2) }} / 单</b></td>
              </tr>
              <tr>
                <td><b>立项上新奖</b></td>
                <td>{{ hasValidPeers ? '跟卖型：上架 30 天内出首单即发' : '路测型：实测复现过关发 ¥100 + 首单发 ¥100' }}</td>
                <td class="num"><b>¥{{ hasValidPeers ? 20 : 200 }}</b></td>
              </tr>
            </table>
          </div>
        </section>
      </div>

      <footer class="step-foot card">
        <button class="btn lg" @click="step = 1">← 上一步：改分类与同行</button>
        <span class="muted">第 2 / 3 步：确认优惠取得路径与毛利底线</span>
        <button class="btn pri lg" @click="goStep(3)">下一步：配发货卡密与防骗风控 →</button>
      </footer>
    </template>

    <!-- ==================== 第 3 步（独立大页面）：卡密洗重 & 阿奇索防骗直发 ==================== -->
    <template v-else-if="step === 3">
      <div class="two-col">
        <!-- 左卡：5 种标准交付形态 + 卡密机器洗重池 -->
        <section class="card pane">
          <div class="pane-head">
            <span class="step-num">3A</span>
            <div>
              <h3>选择交付形态 &amp; 卡密机器洗重入库（对标阿奇索 91卡券 / 福禄）</h3>
              <p class="muted">唯一卡密支持整批粘贴，机器自动剔除空行与重复卡密，确认无误即建库。</p>
            </div>
          </div>

          <div class="deliv-grid">
            <button
              v-for="d in DELIVERIES"
              :key="d.k"
              type="button"
              class="deliv-btn"
              :class="{ on: form.delivery === d.k }"
              @click="switchDelivery(d.k)"
            >
              <b>{{ d.title }}</b>
              <span>{{ d.sub }}</span>
            </button>
          </div>

          <!-- 形态 1：唯一卡密（阿奇索 91卡券式洗重台） -->
          <div v-if="form.delivery === 'card'" class="deliv-body">
            <div class="form-grid cols-3">
              <label>
                <span>首批供货来源备注</span>
                <input class="inp" v-model="form.supplier" placeholder="例如：91卡券华东券商" />
              </label>
              <label>
                <span>卡密有效期至</span>
                <input class="inp" v-model="form.expire" placeholder="2026-12-31" />
              </label>
              <label>
                <span>低库存黄灯预警线（张）</span>
                <input class="inp" type="number" min="1" v-model.number="form.warn_at" />
              </label>
            </div>

            <label class="paste-lbl">
              <span>
                📋 批量粘贴卡密（一行一张，支持 <code>卡号----卡密</code>、兑换码或短链；路测期可先留空）
              </span>
              <textarea
                class="card-textarea"
                v-model="form.raw_cards"
                rows="7"
                placeholder="在此粘贴整批卡密，机器将实时自动剔除空行与重复卡密……&#10;示例：&#10;SBUX-2026-8841-9920----7361&#10;SBUX-2026-8841-9921----1048"
              ></textarea>
            </label>

            <!-- 机器初审洗重统计横幅 -->
            <div class="dedup-bar" :class="cardStats.net_imported > 0 ? 'grn' : 'amb'">
              <div class="dd-pills">
                <span>原始粘贴 <b>{{ cardStats.raw_lines }}</b> 行</span>
                <span>机器剔除空行 <b>{{ cardStats.empty_removed }}</b> 行</span>
                <span :class="{ hit: cardStats.duplicates_removed > 0 }">
                  机器拦截重复码 <b>{{ cardStats.duplicates_removed }}</b> 条
                </span>
                <span class="net">净入库有效卡密 <b>{{ cardStats.net_imported }}</b> 张</span>
              </div>
              <div v-if="cardStats.duplicate_samples.length" class="dup-warn">
                已自动过滤重复卡密：<code>{{ cardStats.duplicate_samples.join(' , ') }}</code>
              </div>
              <div v-if="cardStats.preview_masked.length" class="mask-preview">
                <small>入库脱敏预览：</small>
                <code v-for="(m, i) in cardStats.preview_masked" :key="i">{{ m }}</code>
              </div>
            </div>
          </div>

          <!-- 形态 2：无卡密·固定内容（网盘/口令循环发） -->
          <div v-else-if="form.delivery === 'nocard'" class="deliv-body">
            <label class="paste-lbl">
              <span>🔗 固定自动发货内容载荷（付款后系统向每位买家自动发送同一份网盘链接/提取码） <em>*</em></span>
              <textarea
                class="card-textarea"
                v-model="form.fixed_payload"
                rows="4"
                placeholder="例如：夸克网盘：https://pan.quark.cn/s/xxxx 提取码：8866 ｜ 备用百度网盘：https://pan.baidu.com/s/xxxx 提取码：paya"
              ></textarea>
            </label>
            <p class="muted sm">提示：建议同时配置主备双网盘链接，防止单一网盘分享被和谐导致买家秒退。</p>
          </div>

          <!-- 形态 3：直充 / 代充（福禄/橙券 0 库存模式） -->
          <div v-else-if="form.delivery === 'topup'" class="deliv-body">
            <div class="form-grid">
              <label class="full">
                <span>上游直充接口 / 代充渠道</span>
                <input class="inp" v-model="form.upstream" placeholder="例如：福禄开放平台 API / 橙券直充后台" />
              </label>
              <label class="full">
                <span>买家拍下必填账号提示（严禁向买家索要登录密码或短信验证码！）</span>
                <input class="inp" v-model="form.buyer_prompt" placeholder="例如：请发送充值手机号或 UID，绝不需要密码与验证码" />
              </label>
              <label>
                <span>上游涨价自动熔断阈值 (%)</span>
                <input class="inp" type="number" v-model.number="form.price_hike_stop_pct" />
              </label>
            </div>
          </div>

          <!-- 形态 4：程序自助预约码 -->
          <div v-else-if="form.delivery === 'selfserve'" class="deliv-body">
            <label class="paste-lbl">
              <span>🎫 自助预约核销页说明（对标 D05 程序化交付）</span>
              <textarea
                class="card-textarea"
                v-model="form.portal_note"
                rows="3"
                placeholder="买家拍下自动获得唯一预约码，打开预约 H5 填写门店/日期后由系统自动流转出票。"
              ></textarea>
            </label>
          </div>

          <!-- 形态 5：人工在线交付服务 -->
          <div v-else class="deliv-body">
            <div class="form-grid">
              <label>
                <span>每周接单产能上限（单）</span>
                <input class="inp" type="number" min="1" v-model.number="form.week_limit" />
              </label>
              <label>
                <span>标准交付响应 SLA</span>
                <input class="inp" value="接单后 1 小时内响应交付（超时可一键转同行兜底）" disabled />
              </label>
            </div>
          </div>
        </section>

        <!-- 右卡：闲管家多号发布 + 阿奇索三大防白嫖风控开关 -->
        <section class="card pane">
          <div class="pane-head">
            <span class="step-num">3B</span>
            <div>
              <h3>多店铺矩阵分发 &amp; 阿奇索式防白嫖风控</h3>
              <p class="muted">建卡同时配齐防骗拦截与售后分流，杜绝「连拍套卡秒退」损失。</p>
            </div>
          </div>

          <span class="lbl">勾选同步挂牌账号（闲管家多号分发）：</span>
          <div class="shop-checks">
            <label v-for="s in meta.shops" :key="s.id" class="shop-chip" :class="{ on: form.shops.includes(s.id) }">
              <input type="checkbox" :value="s.id" v-model="form.shops" />
              <div>
                <b>{{ s.label }}</b>
                <small>{{ s.mode }}</small>
              </div>
            </label>
          </div>

          <div class="switch-list">
            <label class="sw-row">
              <div>
                <b>售出后自动补库存重新上架（闲管家核心能力）</b>
                <span>解决闲鱼单链接卖出一单自动下架断流问题；卡密归零时自动停补。</span>
              </div>
              <input type="checkbox" v-model="form.auto_relist" />
            </label>
            <label class="sw-row">
              <div>
                <b>24h 付款秒发 + 自动点「无需寄件」发货（阿奇索核心能力）</b>
                <span>路测未过关前建议关闭；跟卖直发默认开启。</span>
              </div>
              <input type="checkbox" v-model="form.auto_delivery" />
            </label>
            <label class="sw-row">
              <div>
                <b>防骗闸门 ①：买家历史退款累计 ≥ <input type="number" min="1" max="10" v-model.number="form.refund_limit" class="mini-num" @click.stop /> 次暂停自动发</b>
                <span>自动转入人工审核队列，防止惯犯白嫖卡密。</span>
              </div>
              <input type="checkbox" checked disabled />
            </label>
            <label class="sw-row">
              <div>
                <b>防骗闸门 ②：黑名单买家 &amp; 同行恶意拍卡号自动拦截</b>
                <span>命中全店退款黑名单一律拦截不发码。</span>
              </div>
              <input type="checkbox" v-model="form.blacklist" />
            </label>
            <label class="sw-row">
              <div>
                <b>防骗闸门 ③：同一买家上一单未确认收货，禁发新卡密</b>
                <span>专防骗子半夜连拍 10 单拿走卡密后批量点仅退款。</span>
              </div>
              <input type="checkbox" v-model="form.prev_unconfirmed" />
            </label>
            <label class="sw-row">
              <div>
                <b>智能退单分流：未发码秒同意退款；已发码退款一律转人工</b>
                <span>单买家单日限购 <input type="number" min="1" max="20" v-model.number="form.max_per_buyer" class="mini-num" @click.stop /> 单；确认退单后提成自动回冲。</span>
              </div>
              <input type="checkbox" v-model="form.auto_refund" />
            </label>
          </div>

          <div class="form-grid" style="margin-top: 14px">
            <label>
              <span>自动发货附言话术</span>
              <input class="inp" v-model="form.script" />
            </label>
            <label>
              <span>买家兑换使用指引</span>
              <input class="inp" v-model="form.guide" />
            </label>
            <label>
              <span>退改规则说明</span>
              <input class="inp" v-model="form.refund_rule" />
            </label>
            <label>
              <span>异常熔断停售红线</span>
              <input class="inp" v-model="form.stop_rule" />
            </label>
          </div>
        </section>
      </div>

      <p v-if="submitErr" class="err-banner">✕ {{ submitErr }}</p>

      <footer class="step-foot card final-foot">
        <button class="btn lg" :disabled="submitting" @click="step = 2">← 上一步：核对算账底线</button>

        <div class="final-actions">
          <template v-if="hasValidPeers">
            <button class="btn lg" :disabled="submitting" @click="submitProduct(false)">
              暂存至第 7 步待上架
            </button>
            <button class="btn pri lg publish-btn" :disabled="submitting" @click="submitProduct(true)">
              {{ submitting ? '正在建卡并同步发卡仓…' : '🚀 机器初审通过 · 人工确认直接上架（免主管审批）' }}
            </button>
          </template>
          <template v-else>
            <button class="btn pri lg route-btn" :disabled="submitting" @click="submitProduct(false)">
              {{ submitting ? '正在创建路测卡…' : '🧪 完成建卡 · 进入第 5 步「小额实测」（无同行严禁跳步直发）' }}
            </button>
          </template>
        </div>
      </footer>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { api, post } from './api.js'
import { loadAll } from './store.js'
import { toast } from './ui.js'

const step = ref(1)
const activeTpl = ref('')
const submitting = ref(false)
const submitErr = ref('')

const meta = reactive({
  tools: [],
  categories: [],
  covers: [
    { id: 'starbucks', label: '星巴克 / 咖啡茶饮' },
    { id: 'mcd', label: '麦当劳 / 连锁快餐' },
    { id: 'kfc', label: '肯德基 / 炸鸡汉堡' },
    { id: 'jdcard', label: '商超礼品卡 / 购物卡' },
    { id: 'chatgpt', label: 'AI 会员 / 数字订阅' },
    { id: 'steam', label: '游戏点卡 / 影音会员' },
    { id: 'ppt', label: '网盘资料包 / 模板素材' },
    { id: 'xdq', label: '景区门票 / 酒旅出行' },
    { id: 'local_fuyang', label: '地方商场活动券' },
    { id: 'points', label: '积分兑换 / 自助预约码' },
    { id: 'svc', label: '在线人工交付服务' }
  ],
  shops: [
    { id: 'xy_xm', platform: '闲鱼', label: '闲鱼 · 小满卡券严选', mode: '闲管家+阿奇索联动' },
    { id: 'xy_zz', platform: '闲鱼', label: '闲鱼 · 周周生活特惠', mode: '闲管家+阿奇索联动' },
    { id: 'xy_fy', platform: '闲鱼', label: '闲鱼 · 泛亚数字权益号', mode: '闲管家+阿奇索联动' },
    { id: 'tb_zy', platform: '淘宝', label: '淘宝 · 泛亚自动发卡店', mode: '阿奇索千牛直连' }
  ],
  templates: []
})

const ANCHORS = [
  { t: '批量折扣 / 券商拿货价差', d: '一级券商、91卡券同行仓或企业集采折扣低于散客零售价' },
  { t: '银行 / 平台活动补贴差', d: '信用卡周三5折、地方消费券、银联立减等活动价差' },
  { t: '积分 / 里程 / 会员权益变现', d: '自有或合作协议账号积分池兑换餐饮票务权益' },
  { t: '服务效率 / AI 工具替代差', d: '自研 AI 工作流、整理素材库或上游 API 极低边际成本交付' }
]

const DELIVERIES = [
  { k: 'card', title: '🔑 唯一卡密（一人一码）', sub: '对标阿奇索 91卡券：卖一张少一张，粘贴自动去重' },
  { k: 'nocard', title: '📦 无卡密·固定内容', sub: '网盘链接/提取码/教程，所有买家自动发同一份' },
  { k: 'topup', title: '⚡ 官方直充 / 代充', sub: '对标福禄/橙券：来一单充一单，0 卡密库存积压' },
  { k: 'selfserve', title: '🎫 程序自助预约码', sub: '买家拿预约码进 H5 自助选时段/门店核销' },
  { k: 'manual', title: '👩‍💻 人工在线服务', sub: '按周产能上限接单，1 小时时效响应交付' }
]

const form = reactive({
  cat_big: 'A 码券类',
  cat_sub: 'A1 餐饮券',
  cat_leaf: '连锁咖啡茶饮',
  brand: '',
  name: '',
  face: '',
  region: '全国',
  valid: '出码后 30 天内有效',
  cover: 'starbucks',
  compliance_level: 'A',
  compliance_note: '',
  peers: [
    { platform: '闲鱼', shop: '同行挂牌 · 卡券小铺99', price: 26.9, sales: 420, url: '' }
  ],
  xianyu_signal: { sales: 25, price_lo: 24.5, price_hi: 29.9, median: 26.9 },
  profit_anchor: '批量折扣 / 券商拿货价差',
  sourcing_main: '',
  sourcing_backup: '无',
  sourcing_qualify: '无特殊限制',
  sourcing_quota: '每周稳定补货',
  cost: 22.5,
  price: 26.5,
  floor_pct: 105,
  platform_fee_rate: 0.016,
  after_sale_reserve: 0.6,
  override_reason: '',
  delivery: 'card',
  supplier: '认证券商首批导码',
  expire: '2026-12-31',
  warn_at: 10,
  raw_cards: '',
  fixed_payload: '',
  upstream: '',
  buyer_prompt: '请直接发送充值手机号/账号，严禁发送登录密码与短信验证码！',
  price_hike_stop_pct: 5,
  portal_note: '买家付款自动发预约码，凭码进 H5 自助填写核销门店与时段。',
  week_limit: 30,
  shops: ['xy_xm', 'xy_zz'],
  auto_relist: true,
  auto_polish: true,
  auto_delivery: true,
  auto_refund: true,
  refund_limit: 2,
  blacklist: true,
  prev_unconfirmed: true,
  max_per_buyer: 3,
  script: '【24h自动秒发】您的券码已发出，请按下方指引核销使用。',
  guide: '打开官方 App / 小程序 → 优惠券/礼券中心 → 输入券码绑定使用。',
  refund_rule: '未发码秒退；电子卡密发出后不支持无理由退换，异常问题人工兜底。',
  stop_rule: '库存归零或退款率 > 8% 自动暂停上架。'
})

const currentBigCat = computed(() => meta.categories.find((c) => c.big === form.cat_big) || meta.categories[0])
const currentSubCat = computed(() => currentBigCat.value?.subs?.find((s) => s.name === form.cat_sub) || currentBigCat.value?.subs?.[0])
const isSvcKind = computed(() => form.cat_big.startsWith('C') && form.delivery === 'manual')

const validPeers = computed(() =>
  (form.peers || []).filter((p) => String(p.shop || '').trim() && Number(p.price) > 0)
)
const hasValidPeers = computed(() => validPeers.value.length > 0)
const peerMedian = computed(() => {
  if (!validPeers.value.length) return 0
  const arr = validPeers.value.map((x) => Number(x.price)).sort((a, b) => a - b)
  return +arr[Math.floor(arr.length / 2)].toFixed(2)
})

watch(validPeers, (list) => {
  if (!list.length) {
    form.xianyu_signal = { sales: 0, price_lo: 0, price_hi: 0, median: 0 }
    form.auto_delivery = false
    return
  }
  const prices = list.map((x) => Number(x.price)).sort((a, b) => a - b)
  form.xianyu_signal.price_lo = +prices[0].toFixed(2)
  form.xianyu_signal.price_hi = +prices[prices.length - 1].toFixed(2)
  form.xianyu_signal.median = +prices[Math.floor(prices.length / 2)].toFixed(2)
  if (!form.xianyu_signal.sales) form.xianyu_signal.sales = list.length
})

const platformFee = computed(() => +(Number(form.price || 0) * Number(form.platform_fee_rate || 0)).toFixed(2))
const unitProfit = computed(() => +(Number(form.price || 0) - Number(form.cost || 0) - platformFee.value - Number(form.after_sale_reserve || 0)).toFixed(2))
const floorPrice = computed(() => (Number(form.cost) > 0 ? +((Number(form.cost) * Number(form.floor_pct || 105)) / 100).toFixed(2) : 0))
const costPct = computed(() => (Number(form.cost) > 0 ? Math.round((Number(form.price || 0) / Number(form.cost)) * 100) : 100))
const needOverrideReason = computed(() => floorPrice.value > 0 && Number(form.price || 0) < floorPrice.value)

const priceGuard = computed(() => {
  if (Number(form.price || 0) <= 0) return { lvl: 'red', msg: '✕ 请填写大于 0 的拟定售价' }
  if (needOverrideReason.value) {
    return {
      lvl: 'red',
      msg: `⚠ 售价 ¥${form.price} 低于机器防倒挂底线 ¥${floorPrice.value}（进价 × ${form.floor_pct}%），请调高售价或填写下方破底线原因`
    }
  }
  if (unitProfit.value <= 0) {
    return { lvl: 'amb', msg: `⚠ 扣除平台费与售后预留后单笔净毛利为 ¥${unitProfit.value.toFixed(2)}，建议上调售价避免白忙活` }
  }
  return {
    lvl: 'grn',
    msg: `✓ 机器算账通过：售价占进价 ${costPct.value}%（高于 ${form.floor_pct}% 底线），单笔净赚 ¥${unitProfit.value.toFixed(2)}`
  }
})

function maskCard(s) {
  const t = s.trim()
  if (t.length <= 8) return t.length > 4 ? t.slice(0, 2) + '****' + t.slice(-2) : '****'
  return t.slice(0, 6) + ' ···· ' + t.slice(-4)
}

const cardStats = computed(() => {
  const raw = String(form.raw_cards || '')
  if (!raw.trim()) {
    return { raw_lines: 0, empty_removed: 0, duplicates_removed: 0, net_imported: 0, preview_masked: [], duplicate_samples: [] }
  }
  const lines = raw.split(/\r?\n/)
  const seen = new Set()
  let empty = 0
  let dups = 0
  const uniq = []
  const dupSamples = []
  for (const ln of lines) {
    const s = ln.trim()
    if (!s || s.startsWith('#')) {
      empty++
      continue
    }
    const key = s.replace(/\s+/g, ' ')
    if (seen.has(key)) {
      dups++
      if (dupSamples.length < 5) dupSamples.push(maskCard(s))
      continue
    }
    seen.add(key)
    uniq.push(s)
  }
  return {
    raw_lines: lines.length,
    empty_removed: empty,
    duplicates_removed: dups,
    net_imported: uniq.length,
    preview_masked: uniq.slice(0, 6).map(maskCard),
    duplicate_samples: dupSamples
  }
})

const step1Ok = computed(() => String(form.name || '').trim().length >= 4 && String(form.brand || '').trim().length >= 1)
const step2Ok = computed(() =>
  String(form.sourcing_main || '').trim().length >= 2 &&
  Number(form.price) > 0 &&
  (!needOverrideReason.value || String(form.override_reason || '').trim().length >= 3)
)

function selectBigCat(c) {
  form.cat_big = c.big
  if (c.subs?.length) selectSubCat(c.subs[0])
}
function selectSubCat(s) {
  form.cat_sub = s.name
  form.cat_leaf = s.leaf_hint || ''
  form.delivery = s.delivery || 'card'
  form.floor_pct = s.floor_pct || (s.delivery === 'card' ? 105 : 130)
  if (s.cover) form.cover = s.cover
}
function switchDelivery(k) {
  form.delivery = k
  if (k === 'card' && form.floor_pct === 130) form.floor_pct = 105
  if (k !== 'card' && form.floor_pct === 105) form.floor_pct = 130
}
function addPeer() {
  form.peers.push({ platform: '闲鱼', shop: '', price: null, sales: 0, url: '' })
}
function clearPeers() {
  form.peers = []
  toast('已切换为无同行状态 → 系统自动切入 8 步路测通道')
}

function applyTemplate(t) {
  activeTpl.value = t.id
  const p = JSON.parse(JSON.stringify(t.payload))
  Object.assign(form, p)
  submitErr.value = ''
  toast(`已载入样板：${t.label}`)
}

function goStep(n) {
  submitErr.value = ''
  if (n >= 2 && !step1Ok.value) {
    toast('请先在第 1 步填写商品名称（≥4字）与品牌')
    step.value = 1
    return
  }
  if (n >= 3 && !step2Ok.value) {
    toast('请先在第 2 步填好主取得路径，并确保售价满足底线（或填写特批原因）')
    step.value = 2
    return
  }
  step.value = n
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function goBack() {
  location.hash = '#/gallery/virt'
}

async function submitProduct(directPublish) {
  submitErr.value = ''
  if (!step1Ok.value) return goStep(1)
  if (!step2Ok.value) return goStep(2)
  if (directPublish && hasValidPeers.value && form.delivery === 'card' && cardStats.value.net_imported <= 0) {
    submitErr.value = '唯一卡密商品直接上架前，请粘贴至少 1 张有效卡密（或点击左侧「暂存至第 7 步待上架」）'
    return
  }
  if (directPublish && hasValidPeers.value && form.delivery === 'nocard' && String(form.fixed_payload || '').trim().length < 6) {
    submitErr.value = '无卡密固定内容商品直接上架前，请填写要自动发给买家的网盘链接/提取码'
    return
  }
  submitting.value = true
  try {
    const created = await post('/virtual/products', {
      ...form,
      direct_publish: directPublish
    })
    await loadAll(true)
    toast(
      created.step >= 8
        ? `🎉 已直接上架！「${created.name}」正在售卖中`
        : `已建卡！「${created.name}」位于第 ${created.step} 步`
    )
    location.hash = `#/item/${created.kind}/${encodeURIComponent(created.id)}`
  } catch (e) {
    submitErr.value = e.message || '创建失败，请检查必填项'
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  try {
    const d = await api('/virtual/peer-tools')
    if (d.tools?.length) meta.tools = d.tools
    if (d.categories?.length) meta.categories = d.categories
    if (d.covers?.length) meta.covers = d.covers
    if (d.shops?.length) meta.shops = d.shops
    if (d.templates?.length) {
      meta.templates = d.templates
      // 默认预填第 1 套真实样板，开箱即可直接点检体验全部洗重与算账细节
      applyTemplate(d.templates[0])
    }
  } catch (e) {
    toast('读取虚拟选品配置失败：' + e.message)
  }
})
</script>

<style scoped>
.vc-page { padding: 24px 36px 80px; max-width: 1720px; display: grid; gap: 18px; }
.wizard-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 20px; flex-wrap: wrap; }
.wiz-steps { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wstep { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; background: var(--soft); color: var(--ink2); font-weight: 700; font-size: 14px; transition: all .15s; }
.wstep i { width: 24px; height: 24px; border-radius: 50%; background: var(--panel); display: inline-flex; align-items: center; justify-content: center; font-style: normal; font-size: 12.5px; font-weight: 800; }
.wstep.cur { background: var(--acc); color: #fff; box-shadow: 0 4px 14px rgba(37, 99, 235, .28); }
.wstep.cur i { background: rgba(255,255,255,.22); color: #fff; }
.wstep.done { background: var(--grn-soft); color: var(--grn-ink); }
.wstep.done i { background: var(--grn); color: #fff; }
.wsep { color: var(--mute); font-weight: 700; }
.bench-on { background: var(--ink) !important; color: #fff !important; }

.tpl-bar { padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; background: linear-gradient(90deg, #f8fafc 0%, #eff6ff 100%); border: 1px solid #bfdbfe; }
.tpl-left b { font-size: 14.5px; color: #1e3a8a; margin-right: 8px; }
.tpl-left .muted { font-size: 13px; }
.tpl-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.tpl-chip { padding: 7px 14px; border-radius: 999px; background: var(--panel); border: 1.5px solid #cbd5e1; font-size: 13px; font-weight: 700; color: var(--ink); transition: all .14s; }
.tpl-chip:hover { border-color: var(--acc); color: var(--acc); }
.tpl-chip.on { background: var(--acc); border-color: var(--acc); color: #fff; }

.step-banner { padding: 20px 26px; border-radius: 20px; display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
.step-banner.grn { background: linear-gradient(95deg, #ecfdf5 0%, #f0fdf4 100%); border: 2px solid #34d399; color: #064e3b; }
.step-banner.amb { background: linear-gradient(95deg, #fffbeb 0%, #fef3c7 100%); border: 2px solid #f59e0b; color: #78350f; }
.sb-pill { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 800; background: rgba(255,255,255,.85); margin-bottom: 6px; }
.step-banner h2 { font-size: 20px; margin: 2px 0 6px; line-height: 1.35; }
.step-banner p { margin: 0; font-size: 13.5px; opacity: .88; }

.two-col { display: grid; grid-template-columns: 1.05fr 1fr; gap: 20px; align-items: start; }
@media (max-width: 1180px) { .two-col { grid-template-columns: 1fr; } }
.pane { padding: 24px 26px; display: grid; gap: 16px; }
.pane-head { display: flex; gap: 14px; align-items: flex-start; }
.step-num { width: 38px; height: 38px; border-radius: 12px; background: var(--acc-soft); color: var(--acc); font-weight: 800; font-size: 15px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.pane-head h3 { margin: 0 0 4px; font-size: 19px; }
.pane-head p { margin: 0; font-size: 13px; }

.cat-big-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.big-cat-btn { text-align: left; padding: 12px 14px; border-radius: 14px; background: var(--soft); border: 2px solid transparent; display: grid; gap: 4px; transition: all .14s; }
.big-cat-btn b { font-size: 15px; color: var(--ink); }
.big-cat-btn span { font-size: 12px; color: var(--mute); line-height: 1.4; }
.big-cat-btn.on { background: var(--acc-soft); border-color: var(--acc); }

.sub-cat-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.lbl { font-size: 13px; font-weight: 700; color: var(--ink2); }
.sub-pill { padding: 6px 13px; border-radius: 999px; background: var(--soft); font-size: 13px; font-weight: 700; color: var(--ink2); }
.sub-pill.on { background: var(--ink); color: #fff; }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
.form-grid.cols-3 { grid-template-columns: repeat(3, 1fr); }
.form-grid.cols-4 { grid-template-columns: repeat(4, 1fr); }
.form-grid label { display: grid; gap: 5px; font-size: 13px; font-weight: 600; color: var(--ink2); }
.form-grid label.full { grid-column: 1 / -1; }
.form-grid label em { font-style: normal; color: var(--acc); font-weight: 600; font-size: 12px; }
.inp { height: 40px; border: 1.5px solid var(--line); border-radius: 11px; padding: 0 12px; background: var(--panel); color: var(--ink); font: inherit; font-size: 14px; width: 100%; box-sizing: border-box; }
.inp:focus { outline: none; border-color: var(--acc); }
.inp.big-num { font-size: 18px; font-weight: 800; height: 44px; }

.cover-picker { display: grid; gap: 8px; }
.cover-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 8px; }
.cv-item { padding: 5px; border-radius: 12px; background: var(--soft); border: 2px solid transparent; display: grid; gap: 4px; text-align: center; }
.cv-item img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 8px; display: block; }
.cv-item span { font-size: 11.5px; font-weight: 600; color: var(--ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cv-item.on { border-color: var(--acc); background: var(--acc-soft); }

.peer-toolbar { display: flex; gap: 10px; flex-wrap: wrap; }
.peer-list { display: grid; gap: 8px; }
.peer-row { display: grid; grid-template-columns: 92px 1.3fr 98px 92px 1.1fr auto; gap: 8px; align-items: center; }
@media (max-width: 900px) { .peer-row { grid-template-columns: 1fr 1fr; } }
.del-btn { color: var(--red-ink); background: var(--red-soft); }
.empty-peers { padding: 18px; border-radius: 14px; background: var(--amb-soft); color: var(--amb-ink); font-size: 13.5px; line-height: 1.55; }
.empty-peers b { display: block; font-size: 15px; margin-bottom: 4px; }
.sig-box { padding: 14px 16px; border-radius: 14px; background: var(--soft); }
.sig-box h4 { margin: 0 0 10px; font-size: 14px; }

.mini-preview { display: flex; gap: 14px; align-items: center; padding: 12px 14px; border-radius: 16px; background: var(--soft); border: 1px solid var(--line); }
.mini-preview img { width: 84px; height: 68px; object-fit: cover; border-radius: 10px; flex-shrink: 0; }
.mini-preview h4 { margin: 4px 0 2px; font-size: 15.5px; }
.mini-preview p { margin: 0; font-size: 12.5px; }
.mp-tags { display: flex; gap: 6px; flex-wrap: wrap; }

.anchor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.anchor-card { text-align: left; padding: 12px 14px; border-radius: 14px; background: var(--soft); border: 2px solid transparent; display: grid; gap: 4px; }
.anchor-card b { font-size: 14px; color: var(--ink); }
.anchor-card span { font-size: 12px; color: var(--mute); line-height: 1.4; }
.anchor-card.on { border-color: var(--acc); background: var(--acc-soft); }

.inline-fill { margin-left: 6px; padding: 2px 8px; border-radius: 999px; background: var(--acc-soft); color: var(--acc); font-size: 11.5px; font-weight: 700; }
.calc-board { padding: 16px 18px; border-radius: 16px; display: grid; gap: 10px; }
.calc-board.grn { background: var(--grn-soft); color: var(--grn-ink); }
.calc-board.amb { background: var(--amb-soft); color: var(--amb-ink); }
.calc-board.red { background: var(--red-soft); color: var(--red-ink); }
.cb-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.cb-metrics span { display: block; font-size: 12px; opacity: .85; }
.cb-metrics b { font-size: 26px; font-weight: 800; letter-spacing: -.02em; }
.cb-metrics b.bad { color: var(--red); }
.cb-metrics small { display: block; font-size: 11.5px; opacity: .8; }
.cb-verdict { margin: 0; font-size: 13.5px; font-weight: 700; }
.override-box { display: grid; gap: 6px; font-size: 13px; font-weight: 700; margin-top: 4px; }

.comm-preview { padding: 14px 16px; border-radius: 14px; background: var(--soft); }
.comm-preview h4 { margin: 0 0 10px; font-size: 14px; }

.deliv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; }
.deliv-btn { text-align: left; padding: 11px 13px; border-radius: 13px; background: var(--soft); border: 2px solid transparent; display: grid; gap: 3px; }
.deliv-btn b { font-size: 13.5px; }
.deliv-btn span { font-size: 11.5px; color: var(--mute); line-height: 1.35; }
.deliv-btn.on { border-color: var(--acc); background: var(--acc-soft); }
.deliv-body { display: grid; gap: 12px; padding-top: 4px; }
.paste-lbl { display: grid; gap: 6px; font-size: 13px; font-weight: 700; color: var(--ink2); }
.card-textarea { width: 100%; box-sizing: border-box; border: 1.5px solid var(--line); border-radius: 13px; padding: 12px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.55; background: var(--panel); color: var(--ink); resize: vertical; }
.card-textarea:focus { outline: none; border-color: var(--acc); }

.dedup-bar { padding: 13px 16px; border-radius: 14px; display: grid; gap: 8px; font-size: 13px; }
.dedup-bar.grn { background: var(--grn-soft); color: var(--grn-ink); }
.dedup-bar.amb { background: var(--amb-soft); color: var(--amb-ink); }
.dd-pills { display: flex; gap: 14px; flex-wrap: wrap; align-items: baseline; }
.dd-pills b { font-size: 18px; font-weight: 800; }
.dd-pills .hit { color: var(--red-ink); font-weight: 700; }
.dd-pills .net { margin-left: auto; font-weight: 800; }
.dup-warn { font-size: 12.5px; color: var(--red-ink); font-weight: 600; }
.mask-preview { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.mask-preview code { padding: 2px 8px; border-radius: 6px; background: rgba(255,255,255,.72); font-size: 12px; }

.shop-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.shop-chip { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--soft); border: 1.5px solid transparent; cursor: pointer; }
.shop-chip.on { border-color: var(--acc); background: var(--acc-soft); }
.shop-chip b { display: block; font-size: 13.5px; }
.shop-chip small { font-size: 11.5px; color: var(--mute); }

.switch-list { display: grid; gap: 8px; }
.sw-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 13px; border-radius: 12px; background: var(--soft); cursor: pointer; }
.sw-row b { display: block; font-size: 13.5px; }
.sw-row span { font-size: 12px; color: var(--mute); }
.sw-row input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--grn); flex-shrink: 0; }
.mini-num { width: 48px; height: 26px; border: 1px solid var(--line); border-radius: 6px; text-align: center; font-weight: 700; margin: 0 3px; }

.step-foot { padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.final-actions { display: flex; gap: 12px; flex-wrap: wrap; }
.btn.lg { height: 46px; padding: 0 22px; font-size: 15px; font-weight: 800; border-radius: 14px; }
.publish-btn { background: #059669 !important; box-shadow: 0 6px 20px rgba(5, 150, 105, .3); }
.err-banner { margin: 0; padding: 14px 18px; border-radius: 14px; background: var(--red-soft); color: var(--red-ink); font-weight: 700; }

/* 同行工具软件调研面板 */
.bench-hero { padding: 26px 30px; display: grid; gap: 20px; }
.bh-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; flex-wrap: wrap; }
.bh-head h1 { font-size: 28px; margin: 6px 0 8px; }
.bh-head .sub { max-width: 920px; color: var(--ink2); line-height: 1.65; margin: 0; }
.eyebrow { margin: 0; font-size: 12px; font-weight: 800; letter-spacing: .06em; color: var(--acc); }
.absorb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 1000px) { .absorb-grid { grid-template-columns: 1fr; } }
.ab-box { padding: 18px 20px; border-radius: 16px; font-size: 13.5px; line-height: 1.6; }
.ab-box.grn { background: var(--grn-soft); color: var(--grn-ink); }
.ab-box.acc { background: var(--acc-soft); color: var(--ink); }
.ab-box b { font-size: 15px; display: block; margin-bottom: 8px; }
.ab-box ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
.tool-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(460px, 1fr)); gap: 18px; }
.tool-card { padding: 22px 24px; display: grid; gap: 12px; }
.tc-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.tc-top h3 { margin: 6px 0 0; font-size: 20px; }
.tc-plats { display: flex; gap: 6px; flex-wrap: wrap; }
.tc-sec { font-size: 13.5px; line-height: 1.55; padding: 10px 13px; border-radius: 12px; background: var(--soft); }
.tc-sec b { display: block; margin-bottom: 4px; font-size: 13px; }
.tc-sec ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
.tc-sec p { margin: 0; }
.tc-sec.warn { background: var(--amb-soft); color: var(--amb-ink); }
.tc-sec.ok { background: var(--grn-soft); color: var(--grn-ink); }
</style>
