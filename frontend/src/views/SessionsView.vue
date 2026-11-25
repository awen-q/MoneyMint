<script setup lang="ts">
/**
 * P-17 登录设备（批 3）
 *
 * 与旧版 sessions_screen.dart 1:1：列表（当前设备徽章 / 设备名 / IP / 登录与活跃时间）、
 * 逐台吊销（二次确认）、退出其他设备、吊销当前设备等同退出登录、404 自动重载。
 * 服务端只下发 SID（token 的 sha256 前缀），前端拿不到也存不住真实凭据。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { sessionApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { SessionItem } from '@/api/types'
import { formatSessionTime } from '@/core/batch3'
import { t } from '@/i18n'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const router = useRouter()

const sessions = ref<SessionItem[]>([])
const loading = ref(false)
const loadError = ref('')
const busy = ref(false)
const notice = ref('')
const actionError = ref('')
const revokeTarget = ref<SessionItem | null>(null)

const others = computed(() => sessions.value.filter((item) => item.current !== true))

function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : t('sessions.errGeneric')
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = await sessionApi.list()
    sessions.value = Array.isArray(res.sessions) ? res.sessions : []
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      loadError.value = t('sessions.errExpired')
    } else {
      loadError.value = err instanceof ApiError
        ? t('sessions.errLoadFailed', { status: String(err.status), message: err.message })
        : t('sessions.errOffline')
    }
  } finally {
    loading.value = false
  }
}

async function run(action: () => Promise<unknown>, success: string): Promise<void> {
  if (busy.value) {
    return
  }
  busy.value = true
  actionError.value = ''
  notice.value = ''
  try {
    await action()
    notice.value = success
    revokeTarget.value = null
    await load()
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      actionError.value = t('sessions.errSessionInvalid')
      revokeTarget.value = null
      await load()
    } else {
      actionError.value = messageOf(err)
    }
  } finally {
    busy.value = false
  }
}

async function confirmRevoke(): Promise<void> {
  const target = revokeTarget.value
  if (target === null) {
    return
  }
  if (target.current === true) {
    await run(async () => {
      await sessionApi.revoke(target.id)
      await session.logout()
      await router.replace({ name: 'login' })
    }, t('sessions.noticeCurrentLoggedOut'))
    return
  }
  await run(() => sessionApi.revoke(target.id), t('sessions.noticeRevoked'))
}

async function revokeOthers(): Promise<void> {
  if (busy.value) {
    return
  }
  busy.value = true
  actionError.value = ''
  notice.value = ''
  try {
    const res = await sessionApi.revokeOthers()
    notice.value = res.revoked > 0
      ? t('sessions.noticeOthersRevoked', { n: String(res.revoked) })
      : t('sessions.noticeNoOthers')
    await load()
  } catch (err) {
    actionError.value = messageOf(err)
  } finally {
    busy.value = false
  }
}

onMounted(() => { void load() })
</script>

<template>
  <section class="ses">
    <header class="ses__hero fb-hero">
      <span class="ses__title">{{ t('sessions.title') }}</span>
      <span class="ses__sub">{{ t('sessions.subtitle') }}</span>
    </header>

    <div class="fb-card ses__toolbar">
      <span class="fb-muted">{{ t('sessions.totalDevices', { n: String(sessions.length) }) }}</span>
      <div class="ses__actions-inline">
        <button v-if="others.length > 0" class="fb-btn-ghost ses__btn" type="button" :disabled="busy" @click="revokeOthers">{{ t('sessions.revokeOthers') }}</button>
        <button class="fb-btn-ghost ses__btn" type="button" :disabled="loading" @click="load">{{ t('sessions.refresh') }}</button>
      </div>
    </div>

    <p v-if="notice" class="ses__notice ses__notice--ok" role="status">{{ notice }}</p>
    <p v-if="actionError" class="ses__notice ses__notice--err" role="alert">{{ actionError }}</p>

    <div v-if="revokeTarget" class="fb-card ses__panel">
      <h2>{{ revokeTarget.current ? t('sessions.revokeCurrentTitle') : t('sessions.revokeTitle') }}</h2>
      <p>
        {{ revokeTarget.current
          ? t('sessions.revokeCurrentBody')
          : t('sessions.revokeBody') }}
      </p>
      <div class="ses__actions">
        <button class="fb-btn-ghost" type="button" @click="revokeTarget = null">{{ t('sessions.cancel') }}</button>
        <button class="fb-btn-primary" type="button" :disabled="busy" @click="confirmRevoke">{{ t('sessions.confirm') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="fb-card ses__state ses__state--err">
      <p>{{ loadError }}</p>
      <button class="fb-btn-ghost" type="button" @click="load">{{ t('sessions.retry') }}</button>
    </div>
    <div v-else-if="loading" class="fb-card ses__state">{{ t('sessions.loading') }}</div>
    <div v-else-if="sessions.length === 0" class="fb-card ses__state">{{ t('sessions.empty') }}</div>
    <div v-else class="fb-card ses__list">
      <div v-for="item in sessions" :key="item.id" class="ses__row">
        <span class="ses__icon">{{ item.current ? '▣' : '▢' }}</span>
        <span class="ses__info">
          <strong>{{ item.device }}<em v-if="item.current" class="ses__current">{{ t('sessions.currentDevice') }}</em></strong>
          <small>
            {{ t('sessions.loginAt', { time: formatSessionTime(item.created_at) }) }} ·
            {{ t('sessions.lastActiveAt', { time: formatSessionTime(item.last_seen_at) }) }}
            <template v-if="item.ip !== ''"> · IP {{ item.ip }}</template>
          </small>
        </span>
        <button class="fb-btn-ghost ses__btn" :class="{ 'ses__btn--danger': item.current }" type="button" :disabled="busy" @click="revokeTarget = item">
          {{ item.current ? t('sessions.logoutDevice') : t('sessions.revoke') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ses { padding-bottom: 20px; }
.ses__hero { padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 20px; border-radius: 0 0 24px 24px; }
.ses__title { display: block; font-size: 16px; font-weight: 700; }
.ses__sub { display: block; margin-top: 4px; font-size: 12px; color: var(--fb-on-hero-muted); }
.ses__toolbar { margin-top: 14px; padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; }
.ses__actions-inline { display: flex; gap: 8px; }
.ses__btn { padding: 6px 12px; font-size: 12px; }
.ses__btn--danger { color: var(--fb-danger); }
.ses__notice { margin: 10px 0 0; padding: 8px 12px; border-radius: var(--fb-radius-input); font-size: 12px; }
.ses__notice--ok { background: var(--fb-green-soft); color: var(--fb-green-ink); }
.ses__notice--err { background: var(--fb-danger-soft); color: var(--fb-danger-ink); }
.ses__panel { margin-top: 12px; padding: 14px 16px; }
.ses__panel h2 { margin: 0 0 8px; font-size: 14px; }
.ses__panel p { margin: 0 0 12px; font-size: 12px; }
.ses__actions { display: flex; justify-content: flex-end; gap: 8px; }
.ses__list { margin-top: 12px; padding: 6px 14px; }
.ses__row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--fb-line); flex-wrap: wrap; }
.ses__row:last-child { border-bottom: none; }
.ses__icon { font-size: 18px; color: var(--fb-blue); }
.ses__info { flex: 1; min-width: 160px; }
.ses__info strong { display: block; font-size: 13px; }
.ses__info small { display: block; margin-top: 3px; font-size: 11px; color: var(--fb-sub); }
.ses__current { margin-left: 6px; padding: 1px 7px; border-radius: var(--fb-radius-pill); background: var(--fb-blue-soft); color: var(--fb-blue); font-size: 10px; font-style: normal; }
.ses__state { margin-top: 14px; padding: 28px 16px; text-align: center; font-size: 13px; color: var(--fb-sub); }
.ses__state--err { color: var(--fb-danger); }
.ses__state p { margin: 0 0 12px; }
</style>
