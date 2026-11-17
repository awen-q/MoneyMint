// @vitest-environment jsdom
/**
 * 小票票面回归（T04）：bean 片段区 / 绿琥珀双态印章 / 感谢语 /
 * 去硬编码色值（全部走 tokens.css 的 var(--fb-*)）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { findColorLiterals } from '../../scripts/check-theme-sources.mjs'
import ReceiptSlip from './ReceiptSlip.vue'

// MoneyText 读取隐私 store（遮挡开关），组件级测试需先装一个空 Pinia。
beforeEach(() => {
  setActivePinia(createPinia())
})

const BEAN = [
  '2026-11-16 * "超市采购"',
  '  tags: "日常 孩子"',
  '  Assets:Alipay -128.50 CNY',
  '  Expenses:Food 128.50 CNY',
].join('\n')

const POSTINGS = [
  { account: 'Assets:Alipay', commodity: 'CNY', amount: '-128.50' },
  { account: 'Expenses:Food', commodity: 'CNY', amount: '128.50' },
]

function mountSlip(props: Record<string, unknown> = {}) {
  return mount(ReceiptSlip, {
    props: {
      stamp: '已保存',
      stampSub: 'SAVED',
      amount: '128.50',
      commodity: 'CNY',
      postings: POSTINGS,
      bean: BEAN,
      ...props,
    },
  })
}

describe('ReceiptSlip：bean 片段与票面语义', () => {
  it('bean prop 非空时渲染 .slip__bean，文本逐字等于预览片段', () => {
    const wrapper = mountSlip()
    expect(wrapper.find('.slip__bean').exists()).toBe(true)
    expect(wrapper.find('.slip__bean').text()).toBe(BEAN)
    expect(wrapper.find('.slip__bean').text()).not.toMatch(/[0-9],[0-9]{3}/)
    wrapper.unmount()
  })

  it('bean 为空时不渲染票面片段区（交易详情页共用不受影响）', () => {
    const wrapper = mountSlip({ bean: '' })
    expect(wrapper.find('.slip__bean').exists()).toBe(false)
    wrapper.unmount()
  })

  it('tone 双态：green 默认 / amber 待同步走独立印章样式', () => {
    const saved = mountSlip()
    expect(saved.find('.slip__stamp').classes()).toContain('slip__stamp--green')
    expect(saved.text()).toContain('已保存')
    saved.unmount()

    const offline = mountSlip({ stamp: '待同步', stampSub: 'OFFLINE', tone: 'amber' })
    expect(offline.find('.slip__stamp').classes()).toContain('slip__stamp--amber')
    expect(offline.text()).toContain('待同步')
    offline.unmount()
  })

  it('感谢语与复式分录表保留', () => {
    const wrapper = mountSlip({ thanks: '— 修 改 完 成 —' })
    expect(wrapper.text()).toContain('— 修 改 完 成 —')
    expect(wrapper.findAll('.slip__ledger tbody tr')).toHaveLength(2)
    expect(wrapper.text()).toContain('借贷平衡 · 已校验')
    wrapper.unmount()
  })
})

describe('ReceiptSlip：色值 token 化', () => {
  it('源码内不再出现旧硬编码色值', () => {
    // jsdom 环境下 import.meta.url 可能是 http: 而非 file:，这里按 cwd 兜底定位源文件。
    const candidates = [
      resolve(process.cwd(), 'src/components/ReceiptSlip.vue'),
      resolve(process.cwd(), 'frontend/src/components/ReceiptSlip.vue'),
    ]
    const file = candidates.find((candidate) => existsSync(candidate))
    expect(file, '未找到 ReceiptSlip.vue 源文件').toBeDefined()
    const source = readFileSync(file as string, 'utf8')
    // 复用主题护栏扫描器，不再把旧色值写死在断言里（换肤后不会假绿 / 假红）。
    const hits = findColorLiterals(source)
    expect(
      hits.map((hit) => `${hit.line}:${hit.text}`),
      'ReceiptSlip.vue 仍存在硬编码色值',
    ).toEqual([])
  })
})
