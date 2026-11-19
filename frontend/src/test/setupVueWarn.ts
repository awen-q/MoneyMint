/**
 * 全局 setup：把 `[Vue warn]` 从「噪音」变成「失败」。
 *
 * 为什么需要它：`<MoneyText>` 曾漏 import，Vue 只打了
 * `[Vue warn]: Failed to resolve component: MoneyText`，而**所有用例照样全绿**——
 * 组件根本没渲染，DOM 里少一个金额节点，但断言查的是别的东西。
 * 如果只看绿灯，发布出去就是一个金额空白的汇总卡。
 *
 * 三条设计约束：
 * 1. **只对 `[Vue warn]` 生效**：把所有 `console.warn` 都变失败会逼出白名单，
 *    而白名单会腐化（「测试全绿，因为所有真警告都被允许了」）。
 * 2. **不改写原输出**：捕获的同时仍转发给原来的 console，失败信息里也会带上原文，
 *    这样既能 fail，又不丢定位信息。
 * 3. 在 `afterEach` 里抛错：抛在用例边界上，报错会自动归到刚跑完的那个用例。
 *
 * 负例自证：临时写一个 `console.warn('[Vue warn] 测试')` 的用例，必须红；
 * 已人工验过（见提交说明），随后删除临时用例。
 */
import { afterEach, beforeEach } from 'vitest'

/** 本轮用例捕获到的 `[Vue warn]` 文本。 */
let caught: string[] = []

type ConsoleMethod = (...args: unknown[]) => void

let originalWarn: ConsoleMethod = console.warn as ConsoleMethod
let originalError: ConsoleMethod = console.error as ConsoleMethod

/** 包装一个 console 方法：转发原输出，同时收集 `[Vue warn]`。 */
function wrap(original: ConsoleMethod): ConsoleMethod {
  return (...args: unknown[]): void => {
    const text = args
      .map((item) => (typeof item === 'string' ? item : String(item)))
      .join(' ')
    if (text.indexOf('[Vue warn]') >= 0) {
      caught.push(text)
    }
    original(...args)
  }
}

beforeEach(() => {
  caught = []
  originalWarn = console.warn as ConsoleMethod
  originalError = console.error as ConsoleMethod
  console.warn = wrap(originalWarn)
  console.error = wrap(originalError)
})

afterEach(() => {
  console.warn = originalWarn
  console.error = originalError
  const list = caught
  caught = []
  if (list.length > 0) {
    throw new Error(
      `捕获到 ${String(list.length)} 条 [Vue warn] —— 框架警告是免费的代码审查，` +
        `必须处理而不是忽略：\n\n${list.join('\n---\n')}`,
    )
  }
})
