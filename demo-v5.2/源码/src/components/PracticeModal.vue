<template>
  <div
    v-if="store.ui.practice"
    class="pm-mask"
    role="dialog"
    aria-modal="true"
    aria-labelledby="practice-modal-title"
    @click.self="close"
  >
    <div class="pm-card">
      <div class="pm-hd">
        <div>
          <span class="tag acc">新手防呆练兵场 · 纯假数据隔离</span>
          <h3 id="practice-modal-title">{{ S.title }}</h3>
        </div>
        <button type="button" class="btn sm" @click="close"><Icon name="close" size="16" /> 关闭</button>
      </div>

      <div class="banner grn">
        🛡️ 放心大胆试错：这里全是演练假单假钱，故意放了最容易赔钱的「坑按钮」，点错会当场教你系统怎么拦，绝不碰公司真账。
      </div>

      <div v-if="!finished" class="pm-body">
        <div class="pm-steps">
          <span
            v-for="(st, idx) in S.steps"
            :key="idx"
            class="tag"
            :class="idx < stepIdx ? 'grn' : idx === stepIdx ? 'acc' : ''"
          >
            {{ idx < stepIdx ? '✓' : idx + 1 }}. {{ st.title }}
          </span>
        </div>

        <div class="pm-task">
          <div class="pm-task-t">👉 第 {{ stepIdx + 1 }} 小步：{{ curStep.learn }}</div>
          <div class="muted" style="font-size: 13px">
            演练商品：<b>{{ S.item }}</b> · {{ S.refText }}
          </div>
        </div>

        <div v-if="curStep.kind === 'input_price'" class="pm-input-box">
          <label class="field">
            <span>输入你在闲鱼购买页看到的标价（改成 4620 才一致）：</span>
            <input v-model.number="mockPrice" type="number" class="input num" />
          </label>
          <p v-if="mockPrice && mockPrice !== 4620" class="bad-hint">
            ✕ 核对不一致！谈妥价是 4620 元，网页还挂着 {{ mockPrice }} 元，现在付钱就亏了！请改成 4620。
          </p>
          <p v-else-if="mockPrice === 4620" class="ok-hint">
            ✓ 价格一分不差，核对通过！下面蓝色正确按钮已解锁。
          </p>
        </div>

        <div v-if="curStep.kind === 'input_return'" class="pm-input-box">
          <label class="field">
            <span>先填写闲鱼平台退货单号（如 RET-991）：</span>
            <input v-model="mockRet" class="input mono" placeholder="不填退货单号直接点下一步会被锁死" />
          </label>
        </div>

        <div v-if="trapWarn" class="errbox">🛑 {{ trapWarn }}</div>

        <div class="pm-btns">
          <button
            v-for="(b, bi) in curStep.buttons"
            :key="bi"
            type="button"
            class="btn"
            :class="b.ok ? 'pri' : 'bad'"
            :disabled="b.ok && !stepReady"
            @click="onPress(b)"
          >
            <Icon v-if="b.ok && !stepReady" name="lock" size="15" />
            {{ b.t }}
          </button>
        </div>

        <p v-if="!stepReady" class="lock-hint">🔒 灰色的原因：{{ curStep.lockedWhy }}</p>

        <div class="pm-guard">
          <b>这一步防呆底线：</b>{{ curStep.guard }}
        </div>
      </div>

      <div v-else class="pm-pass">
        <div style="font-size: 38px">🎉</div>
        <h3>这一关你已经练熟了！</h3>
        <p class="muted">
          {{
            doneCount >= 3
              ? '恭喜！3 关防踩坑练习全部通关，真实采购订单的全部操作按钮已为你解锁！'
              : `已完成 ${doneCount} / 3 关，继续闯完剩下的就能解锁全部真单实操。`
          }}
        </p>
        <div class="pm-btns" style="justify-content: center; margin-top: 8px">
          <button type="button" class="btn" @click="restart">再练一遍</button>
          <button type="button" class="btn pri" @click="nextOrClose">
            {{ nextKey ? '继续闯下一关 ›' : '回工作台开始干活' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { store, callAction, practiceDoneCount } from '../store.js';
import Icon from './Icon.vue';

const SCRIPTS = {
  chat_guard: {
    title: '第 1 关：写「几乎全新/图糊」别追问 + 给仓管打标 + 防漏底价',
    item: 'MacBook Pro 14（卖家写几乎全新但底壳图很糊 · 演练假单）',
    refText: '公司参考价 ¥7300 / 最高上限 ¥6950',
    steps: [
      {
        title: '遇几乎全新/图糊：别追问，直接打标！',
        learn: '卖家成色写了「几乎全新」，底壳照片拍得很模糊没把瑕疵全披露出来，这时候该怎么做？',
        guard: '一旦多嘴问清划痕，卖家顺口说“二手不包成色”就成了已告知，到货没法二次议价！正确做法是不追问、按链接标准买，并给仓管打「质疑成色」重点验机标！',
        buttons: [
          {
            t: '踩坑试试：连发3句追问“底壳真的一点划痕都没有吗？重拍给我看”',
            trap: '拦住了！你一追问，卖家立马补一句“二手难免小划痕”，到货真有划痕也退不了差价了！千万别打草惊蛇！',
          },
          { t: '正确做法：不追问成色，直接给赵仓管打「🎯质疑成色·重点深检」标并按链接标准谈价 ✓', ok: true },
        ],
      },
      {
        title: '聊天绝不说漏公司底价与二次议价词',
        learn: '向卖家谈买前价格时，先点一下红色错误按钮看看工作台怎么拦住泄密词。',
        guard: '外发词含「参考价、目标价、最高上限、提成、二次议价、到手刀」会被当场拦住。',
        buttons: [
          {
            t: '踩坑试试：发“公司参考价7300，便宜点收”',
            trap: '拦住了！千万别把参考价发给卖家，他一听你有高预算立刻咬死不松口！',
          },
          { t: '正确做法：发“哥诚心要这台，6750包顺丰保价合适我现在秒拍” ✓', ok: true },
        ],
      },
      {
        title: '插话前先让自动助手停嘴',
        learn: '你想亲自跟卖家聊之前，自动报价助手还在工作，应该先点什么？',
        guard: '防止你和自动助手同一分钟报两个不同价格穿帮。',
        buttons: [
          {
            t: '踩坑试试：不管自动助手直接强行打字发送',
            trap: '拦住了！自动助手正在发报价，你同时插话直接穿帮！必须先点「让自动助手停嘴」。',
          },
          { t: '正确做法：先点「让自动助手停嘴」再聊 ✓', ok: true },
        ],
      },
    ],
  },
  price_pay: {
    title: '第 2 关：先核闲鱼改价，再填单号锁死卖家原话',
    item: 'iPhone 15 Pro 谈妥 ¥4620（演练假单）',
    refText: '口头谈妥 ¥4620（闲鱼原挂 ¥4850）',
    steps: [
      {
        title: '核对闲鱼购买页标价',
        learn: '把上面输入框里的 4850 改成 4620，体验系统确认一分钱不差才解锁付款登记。',
        kind: 'input_price',
        lockedWhy: '请先把上方输入框金额核对改成 4620 元，蓝色按钮才会解锁。',
        guard: '闲鱼页面挂价跟谈妥价不一致时，付款登记按钮自动上锁。',
        buttons: [
          {
            t: '踩坑试试：不管挂多少钱强行记已付款',
            trap: '拦住了！没核对闲鱼页面真改好价之前，工作台绝不放行付款登记！',
          },
          { t: '正确做法：确认闲鱼页面已改成 4620 元无误 ✓', ok: true },
        ],
      },
      {
        title: '填支付单号锁死卖家原话',
        learn: '付完款必须把支付宝单号填回来，把卖家刚才承诺的成色永久锁死存档。',
        guard: '不填真实支付单号不锁快照；严禁乱填数字 0 或无代替。',
        buttons: [
          {
            t: '踩坑试试：付完钱直接关网页啥也不填',
            trap: '拦住了！不锁死存档万一卖家把闲鱼链接删了，到货屏幕坏了没证据退货！',
          },
          { t: '正确做法：填好真实支付单号并锁死卖家原话 ✓', ok: true },
        ],
      },
      {
        title: '没买成顺手退回买货预算',
        learn: '如果预留了预算但最后卖家反悔没买成，要顺手点什么？',
        guard: '没买成取消时立即退回预留预算，不占死全组买好货的钱。',
        buttons: [
          {
            t: '踩坑试试：放着不管让预算一直占着',
            trap: '拦住了！死单占着预算会导致同事遇到便宜好货提示预算不够！',
          },
          { t: '正确做法：点取消并把预留预算退回组里 ✓', ok: true },
        ],
      },
    ],
  },
  return_planb: {
    title: '第 3 关：9步二次议价（拒签10分钟加微 → 首刀半价+不用了谢谢 → 整单退走对公）',
    item: 'MacBook Pro 14（派送10分钟内仓管拒签 · 演练假单）',
    refText: '首刀直接半价大砍拿 20% 高提成 · 谈成整单退走次日10点支付宝对公支付',
    steps: [
      {
        title: '拒签黄金10分钟：确认面单已拒签 + 电联加微信（禁闲鱼发微信号）',
        learn: '派送 10 分钟内仓管返回拒签结果！业务员必须在 10 分钟内确认面单显示拒签并加对方微信，上方填个备案号（如 RET-991）解锁。',
        kind: 'input_return',
        lockedWhy: '请先在上面填入闲鱼备案单号（如 RET-991），严禁在闲鱼打字发微信号或提退差价！',
        guard: '在闲鱼打字发“加微信/退差价”会被封号扣光提成！必须确认面单已显示拒签，拨打面单电话口头加微信速战速决。',
        buttons: [
          {
            t: '踩坑试试：直接在闲鱼打字发“有划痕退我300，加我微信号xxx聊”',
            trap: '封号红线！闲鱼严打引流词与聊天到手刀！必须闲鱼只提客观退货备案，打电话口头加卖家微信谈！',
          },
          { t: '正确做法：10分钟内确认面单已拒签 + 电联加卖家微信 + 闲鱼客观备案 ✓', ok: true },
        ],
      },
      {
        title: '首刀半价砍 + 卖家急问少退点回「不用了，谢谢」欲擒故纵',
        learn: '微信发完视频首刀直接半价大砍！卖家很着急问“退你100行不行，别退回来了”，这时候怎么回最赚提成？',
        guard: '着急卖家怕退货亏运费卡钱，千万别急着讨价还价暴露你想留货！先假装毫不在意回「不用了，谢谢」，再算清退货三笔亏账游说！若遇打95338强硬卖家且有保底利润则用「算了吧太急了勉强收下」留肉。',
        buttons: [
          {
            t: '踩坑试试：兴冲冲秒回“100太少了，那退180行不行哥？”',
            trap: '亏大了！你一秒顺杆讨价还价，卖家立刻看穿你舍不得退货，死咬100一分不加！必须假装毫不在意！',
          },
          { t: '正确做法：假装不在意先回「不用啦，谢谢」，挂稳半价锚点算退货亏账游说 ✓', ok: true },
        ],
      },
      {
        title: '议价谈成（如 2000→800）：整单退关单 + 支付宝对公支付登记！',
        learn: '原单 2000 元的东西谈妥 800 元成交了！为什么不能在闲鱼点部分退款，该怎么结算？',
        guard: '平台风控一刀切，部分退款会弹红标，且卖家能刷差评、能二次申诉反咬！必须把闲鱼整单退掉关闭脱离平台管辖，做好订单登记走公司【支付宝对公支付】（财务按 T+1 账单在次日 10:00 审批打款）！',
        buttons: [
          {
            t: '踩坑试试：直接在闲鱼申请退 1200 元部分退款（或拿个人微信私转）',
            trap: '大坑拦住！走部分退款仍有资金走平台，卖家反手给你差评+向平台二次申诉，还会把账号搞成红标！私人转账更是严令禁止！',
          },
          { t: '正确做法：把闲鱼整单全退关闭 + 登记卖家支付宝交财务次日10:00（T+1）对公支付 ✓', ok: true },
        ],
      },
    ],
  },
};

const ORDER = ['chat_guard', 'price_pay', 'return_planb'];
const stepIdx = ref(0);
const trapWarn = ref('');
const mockPrice = ref(4850);
const mockRet = ref('');

const S = computed(() => SCRIPTS[store.ui.practice] || SCRIPTS.chat_guard);
const curStep = computed(() => S.value.steps[Math.min(stepIdx.value, S.value.steps.length - 1)]);
const finished = computed(() => stepIdx.value >= S.value.steps.length);
const stepReady = computed(() => {
  if (curStep.value.kind === 'input_price') return Number(mockPrice.value) === 4620;
  if (curStep.value.kind === 'input_return') return mockRet.value.trim().length > 0;
  return true;
});

const doneCount = computed(() => practiceDoneCount());
const nextKey = computed(() => {
  const idx = ORDER.indexOf(store.ui.practice);
  return idx >= 0 && idx < ORDER.length - 1 ? ORDER[idx + 1] : null;
});

watch(
  () => store.ui.practice,
  (v) => {
    if (v) {
      stepIdx.value = 0;
      trapWarn.value = '';
      mockPrice.value = 4850;
      mockRet.value = '';
    }
  },
);

function close() {
  store.ui.practice = null;
}

function restart() {
  stepIdx.value = 0;
  trapWarn.value = '';
}

async function onPress(b) {
  trapWarn.value = '';
  if (b.trap) {
    trapWarn.value = b.trap;
    return;
  }
  if (b.ok) {
    stepIdx.value += 1;
    await callAction('/api/onboarding/practice', { key: store.ui.practice, step: stepIdx.value });
  }
}

function nextOrClose() {
  if (nextKey.value) {
    store.ui.practice = nextKey.value;
  } else {
    store.ui.practice = null;
  }
}

function onKey(e) {
  if (e.key === 'Escape' && store.ui.practice) close();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped>
.pm-mask {
  position: fixed;
  inset: 0;
  z-index: 96;
  background: rgba(8, 12, 22, 0.65);
  display: grid;
  place-items: center;
  padding: 16px;
}
.pm-card {
  width: min(680px, 100%);
  max-height: 90dvh;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 24px;
  box-shadow: var(--sh-up);
  padding: 22px 24px;
  display: grid;
  gap: 14px;
}
.pm-hd {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.pm-hd h3 {
  font-size: 20px;
  font-weight: 800;
  margin-top: 6px;
}
.pm-body {
  display: grid;
  gap: 12px;
}
.pm-steps,
.pm-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.pm-task {
  background: var(--acc-soft);
  padding: 14px 16px;
  border-radius: 14px;
}
.pm-task-t {
  font-size: 15.5px;
  font-weight: 800;
  margin-bottom: 4px;
}
.pm-input-box {
  background: var(--soft);
  padding: 12px 14px;
  border-radius: 14px;
}
.bad-hint {
  color: var(--red-ink);
  font-weight: 700;
  font-size: 13.5px;
  margin-top: 6px;
}
.ok-hint {
  color: var(--grn-ink);
  font-weight: 700;
  font-size: 13.5px;
  margin-top: 6px;
}
.lock-hint {
  color: var(--amb-ink);
  background: var(--amb-soft);
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 700;
}
.pm-guard {
  padding: 10px 14px;
  background: var(--soft);
  border-radius: 12px;
  font-size: 13px;
  color: var(--mute);
}
.pm-pass {
  text-align: center;
  padding: 16px 8px;
  display: grid;
  gap: 8px;
}
</style>
