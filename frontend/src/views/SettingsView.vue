<script setup lang="ts">
/**
 * P-14 设置（批 3）
 *
 * 与旧版 settings_screen.dart 1:1：身份卡（系统管理员 / 账本角色两个分层徽章）、
 * 默认账户卡、设置行（账本 / 成员 / 登录设备 / 改密 / 数据安全 / 报表 / 同步状态）、
 * 开放注册开关（仅 isAdmin 渲染）、退出登录。
 * §14.5 #4/#5 不降级项落在本页：注册开关、默认账户查看与清除。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { accountApi, settingsApi } from '@/api/client'
import AppVersionCard from '@/components/AppVersionCard.vue'
import SelectSheet from '@/components/shell/SelectSheet.vue'
import { setThemePreference, theme, themePreference, type ThemePreference } from '@/composables/useTheme'
import { LOCALES, locale, setLocale, t, type Locale } from '@/i18n'
import { ApiError } from '@/api/errors'
import type { AccountView } from '@/api/types'
import { roleLabel } from '@/core/batch3'
import {
  DEFAULT_ACCOUNT_KINDS,
  clearDefaultAccounts,
  defaultAccountLabel,
  readDefaultAccounts,
  type DefaultAccountKind,
} from '@/core/storage'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const router = useRouter()

const registrationEnabled = ref<boolean | null>(null)
const registrationBusy = ref(false)
const actionError = ref('')
const notice = ref('')
const accounts = ref<AccountView[]>([])
const defaults = ref<Partial<Record<DefaultAccountKind, string>>>({})
const accountsLoaded = ref(false)

const isAdmin = computed(() => session.user !== null && session.user.is_admin === true)
const currentRole = computed(() => {
  for (const ledger of session.ledgers) {
    if (ledger.id === session.ledgerId) {
      return ledger.role
    }
  }
  return session.user === null ? '' : session.user.role
})

interface AppearanceOption {
  value: ThemePreference
  label: string
}

/** 外观三段选项：与 useTheme 偏好层一一对应（跟随系统 / 强制浅纸 / 强制夜纸）。 */
const APPEARANCE_OPTIONS = computed<AppearanceOption[]>(() => [
  { value: 'system', label: t('settings.appearanceSystem') },
  { value: 'light', label: t('settings.appearanceLight') },
  { value: 'dark', label: t('settings.appearanceDark') },
])

/** 跟随系统态的说明：显示当前实际生效主题，帮用户理解「跟随」的含义。 */
const appearanceHint = computed<string>(() => {
  if (themePreference.value !== 'system') {
    return t('settings.appearanceHintCustom')
  }
  const active = theme.value === 'night' ? t('settings.appearanceDark') : t('settings.appearanceLight')
  return t('settings.appearanceHintSystem', { theme: active })
})

function pickAppearance(value: ThemePreference): void {
  setThemePreference(value)
}

/** 语言切换弹层是否打开（阶段 1 唯一迁移项；本页其余文案阶段 2 迁移）。 */
const languageOpen = ref(false)

/** 当前语言代码（显式 computed，模板里比较 highlight 时不依赖 ref 自动解包细节）。 */
const currentLocaleCode = computed<Locale>(() => locale.value)

/** 当前语言的自称（简体中文 / English），直接取自 LOCALES，不翻译语言名本身。 */
const currentLocaleLabel = computed<string>(() => {
  for (const option of LOCALES) {
    if (option.code === locale.value) {
      return option.label
    }
  }
  return locale.value
})

/** 选中语言：全站立即生效并关闭弹层。 */
function pickLanguage(next: Locale): void {
  setLocale(next)
  languageOpen.value = false
}

interface LinkItem {
  key: string
  label: string
  hint: string
  to: string
  disabled?: boolean
}

const links = computed<LinkItem[]>(() => [
  {
    key: 'ledgers',
    label: t('settings.ledgers'),
    hint: t('settings.ledgersCurrentHint', { name: session.ledgerName }),
    to: '/ledgers',
  },
  {
    key: 'members',
    label: t('settings.members'),
    hint: currentRole.value === 'owner' ? t('common.roleOwner') : t('settings.membersHintNotOwner'),
    to: '/members',
    disabled: currentRole.value !== 'owner',
  },
  { key: 'sessions', label: t('settings.sessions'), hint: t('settings.sessionsHint'), to: '/sessions' },
  { key: 'password', label: t('settings.changePassword'), hint: '', to: '/change-password' },
  { key: 'data', label: t('settings.dataSafety'), hint: t('settings.dataSafetyHint'), to: '/data-safety' },
  { key: 'reports', label: t('settings.reports'), hint: t('settings.reportsHint'), to: '/reports' },
  { key: 'sync', label: t('settings.sync'), hint: t('settings.syncHint'), to: '/sync' },
])

function go(item: LinkItem): void {
  if (item.disabled === true) {
    notice.value = t('settings.membersOwnerOnly')
    return
  }
  void router.push(item.to)
}

async function loadRegistration(): Promise<void> {
  if (!isAdmin.value) {
    return
  }
  try {
    const res = await settingsApi.registration()
    registrationEnabled.value = res.enabled === true
  } catch {
    // GET 是公开端点，查询失败按「开放」处理，避免误锁注册入口（与旧版一致）。
    registrationEnabled.value = true
  }
}

async function toggleRegistration(): Promise<void> {
  if (registrationBusy.value || registrationEnabled.value === null) {
    return
  }
  registrationBusy.value = true
  actionError.value = ''
  const next = !registrationEnabled.value
  try {
    const res = await settingsApi.setRegistration({ enabled: next })
    registrationEnabled.value = res.enabled === true
    notice.value = next ? t('settings.registrationOpenNotice') : t('settings.registrationClosedNotice')
  } catch (err) {
    actionError.value =
      err instanceof ApiError
        ? t('settings.registrationToggleFailedAdmin', { message: err.message })
        : t('settings.registrationToggleFailed')
  } finally {
    registrationBusy.value = false
  }
}

async function loadDefaults(): Promise<void> {
  const id = session.ledgerId
  if (id === null) {
    return
  }
  defaults.value = readDefaultAccounts(id)
  try {
    const res = await accountApi.list({ includeClosed: true })
    accounts.value = Array.isArray(res.accounts) ? res.accounts : []
  } catch {
    accounts.value = []
  }
  accountsLoaded.value = true
}

function defaultLabel(kind: DefaultAccountKind): string {
  const uuid = defaults.value[kind]
  if (uuid === undefined || uuid === '') {
    return t('settings.notSet')
  }
  for (const account of accounts.value) {
    if (account.uuid === uuid) {
      return account.display_name || account.name
    }
  }
  return t('settings.defaultDeleted')
}

/** 「已删除」占位判定：走同一字典键，避免模板里硬编码中文比较（en 下也会失配）。 */
function isDefaultMissing(kind: DefaultAccountKind): boolean {
  const uuid = defaults.value[kind]
  if (uuid === undefined || uuid === '') {
    return false
  }
  for (const account of accounts.value) {
    if (account.uuid === uuid) {
      return false
    }
  }
  return true
}

function clearDefaults(): void {
  const id = session.ledgerId
  if (id === null) {
    return
  }
  clearDefaultAccounts(id)
  defaults.value = {}
  notice.value = t('settings.defaultsCleared')
}

async function logout(): Promise<void> {
  await session.logout()
  await router.replace({ name: 'login' })
}

watch(() => session.ledgerId, () => { void loadDefaults() })
onMounted(() => {
  void loadRegistration()
  void loadDefaults()
})
</script>

<template>
  <section class="set">
    <header class="set__hero fb-hero">
      <span class="set__title">{{ t('settings.title') }}</span>
      <span class="set__sub">{{ t('settings.subtitle') }}</span>
    </header>

    <div class="fb-card set__identity">
      <span class="set__avatar">
        {{ session.user ? (session.user.display_name || session.user.username).charAt(0) : '?' }}
      </span>
      <span class="set__who">
        <strong>{{ session.user ? session.user.display_name || session.user.username : t('settings.notLoggedIn') }}</strong>
        <small>@{{ session.user ? session.user.username : '—' }}</small>
      </span>
      <span class="set__badges">
        <em v-if="isAdmin" class="set__badge set__badge--admin">{{ t('settings.admin') }}</em>
        <em class="set__badge" :class="{ 'set__badge--owner': currentRole === 'owner' }">
          {{ t('settings.ledgerRoleBadge', { role: roleLabel(currentRole) }) }}
        </em>
      </span>
    </div>

    <p v-if="notice" class="set__notice set__notice--ok" role="status">{{ notice }}</p>
    <p v-if="actionError" class="set__notice set__notice--err" role="alert">{{ actionError }}</p>

    <div class="fb-card set__card">
      <div class="set__card-head">
        <h2>{{ t('settings.defaultAccounts') }}</h2>
        <button
          v-if="Object.keys(defaults).length > 0"
          class="fb-btn-ghost set__btn set__btn--danger"
          type="button"
          @click="clearDefaults"
        >{{ t('settings.clearAllDefaults') }}</button>
      </div>
      <p v-if="!accountsLoaded" class="set__state">{{ t('settings.readingDefaults') }}</p>
      <dl v-else class="set__defaults">
        <template v-for="kind in DEFAULT_ACCOUNT_KINDS" :key="kind">
          <dt>{{ defaultAccountLabel(kind) }}</dt>
          <dd :class="{ 'set__missing': isDefaultMissing(kind) }">{{ defaultLabel(kind) }}</dd>
        </template>
      </dl>
      <p class="set__hint">{{ t('settings.defaultHint') }}</p>
    </div>

    <div class="fb-card set__card set__appearance">
      <div>
        <strong>{{ t('settings.appearance') }}</strong>
        <p class="fb-muted">{{ appearanceHint }}</p>
      </div>
      <div class="set__seg" role="radiogroup" :aria-label="t('settings.appearanceThemeLabel')">
        <button
          v-for="option in APPEARANCE_OPTIONS"
          :key="option.value"
          type="button"
          role="radio"
          class="set__seg-btn"
          :class="{ 'set__seg-btn--on': themePreference === option.value }"
          :aria-checked="themePreference === option.value"
          @click="pickAppearance(option.value)"
        >{{ option.label }}</button>
      </div>
    </div>

    <!-- 语言 / Language：阶段 1 的设置项，选中即全站生效（本页其余文案阶段 2 迁移） -->
    <div class="fb-card set__card set__links">
      <button type="button" class="set__link" @click="languageOpen = true">
        <span>{{ t('settings.language') }}</span>
        <span class="fb-muted">{{ currentLocaleLabel }} ›</span>
      </button>
    </div>

    <SelectSheet
      :open="languageOpen"
      :title="t('settings.languageDialog')"
      :dialog-label="t('settings.languageDialog')"
      @close="languageOpen = false"
    >
      <ul class="set__lang-list">
        <li v-for="option in LOCALES" :key="option.code">
          <button
            type="button"
            class="set__lang-row"
            :class="{ 'set__lang-row--on': currentLocaleCode === option.code }"
            :aria-current="currentLocaleCode === option.code ? 'true' : undefined"
            @click="pickLanguage(option.code)"
          >
            <span class="set__lang-name">{{ option.label }}</span>
            <span v-if="currentLocaleCode === option.code" class="set__lang-check" aria-hidden="true">✓</span>
          </button>
        </li>
      </ul>
    </SelectSheet>

    <div class="fb-card set__card set__links">
      <button
        v-for="item in links"
        :key="item.key"
        type="button"
        class="set__link"
        :disabled="item.disabled"
        @click="go(item)"
      >
        <span>{{ item.label }}</span>
        <span class="fb-muted">{{ item.hint }} ›</span>
      </button>
    </div>

    <div v-if="isAdmin" class="fb-card set__card set__registration">
      <div>
        <strong>{{ t('settings.registration') }}</strong>
        <p class="fb-muted">{{ t('settings.registrationHint') }}</p>
      </div>
      <button
        class="set__switch"
        type="button"
        role="switch"
        :aria-checked="registrationEnabled === true"
        :disabled="registrationEnabled === null || registrationBusy"
        @click="toggleRegistration"
      >
        <i :class="{ on: registrationEnabled === true }" />
        <span>{{ registrationBusy ? t('settings.switching') : registrationEnabled === null ? '…' : registrationEnabled ? t('settings.registrationOn') : t('settings.registrationOff') }}</span>
      </button>
    </div>

    <!-- 关于：版本 / 构建号 / 日期 + 一键复制，报 bug 用（PM 版本展示方案） -->
    <div class="fb-card set__card">
      <AppVersionCard />
    </div>

    <div class="fb-card set__card">
      <button class="set__link set__link--danger" type="button" @click="logout">
        <span>{{ t('settings.logout') }}</span><span>›</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.set { padding-bottom: 20px; }
.set__hero { padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 20px; border-radius: 0 0 24px 24px; }
.set__title { display: block; font-size: 16px; font-weight: 700; }
.set__sub { display: block; margin-top: 4px; font-size: 12px; color: var(--fb-on-hero-muted); }
.set__identity { margin-top: 14px; padding: 14px 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.set__avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--fb-blue-soft); color: var(--fb-blue); display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700; }
.set__who { flex: 1; min-width: 120px; }
.set__who strong { display: block; font-size: 14px; }
.set__who small { font-size: 11px; color: var(--fb-sub); }
.set__badges { display: flex; gap: 6px; flex-wrap: wrap; }
.set__badge { padding: 3px 9px; border-radius: var(--fb-radius-pill); background: var(--fb-soft); color: var(--fb-sub); font-size: 11px; font-style: normal; }
.set__badge--admin { background: var(--fb-blue-soft); color: var(--fb-blue); }
.set__badge--owner { background: var(--fb-green-soft); color: var(--fb-green-ink); }
.set__notice { margin: 10px 0 0; padding: 8px 12px; border-radius: var(--fb-radius-input); font-size: 12px; }
.set__notice--ok { background: var(--fb-green-soft); color: var(--fb-green-ink); }
.set__notice--err { background: var(--fb-danger-soft); color: var(--fb-danger-ink); }
.set__card { margin-top: 12px; padding: 12px 16px; }
.set__card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.set__card h2 { margin: 0 0 8px; font-size: 14px; }
.set__card-head h2 { margin-bottom: 0; }
.set__btn { padding: 5px 10px; font-size: 11px; }
.set__btn--danger { color: var(--fb-danger); }
.set__defaults { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin: 10px 0 0; font-size: 12px; }
.set__defaults dt { color: var(--fb-sub); }
.set__defaults dd { margin: 0; text-align: right; }
.set__missing { color: var(--fb-danger); }
.set__hint, .set__registration p { margin: 10px 0 0; font-size: 11px; color: var(--fb-sub); line-height: 1.6; }
.set__state { margin: 10px 0 0; font-size: 12px; color: var(--fb-sub); }
.set__appearance { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.set__appearance strong { font-size: 13px; }
/* 外观三段 seg：与 PeriodSeg 同款（soft 底胶囊容器，选中态实心卡片色）。 */
.set__seg { display: inline-flex; padding: 2px; border-radius: var(--fb-radius-pill); background: var(--fb-soft); }
.set__seg-btn { padding: 4px 12px; border: none; border-radius: var(--fb-radius-pill); background: transparent; color: var(--fb-sub); font-family: inherit; font-size: 12px; cursor: pointer; }
.set__seg-btn--on { background: var(--fb-card); color: var(--fb-ink); font-weight: 600; }
.set__links { padding: 4px 16px; }
.set__link { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 0; border: none; border-bottom: 1px solid var(--fb-line); background: transparent; color: var(--fb-ink); font-size: 13px; font-family: inherit; text-align: left; cursor: pointer; }
.set__link:last-child { border-bottom: none; }
.set__link:disabled { opacity: 0.5; cursor: default; }
.set__link--danger { color: var(--fb-danger); }
.set__registration { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.set__registration strong { font-size: 13px; }
.set__switch { display: flex; align-items: center; gap: 8px; border: none; background: transparent; color: var(--fb-sub); font-size: 12px; font-family: inherit; cursor: pointer; }
.set__switch i { display: block; width: 34px; height: 20px; border-radius: 10px; background: var(--fb-line); position: relative; }
.set__switch i::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--fb-white); }
.set__switch i.on { background: var(--fb-blue); }
.set__switch i.on::after { left: 16px; }
/* 语言选项列表：与 LedgerSwitcher 行风格一致（整行可点，选中态描边高亮） */
.set__lang-list { margin: 0; padding: 0; list-style: none; }
.set__lang-list li + li { margin-top: var(--fb-space-2); }
.set__lang-row { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 48px; padding: 10px 14px; border: 1px solid var(--fb-line); border-radius: var(--fb-radius-input); background: var(--fb-card); color: var(--fb-ink); font-family: inherit; font-size: 14px; text-align: left; cursor: pointer; }
.set__lang-row--on { border-color: var(--fb-blue); background: var(--fb-blue-soft); }
.set__lang-row:focus-visible { outline: 2px solid var(--fb-blue); outline-offset: 2px; }
.set__lang-check { flex: none; color: var(--fb-blue); font-size: 14px; font-weight: 700; }
</style>
