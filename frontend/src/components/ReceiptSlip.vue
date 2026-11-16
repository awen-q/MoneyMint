<script setup lang="ts">
/**
 * 小票（收据）纸面组件（保存成功页 / 交易详情页共用）
 *
 * - 纯展示：状态用「印章」表达（绿=成功/已核对、琥珀=待同步/待核对、蓝=幂等命中/冲正、红=已冲正）；
 * - 金额一律走 `MoneyText`（复用 core/Money 的 formatMoney 与隐私遮挡），票面不出现裸浮点；
 * - 票面只做「借贷平衡 · 已校验」一行校验提示，不输出相抵后的合计数字（避免被读成消费总额）；
 * - 齿边用两组 linear-gradient 拼三角，纸纹用 repeating-linear-gradient；
 *   不涉及 mask / :has() / aspect-ratio / dvh / inset，兼容 iOS 14.8。
 */
import MoneyText from '@/components/MoneyText.vue'

withDefaults(
  defineProps<{
    /** 印章主文案（已保存 / 已核对 / 待同步 …）。 */
    stamp: string
    /** 印章副文案（英文小字，可空）。 */
    stampSub?: string
    tone?: 'green' | 'amber' | 'blue' | 'red'
    /** 票头品牌行。 */
    title?: string
    subtitle?: string
    /** 票面主金额（金额字符串，含符号按原值传入）。 */
    amount: string
    commodity?: string
    signed?: boolean
    /** 金额下方的类型徽标（支出 EXPENSE …）。 */
    kindLabel?: string
    /** 明细行：value 与 tags 二选一。 */
    rows?: Array<{ label: string; value?: string; tags?: string[] }>
    /** 复式分录（账户 / 币种 / 金额）。 */
    postings?: Array<{ account: string; commodity: string; amount: string }>
    /** 是否输出「借贷平衡 · 已校验」。 */
    balanced?: boolean
    /** 与折叠预览逐字一致的 bean 片段（票面展示，禁止千分位）。 */
    bean?: string
    footLines?: string[]
    thanks?: string
  }>(),
  {
    stampSub: '',
    tone: 'green',
    title: '家庭账本',
    subtitle: 'FAMBEAN · RECEIPT',
    commodity: 'CNY',
    signed: false,
    kindLabel: '',
    rows: () => [],
    postings: () => [],
    balanced: true,
    bean: '',
    footLines: () => [],
    thanks: '— 感 谢 记 账 —',
  },
)
</script>

<template>
  <div class="slip">
    <div class="slip__noise" aria-hidden="true"></div>

    <div class="slip__stamp" :class="`slip__stamp--${tone}`">
      {{ stamp }}<small v-if="stampSub !== ''">{{ stampSub }}</small>
    </div>

    <div class="slip__brand">
      <p class="slip__brand-name">{{ title }}</p>
      <p class="slip__brand-sub">{{ subtitle }}</p>
    </div>

    <div class="slip__rule slip__rule--star" aria-hidden="true">* * * * * * * * * * * * *</div>

    <div class="slip__amount">
      <MoneyText :amount="amount" :commodity="commodity" :signed="signed" size="lg" />
    </div>
    <div class="slip__kind">
      <span v-if="kindLabel !== ''" class="slip__kind-pill">{{ kindLabel }}</span>
      <slot name="badges" />
    </div>

    <template v-if="rows.length > 0">
      <div class="slip__rule"></div>
      <ul class="slip__rows">
        <li v-for="row in rows" :key="row.label">
          <span class="slip__rows-label">{{ row.label }}</span>
          <span class="slip__rows-value">
            <template v-if="row.tags !== undefined && row.tags.length > 0">
              <span v-for="tag in row.tags" :key="tag" class="slip__tag">{{ tag }}</span>
            </template>
            <template v-else>{{ row.value }}</template>
          </span>
        </li>
      </ul>
    </template>

    <template v-if="postings.length > 0">
      <div class="slip__rule"></div>
      <table class="slip__ledger">
        <thead>
          <tr><th>账户</th><th>币种</th><th>金额</th></tr>
        </thead>
        <tbody>
          <tr v-for="(posting, index) in postings" :key="index">
            <td class="slip__ledger-acc">
              <span class="slip__clamp" :title="posting.account">{{ posting.account }}</span>
            </td>
            <td class="slip__ledger-cur">{{ posting.commodity }}</td>
            <td
              class="slip__ledger-amt"
              :class="posting.amount.charAt(0) === '-' ? 'is-neg' : 'is-pos'"
            >
              <MoneyText :amount="posting.amount" commodity="" :signed="true" size="sm" />
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <div v-if="bean !== ''" class="slip__bean">{{ bean }}</div>

    <template v-if="balanced">
      <div class="slip__rule"></div>
      <div class="slip__balance"><span class="slip__balance-ok">✓</span>借贷平衡 · 已校验</div>
    </template>

    <div class="slip__rule"></div>
    <div class="slip__foot">
      <p v-for="(line, index) in footLines" :key="index">{{ line }}</p>
      <p class="slip__thanks">{{ thanks }}</p>
    </div>
  </div>
</template>

<style scoped>
.slip {
  position: relative;
  width: 100%;
  max-width: 340px;
  margin: 0 auto;
  padding: 26px 22px 14px;
  background: var(--fb-paper);
  color: var(--fb-paper-ink);
  font-family: var(--fb-paper-mono);
  box-shadow: var(--fb-paper-shadow);
}

/* 撕纸齿边：两组 45° 渐变拼三角，矢量、不随票宽变形 */
.slip::before,
.slip::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 12px;
  background-image:
    linear-gradient(-45deg, var(--fb-paper) 6px, transparent 0),
    linear-gradient(45deg, var(--fb-paper) 6px, transparent 0);
  background-size: 14px 14px;
  background-repeat: repeat-x;
}

.slip::before {
  top: -11px;
}

.slip::after {
  bottom: -11px;
  transform: scaleY(-1);
}

/* 热敏纸横向纹理 */
.slip__noise {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  pointer-events: none;
  background-image: repeating-linear-gradient(0deg, var(--fb-paper-edge) 0 1px, transparent 1px 3px);
  opacity: 0.8;
}

.slip__stamp {
  position: absolute;
  top: 18px;
  right: 14px;
  width: 74px;
  height: 74px;
  border-radius: 50%;
  border: 2.5px solid var(--fb-green);
  color: var(--fb-green);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  transform: rotate(-13deg);
  font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-weight: 800;
  font-size: 15px;
  letter-spacing: 2px;
  text-align: center;
  opacity: 0.92;
}

.slip__stamp::after {
  content: '';
  position: absolute;
  top: 5px;
  right: 5px;
  bottom: 5px;
  left: 5px;
  border: 1px solid currentColor;
  border-radius: 50%;
  opacity: 0.45;
}

.slip__stamp small {
  margin-top: 1px;
  font-size: 8px;
  letter-spacing: 1.5px;
  font-weight: 600;
}

.slip__stamp--amber {
  border-color: var(--fb-warn);
  color: var(--fb-warn-ink);
}

.slip__stamp--blue {
  border-color: var(--fb-blue);
  color: var(--fb-blue);
}

.slip__stamp--red {
  border-color: var(--fb-danger);
  color: var(--fb-danger);
}

.slip__brand {
  text-align: center;
  padding-right: 46px;
}

.slip__brand-name {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 4px;
}

.slip__brand-sub {
  margin: 5px 0 0;
  font-size: 9.5px;
  letter-spacing: 1.6px;
  color: var(--fb-paper-sub);
}

.slip__rule {
  margin: 12px 0;
  border-top: 1px dashed var(--fb-paper-line);
}

.slip__rule--star {
  border-top: none;
  text-align: center;
  font-size: 10px;
  letter-spacing: 3px;
  color: var(--fb-paper-sub);
}

.slip__amount {
  margin: 16px 0 6px;
  text-align: center;
}

.slip__amount :deep(.money-text) {
  font-family: var(--fb-paper-mono);
  font-size: 36px;
  font-weight: 700;
  letter-spacing: -1.5px;
}

.slip__amount :deep(.money-text--negative) {
  color: var(--fb-paper-ink);
}

.slip__kind {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.slip__kind-pill {
  display: inline-block;
  padding: 2px 10px;
  border: 1px solid var(--fb-paper-line);
  border-radius: 3px;
  font-size: 10.5px;
  letter-spacing: 1px;
  color: var(--fb-paper-sub);
}

.slip__rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.slip__rows li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 0;
  font-size: 11.5px;
  line-height: 1.7;
}

.slip__rows-label {
  flex: 0 0 auto;
  letter-spacing: 0.5px;
  color: var(--fb-paper-sub);
}

.slip__rows-value {
  text-align: right;
  word-break: break-all;
}

.slip__tag {
  display: inline-block;
  margin-left: 4px;
  padding: 0 6px;
  border: 1px solid var(--fb-paper-rule);
  border-radius: 2px;
  font-size: 10.5px;
}

.slip__ledger {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.slip__ledger th {
  padding: 0 0 5px;
  border-bottom: 1px solid var(--fb-paper-line);
  font-weight: 400;
  font-size: 9px;
  letter-spacing: 1px;
  text-align: left;
  color: var(--fb-paper-sub);
}

.slip__ledger th:last-child,
.slip__ledger td:last-child {
  text-align: right;
}

.slip__ledger td {
  padding: 6px 0 5px;
  border-bottom: 1px dotted var(--fb-paper-rule);
}

.slip__ledger tr:last-child td {
  border-bottom: none;
}

.slip__ledger-acc {
  max-width: 176px;
}

.slip__clamp {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slip__ledger-cur {
  font-size: 10px;
  color: var(--fb-paper-sub);
}

.slip__ledger-amt :deep(.money-text) {
  font-family: var(--fb-paper-mono);
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0;
}

.slip__ledger-amt.is-neg :deep(.money-text) {
  color: var(--fb-danger);
}

.slip__ledger-amt.is-pos :deep(.money-text) {
  color: var(--fb-green);
}

/* Beancount 对照片段：与预览 <details> 逐字一致，金额无千分位。 */
.slip__bean {
  margin: 10px 0 0;
  padding: 8px 9px;
  border: 1px dashed var(--fb-paper-line);
  border-radius: 4px;
  font-size: 9.5px;
  line-height: 1.8;
  color: var(--fb-paper-sub);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.slip__balance {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 10.5px;
  letter-spacing: 1.5px;
  color: var(--fb-green);
}

.slip__balance-ok {
  display: inline-block;
  width: 13px;
  height: 13px;
  line-height: 13px;
  border-radius: 50%;
  background: var(--fb-green);
  color: var(--fb-white);
  font-size: 9px;
  text-align: center;
  letter-spacing: 0;
}

.slip__foot {
  text-align: center;
  color: var(--fb-paper-sub);
  font-size: 9.5px;
  line-height: 1.9;
  letter-spacing: 0.6px;
}

.slip__foot p {
  margin: 0;
}

.slip__thanks {
  margin-top: 12px;
  font-size: 10px;
  letter-spacing: 3px;
  color: var(--fb-paper-sub);
}

/* 小屏（320 / 375）：票内间距与字号各收一档，避免横向滚动 */
@media (max-width: 380px) {
  .slip {
    padding: 22px 16px 12px;
  }

  .slip__stamp {
    width: 62px;
    height: 62px;
    top: 14px;
    right: 10px;
    font-size: 12.5px;
  }

  .slip__stamp small {
    font-size: 7px;
  }

  .slip__brand-name {
    font-size: 13px;
    letter-spacing: 3px;
  }

  .slip__brand-sub {
    font-size: 8.5px;
    letter-spacing: 1.2px;
  }

  .slip__amount {
    margin: 12px 0 5px;
  }

  .slip__amount :deep(.money-text) {
    font-size: 30px;
  }

  .slip__rows li {
    font-size: 11px;
  }

  .slip__ledger {
    font-size: 10.5px;
  }

  .slip__ledger-acc {
    max-width: 128px;
  }
}
</style>
