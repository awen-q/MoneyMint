/**
 * 用例数 + 测试文件数下限防假绿（RK-10）。
 *
 * ## 这道门禁真正防的是什么（曾经写错过，别改回去）
 *
 * **不是**「测试文件加载失败只剩少量用例」——文件加载失败会让 vitest 的
 * `success = numFailedTestSuites === 0 && numFailedTests === 0` 为假、**退出码非 0**，
 * 不需要这道闸兜。
 *
 * 真正防的是**静默少收集**：`vite.config.ts` 的 `test.include` 被改窄、
 * reporter 没跑到某些文件、文件名规则变化导致文件被跳过 —— 这些情况
 * **退出码是 0**，只有用例数会悄悄变小。
 *
 * ## 为什么需要两条下限（用例数 + 文件数）
 *
 * 「保护半径」是判断一道闸值不值的首要属性，比「红不红」更能说明问题：
 *
 * | 下限 | 触发条件 | 保护半径 |
 * |---|---|---|
 * | 用例数 | 消失的用例数 ≥ 实测值 − 下限 + 1 | 取决于差值（曾出现「实测 901、下限 788 → 半径 114 例」而**单文件最多 43 例**，也就是说删掉任意一个测试文件它都不会红） |
 * | 文件数 | 消失的测试文件数 ≥ 1 | **1 个文件** |
 *
 * 所以带「删一个文件」这种最常见的事故，只有文件数下限能反应。
 *
 * ## 文件数取 `testResults.length`，**不是** `numTotalTestSuites`
 *
 * 字段名会骗人：实测报告里 `numTotalTestSuites = 358` 而测试文件只有 **97** 个——
 * 因为 vitest 的 `getSuites(files)` 数的是 **describe 块**（外加每个文件的根 suite），
 * 不是文件。真正的文件级清单是 `testResults`（每个文件一条，`name` 为绝对路径）。
 * 用错字段会让「文件数下限」变成一条永远宽松的废闸。
 *
 * ## skipped 不算数
 *
 * `numTotalTests` **包含** `it.skip` / `it.todo` 的用例（见 vitest JSON reporter 源码：
 * `numTotalTests = getTests(files).length`）。如果直接拿它比下限，
 * 「把 114 条改成 it.skip」就能让总数不变、失败数 0、闸门全绿，而那些用例
 * **从此不再运行、也没人知道**。所以有效用例数要扣除 `numPendingTests` + `numTodoTests`。
 *
 * 用法：node scripts/check-test-floor.mjs <vitest-report.json> <floor> <fileFloor>
 */
import { readFileSync } from 'node:fs'

const [file, floorArg, fileFloorArg] = process.argv.slice(2)
if (file === undefined || floorArg === undefined || fileFloorArg === undefined) {
  console.error(
    '用法：node scripts/check-test-floor.mjs <vitest-report.json> <floor> <fileFloor>\n' +
      '两个下限都必须传。刻意不做「未传就跳过」——可以被跳过的检查等于没有检查。',
  )
  process.exit(2)
}

let report
try {
  report = JSON.parse(readFileSync(file, 'utf-8'))
} catch (err) {
  console.error(`❌ 无法读取 Vitest 报告 ${file}: ${err.message}`)
  process.exit(1)
}

const total = Number(report.numTotalTests)
const failed = Number(report.numFailedTests)
const pending = Number(report.numPendingTests ?? 0)
const todo = Number(report.numTodoTests ?? 0)
const files = Array.isArray(report.testResults) ? report.testResults.length : Number.NaN
const floor = Number(floorArg)
const fileFloor = Number(fileFloorArg)

if (!Number.isFinite(total)) {
  console.error('❌ 报告缺少 numTotalTests 字段，报告形态可能已变化，请检查')
  process.exit(1)
}
if (!Number.isFinite(files)) {
  console.error('❌ 报告缺少 testResults 数组，无法校验文件数下限，请检查')
  process.exit(1)
}
if (!Number.isFinite(floor) || !Number.isFinite(fileFloor)) {
  console.error(`❌ 下限必须是数字，收到 floor=${floorArg} fileFloor=${fileFloorArg}`)
  process.exit(2)
}

if (failed > 0) {
  console.error(`❌ 存在 ${failed} 个失败用例，先用例全绿再谈下限`)
  process.exit(1)
}

// 扣除 skip / todo：只有「真的会运行」的用例才算数。
const effective = total - pending - todo
if (effective < 0) {
  // 不夹到 0：为负说明报告自相矛盾（pending 比 total 还多），这种形态必须报错而不是放过。
  console.error(
    `❌ 有效用例数为负（total ${total} - pending ${pending} - todo ${todo} = ${effective}），` +
      '报告自相矛盾，拒绝据此判定',
  )
  process.exit(1)
}
if (effective < floor) {
  console.error(
    `❌ 有效用例数 ${effective} 低于下限 ${floor}` +
      `（total ${total}，其中 skip/todo ${pending + todo}）——` +
      '疑似静默少收集（include 被改窄 / reporter 漏跑 / 文件被跳过），禁止合入',
  )
  process.exit(1)
}

if (files < fileFloor) {
  console.error(
    `❌ 测试文件数 ${files} 低于下限 ${fileFloor}——` +
      '有测试文件整体消失（被删 / 未被收集）。用例下限对「删一个文件」几乎无感，靠这条兜',
  )
  process.exit(1)
}

console.log(
  `✅ 有效用例 ${effective} ≥ 下限 ${floor}（total ${total}，skip/todo ${pending + todo}），` +
    `测试文件 ${files} ≥ 下限 ${fileFloor}，且零失败`,
)
