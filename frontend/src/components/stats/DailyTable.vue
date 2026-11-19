<script setup lang="ts">
/**
 * 每日收支明细表（B4 / T44）。
 *
 * 三条版式口径（别搞反）：
 * 1. **总计上提到卡头右侧**（`总计 收 X · 支 Y · 结余 Z`），**不放 tfoot** ——
 *    总量是「一眼答案」，跟着滚动跑掉就等于没有；
 * 2. **`tfoot` 只留「日均」一行**并吸底 —— 它是读表时的参照系，需要一直可见；
 * 3. **320px 走卡片式**（不是横向滚动）：`@media (max-width: 360px)` 时把每行的
 *    日期与三个金额摊成两行，避免横向滚动条把表格切一半。
 *
 * 无收支的单元格显示「—」而不是 `¥0.00`：一屏 30 个 `¥0.00` 会让真实的 0 与
 * 「这天没有记录」混在一起。
 */
import type { DailyTable } from '@/core/stats'
import MoneyText from '@/components/MoneyText.vue'

withDefaults(
  defineProps<{
    table: DailyTable
    commodity: string
    masked?: boolean
  }>(),
  { masked: false },
)
</script>

<template>
  <section class="daily">
    <header class="daily__head">
      <span class="daily__title">每日收支明细</span>
      <span class="daily__sum">
        <span class="daily__sum-text">总计</span>
        <span class="daily__sum-item">收 <MoneyText :amount="table.total.income" :commodity="commodity" :privacy="masked" size="sm" /></span>
        <span class="daily__sum-sep" aria-hidden="true">·</span>
        <span class="daily__sum-item">支 <MoneyText :amount="table.total.expense" :commodity="commodity" :privacy="masked" size="sm" /></span>
        <span class="daily__sum-sep" aria-hidden="true">·</span>
        <span class="daily__sum-item">结余 <MoneyText :amount="table.total.balance" :commodity="commodity" :privacy="masked" size="sm" signed /></span>
      </span>
      <span class="daily__note">日期 · 收入 · 支出 · 结余</span>
    </header>

    <div class="daily__wrap">
      <table class="daily__table">
        <thead>
          <tr>
            <th scope="col">日期</th>
            <th scope="col" class="daily__r">收入</th>
            <th scope="col" class="daily__r">支出</th>
            <th scope="col" class="daily__r">结余</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in table.rows" :key="row.day" :class="{ 'daily__row--empty': !row.hasData }">
            <td class="daily__date">{{ row.day }}日</td>
            <td class="daily__r">
              <MoneyText v-if="row.income !== '0.00'" :amount="row.income" :commodity="commodity" :privacy="masked" size="sm" />
              <span v-else class="daily__dash" aria-label="无收入">—</span>
            </td>
            <td class="daily__r">
              <MoneyText v-if="row.expense !== '0.00'" :amount="row.expense" :commodity="commodity" :privacy="masked" size="sm" />
              <span v-else class="daily__dash" aria-label="无支出">—</span>
            </td>
            <td class="daily__r">
              <MoneyText :amount="row.balance" :commodity="commodity" :privacy="masked" size="sm" signed />
            </td>
          </tr>
        </tbody>
        <!-- tfoot 只放「日均」一行，且吸底；总计在卡头 -->
        <tfoot>
          <tr>
            <td>日均</td>
            <td class="daily__r">
              <MoneyText
                v-if="table.average.applicable"
                :amount="table.average.income"
                :commodity="commodity"
                :privacy="masked"
                size="sm"
              />
              <span v-else class="daily__dash" aria-label="本月未开始">—</span>
            </td>
            <td class="daily__r">
              <MoneyText
                v-if="table.average.applicable"
                :amount="table.average.expense"
                :commodity="commodity"
                :privacy="masked"
                size="sm"
              />
              <span v-else class="daily__dash" aria-label="本月未开始">—</span>
            </td>
            <td class="daily__r daily__dash" aria-label="日均结余不作展示">—</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <p class="daily__avg-note">
      {{
        table.average.applicable
          ? `日均按已过 ${table.elapsedDays} 天折算${table.isCurrentMonth ? '（本月未完）' : ''}`
          : '本月未开始，日均暂不计算'
      }}
    </p>
  </section>
</template>

<style scoped>
.daily__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.daily__title {
  color: var(--fb-ink);
  font-size: 13px;
  font-weight: 600;
}

.daily__sum {
  margin-left: auto;
  color: var(--fb-ink);
  font-size: 11px;
  font-variant-numeric: var(--fb-font-numeric);
}

.daily__sum-text {
  color: var(--fb-sub);
}

.daily__sum-sep {
  margin: 0 4px;
  color: var(--fb-sub);
}

.daily__note {
  width: 100%;
  color: var(--fb-sub);
  font-size: 11px;
}

.daily__wrap {
  margin-top: 8px;
  max-height: 420px;
  overflow-y: auto;
}

.daily__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: var(--fb-font-numeric);
}

.daily__table th {
  padding: 6px 4px;
  border-bottom: 1px solid var(--fb-line);
  color: var(--fb-sub);
  font-weight: 500;
  text-align: left;
}

.daily__table td {
  padding: 7px 4px;
  border-bottom: 1px solid var(--fb-line);
  color: var(--fb-ink);
}

.daily__r {
  text-align: right;
}

.daily__date {
  color: var(--fb-sub);
}

.daily__dash {
  color: var(--fb-sub);
}

.daily__row--empty .daily__date {
  color: var(--fb-sub);
}

/* tfoot 唯一一行吸底（总计在卡头，别搞反） */
.daily__table tfoot td {
  position: sticky;
  bottom: 0;
  background: var(--fb-card);
  border-top: 1px solid var(--fb-line);
  color: var(--fb-sub);
  font-weight: 600;
}

.daily__avg-note {
  margin: 8px 0 0;
  color: var(--fb-sub);
  font-size: 11px;
}

/* 320px：卡片式（不是横向滚动）—— 日期独占一行，三个金额并排 */
@media (max-width: 360px) {
  .daily__table thead {
    display: none;
  }

  .daily__table tr {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px 8px;
    padding: 8px 0;
    border-bottom: 1px solid var(--fb-line);
  }

  .daily__table td {
    padding: 0;
    border: none;
    text-align: right;
  }

  .daily__table td.daily__date {
    grid-column: 1 / -1;
    color: var(--fb-ink);
    font-weight: 600;
    text-align: left;
  }

  .daily__table tfoot tr {
    border-top: 1px solid var(--fb-line);
  }

  .daily__table tfoot td {
    position: sticky;
    bottom: 0;
    background: var(--fb-card);
  }
}
</style>
