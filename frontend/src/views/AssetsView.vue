<script setup lang="ts">
/**
 * 资产页（B5 / T53，design.md 资产页 / mockup `page-assets`）
 *
 * 结构：hero → 工具行卡 → asset-hero（净资产 / 总资产 / 总负债）→ 资产列表卡。
 *
 * 五条本页级决策：
 *
 * 1. **`hero` 与 `AssetHero` 都在 `StateCard` 之外**。空态 / 错误态不能让人失去出口，
 *    也不能把「净资产」这块答案藏起来 —— 与账单页 hero + 工具卡同一条理由。
 * 2. **数据只走 `ledgerData.ensure()`**（§3：页面不自己调 `accountApi.list()`）；
 *    重试只走 `reload()`（`ensure()` 在 `loaded === true` 时短路，点了没反应）。
 * 3. **币种取 `period.commodity`**（跨页单源），不取 `session.defaultCommodity` ——
 *    否则「资产页看人民币、统计页看美元」。
 * 4. **四态判据沿用冻结的 v3.2**：`error` 只在「从未成功加载过」时整页报错；
 *    有旧快照的刷新失败留在 `ready`，只出一条内联提示条。
 * 5. **「资产统计 ›」入口与路由同生共死**：`/assets/stats` 可达却没有入口，等于把功能
 *    藏起来（用户只能靠侧栏碰运气）；反过来，路由还没通就放按钮就是死链。所以本入口、
 *    `router/index.ts` 的 `asset-stats` 路由、`navItems.ts` 的 `ready: true` 同批落地。
 *    两个方向都有机械守卫：删路由 → `shellNav.test.ts` 红；删入口 → 本页测试红。
 *
 * 分组聚合全部由 `core/assets.ts` 产出，净资产由 `core/record.ts` 的
 * `computeBalanceSummary` 产出 —— 本页**不做任何算术**。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { buildAssetBreakdown, type AssetBreakdown } from '@/core/assets'
import { computeBalanceSummary, type BalanceSummary } from '@/core/record'
import { t } from '@/i18n'
import { useLedgerDataStore } from '@/stores/ledgerData'
import { usePeriodStore } from '@/stores/period'
import { usePrivacyStore } from '@/stores/privacy'
import { useSessionStore } from '@/stores/session'
import AccountForm from '@/components/AccountForm.vue'
import AssetGroupList from '@/components/assets/AssetGroupList.vue'
import AssetHero from '@/components/assets/AssetHero.vue'
import StateCard from '@/components/shell/StateCard.vue'

const data = useLedgerDataStore()
const period = usePeriodStore()
const privacy = usePrivacyStore()
const router = useRouter()

// `!loaded → loading` 的判据意味着漏调它表现为「永久骨架屏」，所以这条调用有测试守。
onMounted(() => {
  void data.ensure()
})

/** 主币种：跨页单源（bills ≡ stats ≡ period.commodity）。 */
const commodity = computed(() => period.commodity)

const breakdown = computed<AssetBreakdown>(() =>
  buildAssetBreakdown(data.accounts, commodity.value),
)

/**
 * 净资产口径与首页同源：`ΣAssets + ΣLiabilities`（负债分录本身为负）。
 *
 * **`allowFallback: false`**：资产页的币种是用户显式选的（`period.commodity`），
 * 该币种没有余额数据时就该显示 0.00 —— 绝不回退到别的币种（那会「标题写 USD、
 * 数字却是 CNY」的静默改口）。首页 / 报表用账本默认币种，仍走默认回退行为。
 */
const summary = computed<BalanceSummary>(() =>
  computeBalanceSummary(data.accounts, commodity.value, { allowFallback: false }),
)

/** 外币说明（有外币账户时才出现，币种来自 core，不在页面拼）。 */
const foreignNote = computed(() => {
  const codes = breakdown.value.foreignCommodities
  if (codes.length === 0) {
    return ''
  }
  return t('assets.foreignNote', {
    codes: codes.join('、'),
    commodity: breakdown.value.commodity,
  })
})

/** 整页四态（v3.2 冻结判据）。 */
const pageState = computed<'loading' | 'error' | 'empty' | 'ready'>(() => {
  if (data.error !== '' && !data.loaded) {
    return 'error'
  }
  if (!data.loaded) {
    return 'loading'
  }
  if (breakdown.value.rowCount === 0) {
    return 'empty'
  }
  return 'ready'
})

/** 有旧快照时的刷新失败：留在 ready，只出内联条。 */
const staleError = computed(() => (data.error !== '' && data.loaded ? data.error : ''))

/**
 * 空态与错误态**文案不同**：一个说「没有任何资产 / 负债账户」，
 * 一个说「加载失败」—— 把两者混成一句会把故障伪装成结论。
 */
const cardDesc = computed(() => {
  if (pageState.value === 'error') {
    return t('common.networkRetry')
  }
  if (pageState.value === 'empty') {
    return t('assets.emptyDesc', { commodity: commodity.value })
  }
  return ''
})

function reload(): void {
  void data.reload()
}

/**
 * 「＋ 新建账户」入口（FR-1）：owner/editor 可见，viewer 不渲染。
 * 门禁只用 `session.isViewer`（ledgers[].role 派生）——创建只需非 viewer，
 * 与 AccountsView 同口径；`isOwner` 是另一个口径，勿混用。
 */
const session = useSessionStore()
const showCreateForm = ref(false)

function openCreate(): void {
  if (session.isViewer) {
    return
  }
  showCreateForm.value = true
}

function closeCreateForm(): void {
  showCreateForm.value = false
}

/**
 * StateCard 空态动作：空态且非 viewer 直达创建；error 态传空串走
 * StateCard 默认「重试」。空态文案保持既有不动（按钮直达已解决可达性）。
 */
const stateActionText = computed(() =>
  pageState.value === 'empty' && !session.isViewer ? t('accounts.create') : '',
)

function onStateAction(): void {
  if (pageState.value === 'empty') {
    openCreate()
    return
  }
  reload()
}

/**
 * 进「资产统计」。
 *
 * 走**命名路由**（`asset-stats`）而不是拼 `'/assets/stats'` 字符串：路由改写 /
 * 加 params 时字符串会静默失效（跳到 404 或留在原地），命名路由改错是编译期/测试期红。
 */
function goAssetStats(): void {
  void router.push({ name: 'asset-stats' })
}

/** 关户提示：列出但标注，避免「钱去哪了」。 */
const closedNote = computed(() => {
  const count = breakdown.value.closedCount
  if (count === 0) {
    return ''
  }
  return t('assets.closedNote', { count: String(count) })
})
</script>

<template>
  <section class="assets">
    <!-- ① hero：页名 + 一句话说明 -->
    <header class="assets__hero">
      <h1 class="assets__title">{{ t('shell.nav.assets') }}</h1>
    </header>

    <!-- ② 工具行卡：标题 + 创建入口（非 viewer）+「资产统计 ›」入口（与 /assets/stats 路由同批落地，见脚本注释 5） -->
    <section class="assets__card assets__card--tool">
      <div class="assets__tool-row">
        <h2 class="assets__card-title">{{ t('assets.overview') }}</h2>
        <div class="assets__tool-actions">
          <button v-if="!session.isViewer" type="button" class="assets__create" @click="openCreate">{{ t('accounts.create') }}</button>
          <button type="button" class="assets__link" @click="goAssetStats">{{ t('shell.nav.assetStats') }} ›</button>
        </div>
      </div>
    </section>

    <!-- 刷新失败但有旧快照：留在 ready，只出内联提示条 -->
    <p v-if="staleError !== ''" class="assets__stale" role="status">
      <span class="assets__stale-text">{{ t('common.staleNotice') }}</span>
      <button type="button" class="assets__stale-btn" @click="reload">{{ t('common.retry') }}</button>
    </p>

    <!-- ③ 净资产总计：四态之外（空态也不能把这块答案藏起来） -->
    <AssetHero :summary="summary" :commodity="commodity" :note="foreignNote" />

    <!-- ④ 资产列表：四态承载内容区 -->
    <section class="assets__card">
      <div class="assets__card-head">
        <h2 class="assets__card-title">{{ t('assets.listTitle') }}</h2>
        <span class="assets__card-note">{{ t('assets.listNote') }}</span>
      </div>
      <StateCard :state="pageState" :desc="cardDesc" :action-text="stateActionText" @action="onStateAction">
        <AssetGroupList
          :groups="breakdown.groups"
          :commodity="breakdown.commodity"
          :masked="privacy.enabled"
        />
        <p v-if="closedNote !== ''" class="assets__hint">{{ closedNote }}</p>
        <p class="assets__hint">{{ t('assets.listHint', { commodity: breakdown.commodity }) }}</p>
      </StateCard>
    </section>

    <!-- ⑤ 新建账户弹层：与 AccountsView / CategoriesView 同款本地挂载（不跳页）。
         数据刷新零新增代码：AccountForm create 成功已调 markDirty → 既有失效
         链路（dataFreshness → ledgerData watch → reload）让本页列表原地更新。 -->
    <AccountForm
      v-if="showCreateForm"
      mode="create"
      @close="closeCreateForm"
      @saved="closeCreateForm"
    />

  </section>
</template>

<style scoped>
.assets {
  padding-bottom: 20px;
}

/* X-02：横向内边距归零 —— 水平留白只由 `.layout__content` 一处给，
   否则「layout 16 + 视图 16」= 32px，与账单页、统计页对不齐。 */
.assets__hero {
  padding: 0 0 10px;
}

.assets__title {
  margin: 0;
  color: var(--fb-ink-deep);
  font-size: 21px;
  font-weight: 700;
}

.assets__card {
  margin: 14px 0 0;
  padding: 14px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

/* A-02：工具卡内边距与设计 `.card` 一致（16，移动 14） */
.assets__card--tool {
  padding: 16px;
}

/* 稿 `page-assets` 的 `.tool-row`：标题在左、入口在右（tool-spacer 撑开） */
.assets__tool-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

/* 右侧动作区：pill 实体按钮（主动作）+ 文字链接（次入口） */
.assets__tool-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

/* 样式仿 AccountsView 的 `.accts__create`：实体按钮表达主动作 */
.assets__create {
  padding: 6px 12px;
  border: none;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-on-hero-pill);
  color: var(--fb-white);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.assets__create:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

/* 稿 `.link-btn`：文字型链接按钮，13/700，不是实体按钮（会抢走注意力） */
.assets__link {
  flex: none;
  padding: 6px 4px;
  border: none;
  background: transparent;
  color: var(--fb-blue);
  font-family: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.assets__link:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

/* A-06：卡头与内容间距 12（设计 `.card-head`） */
.assets__card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* A-02：卡标题 15/700（设计 `.card-title`） */
.assets__card-title {
  margin: 0;
  color: var(--fb-ink);
  font-size: 15px;
  font-weight: 700;
}

.assets__card-note {
  color: var(--fb-sub);
  font-size: 11px;
}

/* X-02：提示条不再自带横向外边距 */
.assets__stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 14px 0 0;
  padding: 8px 12px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-danger-soft);
  color: var(--fb-danger-ink);
  font-size: 12px;
}

.assets__stale-btn {
  flex: none;
  border: none;
  background: transparent;
  color: var(--fb-danger-ink);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
}

.assets__hint {
  margin: 10px 0 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.5;
}

@media (max-width: 768px) {
  .assets__card--tool {
    padding: 14px;
  }
}
</style>
