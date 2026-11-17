# FamBean 下阶段目标与前端全量重构方案（M7）

> 版本：**v2.5** ｜ 日期：2026-11-11 ｜ 性质：**方案 + 任务拆解，批 0~2.5 已落地（部分实现，非纯规划）**
> 输入：本地仓库 `D:/Project/Self/ezbookkeeping`（开源自托管记账，读取 2026-11-09，含版本与兼容配置复核）+ FamBean 当前代码与文档端到端核对 + 老板 2026-11-09 决策「直接全量重构」+「按推荐走」+ 框架二次选型问询 + 全栈工程可行性评审 + 三方补充评审（架构/数据、离线内核、前后端契约）+ 老板 D-7 拍板
> 关联：`docs/product-review-2026-11.md` v2.1（M0~M6 路线图）、`docs/m2-plan.md`（恢复 + 导入方案）、`docs/frontend-framework-rewrite-assessment.md`（换框架评估，已被 v2.0 决策取代）、`docs/no-upgrade-compat-plan.md`（S1/S2）、`docs/progress-review-2026-11-11.md`（进度审查）
> 状态：**D-1~D-7 已锁定 / 已给结论**；**D-7 已锁定为 A（httpOnly Cookie）**，见 §5.6 E-03 / §5.7 / §13。D-5 涉及删除文件，仍待老板逐个指定后执行；**截至 2026-11-11 已实现至批 2.5**（批 0~2.5 已提交，`frontend/src` 57 文件 / 14067 行，Vitest 202/202 通过），批 3~6 未开工。**同日进度审查后老板拍板：CI `web-verify` 门禁与工具链钉版暂缓，本版只收口文档口径，不宣称这两项已完成**（见 v2.5 变更记录、§9、§11、§14.1）。

### 变更记录

| 版本 | 日期 | 变更内容 | 触发 |
|---|---|---|---|
| v1.0 | 2026-11-09 | 初稿：竞品调研 + 现状核对 → 推荐方案 C（新载体承载新页面） | 老板「看下竞品，定下阶段目标」 |
| v1.1 | 2026-11-09 | 并入竞品深度调研；新增 **G-04「在线记账无幂等键」** 缺口及其需求 / API / 验收 / 风险条目 | 调研报告回传 |
| **v2.0** | **2026-11-09** | **方向性修订**：推荐方案由「渐进式绞杀者」改为**前端全量重构 + 一次性切换**；新前端范围 6 页 → 28 屏功能全覆盖（收敛为 20 页）；Flutter 版由「冻结长期并存」改为「开发期 `/legacy/` 对照 → cutover 后清退」；离线同步内核由 Out 改为 **In**；S1 探针决策门作废；分批 4 → 6；验收、风险、RTM 同步重算 | **老板：「还是直接全量重构比较好，现在还没上线，无所谓」** |
| **v2.1** | **2026-11-09** | **决策收口 + 框架二次选型**：D-1~D-5 按推荐值锁定；新增 §5.5「Vue 3 SPA vs Nuxt」五维对比，结论 **纯 Vue 3 + Vite SPA，不引入 Nuxt / SSR**；补部署链实测证据（Dockerfile 单容器单端口 / `static.go` spaHandler / 内网定位 / token 存储已定不做 httpOnly Cookie）；D-6 记录该结论 | **老板：「按推荐走。前端框架是纯 vue 还是用 nuxtjs 比较好？」** |
| **v2.2** | **2026-11-09** | **全栈工程可行性评审**：结论「整体可行，附 3 个 P0 + 5 个 P1 工程前提」；新增 §5.6（金额精度 / 幂等落库 / 认证存储 / SW / 依赖语法 / dev proxy / 401·428 / `X-Ledger-Id`）+ 前端分层与类型化 fetch 示意；§7 幂等补迁移 013 与唯一索引；§10 补 4 条验收；§11 批 0/1/5 增补；**新增 D-7 待拍板**（httpOnly Cookie 属范围变化） | **老板切到全栈视角问「ok，你觉得可行吗」** |
| **v2.3** | **2026-11-09** | **三方评审收口 + D-7 拍板**：新增 §5.7 六条 P0（产物目录 / `/legacy/` 回滚 / 版本门禁 / 幂等语义 / 库世代 / 覆盖到功能点）；**D-7 锁定 A（httpOnly Cookie + CORS 收敛 + CSRF 头）**；§6.5 / §6.7 / §7 / §9 / §11 / §12 / §13 / §14 增量修订；新增 AC-27~AC-36、RK-13~RK-16、§14.5 旧功能不降级、§14.6 用例映射、§14.7 依赖钉版与禁用清单 | **老板「产品和研发还有需要补充的吗」+ 参考项目 `D:/Project/Self/ezbookkeeping` 评审 + D-7 拍板** |
| **v2.4** | **2026-11-11** | **追记批 1 / 2 / 2.5 落地（非纯规划）**：方案升级为「部分已实现」。批 0（工程底座 `c4ce399`）/ 批 1（登录·首页·记一笔 + 401·428 + 幂等 `4feccaf`）/ 批 2（流水·账户·分类·币种 + 期初·关户 + CSV 导出 `e018cc0`）/ 批 2.5（口径对齐 fava/beancount 双审计裁决 `20fd5d8`）均已提交；`frontend/src` 57 文件 / 14067 行，Vitest **202/202 通过**。§1 现状、§11 分批表、§14.1 RTM 同步标注；AGENTS.md 同步更新到批 2.5 | **老板「更新 AGENTS.md 到批 2.5 现状，并把方案升 v2.4 追记批 1/2/2.5 落地」** |
| **v2.5** | **2026-11-11** | **进度审查后口径收口（仅文档）**：§1 标为历史基线快照并更正两处失效事实；§9 依赖就绪度、§11 批 0 交付点、§14.1 RTM、§14.3 迁移编号、§14.6 用例映射（改为覆盖矩阵）、§14.7 钉版现状逐项对齐代码；同步 AGENTS.md / CLAUDE.md / README.md / CHANGELOG.md 到批 2.5 与 v2.5；**老板追加「docs\ 目录中的文件暂时不提交」，方案 / 评估文档 / 审查报告均保持未跟踪，本次仅提交根目录 4 份文档**。**老板拍板：CI `web-verify` 门禁与工具链钉版（`.nvmrc` / `.npmrc` / lock 重生成 / 版本校验改源）暂缓，本次不动任何代码、脚本与 CI 配置**，相关交付点一律保持「未完成」，不写「已补」 | **老板「按你的推荐来吧」+「CI 前端门禁与工具链钉版暂不做」** |

### 沿用口径（v1.1 已确认，本版不漂移）

13,993 行 Dart / 60 文件 / 28 屏 / 14 个通用 widget / 31 个 REST 端点 / 675 行离线同步纯内核 / 87 个 Go 测试 / 33 个前端用例 / 4 份 HTML 原型 / iOS 14.8 Safari 14.1.2 / M2 新增 4 端点 / G-04 幂等为账本底线 / 竞品无独立预算模块 / 竞品无多账本与角色模型 / `bean-check` 必须过。

---

## 〇、结论先行（v2.0 全量版）

**下阶段目标（M7，一句话）**：**用 Vue 3 一次性重写全部前端，把 M2（备份恢复 + Beancount 导入）直接建在新前端里，然后把 Flutter Web 整体换掉并清退。**

| 问题 | v1.1 答案 | **v2.0 答案** |
|---|---|---|
| 走渐进式还是全量 | 渐进式，新载体 6 页 | **全量重构，28 屏功能全覆盖，一次性切换** |
| 新前端范围 | 登录 / 记一笔 / 流水 / 余额 / 2 个向导 = 6 页 | **20 个页面 + 2 个复用组件 + 1 套布局**（28 个 Dart 文件收敛而来），含 M2 两个向导 |
| Flutter 版怎么办 | 冻结功能、长期并存 | **开发期移到 `/legacy/` 当对账基准与回滚兜底；cutover 通过且观察期结束后删除 Dart 代码与 Flutter 构建链** |
| 离线同步内核 | 明确不做，另立项 | **必须纳入本期**（否则 FamBean 从「离线优先」降级为「在线应用」），放最后一批 + 契约测试门禁 |
| S1 真机探针 | 决定新载体 2 页还是 6 页的决策门 | **整条 S1 支线作废**：不再依赖 CanvasKit/WASM，无需给 Flutter 打兼容补丁；真机冒烟仍作为上线门禁保留 |
| M2 怎么排 | 与轻量载体合成一个里程碑 | **并入重构**：后端 4 端点按既有方案并行推进，两个向导页直接写进新前端，不写两遍 |
| 视觉 / IA 重画吗 | 不重画 | **仍不重画**。设计稿直接拆成组件，功能 1:1 覆盖，借机收敛冗余容器 |
| 工期量级 | 约 6 天（估算） | **约 20~25 天 + 约 1~1.5 天（D-7=A 已锁定，估算，单人自然日，分 6 批可中断）** —— 这是「没上线无所谓」的另一面，必须如实说；工程前提见 §5.6 / §5.7 |

**「全量重构」在本方案里的精确定义**（避免和渐进式混淆）：

> **交付方式是一次性 cutover（根路径整体切换），不做逐页流量分流、不长期维护两套前端；开发过程仍分 6 批，每批可独立验收、可随时中断。**
> 区别对照：渐进式 = 两版长期并存、按页面逐步切流量；全量 = 新版本一次写完全部页面，整体切换，旧版只在切换前当回滚兜底。

**三条不能因为「还没上线」就砍的东西**：

1. **后端契约与账芯硬约束** —— 31 个端点、复式借贷平衡、append-only 不可变交易、`bean-check` 必须过、三级账户命名空间。全量重构的是**前端**，不是全栈。
2. **离线同步内核** —— 1,149 行相关代码（纯内核 675 行 + 模型 302 行 + UI 172 行），是最容易静默出错的一块。砍掉它，重构就变成降级。
3. **在线记账幂等键（G-04）** —— 账本类底线，与用什么框架无关，v1.1 已列为必做。

**「还没上线」真正免掉的成本**（这几项确实是白捡的）：无存量用户 → 不用灰度、不用公告、不用兼容旧 URL / 书签；无存量前端本地数据 → 不用写前端数据迁移（SQLite 数据本就不动）；无迁移窗口 → 随时可切、随时可回滚；**S1 兼容补丁这条支线整体作废**。

**前端改法三句话**：
1. **设计不重画** —— `mobile-redesign-v2.html`（9 屏）/ `pc-redesign.html` 直接拆成 Vue SFC 样式底稿，4 Tab + 中央 ＋、日历视图、数字键盘、分录预览全部保留。
2. **代码全量换** —— **纯 Vue 3 + Vite 的 SPA（不引入 Nuxt / SSR）** + Pinia + Vue Router(hash) + Vitest，`build.target: 'es2015'`，禁 WASM / WebGL / CanvasKit；28 个 Dart 屏收敛为约 20 个页面。选型依据见 §5.5。
3. **一次切干净** —— 旧版以 `--base-href /legacy/` 重建后复制到 `dist/legacy/`，Go/No-Go 门禁全过后根 `index.html` 指向 Vue 产物，观察期结束清 Dart 目录与 Dockerfile 的 Flutter 构建链。

---

## 一、现状事实清单（2026-11-09 立项基线快照，非当前现状）

> **v2.5 注**：本章是 v1.0 / v2.0 立项时的端到端核对快照，**保留作为决策证据链，不代表 2026-11-11 的现状**。批 0~2.5 落地后的现状以 §11 分批表、§14.1 RTM 与 `AGENTS.md` 为准；表内两条已失效事实（工具链 / 工作区）已就地更正，其余各行请按「当时」理解。

| 维度 | 事实 | 证据 |
|---|---|---|
| 里程碑 | M0 工程护栏、M1 备份、M3 可用门槛（强制改密 / 限流 / 会话吊销 / 回收站）**均已落地** | `CHANGELOG.md` [0.5.0] + [Unreleased]、`git log` |
| 前端改版 | **F-1~F-10 四批全部收口**（theme、导航壳、记一笔、账单、资产、流水、报表、更多、认证、PC 增量 + 回归） | `docs/frontend-revamp-tasks.md`、`git log 010f9b5`、CHANGELOG [Unreleased] |
| 当前 IA | 移动 4 Tab（账单 / 资产 / 报表 / 更多）+ 中央 ＋ FAB；PC 侧边栏 4 组 9 模块；断点 1024 | `frontend/lib/app/navigation.dart`、`mobile_shell.dart` |
| 设计资产 | `docs/prototype/` 4 份 HTML（69KB / 45KB / 25KB / 25KB），v2 含 9 屏；**均自带 CSS 与交互脚本，可直接拆组件** | 本轮 `ls -la docs/prototype` |
| 代码规模 | **60 个 Dart 文件 / 13,993 行 / 28 个 screen 文件 / 14 个 widget** | 本轮 `find` + `wc -l` 实测 |
| 离线同步 | `sync_service.dart` 305 + `local_store.dart` 370 + `sync_models.dart` 302 + `sync_screen.dart` 102 + `sync_badge.dart` 70 = **1,149 行** | 本轮 `wc -l` 实测 |
| API 客户端 | 4 文件 / 1,164 行（`ledger_api.dart` 614 行） | 本轮 `wc -l` 实测 |
| 后端 | **31 个 `/api/` 端点**，`static.go` 支持目录 index、无扩展名路径回退根首页 | 本轮 `grep -c` + `sed -n '55,90p'` |
| 测试基线 | 6 个测试文件 / 33 用例、87 个 Go 测试全过；**CI verify 只跑 `go test`，连 `flutter test` 都不跑，更没有 npm 门禁** | 本轮 CI workflow 检查 + 11-06 工作日志 |
| 工具链 | 立项时 `frontend/` 下**无 `package.json`**；`/lite/` 目录**不存在** | 本轮 `ls` 实测（v1.1 把它当已有资产，此处更正）。**v2.5 更正：批 0 已引入 `package.json` / `package-lock.json` / Vite 工具链，Vue 源码 57 文件 / 14,067 行** |
| 账芯 | 期初余额与恒等式检查已提交（`aa271fd`），符号口径统一 | `git log`、11-05/11-06 工作日志 |
| 未开工 | **M2（恢复 + Beancount 导入）方案 v1.0 已出、3 个决策待拍、代码未动**；M4 / M5 / M6 均未开工 | `docs/m2-plan.md`、`docs/product-review-2026-11.md` |
| 今日新线 | iOS 14.8 白屏 → `compat-gate.js` polyfill（已提交 `936e384`）；换框架评估原推荐「Vue 3 + 渐进替换」 | `docs/frontend-framework-rewrite-assessment.md` |
| **工作区（立项时实测，与 v1.1 记录不同）** | 当时 `D docs/ios14-white-screen-plan.md`、`M compat-gate.js`、`M compat.html` 等 | `git status --short`。**v2.5 更正：2026-11-11 审查时工作区仅 `M AGENTS.md` + 2 个未跟踪 docs（方案 v2.4、换框架评估）；收口后根目录 4 份文档已提交；**docs/ 下方案 / 评估 / 审查报告按老板指示暂不入库，保持未跟踪** |

**关键判断**：F-1~F-10 把设计与 IA 做完了，这轮全量重构**不是重做设计，是把已定稿的设计从 Dart 换到 Vue，并借机收敛 4 个记录容器、3 个 shell 这类冗余结构**。设计决策、PRD、验收文档齐全，需求侧不用重新澄清——这是全量重构能成立的最大前提。

---

## 二、竞品设计拆解

> 来源：本地仓库 `D:/Project/Self/ezbookkeeping` 的 `README.md`、`src/` 目录与文件名（读取时间 2026-11-09）。以下为**已查证的能力事实**与**本方案的参考判断**，两者分开表述；仅提炼通用产品模式，不复制其界面文案、视觉或代码。

### 2.1 定位差异（决定「什么不能照搬」）

| | ezbookkeeping | FamBean |
|---|---|---|
| 记账模型 | **单式**：账户 + 分类 + 金额，两级账户与分类（README Features） | **复式 Beancount**：五大账户类型、三级分类、按币种借贷平衡、append-only 不可变交易 |
| 账本边界 | 源码未见多账本 / 成员角色模型 | **多账本隔离 + owner/editor/viewer 角色** |
| 修改语义 | 交易可编辑，带「可编辑范围」限制（上次对账之后） | **append-only 不可变**，改账 = 冲正，删除 = 软删 + 回收站 |
| 差异化 | 轻量 NAS 自托管、录入辅助、导入覆盖、分析图表 | 可审计账芯、标准兼容、离线多端同步、数据自持 |
| 结论 | **记账模型与数据层禁止照搬** —— 照搬即破坏 `bean-check` 硬约束 | 只借鉴「交互模式 / 信息组织 / 流程设计」 |

> **反向结论（同样重要）**：竞品为了「可编辑」才需要对账与可编辑范围限制；FamBean 的 append-only 模型天然不存在「改坏历史」的问题。**多账本、角色权限、复式可审计、离线同步是 FamBean 的长板，不能为了对齐竞品而弱化。**

### 2.2 信息架构与页面组织（已查证）

- **双端是两套独立入口，不是 CSS 响应式**：由服务端按 UA 分流到不同的 HTML 入口（桌面 / 移动各自 `index`），视图层 `src/views/desktop/` 与 `src/views/mobile/` 分家，组件层同样分家；768px 是「桌面内紧凑布局」的断点，不是切端断点。
- **架构上做了正确的解耦**：`src/core/`（模型 / 常量 / i18n）、`src/stores/`（状态）、`src/router/`（路由表）、`src/lib/`（服务）**双端共享**；只有 views 与 components 分叉。逻辑写一遍，UI 写两遍。
- 桌面按**领域分组**：accounts / categories / exchangerates / customicons / insights（数据探索器含图表、数据表、可编辑数据表、查询四个 Tab）/ transactions / settings。
- 移动以 **Sheet（底部弹层）** 为主要交互形态：数字键盘、日期/月份/范围选择、标签选择、树形选择、双列选择、颜色/图标选择。移动底部为 **5 Tab：明细 / 账户 / 中间 ＋ / 统计 / 设置**。
- 首页是**可编排的 widget 网格**（约 14 类卡片：净资产、当月收支、支出进度、账户余额、趋势、日历热力等），每类卡片按需取数而非整页一次拉全。
- 概览支持自定义布局、深色模式、PWA（README Features）。

**参考判断（v2.0 调整）**：竞品「逻辑层与视图层解耦、双端共享领域层」的做法，在**全量重构时正好可以一步到位落地**——新前端按 `core / api / stores / views / components` 分层，逻辑写一遍。但**不学它维护两套 UI**：FamBean 保持「一套 Vue 代码 + CSS 断点双布局」，单人维护成本更低。真正值得学的是 **① 逻辑层解耦 ② 按设备给不同信息密度 ③ 首页卡片按需取数**。

### 2.3 录入与分析能力（已查证的能力名词）

| 类别 | 竞品具备（依据文件 / README） |
|---|---|
| 记账主表单 | **支出 / 收入 / 转账 / 余额调整四类共用一张表单**，`Add / Edit / View` 三态复用同一组件；金额支持公式计算与多币种联动；二级分类 / 账户用**双列级联选择器**并在选项旁显示余额 |
| 录入辅助 | 数字键盘 `NumberPadSheet.vue`、金额输入 `AmountInput.vue`、交易日历 `TransactionCalendar.vue`、图片附件、地理位置 `MapView/MapSheet`、标签自动补全 |
| 连续记账 | 保存后提供「返回 / 连续新增 / 复制上一笔」三种去向；表单草稿自动保存；提交带 **客户端幂等标识**，避免弱网重复提交 |
| 重复录入 | **模板与周期交易是同一个模型**（模板 = 预填交易，周期 = 带频率的模板），`ScheduleFrequencySelect/Sheet.vue` 只负责频率 |
| 流水列表 | **三种视图**（列表 / 日历 / 相册）+ **两级汇总**（月份块头汇总、每日小计）；筛选状态写进 URL，可分享可回退；标签筛选支持 4 种逻辑组合 |
| 批量处理 | 批量删除 / 批量改账户、分类、标签（`insights/dialogs/Batch*.vue`） |
| 对账 | 账户对账单、上次对账时间、对账后限制可编辑范围 |
| 分析 | 桑基图、热力图 / 日历热力图、雷达图、饼图、账户余额趋势、层级图、数据探索器与查询 Tab |
| 导入导出 | **CSV / Excel / OFX / QFX / QIF / IIF / Camt / MT940 / GnuCash / Firefly III / Beancount 等**，含自定义列映射、规则、脚本与预设保存；另有 JSON / 数据导出 |
| 安全与账号 | 2FA、OIDC、登录限流、应用锁（PIN / WebAuthn） |
| AI | 文本与小票图片识别、AI 生成图表、MCP 集成、Agent Skill；PWA 通过 Web Share Target 直接接收小票图片 |
| 国际化 | 多语言 / 多币种 / 多时区 / 多汇率源自动更新 / 自定义日期数字格式 |

### 2.4 逐项对照：借鉴 / 改造 / 明确不做

| # | 竞品能力 | FamBean 现状 | 决策 | 理由 |
|---|---|---|---|---|
| B-01 | 多格式导入（含 Beancount）+ 列映射 + 解析预览 | 只导出；M2 方案已出未开工 | **照做（本期）** | D-4 已押 Beancount 生态，「只出不进」是唯一战略级差距 |
| B-02 | 恢复 / 备份可视化向导 | M1 备份卡片已有，恢复无入口 | **照做（本期）** | 数据自持闭环的另一半；M2 已定预检 + 二次确认 |
| B-03 | 解析错误全量行号 + 整体拒绝 | M2 方案已写 | **照做（本期）** | 静默丢账是账本应用的致命错误 |
| B-04 | 标签自动补全 | 标签已有（`transactions.tags`），输入为手填 | **改造（Should）** | 低成本提升录入效率，数据现成 |
| B-05 | 周期交易 | 无（M5） | **记入 M5，本期不做** | 家人尚未开始用，留存机制无作用对象；**沿用竞品「模板 = 预填交易、周期 = 带频率的模板」的同一模型**，M5 可少建一套实体 |
| B-06 | 批量改分类 / 加标签 / 删除 | 无（G-14） | **后续版本（Could）** | 有价值但不在核心闭环，避免范围蔓延 |
| B-07 | 数字键盘 / 金额大屏 / 分类九宫格 | F-3 已落地 + 分录预览（竞品无） | **不重复** | 已具备，且复式分录预览是 FamBean 长板；全量重构按原样复刻 |
| B-08 | 日历视图 / 按日分组 | F-4 / F-6 已落地 | **不重复** | 已具备，按原样复刻 |
| B-09 | 桑基 / 热力 / 雷达 / 数据探索器 | 基础图表 | **明确不做** | D-4 已拍板「不做自建分析，交给 Fava / `bean-query`」 |
| B-10 | 图片附件 / 地理位置 | 无 | **明确不做** | 家庭内网场景价值低，且增加自持存储与隐私负担 |
| B-11 | AI 识别 / MCP / AI 图表 | 无 | **明确不做** | D-2 内网自持，不接外部模型；与主线无关 |
| B-12 | 2FA / OIDC / 应用锁 | 强制改密 / 限流 / 会话吊销 / 隐私遮挡 | **明确不做** | D-2 内网为主，现有水位已够 |
| B-13 | 深色模式 / 自定义概览 | F-1~F-10 已明确不做深色 | **明确不做** | 上轮已拍板，不翻案 |
| B-14 | 桌面 / 移动两套独立 UI | 响应式双布局一套代码 | **不学** | 单人维护不起；只学「逻辑层解耦」与「按设备给信息密度」 |
| B-15 | **提交幂等 + 连续记账 + 草稿** | 在线 `POST /api/transactions` **无幂等键**（G-04）；离线 `sync/push` 已有按 uuid 幂等 | **照做（本期，必做）** | 账本类底线：弱网重试点两次会产生两笔真实交易，且 append-only 模型下无法原地改，只能冲正 |
| B-16 | 一张表单三态复用 / 模板与周期同模型 | F-3 三 Tab 已有，Add/Edit/View 分组件 | **全量重构落地** | 新前端把记一笔做成**一个组件 + 三种容器**（PC 弹窗 / 移动 Sheet / 全屏），4 个 Dart 文件收敛为 1 |
| B-17 | 双列级联选择器带余额 | 账户/分类选择器不带余额 | **改造（Should）** | 低成本减少「选错账户」；余额数据本地已有 |
| B-18 | 两级汇总 / 筛选状态 URL 化 | 已有按日分组与日历 | **改造（Should）** | 全量重构用 Vue Router 顺手把筛选写进 query，成本比 Dart 低；相册视图不做 |
| B-19 | **独立预算模块** | 无（原列 M5） | **明确不做（M5 重估）** | **竞品全库亦无独立预算实体**，只在首页用「当月支出进度」卡片承载 → 印证不必自建预算模型，M5 应优先做周期记账 |
| B-20 | 首页可编排 widget / 卡片按需取数 | 账单页整页本地聚合 | **Could** | 家庭数据量下本地聚合够用（F-1~F-10 已论证），不急 |

---

## 三、差距诊断

**表面差距**（图表数量、附件、AI、2FA）大多属于**刻意不做**或**低价值**，且 D-4 已明确把分析交给生态工具。真正剩下的只有四条：

| 编号 | 差距 | 级别 | 落在哪 | 依据 |
|---|---|---|---|---|
| G-01 | **只出不进**：导出的 `.beancount` 回不来，外部账本也进不来 | 战略级（D-4 主线的断点） | **M7 / M2** | 竞品已支持 Beancount 等十几种格式导入；FamBean 仍只有 `/api/export` |
| G-02 | **备份了回不去**：M1 只解决「能备份」，无恢复入口 | 阻断级（数据自持承诺） | **M7 / M2** | `docs/m2-plan.md` 方案已出、代码未动 |
| G-03 | **浏览器基线卡住家人设备**：iOS 14.8 白屏，Flutter Web 依赖 CanvasKit/WASM | 可用性硬阻断 | **M7 / 全量重构** | 真机诊断 + 换框架评估 |
| G-04 | **在线记账无幂等键**：`POST /api/transactions` 每次 `uuid.NewString()`，重复提交即两笔 | **底线级（账本类）** | **M7 / 必做** | 本轮代码实测：`internal/service/transaction.go` `CreateTransaction`；离线 `sync/push` 走 `saveTransaction(idempotent=true)` 反而有幂等 |

**也应记住 FamBean 已有的长板**（不要只盯差距）：复式可审计账芯、三级分类、多账本 + 角色隔离、append-only 不可变交易、离线优先同步、备份一致性快照、期初余额与恒等式检查 —— 这些竞品多数没有，或对账成本更高。

**四者在全量重构里一次性收口**：Vue 3 产物是纯 DOM + 普通 JS，从根上不再有 CanvasKit/WASM 的版本墙（G-03）；M2 的两个向导页直接写进新前端（G-01 / G-02）；幂等键随新前端的记一笔一起落地（G-04）。**v1.1 里「新页面写在哪」这个问题，在全量重构下自动消失——所有页面都写在新前端。**

---

## 四、下阶段目标（M7，v2.0 重定义）

### 4.1 目标定义

> **M7：用 Vue 3 全量替换 Flutter Web 前端，功能 1:1 覆盖 + 补齐 M2 数据自持闭环 + 修复在线记账幂等，一次性切换后清退旧前端。**

**与 v1.1 的差别**：v1.1 把「换框架」当成长期选项（阶段 2~4 另立项），M7 只做 M2 + 6 页切片；v2.0 把换框架本身变成 M7 的主交付物，M2 与幂等作为其中的功能项一并落地。

**为什么可以合并**：全量重构本来就要重写记一笔、流水、设置、数据安全这些页面；M2 的两个向导只是多写两页，边际成本远低于「先在旧版写一遍、重构时再写一遍」。

### 4.2 成功指标（含口径）

| 指标 | 目标值 | 口径与统计方式 | 数值来源 |
|---|---|---|---|
| **功能覆盖率** | **28 / 28 个 Dart 屏的功能点全部可达** | 按 §14.1 RTM 逐条核对：每个旧屏的核心操作在新前端有对应入口且可完成；收敛项（4→1 等）按「功能不减」判定 | 本轮 `find frontend/lib/screens` 实测 28 文件 |
| **API 覆盖率** | **31 / 31 个既有端点均被新前端调用或明确保留后端能力** | 按 `router.go` 端点清单逐条对照新前端 API 层；未覆盖项需书面说明归属 | 本轮 `grep -c` 实测 |
| 导入 round-trip 一致性 | **差异 0** | 自家导出的 `.beancount` → 导入 → 再导出；账户数 / 交易数 / 金额逐项一致，两次导出文本等价，且两次均过 `bean-check`（退出码 0） | `m2-plan.md` §8 |
| 恢复一致性 | **差异 0** | 还原后五张核心表行数与预检摘要完全一致，`integrity_check` = ok，还原前自动生成 `pre-restore` 快照 | `m2-plan.md` §8 |
| 真机可达性 | **全主流程无白屏** | iOS 14.8 Safari 打开新前端，登录 / 首页 / 记一笔 / 流水 / 账户 / 设置 / 数据安全 主流程无白屏、无阻断性 JS 错误；按真机冒烟清单逐页判定 | `no-upgrade-compat-plan.md` §6 |
| 记一笔关键操作数 | **≤ 3 次** | 从点击「＋」到提交成功的关键操作次数，不含金额字符输入与键盘收起；口径沿用 F-3 验收 | `frontend-revamp-tasks.md` F-3 |
| **离线同步契约** | **100% 通过** | 新增的同步契约测试覆盖 pull / push / 水位增量 / 幂等 / 自然键合并 / uuid 重映射，逐条与旧版行为对齐 | 本方案 §6.6 |
| 回归零破坏 | **0 项回归** | 33 个用例重写为 Vitest 且 CI 全绿 + 87 个 Go 测试全过；`BEAN_CHECK_STRICT=1` 全绿 | 11-06 验证记录 |
| 新增业务端点 | **4 个** | M2 的 `restore/preview`、`restore`、`import/preview`、`import`；**全部来自 `m2-plan.md`，本方案不新增端点** | `m2-plan.md` §4/§5 |
| 重复提交产生的交易数 | **恒为 1** | 同一幂等键在弱网下重复提交 3 次，流水只新增 1 笔，且返回同一 uuid | 本轮代码实测缺口 G-04 |
| **旧代码清退** | **cutover 观察期后 `frontend/lib/` 与 Dockerfile Flutter 构建链移除** | 以 `git rm` 记录为证；观察期长度由老板定（建议 3~7 天） | 本方案 §11 批 6 |

**最小数据能力（每版本必备）**：导入 / 恢复操作留痕（操作人、时间、文件名、结果、错误行数），在「设置 → 数据安全」可查最近 10 条，用于事后复盘，不引入外部埋点服务。

### 4.3 范围

| 包含（In） | 不包含（Out，本期明确不做） |
|---|---|
| **Vue 3 全量前端**：20 页 + 2 复用组件 + 1 套响应式布局，覆盖 28 个旧屏全部功能 | **后端账芯重写**：31 端点、复式平衡、append-only、导出器、数据库 schema 全部不动 |
| **离线同步内核重写**（1,149 行相关代码）+ 契约测试 | 周期记账、预算（M5 重估后预算不做）；批量操作（Could） |
| **M2 后端 4 端点** + 导入向导 / 恢复向导（并入新前端） | 报表增强图表、AI、附件、位置、2FA、深色模式（§2.4 已判不做） |
| **在线记账幂等键**（G-04，账本类底线，不可砍） | 公网 HTTPS / 反代（D-2 已砍） |
| 兼容基线固化（README / AGENTS.md / CI 门禁） | 独立预算模型、对账模块（M4 候选） |
| 旧版 `/legacy/` 对照 + 一次性 cutover + 观察期后清退 | **S1 兼容补丁支线**（`compat-gate.js` / `compat.html` / selftest）：目标消失，建议收口 |
| 33 个前端用例重写为 Vitest + CI 补前端门禁 | 用户数据迁移（无存量用户，且后端数据不动） |
| 现有工作区未提交改动的收口 | 桌面 / 移动两套独立 UI（B-14 不学） |

### 4.4 与既有路线图的关系

```
M0 ✅ → M1 ✅ → M3 ✅ → 【M7 = 前端全量重构 + M2 + 幂等】 → M4 生态深化 → M5 留存 → M6 打磨
                              ↑
                 换框架评估的阶段 1~4 全部并入 M7（不再另立项）
                 S1/S2 兼容补丁支线作废
```

**M2 不改名、不扩范围**，仍按 `docs/m2-plan.md` 的 M2-a~M2-g 执行；M7 只是把它的前端部分（M2-c / M2-f）改为写进 Vue 版，后端 M2-a/b/d/e/g 不变。

---

## 五、方案对比与选型（v2.0 重做）

> 老板已拍板「全量重构」，因此本节**不再讨论要不要全量**，只讨论「全量怎么落地最稳」：三个候选都是全量，差别在切换方式与内核处置。

### 5.1 三个候选

| 方案 | 思路 |
|---|---|
| **A** | 全量重写 + **长期双版并行**：新前端挂 `/v2/`，旧版继续在根路径，逐页放量，半年后再切 |
| **B** | 全量重写 + **一次性 cutover，但离线内核后补**：先上在线全功能，离线同步另立项 |
| **C（推荐）** | **全量重写 + 一次性 cutover + 离线内核同期完成**：开发期旧版以 `--base-href /legacy/` 重建并复制到 `dist/legacy/` 当对账基准，Go/No-Go 全过后切根路径，观察期结束清退 Dart |

### 5.2 五维对比

| 维度 | A 长期双版并行 | B cutover 但离线后补 | **C 一次性 cutover + 内核同期** |
|---|---|---|---|
| 实现成本 | 高（两套长期维护 + 分流逻辑） | 中 | **中~高（一次性投入）** |
| 开发复杂度 | 高（双版状态、路由、缓存头都要兼顾） | 中 | **中** |
| 用户体验 | 分裂（家人可能进到不同版本） | 短期降级，且**没上线就没感知** | **一致，能力不降级** |
| 风险 | 中（永无「做完」的一天，最易半途而废） | **高（FamBean 从离线优先降级为在线应用）** | **中（内核重写集中在最后一批，有契约测试兜底）** |
| 上线时间 | 最慢 | 快 | **较慢（20~25 天估算）** |
| 与老板决策一致性 | 冲突（等于换皮的渐进式） | 部分一致 | **一致** |

### 5.3 推荐结论

**推荐 C**。理由按权重：

1. **「没上线」正好是 cutover 的最佳窗口**：没有灰度、没有公告、没有旧 URL 兼容、没有迁移窗口，A 的全部优势都失效了，只剩维护两套的负担。
2. **能力不降级**：离线优先 + 多端同步是 FamBean 相对竞品的长板（§2.1），B 把它砍掉等于用重构换降级，不划算。
3. **风险可控**：全量重写最大的敌人是账本里的**静默错误**（金额符号、期初标记、恒等式），而不是工期。C 用「旧版 `/legacy/` 冻结为对账基准 + 恒等式断言 + `bean-check` 回归 + 同步契约测试」四条兜底，把静默错误变成可检测错误。
4. **一次清干净**：cutover 后删 Dart、改 Dockerfile、CI 换门禁，不留「两套构建链长期并存」的技术债。

**不选 A**：与老板「全量」决策相悖，且单人维护两套前端的结局大概率是两套半成品（换框架评估 RK-07 已点名）。
**不选 B**：离线内核后补在「已上线」后会变成永远排不上的技术债；现在没上线，正是把它一次做对的最便宜时刻。

**演进路径（本期 → 后续 + 触发条件）**

| 阶段 | 内容 | 触发条件 |
|---|---|---|
| **M7（本期）** | 全量 Vue 前端 + M2 + 幂等 + 离线内核 + cutover + 清退 | 立即 |
| 后续 A | M4 生态深化（通用 Beancount 语法、Fava 集成） | M7 验收通过 |
| 后续 B | M5 留存（周期记账优先，预算不做） | 家人开始实际使用 |
| 后续 C | 筛选状态 URL 化、标签自动补全等 Should 项补强 | 按实际使用反馈排序 |
| 后续 D | M6 打磨 | 按 `product-review-2026-11.md` 原顺序 |

### 5.4 全量重构下 S1 探针的处置（v1.1 决策门作废）

| v1.1 | **v2.0** |
|---|---|
| S1 成功 → 新载体只做 2 页（纯 ES5）；失败 → 扩成 6 页（Vue 3） | **不再需要 S1 作为决策门**：全量重构后根路径就是 Vue 3 产物，不依赖 Flutter 引擎，白屏根因（CanvasKit/WASM）从产物里消失 |
| 真机冒烟是新载体验收项 | **真机冒烟保留为全站上线门禁**，且范围从 4 页扩到全部主流程 |
| `compat-gate.js` 补丁继续维护 | **建议收口**（回滚或删除），涉及删文件需老板确认，见 §13 D-5 |

### 5.5 框架二次选型：纯 Vue 3 SPA 还是 Nuxt（v2.1 新增，已给结论）

> **结论：选纯 Vue 3 + Vite 的 SPA，不引入 Nuxt、不启用 SSR。**
> 理由不是「Nuxt 不行」，而是 **Nuxt 的核心价值（SSR / SSG / SEO / 服务端路由）在 FamBean 场景里逐条落空，且会与已定的「Go 单容器单端口 + 静态托管」部署模型直接冲突**。以下项目事实均为本轮本地实测，框架能力描述为通用工程判断，两者分开表述。

#### 5.5.1 三个候选与五维对比

| 方案 | 思路 |
|---|---|
| **A（推荐）** | **Vue 3 + Vite 纯 SPA**：`vite build` 出静态目录，交给 Go 的 `LEDGER_WEB_ROOT` 托管 |
| **B** | **Nuxt 3 SSR**：Nitro 服务端渲染，运行时多一个 Node 进程 |
| **C** | **Nuxt 3 静态导出**（`ssr: false` / `nuxt generate`）：本质仍是 SPA，只买「约定式路由 + 自动导入」 |

| 维度 | A 纯 Vue SPA | B Nuxt SSR | C Nuxt 静态导出 |
|---|---|---|---|
| 实现成本 | **低**（构建链只换 Stage 1） | 高（运行时加 Node、改 compose / 反代 / 健康检查 / 降权脚本） | 中（多一层框架配置，产物仍是静态） |
| 开发复杂度 | **低**（显式路由表、单一构建目标） | 高（认证态透传、hydration、双端环境判断、Nitro 配置） | 中（约定式路由 + 自动导入，心智模型多一层） |
| 用户体验（本项目口径） | **够用**：内网登录后使用，无公开首屏；离线壳天然适配 | 无收益：数据全在登录态之后，服务端无可读认证态可直出 | 同 A |
| 风险 | **低**：白屏根因链短、`es2015` 单一开关可控 | **高**：改部署模型即动 §7「后端零改动」硬约束；SSR 报错在 Safari 14.1 上更难定位 | 中：构建链变长，兼容面比单 Vite 宽（**工程判断，非查证结论**） |
| 上线时间 | **快** | 慢 | 中 |

#### 5.5.2 四条决定性依据（项目实测）

| # | 事实 | 推论 |
|---|---|---|
| 1 | **`Dockerfile` 注释明写「单容器单端口：Go 进程同时提供 API 与前端静态资源」**；Stage 3 是 `alpine:3.20` + 一个 Go 二进制 + `COPY --from=web-builder .../build/web /app/web`，**运行时没有 Node**；`docker-entrypoint.sh` 用 `su-exec` 降权并 `exec` 单进程 | Nuxt SSR 要么往运行时塞 Node 进程（破坏单进程模型），要么拆成双容器 + 反代（改 compose、健康检查、降权逻辑）。**这是最硬的一条**：等于把 §7「后端零改动」和已验证的部署链一起推翻 |
| 2 | `internal/server/static.go` 的 `spaHandler` 明确「未命中且无扩展名 → 回退 `index.html`」「`/api/` 永不回退」；`LEDGER_WEB_ROOT` 默认 `./web` | 这套托管规则就是为 SPA 写的。Vite 产物丢进 `/app/web` 即可，**0 行后端改动** |
| 3 | **`docker-compose.yml` 注释「本产品面向内网」**；`README.md` 写「PWA：可安装、离线壳、IndexedDB 本地真相源」；D-2 已砍公网 HTTPS | **零 SEO 需求、零公开落地页、零首屏直出需求** —— SSR / SSG 的三个主要收益全部不成立；而离线优先 + IndexedDB 是纯客户端模型，SSR 注水后才可用，反而多一层 |
| 4 | v2.2 前 §7 曾写「token 只存内存 / `sessionStorage`，不推动后端改 Cookie」；**v2.3 起 D-7 已锁定 A（httpOnly Cookie）**，但 SSR 的收益判断不变 | 即便服务端能读到 Cookie，FamBean 仍无 SEO / 首屏直出需求（依据 3）；Cookie 化只解决 XSS 与刷新体验，不构成选 Nuxt 的理由。Nuxt SSR 在本期仍等于「只 SSR 出一个登录壳」，收益为零 |

#### 5.5.3 对「Nuxt 也能纯静态」的回应

C 方案技术上可行，也确实不引入 Node 运行时。但 `ssr: false` 之后，Nuxt 保留下来的只有**约定式文件路由与自动导入**，而这两项对本期的价值是负的：

- §6.2 的页面映射表要按 **28 屏 → 20 页**逐条做 RTM 覆盖率验收，**显式路由表比目录约定更好核对**；
- 引入 Nitro / 模块生态 / Nuxt 配置层，换来的便利抵不过多一套约定与升级链；
- 兼容基线的可控性：Vite SPA 是 `build.target: 'es2015'` 一个显式开关，Nuxt 多一层构建编排（工程判断）。

**结论**：C 是「花 Nuxt 的成本买 SPA 的结果」，不选。

#### 5.5.4 反转条件与演进路径（现在选 SPA 不把路走死）

| 触发条件 | 届时的动作 |
|---|---|
| 出现**公开可索引内容**（帮助中心、公开账本分享页、产品官网） | 单独为该内容做 SSG / Nuxt 子站，主应用仍是 SPA |
| 决定把 BFF 收进 Node、**替换 Go 后端** | 已不是「前端重构」，另立项重评全栈架构 |
| 需要**未登录落地页服务端直出** | 与内网登录制定位冲突，先重评 D-2 |

**可迁移性**：Nuxt 3 与 Vite SPA 同属 Vue 3 生态，SFC、Pinia store、`core/` 领域层、API 客户端均可复用；真出现上述条件时，迁移主要是路由与构建配置，不是重写业务逻辑。

#### 5.5.5 对本方案的影响

| 影响面 | 结论 |
|---|---|
| §6.5 技术栈 | 明确为「Vue 3 + Vite **SPA**」，不写 SSR / Nitro / server routes |
| §6.7 Dockerfile | Stage 1 由 Flutter SDK 换 `node:22-alpine` + `npm ci && npm run build`，产物目录改为 `frontend/dist`（见 §5.7 S-A01）；**Stage 2 / Stage 3 / entrypoint / compose 全不动** |
| §7 API 变更 | 除 M2 4 端点 + 幂等字段外，**另加 D-7 认证改造（Cookie 下发 / CORS 收敛 / CSRF 头）与库世代字段**；其余 31 端点结构不变 |
| §9 依赖 | 运行时**不新增 Node 依赖**（Node 只在构建阶段），部署侧无新阻塞项；构建期依赖按 §14.7 钉版 |
| §10 验收 | AC-19 静态扫描扩展到 API 特性与 CSS 特性（§14.7），其余不变 |

### 5.6 全栈工程可行性评审（v2.2 新增）

> **结论：整体可行，但不是「照着页面清单写 20 个 Vue 文件」就行。**
> 架构、部署、接口契约三条主链都成立；方案里漏了 **3 个 P0 级、5 个 P1 级工程前提**，其中「金额精度」「幂等落库」「认证存储」若不先定，会在批 1 就返工，或更糟——产生**静默错账**。以下为本地代码实测，不是推测。

#### 5.6.1 三个 P0（不补不能开工）

| # | 缺口 | 实测依据 | 后果 | 处置 | 批次 |
|---|---|---|---|---|---|
| **E-01** | **金额精度缺少 JS 等价物** | 现有 `frontend/lib/core/store/local_store.dart`、`viewmodels/ledger_controller.dart`、`screens/reports/reports_screen.dart` 全用 `package:decimal/decimal.dart` 做定点累加（`Decimal.parse` / `Decimal.zero`）；方案 §6.4 只写「金额用定点十进制字符串」，**没指定 JS 侧运算库** | JS `Number` 是 IEEE754 浮点。净资产 `ΣAssets + ΣLiabilities`、日历每日小计、报表分组求和一旦用裸 `+`，就是 11-05 修过的那类**静默错账** | 引入 `decimal.js`（或 `big.js`），封装 `core/Money` 唯一入口；**禁止组件里裸 `+/-` 参与金额**；33 个用例中的金额用例逐条对齐旧版结果 | 批 0 |
| **E-02** | **幂等键只有协议、没有落库方案** | `schema.sql` 的 `transactions` 表**无幂等列**，只有 `uuid UNIQUE`；迁移已到 **`012_opening_balance`**（`migrate.go` 的 `migrations` 数组，AGENTS.md 里「002 为最新」已过期）；§7 只写「请求体加 1 个可选字段，按 `(ledger_id, 标识)` 查重」 | **先查后写在并发下挡不住**：两个请求同时通过检查 → 两笔真账。append-only 下只能冲正 | 加 **迁移 013**：`client_request_id TEXT` + **部分唯一索引** `UNIQUE(ledger_id, client_request_id) WHERE client_request_id IS NOT NULL`；**v2.3 补全冲突矩阵、`ON CONFLICT` 谓词与事务边界，见 §7 / §5.7 S-A04**；旧客户端不传该字段则行为不变 | 批 1 |
| **E-03** | **认证存储与现有体验冲突**（**v2.3 已拍板 = A**） | 现有 `frontend/lib/core/api/ledger_api.dart` 把 token 存 **`localStorage`**（`fl_token`），注释明写「刷新后保持」；方案 §6.5 改为「只存内存 / sessionStorage，**刷新需重新登录**」；`internal/server/middleware.go` 的 `authMiddleware` **只读 `Authorization: Bearer`**；CORS 是 `*` | 二选一都难受：照方案走 → 家人每次刷新都要重登（**体验降级**）；沿用现状 → localStorage 可被任意 JS 读取，XSS 直接拿走 30 天会话 | **已锁定 A**：登录 / 刷新 / 登出下发 **httpOnly + SameSite=Lax** Cookie（内网 HTTP 不设 Secure），`authMiddleware` **Cookie 优先、Bearer 兜底**，CORS 由 `*` 收敛为回显 Origin + `Allow-Credentials` + `Vary: Origin`，非 GET 加自定义头防 CSRF。实施清单与回退开关见 §13 D-7 | 批 0 决策 / 批 1 实施 |

#### 5.6.2 五个 P1（不补会返工或埋雷）

| # | 缺口 | 实测依据 | 处置 | 批次 |
|---|---|---|---|---|
| **E-04** | **PWA / Service Worker 方案空缺** | 现有离线壳是 `frontend/build/web/flutter_service_worker.js`（Flutter 生成）；`frontend/web/manifest.json` 已含 4 组图标、`standalone`、可复用；方案 §8 只写「离线壳」 | 用 `vite-plugin-pwa`（injectManifest）或手写 SW；**只缓存应用壳与静态资源，API 响应一律不缓存**（本地真相源是 IndexedDB，缓存响应会与同步协议打架）；清退 Flutter 时别把 manifest/icons 一起删了 | 批 5 |
| **E-05** | **依赖语法降级未覆盖** | Vite `build.target: 'es2015'` **默认不转译 `node_modules`**；AC-19 只扫 WASM / target | 引入 decimal.js、IndexedDB 封装、图表库后做**构建产物语法扫描**（如 `es-check es2015`）+ 依赖白名单；必要时显式转译指定依赖；真机全主流程冒烟仍是最终门禁。这是工程判断，非「Nuxt/SPA 不兼容 Safari」的结论 | 批 0 / AC-19 扩展 |
| **E-06** | **开发期跨域与 Base URL** | 生产是单容器同源，API 走相对 `/api` 即可；开发期 Vite dev server 另一端口；后端 `cors()` 当前固定 `*`（D-7 后收敛为回显 Origin） | `vite.config.ts` 配 `server.proxy` 把 `/api` 转发到 `127.0.0.1:8080`，**开发期走同源代理，不依赖 CORS**；生产代码禁止出现绝对后端地址；`import.meta.env` 只放非密钥配置（`base:'./'` 支持反代子路径） | 批 0 |
| **E-07** | **401 / 428 与刷新并发** | 后端 `/api/auth/refresh` 换发新 token、旧立即失效；`authMiddleware` 在「必须先改密」态对业务端点返回 **428**；现有前端只有 `refresh()` 方法，**无统一 401 拦截** | API 客户端做 **single-flight 刷新队列**（并发 401 只发一次 refresh，其余挂起复用结果；refresh 本身走裸 fetch 绕过拦截器防递归）；401 → 重试一次 → 失败统一登出；428 → 跳改密页 | 批 1 |
| **E-08** | **`X-Ledger-Id` 遗漏会静默错账** | 多账本上下文靠该头，缺失**回退默认账本 id=1**（`AGENTS.md` §7）；现有 `ledger_api.dart` 统一注入；`middleware.go` 中 `/api/health`、`/api/auth/*`、`/api/ledgers`、`/api/backup/*`、`/api/settings/*` **本就不解析账本** | 新 API 客户端强制注入并**按白名单豁免**上述端点（缺失即抛错，不静默回退）；切账本时清空相关 store 缓存；**恢复后先校验持久化 ledger id 是否仍在成员列表**，不在则回退首个账本；验收补「切账本后记一笔落在正确账本」与「恢复后不 403」 | 批 1 |

#### 5.6.3 已经具备的工程基础（利好，别只盯缺口）

- **后端三层已到位**：`handler / service / repository` 分工清楚，控制器不写业务逻辑；新前端只需补一个 API 客户端层，**不把业务规则回流到 Vue 组件**。
- **错误结构已规范化**：`internal/handler/handler.go` 的 `writeError` 与 `frontend/lib/core/api/api_error.dart` 的 `ApiException.fromBody` 已约定 `{ error, code?, ...details }`，含 409 的 `balances` 明细。4xx 不重试 / 5xx 最多 3 次 / fetch 失败显示离线提示且保留输入，可在**一个类型化 fetch 封装里统一做**，不用逐页写。
- **静态托管 / SPA 回退 / manifest / icons 可复用**；CI 只跑 `go test`，补前端门禁是净收益。
- **31 端点契约稳定**，可按 `router.go` 生成 TS 类型，跨端类型安全成本很低。

#### 5.6.4 前端分层与 API 客户端落地建议

```
src/
  core/     领域常量、Money(decimal.js 封装)、ApiError 类型 —— 零 UI 依赖
  api/      类型化 fetch 封装 + 31 端点请求/响应类型 + 错误映射 + 令牌/账本头注入
  sync/     IndexedDB 本地真相源 + SyncEngine（契约测试）
  stores/   Pinia 按域
  views/ components/    只渲染，不写金额运算与同步逻辑
```

关键封装**示意**（设计示例，非落库代码；认证按 D-7=A 的 Cookie 形态定稿）：

```ts
export class ApiError extends Error {
  constructor(public status: number, public code?: string, public details?: unknown) {
    super(`HTTP ${status}`);
  }
}

let refreshing: Promise<boolean> | null = null; // single-flight

async function request<T>(path: string, init: RequestInit = {}, retry = 0): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...ledgerHeader(), ...init.headers },
  });
  if (res.status === 401) {
    refreshing ??= refreshOnce().finally(() => { refreshing = null; }); // refreshOnce 用裸 fetch，避免递归
    return (await refreshing) ? request<T>(path, init) : Promise.reject(new ApiError(401));
  }
  if (res.status === 428) { goto('/change-password'); throw new ApiError(428); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status >= 500 && retry < 3) return request<T>(path, init, retry + 1); // 4xx 不重试
    throw new ApiError(res.status, body.code, body);
  }
  return res.json() as Promise<T>;
}
```

`ledgerHeader()` 必须每次返回 `X-Ledger-Id`，缺失即抛错而非静默回退（对应 E-08）。错误到用户文案的映射集中在 `api/errors.ts`，禁止把 `HTTP 500` 原文甩给家人。

#### 5.6.5 对工期与分批的影响

| 项 | 结论 |
|---|---|
| 20~25 天估算 | **不推翻，但补前提**：该估算已含「写 20 页 + 记一笔 + 内核」，E-01 / E-02 是**设计前置**而非额外工作量（本来就要写这些代码） |
| D-7 = A（已锁定） | **已计入约 1~1.5 天（估算）**，含 Cookie 下发、CORS 收敛、CSRF 头与 Bearer 双读；总口径写「20~25 天 + 约 1~1.5 天」 |
| 批 0 增补 | decimal 库与 `Money` 封装、dev proxy、依赖语法 / API / CSS 特性扫描门禁、**D-7=A 认证改造落地**、版本钉版与 lockfile |
| 批 1 增补 | 迁移 013（幂等键）+ 唯一索引 + 冲突矩阵、401/428 封装、`X-Ledger-Id` 断言、AC 新增项 |
| 批 5 增补 | SW / PWA 离线壳（更新提示、租约、隔离区） |
| 关键路径 | **批 0 的工程底座与 D-7 改造 → 批 1 的认证与幂等 → 后面所有页面**。这一链路是唯一会阻塞全局的地方，其余页面可并行推进 |

### 5.7 v2.3 补充评审收口

> 三方评审（架构/数据、离线内核、前后端契约）在 §5.6 之外又找出 6 条 P0。**D-7 已按 A 拍板**，下面 S-A01~S-A06 全部并入本方案：S-A01/S-A02/S-A03 落 §6.5/§6.7/§9/§11/§12，S-A04 落 §7，S-A05 落 §7/§6.6，S-A06 落 §14.5/§10。**P1/P2 已分别并入 §6.5 / §6.6 / §7 / §9 / §10 / §11 / §12 / §14，不再单列**。

| 编号 | 问题（v2.2 遗留） | 处置（已写入本版） | 落地章节 | 批次 |
|---|---|---|---|---|
| **S-A01** | **产物目录冲突**：§6.5 原写「Vite 产物输出到 `frontend/web/`」，与 Flutter 源目录同名；`emptyOutDir` 会清空源 `index.html` / `manifest.json` / `icons/` | 新入口 `frontend/index.html`；`publicDir='public'` 放 manifest + icons；`build.outDir='dist'`（相对 Vite root `frontend/`，即 `frontend/dist`，gitignore）；`frontend/web/` 不再是新构建落点 | §6.5 静态托管行 / §6.7 静态产物行 | 批 0 |
| **S-A02** | **`/legacy/` 回滚不可执行**：产物写死 `<base href="/">`，挪目录后资源全打到根路径（被 Vue 接管）；根作用域 Flutter SW 还会继续接管根路径 | `flutter build web --release --base-href /legacy/` **重建**后复制到 `dist/legacy/`（批 0 用**复制**不用移动，旧版主流程仍可用）；切根前先部署根 `sw-kill.js`（unregister 全部 SW + 清 caches）再注册 Vue SW；AC-18 回滚动作改为「根 `index.html` 指向 `/legacy/` 并清 SW」 | §6.7 / §11 批 0·批 6 / §10 AC-18 / §12 RK-09 | 批 0 / 批 6 |
| **S-A03** | **版本/兼容门禁不可照抄参考项目**：对方是 Vite 8 / TS 6 / vue-router 5 / Pinia 4 / Vitest 5 / `target: safari16.4` / `lib: ES2022` / `browserslist: last 5`；照抄会在 Safari 14.1 上「全绿白屏」 | 按 §14.7 钉版（Node 22.23.4、Vite `^5.4` + plugin-legacy `^5`、Vue `^3.5`、vue-router `^4.5`、Pinia `^2.3`、Vitest `^2.1`、TS `~5.6`、decimal.js `^10.4`、vite-plugin-pwa `^0.21`、postcss-preset-env `^9`）；`tsconfig lib: ["ES2019","DOM"]`；`browserslist: ["iOS >= 14.8","Safari >= 14.1"]`；`es-check` 只查语法，另补 **API 扫描**（`structuredClone` / `crypto.randomUUID` / `.at()` / `findLast` / `Object.hasOwn` / `showModal` / `BroadcastChannel` / `navigator.locks`）与 **CSS 特性检查**（`aspect-ratio` / `:has()` / `dvh` / `inset`） | §14.7 / §6.5 / §10 AC-19 / §11 批 0 | 批 0 |
| **S-A04** | **E-02 幂等语义未闭合**：`delete/restore` 现为两条独立 `s.db.Exec`（非事务）；期初「冲正+新建」重试会多一对交易；M2 四个端点也会被重试 | §7 给全冲突矩阵（201 / 200 / 409-deleted / 409-mismatch）、`ON CONFLICT(...) WHERE ...` 谓词与部分索引一致、同事务边界扩到 create/delete/restore/opening、冲正沿用 `opening_key`、M2 端点用 `Idempotency-Key` | §7 / §5.6 E-02 / §10 AC-23 | 批 1 / 批 4 |
| **S-A05** | **同步水位缺库世代（唯一技术阻塞）**：restore 覆盖 DB 后 `sync_log` 自增回退，客户端 `last_seq` 超前 → `id > since` 永远为空且不报错 | 迁移 **014** 增 `app_settings.db_instance_id`（建库写入、restore 成功后重写）；Pull/Push/health 返回 `instance_id`；客户端按 `{ledger_id: {instance_id, last_seq}}` 比对，不匹配则清该账本实体 + 全量 pull；pending 转隔离区不静默删 | §7 新增行 / §6.6 / §10 AC-30 / §11 批 4·批 5 | 批 4 / 批 5 |
| **S-A06** | **覆盖到页不到功能点**：CSV 导出、分类拖拽排序、导出不平告警、注册开关、默认账户管理 5 项旧功能无落点；期初 / 关户守门交互无 AC | 新增 §14.5「旧版功能不降级清单」（5 项给落点，旧功能统一标 **Must**，Should 只留给新增增强）；补 AC-27~AC-29（期初校准 / 关户守门 / 关联交易确认） | §14.5 / §10 | 批 1 / 批 2 / 批 3 |

---

## 六、前端全量重构方案

### 6.1 信息架构（不推倒，沿用 v2 原型）

```
Vue 3 单应用，一套代码 + CSS 断点（1024）
┌─────────────────────────────────────────────┐
│ 认证：登录 / 待邀请 / 改密 / 会话              │
├─────────────────────────────────────────────┤
│ 移动 4 Tab：账单 / 资产 / [＋] / 报表 / 更多   │
│ PC 侧栏 4 组 9 模块（同 F-1~F-10 定稿）      │
├─────────────────────────────────────────────┤
│ 更多 → 数据安全                              │
│   ├ 备份（M1 已有）                          │
│   ├ 恢复备份      [新] M2                    │
│   ├ 导入 Beancount [新] M2                   │
│   ├ 导出 / 归档（已有）                      │
│   └ 同步状态（已有）                         │
└─────────────────────────────────────────────┘
```

- **导航层级 ≤ 3 层**，常用功能 ≤ 2 次点击可达；M2 入口挂「更多 → 数据安全」，与 M1 备份卡同组，符合用户心智。
- 路由用 **hash 模式**（`createWebHashHistory`）：`static.go` 会把无扩展名路径回退到根首页，hash 路由完全绕开这个限制，**后端零改动**。
- 筛选条件写进 query（B-18）：列表 / 日历切换、日期范围、类型、分类、账户、关键词可分享可回退。

### 6.2 页面映射表（28 个 Dart 文件 → 20 页 + 2 组件 + 1 布局）

> 这是全量重构最实在的收益：**不是 1:1 翻译 28 个文件，而是把同一功能的四种容器形态收敛成 1 个组件**。收敛项按「功能不减」验收。

| 组 | 现有 Dart 文件 | Vue 落点 | 处置 | 优先级 |
|---|---|---|---|---|
| 认证 | `login_screen`、`await_invite_screen` | P-01 登录 / P-02 待邀请 | 复刻（v2 原型含登录） | Must |
| 壳 | `app_shell`、`desktop_shell`、`mobile_shell` | L-01 单 Layout + CSS 断点 | **3 → 1 收敛** | Must |
| 首页 | `dashboard_screen` | P-03 首页 / 余额 | 复刻（v2 原型含账单 / 资产） | Must |
| 记一笔 | `record_screen`、`record_dialog`、`record_panel`、`record_sheet` | C-01 记一笔组件（PC 弹窗 / 移动 Sheet / 全屏三容器） | **4 → 1 收敛（B-16）** | Must |
| 流水 | `transactions_screen`、`txn_detail_screen`、`trash_screen` | P-04 流水 / P-05 详情 / P-06 回收站 | 复刻 | Must / Should / Should |
| 账户 | `accounts_screen`、`account_detail_screen`、`account_edit_screen`、`account_dialog` | P-07 账户列表 / P-08 详情 / C-02 编辑表单 | **4 → 3 收敛** | Must |
| 分类 / 币种 | `categories_screen`、`commodities_screen` | P-09 分类 / P-10 币种 | 复刻 | Should |
| 报表 | `reports_screen` | P-11 报表（Canvas 2D 图表） | 复刻 | Should |
| 成员 / 账本 | `members_screen`、`ledgers_screen` | P-12 成员 / P-13 账本切换 | 复刻（FamBean 长板，不降级） | Must |
| 设置 | `settings_screen`、`backup_card`、`change_password_screen`、`sessions_screen`、`sync_screen` | P-14 设置 / P-15 数据安全 / P-16 改密 / P-17 会话 / P-18 同步状态 | 复刻 | Must / Should |
| 导入导出 | `import_export_screen` | 合并进 P-15 数据安全 | **合并** | Must |
| — | （无） | **P-19 导入向导** | **新增（M2）** | Must |
| — | （无） | **P-20 恢复向导** | **新增（M2）** | Must |
| 通用 widget | 14 个（图表 / 金额 / 标签 / 日历 / 键盘 / 隐私 / 恒等式提示等） | `components/` 按职责重建 | 复刻，图表改 Canvas 2D | Must |

**页面流转**：`P-01 → P-03 →（C-01 | P-04 | P-07 | P-15）`；`P-15 →（P-19 | P-20）→ 结果页 → 重新登录 / P-03`。
**返回路径**：每个向导页每步可返回上一步；执行成功后回结果页，失败保留表单与错误明细。

### 6.3 关键页面说明（线框思路）

**P-19 导入向导（M2 主线，本期最重新页面）**
```
页面目标：让用户在不理解 Beancount 语法的前提下，安全地把账本带回来
布局思路：
- 顶部：步骤条（① 选择文件 → ② 解析预览 → ③ 完成）
- 内容区①：文件选择 + 文本粘贴区 + 格式说明（严格子集，不支持即整体拒绝）
- 内容区②：摘要卡（账本名 / 账户数 / 交易数 / 日期范围）
           + 错误列表（行号 + 原因，一次列全，不逐条弹）
           + 明确提示「将新建账本，现有数据不受影响」
- 底部：吸底「取消 / 确认导入」（解析有错时禁用并说明）
交互说明：
- 正常态：预览 → 确认 → 成功页显示新账本名与「切换过去」入口
- 空状态：未选择文件时按钮禁用，不显示空白表格
- 加载态：解析中显示进度与「不要关闭页面」
- 错误态：整体拒绝时保留原文与全部行号，可复制错误列表
- 边界：超长文件走大小上限提示；重名账本自动加序号并提示
```
验收锚点：对应 `m2-plan.md` §5 的严格子集、全量行号、大事务回滚、重复导入提示。

**P-20 恢复向导**
```
页面目标：把「不可逆操作」变成看得懂、可反悔的操作
布局思路：
- 顶部：警示条（还原会替换全部数据，当前账号可能失效）
- 内容区：覆盖前 / 覆盖后对比表（用户数/账本数/账户数/交易数）
         + 备份来源与 schema 版本 + warnings 列表
- 底部：需手动输入 RESTORE 才解锁「执行还原」
交互说明：
- 预检为只读，任何校验不通过直接列出原因、不进下一步
- 执行前自动 pre-restore 快照；结果页明确「请用备份中的账号重新登录」
- 错误态：失败保持数据原样，显示失败步骤与快照文件名
```

**C-01 记一笔（一个组件三种容器，沿用 F-3 视觉）**
- 支出 / 收入 / 转账三 Tab + 金额大屏 + 数字键盘 + 分类九宫格 + 资金账户必选；竞品第四类「余额调整」由 FamBean 既有的**高级双录入口**覆盖，不新增类型。
- **保留 FamBean 独有的分录预览行**（示例：`Expenses:食品饮料:食品 +38.50 ← 招商储蓄 −38.50`，金额为虚构示例），这是竞品单式模型给不了的复式可视性。
- 在线提交 postings 用 `account_id`（整数），**禁止**用 `account_uuid`；金额一律定点十进制字符串，禁止浮点。
- **幂等（必做）**：提交时生成一次性客户端标识并随请求上送，服务端按账本 + 该标识查重，重复请求返回首次的 uuid 而不新增交易；提交中禁用按钮只是辅助，不能替代服务端幂等。理由见 G-04。
- **连续记账 + 草稿**：保存后提供「返回 / 再记一笔 / 复制上一笔」；表单内容按账本命名空间暂存 IndexedDB，意外刷新可恢复（**token 走 httpOnly Cookie，不落 localStorage；草稿不含任何凭据**）。
- 标签输入接 B-04 自动补全；账户 / 分类选择器按 B-17 在选项旁显示余额。

**L-01 响应式布局**
- 一套组件 + CSS 媒体查询（断点 1024）实现 PC 侧栏 / 移动底栏，替掉 3 个 Dart shell。
- 沿用 `pc-redesign.html` 与 `mobile-redesign-v2.html` 的布局 token；PC 宽屏内容区沿用 `max-width` 居中约束，禁止在定高容器里嵌全屏列表导致溢出。

### 6.4 组件与设计系统

| 项 | 处理 |
|---|---|
| 视觉 token | 直接复用 `docs/prototype/mobile-redesign-v2.html` / `pc-redesign.html` 的渐变蓝、白卡上浮、彩色分类图标、金额 `tabular-nums`；**不新建设计系统** |
| 分层 | `core`（枚举 / 常量）/ `api`（31 端点客户端）/ `stores`（Pinia 按域）/ `views` / `components` —— 逻辑层写一遍，UI 一套（§2.2 竞品解耦思路落地） |
| 金额显示 | 必须接入隐私遮挡开关（家庭场景防瞟屏，F-1 既有功能）；净资产为负必须显示负号（11-05 已拍板） |
| 符号口径 | 统一 `ΣAssets + ΣLiabilities`，禁止各页面自行 `abs()` 或按类型乘系数（11-05 修过的静默错误） |
| 图表 | 4 处 `fl_chart` 换 **Canvas 2D** 渲染的轻量方案，**禁止 WebGL / WASM**；不引 ECharts 全家桶 |
| 状态四态 | 每个页面必须覆盖空 / 加载 / 错误 / 边界（超长文本、超多数据） |
| 无障碍 | 关键操作键盘可达、文字与背景对比度可读、表单错误指出位置与修正建议 |

### 6.5 技术约束（兼容基线，写进 CI / README / AGENTS.md）

| 约束 | 要求 | 依据 |
|---|---|---|
| 技术栈 | **Vue 3 + Vite 纯 SPA**（不引入 Nuxt / SSR / Nitro）+ Pinia + Vue Router(hash) + Vitest；Node 只在构建阶段，运行时无 Node；构建版本按 §14.7 钉版（Node 22.23.4 / Vite `^5.4`） | 换框架评估 §5 + 本方案 §5.5（v2.1 二次选型） |
| 构建目标 | `build.target: 'es2015'` + `@vitejs/plugin-legacy` 兜底 | Vite 官方最低目标，Safari >= 14 |
| 渲染 | **禁止 WASM / WebGL / CanvasKit / OffscreenCanvas 依赖**；图表用 Canvas 2D 或 SVG | 真机缺 `compileStreaming` / WebGL2 |
| Web API | 禁用 Safari 14.1 不支持的 API：`structuredClone` / `crypto.randomUUID` / `.at()` / `findLast` / `Object.hasOwn` / `showModal`；**多标签页协调不得用 `BroadcastChannel` 或 `navigator.locks`（Safari 15.4+ 才有）**，改用 `storage` 事件 + IndexedDB 单记录 CAS 租约 | 真机诊断 + Safari 14.1 兼容基线 |
| 路由 | hash 路由，避开 `static.go` 把无扩展名路径回退到根首页 | `static.go:66-85` 本轮实测 |
| 令牌 | **httpOnly + SameSite=Lax Cookie**（内网 HTTP 不设 Secure），`authMiddleware` Cookie 优先 / Bearer 兜底；**禁止 localStorage 存 token**；刷新后保持登录由 Cookie 承担 | D-7（§13） |
| 静态托管 | 源入口 `frontend/index.html`，`publicDir='public'`，`build.outDir='dist'`（相对 root 即 `frontend/dist`，gitignore）；产物仍由 `LEDGER_WEB_ROOT` 托管，目录 index 由 `static.go` 原生支持，**后端托管逻辑零改动** | §5.7 S-A01 + 本轮 `static.go` 实测 |
| 真机门禁 | cutover 前必须在 iOS 14.8 Safari 跑全主流程冒烟，未过不得切换 | 本方案 §11 批 6 |
| CI | 新增独立 `web-verify` job（与 Go job 并行）：`web:lint` / `web:typecheck` / `web:test` / `web:build` / `web:compat`；`verify-version.sh` 改读 `frontend/package.json`；**现有 CI 连 `flutter test` 都不跑，这次一并补上** | §5.7 S-A03 + §11 批 0 |
| 金额运算 | 引入 `decimal.js`（或 `big.js`）封装 `core/Money`，**禁止 JS 裸 `+/-` 参与金额**；金额用例逐条对齐旧版 `package:decimal` 结果 | §5.6 E-01 |
| API 客户端 | 类型化 fetch 封装统一注入 `Authorization` 与 **`X-Ledger-Id`**（缺失抛错，不静默回退）；错误映射集中一处；4xx 不重试 / 5xx 最多 3 次 / fetch 失败显示离线提示 | §5.6 E-07 / E-08 |
| 认证流 | single-flight 401 刷新（跨标签页用 `storage` 事件选举唯一刷新者，失败重试一次）+ 428 跳改密页；Cookie 轮换后旧 token 立即失效，重试自动携带新 Cookie | §5.6 E-07 + D-7 |
| 开发期跨域 | `vite.config.ts` 配 `server.proxy` 转发 `/api` 到 `127.0.0.1:8080`；生产代码用相对 `/api`，**禁止硬编码绝对后端地址** | §5.6 E-06 |
| 依赖语法 | 增加构建产物 `es2015` 语法扫描（`node_modules` 默认不转译）；依赖白名单 | §5.6 E-05 |
| PWA | `vite-plugin-pwa` 用 `injectManifest` + `injectRegister:false` + 手写 `src/sw.ts`；`navigateFallbackDenylist: [/^\/legacy\//, /^\/api\//]`；**去掉无条件 `skipWaiting`**，改「有新版本」提示；API 响应不缓存；`base:'./'` 支持反代子路径，相对注册 `path:'./sw.js'`；manifest / icons 从 `public/` 复用 | §5.6 E-04 + §5.7 S-A02 |
| CORS / CSRF | 由 `*` 收敛为回显 `Origin` + `Allow-Credentials: true` + `Vary: Origin`；允许头加 `X-CSRF`；非 GET 写操作必须带该自定义头，缺失即 403；`LEDGER_CORS_ORIGINS` 可回退 | D-7（§13） |
| 依赖钉版 | 见 §14.7；`package.json` 依赖版本已钉版，**`.nvmrc` / `.npmrc` / `engines` 收紧 / lock 在 Linux/WSL 重生成按 v2.5 决策暂缓**（§9 已复核 lock 含 Linux 平台 optional 包，风险降级） | §5.7 S-A03 |

### 6.6 离线同步内核重写（本期 In，最高风险项）

| 现有实现（Dart） | Vue 落点 | 必须对齐的行为 |
|---|---|---|
| `sync_service.dart` 305 行 | `core/sync/SyncEngine.ts` | 水位增量拉取、待推队列、重试策略、4xx 不重试 / 5xx 最多 3 次 |
| `local_store.dart` 370 行 | `core/sync/LocalStore.ts`（IndexedDB） | append-only 本地写入、自然键合并、uuid 重映射、离线队列持久化 |
| `sync_models.dart` 302 行 | `core/sync/models.ts` | 请求 / 响应结构与 31 端点契约一致 |
| `sync_screen.dart` 102 行 + `sync_badge.dart` 70 行 | P-18 同步状态 + `SyncBadge.vue` | 状态展示、手动触发、失败可见 |

**验收方式**：不靠人工点。用后端现有 `/api/sync/pull` 与 `/api/sync/push` 写**契约测试**，逐条断言：增量水位不重不漏、重复 push 不产生重复交易（与 G-04 幂等键共用口径）、离线期间写入在恢复后完整上报、uuid 重映射后本地与服务端引用一致。

#### 6.6.1 一致性补充（v2.3，五条必须写进内核设计）

| # | 缺口 | 设计口径 |
|---|---|---|
| 1 | **失败分类 / 死信**（旧实现 4xx 仍无限重试，pending 无状态字段） | pending 增 `attempts / last_error_code / next_retry_at / state(pending\|dead)`；`account_not_found` → 全量 pull 后按自然键重映射重试一次；`account_closed` / `validation` / `forbidden` → **dead** 且同步页可见（可导出 / 丢弃）；网络与 5xx → 指数退避封顶。服务端 `code` 白名单与前端同一张表，契约测试断言 |
| 2 | **IndexedDB 单事务原子写**（旧代码账户 / 交易 / pending 三次独立写） | 只允许 3 个原子操作，各自单个 readwrite 事务（跨 `accounts/txns/pending/meta`）：`recordEntry`、`applyPushResults(uuidMap + removedKeys + lastSeq)`、`applyPullChanges(changes + lastSeq)`；崩溃只能落在事务外，重放幂等；测试注入「事务中途关闭 DB」 |
| 3 | **`uuid_map` 崩溃回放**（旧流程「服务端成功 → 本地 remap → 删 pending」，中途崩溃即永久卡死） | 收到 `server_uuid` 后先把 `{client_uuid, server_uuid, ledger_id}` 落库（与删 pending 同事务），再改引用；启动与每次 push 前回放；兜底按账户 `name` 反查 server uuid，二次失败才 dead |
| 4 | **多标签页租约** | **Safari 14.1 既无 `navigator.locks` 也无 `BroadcastChannel`（15.4+ 才有）**：用 `storage` 事件选举 + IndexedDB 单记录 CAS 租约（`lease_holder / lease_expires_at`，30s 心跳、90s 过期抢占）；非 leader 只读本地并监听更新；401 刷新也只由 leader 执行 |
| 5 | **库世代 + 离线期账户被软删 + 水位单调性** | pull / push 带 `instance_id`（§7）；不匹配 → 清该账本实体 + 全量 pull + pending 转隔离区；离线期账户被他人软删 → push 返回 `account_not_found`，**不自动改挂其它账户**，转 dead 并提示「该账户已被他人删除」；`last_seq` 仅在变更成功应用后推进且只允许单调增，空结果不推进；`op=delete` 重放按 uuid 幂等，delete 先到则保留 tombstone，后续同 uuid create 直接忽略 |

### 6.7 改动文件 / 目录清单（预估，非承诺）

| 层 | 路径 | 动作 |
|---|---|---|
| 新前端 | `frontend/` 新增 `index.html` / `package.json` / `package-lock.json`（Linux/WSL 生成）/ `.nvmrc` / `.npmrc` / `vite.config.ts` / `public/` / `src/`（20 页 + 组件 + stores + api + sync） | 新增 |
| 静态产物 | Vite 源入口 `frontend/index.html`；`frontend/public/manifest.json` + `icons/`（从 `frontend/web/` 迁入）；构建输出 `frontend/dist/`（gitignore），**不再写 `frontend/web/`** | 新增 / 迁入 |
| 旧版对照 | `flutter build web --release --base-href /legacy/` **重建**后复制到 `frontend/dist/legacy/`（批 0 用复制不用移动，旧版主流程仍可用；不维护源码） | 重建 / 复制 |
| 旧源码 | `frontend/lib/`、`frontend/test/`、`pubspec.yaml` 等 Dart 资产 | **cutover 观察期后删除** |
| S1 支线 | `frontend/web/compat-gate.js`、`compat.html`、`scripts/compat-gate-selftest.js`、`docs/ios14-white-screen-plan.md` | **建议收口（回滚 / 删除，需确认）** |
| 后端 | `internal/restore/`、`internal/beancount/`、4 个端点、幂等字段 | 新增 / 修改（按 `m2-plan.md` 与 §7） |
| 构建 | `Dockerfile` **仅 Stage 1** 由 Flutter SDK 换 `node:22-alpine`（先 COPY `package*.json` 再 `npm ci`，最后 `npm run build`），产物 `frontend/dist` → `/app/web`；Stage 2（Go）/ Stage 3（alpine 运行时）/ `docker-entrypoint.sh` / `docker-compose.yml` **全不动**；`.dockerignore` 补 `frontend/node_modules/`、`frontend/dist/` | 修改（批 6，范围已收窄，见 §5.5.5） |
| 工具链脚本 | `scripts/local.sh` / `Makefile` 增 `web:build` / `web:dev` / `web:test` / `web:lint` / `web:typecheck` / `web:compat` / `web:legacy` / `version`；`scripts/verify-version.sh` 改读 `frontend/package.json` | 修改 |
| CI | `.github/workflows/docker-image.yml` 新增独立 `web-verify` job（与 Go job 并行），含 lint / typecheck / test / build / compat | 修改 |
| 文档 | `README.md` / `AGENTS.md` 写兼容基线；`CHANGELOG.md` 记 M7；`frontend/README.md` 重写 | 修改 |
| 收口 | 当前 1 删 2 改 5 未跟踪 | 先决定提交或回滚，不与 M7 混在同一次提交 |

> **后端、账芯、同步协议、导出器、数据库 schema 均不在本方案改动范围**（M2 后端按既有方案独立推进，仅新增 4 端点 + 迁移 013/014；D-7 另行改造认证与 CORS，见 §7 / §13）。

---

## 七、API 变更（列计划必附）

| 类型 | 内容 | 是否必须 |
|---|---|---|
| 新增业务端点 | `POST /api/backup/restore/preview`、`POST /api/backup/restore`、`POST /api/import/beancount/preview`、`POST /api/import/beancount` —— **4 个，全部来自 `m2-plan.md`，本方案未新增任何端点** | M2 必须 |
| 请求/响应结构 | 复用既有 **31 端点**，账户 / 流水 / 导出 / `sync/pull` / `sync/push` 结构**不变**；认证端点改为下发 `Set-Cookie`（响应主体仍保留 `user` 等字段）；**兼容期默认仍返回 `token` 供旧版 Bearer 使用，`LEDGER_AUTH_EXPOSE_TOKEN=false` 后不再返回（批 6 cutover 时切换）** | 硬约束 |
| **在线记账幂等（G-04）** | `POST /api/transactions` **请求体新增 1 个可选字段** `client_request_id`；**服务端新增迁移 013**：`transactions.client_request_id TEXT` + 部分唯一索引 `UNIQUE(ledger_id, client_request_id) WHERE client_request_id IS NOT NULL`。**冲突矩阵（v2.3 定稿）**：新建 → **201** `{uuid, idempotent:false}`；命中未删 → **200** `{uuid, idempotent:true}`；命中已软删 → **409 `idempotency_key_deleted`**（前端换新 key 重提）；同 key 不同 payload → **409 `idempotency_payload_mismatch`**。**不新增端点、旧客户端不传则保持原行为** | **必做（账本底线）** |
| **幂等的实现边界（v2.3）** | 落库用 `INSERT ... ON CONFLICT(ledger_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING`（**conflict target 必须重复部分索引的谓词**，否则 SQLite 报 no matching unique index）；**「业务行 + `sync_log` 同事务」扩到 create / delete / restore / opening 四条写路径**（现 delete/restore 是两条独立 `s.db.Exec`）；冲正沿用 `opening_key`，**禁止**复用 `client_request_id`；M2 四端点用 `Idempotency-Key` 头 + 通用 `idempotency_keys` 表；今天的并发安全隐式依赖 `MaxOpenConns=1`，放开连接数或切 Postgres 必须改为 `ON CONFLICT` / `BEGIN IMMEDIATE` | 必做 |
| **库世代（v2.3，唯一技术阻塞）** | **迁移 014** 增 `app_settings.db_instance_id`：建库时写入，**restore 成功后重写**；`GET /api/sync/pull`、`POST /api/sync/push` 响应与 `GET /api/health` 增加 `instance_id`；客户端按 `{ledger_id: {instance_id, last_seq}}` 比对，不匹配则清该账本实体 + 全量 pull + pending 转隔离区（见 §6.6.1 #5） | 必做（批 4 前） |
| 静态托管 | 目录 index 已支持；hash 路由避开 SPA 回退 | **0 改动** |
| SPA 回退 | 若将来改 history 模式，需给 `static.go` 加 1 处前缀判断；**本期用 hash 路由绕开，不动后端** | 本期不需要 |
| CORS / CSRF | **D-7=A 已锁定（批 1 已实现）**：`LEDGER_CORS_ORIGINS` 未设 = 仅同源（不输出 CORS 头）；设逗号白名单 = 命中回显 `Origin` + `Allow-Credentials: true` + `Vary: Origin`；设 `*` = 仅通配且不带凭证（回退用）。允许头加 `X-CSRF`；Cookie 路径非 GET 写操作必须带该头，缺失 403；`OPTIONS` 预检 204 不鉴权 | 必做（已完成） |
| 缓存头 | Vite 产物带 hash → immutable，`index.html` → no-cache，现有 `setStaticCacheHeaders` 已覆盖；`/legacy/` 走 no-cache；需实测确认 | 需验证 |
| 令牌 / 会话 | 登录 / 刷新 / 登出下发 **httpOnly + SameSite=Lax** Cookie（内网 HTTP 不设 Secure，`Path=/`，`Max-Age` 与 30 天会话一致）；`authMiddleware` **Cookie 优先 / Bearer 兜底**；登出清除 Cookie 并删会话；Bearer 分支保留至观察期结束（§13 D-7） | 必做（D-7） |
| 记账协议 | 在线 postings 用 `account_id`；金额定点十进制字符串；借贷平衡仍由后端校验 | 硬约束 |

---

## 八、非功能需求

| 类别 | 要求（可测） |
|---|---|
| 兼容性 | iOS 14.8 / Safari 14.1.2 真机全主流程可用；Chrome / Edge 现代版本无回归 |
| 性能 | 首屏可交互 ≤ 2 秒（口径：iOS 14.8 Safari、局域网、冷启动、无 SW 缓存；**估算目标**，需真机实测校准） |
| 首屏体积 | JS + CSS 合计 ≤ 300 KB（**估算上限**，不含后端数据；较 v1.1 的 200 KB 放宽，因全量前端含 20 页路由与图表） |
| 安全 | 会话走 httpOnly Cookie（token 不落 localStorage / URL）；非 GET 必须带 `X-CSRF` 自定义头；CORS 白名单 + 凭证；恢复二次确认词；导入 / 恢复仅管理员；4xx 不重试，5xx 最多 3 次 |
| 数据一致性 | 导入与恢复均在单事务内，失败整体回滚；导出仍过 `bean-check`（退出码 0） |
| 幂等 | 记账提交重复 3 次只产生 1 笔交易且返回同一 uuid；**账本类底线，任何排期压缩不得砍除** |
| 离线 | 断网可记账并本地持久化；恢复联网后完整上报且不重不漏；契约测试全过 |
| 可访问性 | 关键操作键盘可达、表单错误可定位、金额对比度可读 |
| **可回滚** | cutover 观察期内，把根 `index.html` 指向 `/legacy/` 并清 SW 缓存即回到 Flutter 版（`/legacy/` 为 `--base-href` 重建产物），**不依赖数据库回滚**；旧版与新版共用同一后端（Bearer 兜底） |
| 可维护 | 前端测试进 CI；`es2015` / 禁 WASM 由静态检查卡住，避免后来者踩回旧坑 |

---

## 九、依赖就绪度评估（三档）

| 依赖项 | 所属系统 | 就绪状态（v2.5 复核） | 分级 | 最晚就绪时限 | 影响与替代方案 |
|---|---|---|---|---|---|
| Node.js + Vite 工具链 | 本机 | **已引入（批 0）**：`package.json` / `package-lock.json` / Vite / Vue / Vitest 均在库，Vue 源码 57 文件 / 14,067 行 | **已解除** | 批 0 前（已过） | 版本按 §14.7 钉版；**`.nvmrc` / `.npmrc` 入库、`engines` 收紧、lock 在 Linux/WSL 重生成，按 2026-11-11 决策暂缓**。已复核 lock 含 42 处 Linux 平台 optional 包条目，镜像缺平台二进制风险降级，批 6 前仍需 Linux 实机复核；本机 Node 22.22.2 / 钉版目标 22.23.4。不使用项目外环境 |
| 31 端点契约清单 | Go + TS | **已具备**：手写 `api/{types,routes,errors,client}.ts`（31 端点）+ `client.contract.test.ts` | **已解除** | — | `router.go` 命令式注册、请求体为匿名 struct，无 OpenAPI 可反射，故**不生成**客户端；接口歧义以实测响应为准 |
| M2 的 4 个后端端点 | Go | 方案已出、代码未动 | **阻塞（P-19/P-20 联调）** | 批 4 结束前 | 未就绪时前端按 `m2-plan.md` 契约用 mock 联调；**未确认就绪前不承诺向导页联调排期** |
| 幂等字段后端支持 | Go | **已实现（批 1）**：迁移 013 + 部分唯一索引 + 冲突矩阵，`migrate013_test.go` / `server/idempotency_test.go` 覆盖 | **已解除** | 批 1 结束前（已过） | 并发安全仍隐式依赖 `MaxOpenConns=1`；放开连接数或切 Postgres 前须补 `ON CONFLICT` / `BEGIN IMMEDIATE` |
| **CI 前端门禁 `web-verify`** | CI | **未加入，按 2026-11-11 老板决策暂缓** | **暂缓** | 批 6 前再评估 | 当前 CI 只有 `verify`（go vet / go test strict / bean-check 自检 / 版本一致）+ `build`；**202 个 Vitest 用例只在本地跑**，AC-20 仍无法验，RK-10「假绿」敞口保留。暂缓期间每次提交前请自跑 `web-test` + `web-typecheck` + `web-compat`；`web-build` 后补 `web-legacy` |
| `/api/sync/*` 契约测试基线 | Go + Dart | 后端已有，旧版行为可对照 | **阻塞（批 5）** | 批 5 开工前 | 先把旧版 pull/push 行为录成契约样本，再重写内核逐条对齐 |
| 真机 Safari 14.1 冒烟 | 老板 iPhone | 待排 | **阻塞（cutover）** | 批 6 前 | 未验不得切换根路径；S1 探针本身已不再需要 |
| 当前未提交改动收口 | git 工作区 | **部分收口**：根目录 `AGENTS.md` / `CLAUDE.md` / `README.md` / `CHANGELOG.md` 已提交；**docs/ 下 3 份（方案 v2.5 / 换框架评估 / 进度审查报告）按老板 2026-11-11 指示暂不提交** | **部分** | 批 0 前（已过） | D-5「不与 M7 代码混在同一次提交」已遵守：本次为纯根目录文档提交。docs 未入库期间，根文档对方案 v2.5 的引用在 clone 后会断链，待放行后补提交 |
| 旧版构建产物 `/legacy/` | Flutter | **开发机已产出**：`dist/legacy/` 由 `--base-href /legacy/` 重建后复制，`build-legacy.sh` / `check-legacy.sh` 校验 | **部分** | 批 0 结束前（开发机已过） | `dist/` 为 gitignore，CI / 镜像内尚不可产出（`npm run build` 会清空 `dist/`，每次构建后须补 `web-legacy`）；CI 内产出与 `sw-kill.js` 随批 6 处理 |

> 遵循项目规则：**阻塞项未确认就绪前，不承诺排期**；D-5 要求每个分批可独立中断、独立验收。

---

## 十、验收标准（GWT，可被测试用例直接引用）

| 编号 | 验收标准 |
|---|---|
| AC-01 | Given iOS 14.8 Safari 打开根路径，When 页面加载完成，Then 2 秒内出现登录框而非白屏，且无阻断性 JS 错误 |
| AC-02 | Given 已登录，When 逐条走 §6.2 的 20 个页面，Then 每个旧屏对应的核心操作均可达、无死链、无不可达页面 |
| AC-03 | Given 已登录，When 录入一笔支出并提交，Then 后端流水可查、金额与输入一致、导出仍通过 `bean-check` |
| AC-04 | Given 断网，When 在记一笔提交，Then 交易进入本地待推队列且不产生半笔交易；Given 恢复联网，Then 完整上报且服务端只新增 1 笔 |
| AC-05 | Given 上传自家导出的 `.beancount`，When 执行导入，Then 新建账本的账户数 / 交易数 / 金额与源文件一致，原账本数据不变 |
| AC-06 | Given 上传含 `plugin` / `include` / cost 注解的文件，When 解析预览，Then **整体拒绝**并一次列出全部错误行号（不是只报第一个） |
| AC-07 | Given 导入中途失败（注入错误），When 查看数据库，Then 不留半个账本，原账本完好 |
| AC-08 | Given 选择备份文件，When 只做预检，Then 数据库行数前后一致，且展示覆盖前/后对比与警告 |
| AC-09 | Given 预检通过，When 未输入 `RESTORE`，Then 「执行还原」保持禁用；执行后自动生成 `pre-restore` 快照 |
| AC-10 | Given 还原失败（注入错误），When 查看数据，Then 数据保持原样且提示失败步骤 |
| AC-11 | Given 金额隐私开关开启，When 查看任意金额位，Then 全部被遮挡（含日历格与列表小计） |
| AC-12 | Given 净资产为负，When 查看余额区，Then 显示负号，不取绝对值；Given 任一页面计算净资产，Then 口径均为 `ΣAssets + ΣLiabilities` |
| AC-13 | Given 记一笔已生成幂等标识，When 弱网下重复提交 3 次，Then 流水只新增 1 笔且三次返回同一 uuid，余额只变动一次 |
| AC-14 | Given 一笔保存成功，When 选择「再记一笔 / 复制上一笔」，Then 表单按对应语义预填且金额、账户可修改；Given 表单未提交即刷新，Then 草稿内容可恢复 |
| AC-15 | Given 同一功能在 PC（>1024）与移动（≤1024），When 分别打开，Then 分别呈现侧栏 / 底栏布局，且核心任务完成路径 ≤ 3 步关键操作 |
| AC-16 | Given 筛选条件已设置，When 复制当前 URL 并在新标签打开，Then 筛选状态完整还原；Given 切换列表 / 日历视图，Then 数据集合一致 |
| AC-17 | Given 同步契约测试运行，When 覆盖 pull / push / 水位 / 幂等 / 自然键合并 / uuid 重映射，Then 全部通过且与旧版行为逐条一致 |
| AC-18 | Given cutover 后观察期内，When 把根 `index.html` 指向 `/legacy/`（`--base-href /legacy/` 重建产物）并执行旧 SW unregister + 清 caches，Then Flutter 版全部功能可用、资源路径无 404、数据无变化、Go 测试全绿 |
| AC-19 | Given 新前端构建产物，When 静态扫描依赖，Then 不含 WASM / WebGL / CanvasKit / `structuredClone`，`build.target` = `es2015`（产物基线不变），**语法扫描门禁为 es2020（仅放行路由懒加载的动态 `import()`）**，且 **API 扫描与 CSS 特性扫描清单（§14.7）零命中（已由 `scripts/compat.mjs` 接上）** |
| AC-20 | Given CI `web-verify` job 运行，When 执行前端门禁，Then `web:typecheck` / `web:test` / `web:build` / `web:compat` 全绿（项目未配置 lint，**不擅自引入 ESLint**），且 `BEAN_CHECK_STRICT=1` 下 Go 全量测试通过。**v2.5：该 job 按老板决策暂缓，AC-20 保持未验；暂缓期以本机自跑四项 + `web-build` 后补 `web-legacy` 替代** |
| AC-21 | Given 观察期结束且 Go/No-Go 全过，When 执行清退，Then `frontend/lib/` 与 Dockerfile 的 Flutter 构建链已移除，仓库只剩一套前端构建链 |
| AC-22 | Given 含 `0.1 + 0.2` 类小数的多笔交易，When 计算净资产 / 每日小计 / 报表分组求和，Then 结果与旧版 `package:decimal` 完全一致，无浮点尾差（E-01） |
| AC-23 | Given 同一幂等标识，When **并发**发出 5 个 `POST /api/transactions`，Then 数据库只新增 1 笔且 5 个响应返回同一 uuid，唯一索引生效（E-02） |
| AC-24 | Given 登录态过期且页面并发发出 4 个请求，When 全部返回 401，Then 只触发 1 次 refresh、其余请求挂起复用结果并成功重试；Given 强制改密态，When 任一业务请求返回 428，Then 跳转改密页而非显示通用错误（E-07） |
| AC-25 | Given 已切换到非默认账本，When 记一笔，Then 请求携带正确 `X-Ledger-Id` 且交易落在该账本；Given API 客户端未取到账本 id，Then 直接抛错而非静默回退 id=1（E-08） |
| AC-26 | Given 断网后重新打开应用，When 查看应用壳，Then 由 SW 离线缓存正常渲染；Given 任意 API 请求，Then 不经 SW 缓存、始终走网络或本地 IndexedDB 真相源（E-04） |
| AC-27 | Given 账户已有期初，When 修改期初金额并保存，Then 生成「冲正 + 新建」成对交易、净资产只按新值变化、导出仍通过 `bean-check`；重试同一操作不产生第二对（`opening_key`，E-02 / S-A04） |
| AC-28 | Given 账户已关户，When 在线或离线记一笔时选择该账户，Then 前端不可选、服务端拒绝并返回明确 `code`，不产生半笔交易（S-A06） |
| AC-29 | Given 账户存在未删除交易，When 关户或删除该账户，Then 二次确认列出受影响笔数，确认后软删并写 `sync_log`，其他端下次 pull 可见（S-A06） |
| AC-30 | Given 断网记 2 笔，When 切到另一账本再切回，Then 待推队列仍在；恢复联网后按 `pending` / `dead` 分类上报，4xx 永久失败进 `dead` 且同步页可见可重试 / 丢弃（§6.6.1 #1 / #4） |
| AC-31 | Given 同一数据集，When 新报表按口径清单（时间范围 / 币种 / 账户 / 标签下钻 / 转账剔除 / 净资产符号）计算，Then 与旧版逐项一致（差异为零） |
| AC-32 | Given 表单有草稿且已选非默认账本，When 刷新页面，Then Cookie 会话仍有效、草稿与上次账本自动恢复（D-7 / §6.5） |
| AC-33 | Given viewer 打开任一写入口，Then 只读不产生请求；Given owner 重置某成员密码，Then 该成员全部会话立即失效、需重新登录（§7 鉴权与成员管理） |
| AC-34 | Given 导入成功 / 失败或恢复成功 / 失败，When 完成后查看，Then 结果可解释（新建账本 id / 失败步骤 / 需重新登录），失败不留半份数据（AC-05~10 的用户可见面） |
| AC-35 | Given 服务端已发布新版本，When 页面仍开着旧版，Then 出现「有新版本」提示，用户确认后刷新；**不得自动 `skipWaiting` 打断正在录入的记账**（§5.7 S-A02） |
| AC-36 | Given 曾在线访问过某 API，When 断网后再次请求，Then 返回失败 / 离线提示而非 SW 缓存响应；`/legacy/` 与 `/api/` 不被导航回落接管（E-04） |

---

## 十一、实施分批（6 批，每批可独立中断、独立验收）

| 批次 | 内容 | 可交付点 | 估算工作量 |
|---|---|---|---|
| **批 0**（工程底座）⚠️ 主体完成 / 若干交付点暂缓（已提交 `c4ce399`） | Node/Vite/Vue 脚手架（**目录布局定稿：`frontend/index.html` + `public/` + `src/` + `dist/`**）+ `package.json` / `package-lock.json` 入库 + `web:*` 命令族 + 兼容基线写进配置 + **旧版 `--base-href /legacy/` 重建后复制到 `dist/legacy/`（复制不移动）** + S1 支线与未提交改动收口 + 31 端点手写 TS 类型 + **E-01 `decimal.js`/`Money` 封装、E-05 依赖语法/API/CSS 特性扫描、E-06 dev proxy、D-7=A 认证改造落地**。**按 v2.5 决策暂缓未做**：`.nvmrc` / `.npmrc` / `engines` 收紧、Linux/WSL 重生成 lock、`verify-version.sh` 改读 `frontend/package.json`、CI `web-verify` job | 空壳应用能在 iOS 14.8 Safari 打开；**旧版主流程仍可用**；~~CI 有前端门禁~~ **（该交付点未兑现，暂缓）** | 1~1.5 天（估算） |
| **批 1**（最小闭环）✅ 已完成（已提交 `4feccaf`） | P-01/02 认证（**Cookie 下发 / CORS 收敛 / `X-CSRF` / Bearer 兜底 / 401·428**）+ L-01 布局 + P-03 首页 + C-01 记一笔（**含幂等、连续记账、草稿**）+ 金额 / 符号口径组件 + Vitest 基础用例 + **E-02 迁移 013（冲突矩阵与事务边界）、E-07 401/428 封装、E-08 `X-Ledger-Id` 断言（含例外清单）** | 登录到记一笔全链路可跑；真机首轮冒烟；G-04 收口；AC-22~25、AC-32 可验 | 已提交 4feccaf |
| **批 2**（账本主体）✅ 已完成（已提交 `e018cc0`） | P-04 流水 / P-05 详情 / P-06 回收站 / P-07 账户 / P-08 账户详情 / C-02 / P-09 分类 / P-10 币种 + 日历与筛选 query 化 + **期初 / 关户守门交互（AC-27~29）** | 日常记账与查询闭环完整 | 已提交 e018cc0 |
| **批 2.5**（口径修正） | 基础核心对齐 fava/beancount（产品+架构双审计裁决）：RecordSheet 大改、record/accounts 核心逻辑、期初 / 关户 / CSV 导出口径对齐 | 导出与口径与 fava/beancount 一致，回归不破坏 | 已提交 20fd5d8 |
| **批 3**（管理与设置） | P-11 报表（Canvas 2D）/ P-12 成员 / P-13 账本 / P-14 设置 / P-15 数据安全（备份+导出）/ P-16 改密 / P-17 会话 / P-18 同步状态 | **28 个旧屏功能点全覆盖**（§14.5 不降级清单全 Must），RTM 逐条可对；AC-31 / AC-33 可验 | 3~4 天（估算） |
| **批 4**（M2 并入） | 后端 M2-a/b/d/e/g + **迁移 014 库世代** + P-19 导入向导 + P-20 恢复向导；**解析器可与批 0~3 并行前置** | 数据自持闭环可用；round-trip 与恢复 e2e 通过；AC-34 可验 | 6 天（估算，沿用 `m2-plan.md` §6） |
| **批 5**（内核迁移，最高风险） | 离线同步内核重写（§6.6 / §6.6.1）+ `/api/sync/*` 契约测试 + 旧版行为逐条对齐 + 33 个用例全量重写为 Vitest + **E-04 SW 更新提示 / 租约 / 隔离区（只缓存壳与静态资源）** | 离线优先能力不降级；契约测试 100% 通过；AC-26 / AC-30 / AC-35 / AC-36 可验 | 3~4 天（估算） |
| **批 6**（cutover 与清退） | Go/No-Go 门禁全过 → **部署根 `sw-kill.js` 清旧 SW** → 根路径切 Vue → 全量回归 + 真机全主流程冒烟 → 观察期（建议 3~7 天，由老板定）→ Dockerfile 改 Node 构建（先 COPY `package*.json`）→ 删 Dart 代码与 S1 支线 | M7 收口，仓库只剩一套前端 | 1~2 天 + 观察期（估算） |

> 工作量单位：单人自然日，含自测，**均为估算**，不含返工；每批可随时停下且不产生半成品状态。M2-a~g 的详细顺序以 `m2-plan.md` §9 为准（解析器排第一的理由已在那份文档论证）。
> **v2.3 工期口径**：**20~25 天 + 约 1~1.5 天（D-7=A 已锁定，含 Cookie 下发 / CORS 收敛 / CSRF 头 / 双读兼容）**，以「E-01/E-02 在批 0/1 完成设计前置」为前提。关键路径是 **批 0 的工程底座与 D-7 改造 → 批 1 的认证与幂等**，其余页面可并行推进（§5.6.5 / §5.7）。
> **Go/No-Go 门禁**（批 6 切换前必须全绿）：RTM 28/28 · API 31/31 · Vitest 全绿 · 87 Go 测试 + `bean-check` strict 全绿 · 同步契约 100% · 真机全主流程冒烟通过 · **`/legacy/` 回滚演练通过（含根 SW unregister）** · AC-27~36 全过。

---

## 十二、风险登记册

| 编号 | 风险描述 | 类别 | 概率 | 影响 | 等级 | 应对措施 |
|---|---|---|---|---|---|---|
| RK-01 | **全量重写引入金额 / 符号口径偏差，静默错账**（失去逐片与旧版对照的便利） | 技术 | 4 | 5 | **20 高** | 旧版 `/legacy/` 冻结为对账基准；统一 `ΣAssets + ΣLiabilities`；**`core/Money` + decimal.js 定点运算，禁止裸 `+/-`（E-01）**；恒等式断言；每批与旧版跑同一组数据比对；导出 `bean-check` 回归（11-05 已修过同类问题，不重犯）；AC-22 卡浮点尾差 |
| RK-02 | 恢复覆盖数据不可撤销 | 数据 | 3 | 5 | **15 高** | 强制 `pre-restore` 快照 + 预检对比 + 输入 `RESTORE` 二次确认（`m2-plan.md` 已定） |
| RK-03 | 新前端误引 WASM/WebGL 或 target 未降级，白屏重演 | 技术 | 3 | 5 | **15 高** | §6.5 硬约束 + CI 静态检查 + 真机 Safari 14.1 冒烟门禁（AC-19） |
| RK-04 | 导入外部文件静默丢指令污染账本 | 技术 | 3 | 5 | **15 高** | 严格子集 + 整体拒绝 + 全量错误行号 + round-trip 测试纳 CI |
| RK-05 | **离线同步内核重写出错，离线记账丢失或重复**（1,149 行相关代码） | 数据 | 4 | 5 | **20 高** | 批 5 单列；先用旧版录契约样本再逐条对齐；`/api/sync/*` 契约测试 + 幂等口径与 G-04 共用（AC-17） |
| RK-06 | **工期与单人精力：20~25 天全由老板一人，半途而废留下两套半成品** | 进度 | 4 | 4 | **16 高** | 6 批各自可独立中断、独立验收；`/legacy/` 全程可回滚；**任何一批停下都不产生「不能用了」的状态**；不做长期双版并行 |
| RK-07 | cutover 后回滚成本上升（旧版源码已删） | 运营 | 2 | 4 | **8 中** | 观察期（建议 3~7 天）内**不删 Dart 源码**；Go/No-Go 全过 + 观察期结束才清退（AC-18 / AC-21） |
| RK-08 | 范围蔓延：借全量重构把图表 / AI / 预算 / 深色模式一并塞进来 | 需求 | 4 | 3 | **12 中** | §2.4 的 8 条「明确不做」与 §4.3 Out 清单写死；新增诉求走变更评估表 |
| RK-09 | 两套构建链并存期（Flutter + Node）Docker 镜像与 CI 配置冲突 | 工程 | 3 | 3 | **9 中** | 批 0 先补 CI 门禁；旧版按 `--base-href /legacy/` **重建一次**后复制到 `dist/legacy/`（不是「只用现成产物」）；批 6 一次性改 Dockerfile |
| RK-10 | CI 补前端门禁后历史用例重写不全，形成假绿 | 工程 | 3 | 3 | **9 中** | 33 个用例逐条映射进 Vitest 并保留映射表（§14.6）；门禁必须包含 `web:test` 与 `web:build` 两项 |
| RK-11 | **弱网重复提交产生重复交易**，append-only 下只能靠冲正补救 | 数据 | 4 | 5 | **20 高** | 服务端幂等键（G-04 / §7）为必做；**必须落迁移 013 的部分唯一索引，仅应用层「先查后写」挡不住并发（E-02）**；前端提交锁仅作辅助；AC-13 / AC-23 纳入回归。**账本类底线，不得因排期压缩砍除** |
| RK-12 | 新前端漏带 `X-Ledger-Id`，交易静默记进默认账本 id=1 | 数据 | 3 | 5 | **15 高** | API 客户端强制注入并断言，缺失直接抛错而非回退；切账本清缓存；AC-25 纳入回归（E-08） |
| RK-13 | **iOS 非安装态 ITP 7 天清库**：Safari 对 script-writable storage 有「7 天无交互即清」策略，`pending` 队列与草稿可能被系统清掉 | 数据 | 3 | 4 | **12 中** | 真相源始终是服务端；同步页显示「上次同步时间 / 长期未打开」提醒；建议安装到主屏（standalone）；ITP 清理不可编程绕过，**不承诺「离线队列永久保留」**，只承诺「在线时尽快上报」 |
| RK-14 | **照抄参考项目版本导致「全绿白屏」**：Vite 8 / TS 6 / vue-router 5 / Pinia 4 / Vitest 5 / `target: safari16.4` / `lib: ES2022` | 技术 | 3 | 5 | **15 高** | 严格按 §14.7 钉版；`es-check` 只查语法，另补 **API 扫描**与 **CSS 特性检查**；`build.target: 'es2015'` + plugin-legacy；真机 Safari 14.1 冒烟为 cutover 硬门禁（AC-01 / AC-19） |
| RK-15 | **幂等键与实际事务边界不一致**：软删后重放、冲正 / 期初、M2 四端点各自为政，出现「假成功」或重复记账 | 数据 | 3 | 5 | **15 高** | §7 冲突矩阵 + `ON CONFLICT` 谓词 + 同事务扩到 create/delete/restore/opening；期初走 `opening_key`；M2 用 `Idempotency-Key`；AC-23 / AC-27 回归 |
| RK-16 | **Cookie 化后的 CSRF / CORS 与 iOS PWA 持久化**：带凭证时 `Origin: *` 非法；单例 Cookie 在 PWA 独立进程可能反复丢失导致重登 | 技术 | 3 | 4 | **12 中** | `Allow-Credentials` + 回显 Origin + `Vary: Origin`；非 GET 强制 `X-CSRF`；不要用 `SameSite=None`；**Bearer 双读兜底**，Cookie 失配只降级体验不锁死；`LEDGER_CORS_ORIGINS` 可回退到 `*`；iOS 装到主屏与 Safari 两种形态都要真机验证（§13 D-7） |

> 高等级（≥15）共 10 项；v2.3 新增 **RK-14 / RK-15**（均高）与 RK-13 / RK-16（中）。**RK-01 / RK-05 / RK-06 / RK-11 是全量重构相对 v1.1 新增或升级的风险**，需在开工前明确接受。

---

## 十三、决策点（D-1~D-7 已锁定 / 已给结论）

> **锁定记录：2026-11-09 老板「按推荐走」→ D-1~D-5 全部按下表推荐值执行。** 推荐值即为执行口径，不再另行确认。D-6 已给结论。
> **锁定记录（v2.3）：2026-11-09 老板拍板 D-7 = A（改 httpOnly Cookie）**，工期口径「20~25 天 + 约 1~1.5 天」；实施清单与回退开关见下表。
> **D-5 例外**：涉及删除 `compat-gate.js` / `compat.html` / `scripts/compat-gate-selftest.js`，方向虽已锁定，删除属不可逆动作，仍待老板逐个指定后执行（**本轮未动任何文件**）。

| # | 问题 | 推荐（= 已锁定口径） |
|---|---|---|
| **D-1** | 确认「全量重构」的落地形态 = **交付一次性 cutover + 开发期分 6 批可中断**（§0 定义），而非长期双版并行？ | **是**（§5 推荐 C）。这一步决定后面所有排期口径 |
| **D-2** | **离线同步内核是否本期一起重写**？若否，FamBean 将降级为在线应用 | **是**，放批 5 + 契约测试门禁。现在没上线，正是把它一次做对的最便宜时刻 |
| **D-3** | 框架与工具链确认 **Vue 3 + Vite + Pinia + Vue Router(hash) + Vitest**，`es2015` / 禁 WASM-WebGL？ | **是**，沿用 `frontend-framework-rewrite-assessment.md` §5 已论证结论，全量只是去掉「渐进」部分 |
| **D-4** | **M2 并入重构**（后端 4 端点按既有方案并行、两个向导写进新前端）+ M2 三个既有决策（全库还原 / 新建账本 / 严格子集）按推荐走？ | **是**。避免「旧版写一遍、重构再写一遍」；三个子决策沿用 `m2-plan.md` §3 论证 |
| **D-5** | **S1 兼容补丁支线作废**：`compat-gate.js` / `compat.html` / `scripts/compat-gate-selftest.js` 回滚或删除；当前 1 删 2 改 5 未跟踪文件如何收口？ | **方向已锁定为作废并收口**（涉及删除文件，仍待逐个指定），且**不与 M7 混在同一次提交**。真机冒烟门禁保留 |
| **D-6** | **v2.1 新增**：前端用纯 Vue 3 SPA 还是 Nuxt？ | **纯 Vue 3 + Vite SPA，不引入 Nuxt / SSR**。§5.5 五维对比 + 四条实测依据 + 反转条件；结论已给，不再列为待拍板项 |
| **D-7** | **v2.3 已锁定 = A**：会话凭据放哪里？（现有 `ledger_api.dart` 存 `localStorage` 且刷新保持登录） | **A：改 httpOnly Cookie（已拍板）**。登录 / 刷新 / 改密 / 登出下发 `httpOnly + SameSite=Lax`（内网 HTTP 不设 Secure，`Path=/`，`Max-Age` 对齐 30 天会话）；`authMiddleware` **Cookie 优先、Bearer 兜底**；CORS 由 `*` 收敛为回显 Origin + `Allow-Credentials` + `Vary: Origin`；非 GET 加 `X-CSRF` 自定义头。一次性收掉 XSS + 体验降级 + CORS 安全债；代价约 **1~1.5 天**。**Bearer 分支观察期结束前不得删**；备选 B（刷新重登）零后端改动但持续摩擦，C（localStorage）不采纳 |

**D-7 实施清单（已锁定 A；批 0 定稿、批 1 实施）**

| # | 改造点 | 落点 |
|---|---|---|
| 1 | 新增 `RequestToken(r)`：Cookie 优先、`Authorization: Bearer` 兜底 | `internal/server/middleware.go`（现只读 Bearer，第 65 行） |
| 2 | 六处 token 调用点统一改用 `RequestToken` | `internal/handler/auth.go`（`BearerToken` 定义 :30-31、logout :85、refresh :108、sessions :149、revoke :164、revoke-others :182） |
| 3 | 登录 / 注册 / 刷新 / 改密 / 登出 `Set-Cookie`（登出清空） | `internal/handler/auth.go` |
| 4 | CORS：回显 `Origin` + `Allow-Credentials: true` + `Vary: Origin` + 允许 `X-CSRF` | `internal/server/middleware.go:18-20` |
| 5 | CSRF：非 GET 缺 `X-CSRF` 直接 403；`OPTIONS` 预检放行 | `internal/server/middleware.go` |
| 6 | 响应体默认仍返回 `token`（兼容旧版 Bearer），`LEDGER_AUTH_EXPOSE_TOKEN=false` 时不再返回；旧版 `/legacy/` 继续用 Bearer | `internal/handler/auth.go` |
| 7 | 前端 `fetch` 统一 `credentials:'same-origin'`；删除 `fl_token` localStorage 读取并在启动时清理旧键 | `src/api/*` |
| 8 | 真机验证：iOS 14.1 Safari 与「添加到主屏」两种形态的 Cookie 持久化 | 批 1 / 批 6 冒烟 |

> **回退开关（两项均已实现）**：`LEDGER_CORS_ORIGINS`（未设 = 仅同源；设 `*` = 恢复旧行为且不带凭证）；`LEDGER_AUTH_COOKIE=false` 一键停发 Cookie、仅走 Bearer。另有 `LEDGER_COOKIE_SECURE`（HTTPS 部署置 `true`）与 `LEDGER_AUTH_EXPOSE_TOKEN`（批 6 cutover 后置 `false`）。全部属服务端环境变量，回退不需要重新构建前端。

**另需留意（非决策，属如实说明）**：全量重构把 M7 从约 6 天推到 **约 20~25 天 + 约 1~1.5 天（D-7=A 已锁定，估算）**，主要来自 20 页功能复刻（约 10~12 天）与离线内核（约 3~4 天）。老板「没上线无所谓」免掉的是**用户与数据迁移成本**，不是**开发与验证成本**——这条摆出来，不替你乐观。工程评审另发现 6 个 P0 前提（产物目录 / `/legacy/` 回滚 / 版本门禁 / 幂等语义 / 库世代 / 功能点覆盖），见 §5.7。

---

## 十四、附录

### 14.1 需求追踪矩阵（RTM）

| 需求编号 | 需求描述 | 方案章节 | 设计/原型 | 验收用例 | 状态 |
|---|---|---|---|---|---|
| R-01 | 前端全量替换（28 屏功能全覆盖） | §4.1 / §6.2 / §11 批 1~3 | `mobile-redesign-v2.html` / `pc-redesign.html` | AC-01 / AC-02 / AC-15 | 批 0~2.5 已提交（核心记账闭环已落地，P-11~P-18 待批 3） |
| R-02 | 离线同步内核重写，能力不降级 | §4.3 / §6.6 / §11 批 5 | 现有 `sync_service.dart` / `local_store.dart` | AC-04 / AC-17 | 待开工 |
| R-03 | 补齐 Beancount 导入 | §4.1 / §6.3 P-19 / §7 | `m2-plan.md` §5 | AC-05~07 | 待开工 |
| R-04 | 补齐备份恢复入口 | §4.1 / §6.3 P-20 / §7 | `m2-plan.md` §4 | AC-08~10 | 待开工 |
| R-05 | 金额与隐私口径一致 | §6.4 | 11-05 决策 | AC-11 / AC-12 | **部分完成（批 1/2）**：`core/Money` 定点金额（8 用例）+ `stores/privacy` 金额遮挡已落地；AC-11「日历格与列表小计全遮挡」、AC-12「净资产符号口径」待页面回归逐项核 |
| R-06 | 兼容基线固化与 CI 门禁 | §6.5 / §9 | 换框架评估 §5 | AC-19 / AC-20 | **部分完成**：`build.target: 'es2015'` + plugin-legacy + `es-check` 语法门禁（v2.6 抬到 **es2020** 仅放行动态 `import()`）+ `scripts/compat.mjs`（特征串 + `dist/legacy/` 不变量 + **§14.7 API/CSS 扫描**）已落地；**CI `web-verify` job 按 v2.5 决策暂缓，AC-20 仍无法验** |
| R-07 | 在线记账幂等 + 连续记账 + 草稿 | §3 G-04 / §6.3 C-01 / §7 | 竞品「连续记账」通用模式 | AC-13 / AC-14 | **批 1 已完成**：迁移 013 + `client_request_id` 冲突矩阵；`RecordSheet.idempotency.test.ts` / `record.test.ts` 覆盖草稿与连续记账 |
| R-08 | 旧版 `/legacy/` 对照 + 一次性 cutover + 清退 | §5 / §11 批 6 | — | AC-18 / AC-21 | 待开工（开发机 `dist/legacy/` 已产出，cutover / 清退 / CI 内产出待批 6） |
| R-09 | 筛选状态 URL 化 / 两级汇总 | §6.1 / §2.4 B-18 | 竞品通用模式 | AC-16 | **批 2 部分完成**：`core/filters` / `core/calendar` 支持 query 化与日历视图（11 用例）；「复制 URL 完整还原筛选」与两级汇总待页面回归核 |
| R-10 | 操作留痕可复盘 | §4.2 最小数据能力 | — | 人工核对最近 10 条 | 待开工 |
| R-11 | S1 支线作废与工作区收口 | §5.4 / §13 D-5 | — | 人工核对 `git status` | 方向已锁定，删除动作待指定 |
| R-12 | 框架定为纯 Vue 3 SPA（不引入 Nuxt / SSR） | §5.5 / §6.5 / §6.7 | `Dockerfile` / `static.go` | AC-19 / AC-20 | 已给结论 |
| R-13 | 金额定点运算（`core/Money` + decimal.js） | §5.6 E-01 / §6.5 | 旧版 `package:decimal` 行为 | AC-22 | 批 1 已完成 |
| R-14 | 在线记账幂等落库（迁移 013 + 唯一索引） | §5.6 E-02 / §7 | `schema.sql` / `migrate.go` | AC-13 / AC-23 | 批 1 已完成（迁移 013 已提交） |
| R-15 | 类型化 API 客户端（401/428、`X-Ledger-Id`、错误映射、重试策略） | §5.6.4 / E-07 / E-08 | `api_error.dart` / `middleware.go` | AC-24 / AC-25 | 批 1 已完成（`api/client.ts`） |
| R-16 | PWA 离线壳（SW 只缓存壳与静态资源） | §5.6 E-04 / §6.5 | 现有 `manifest.json` / icons | AC-26 | 待开工 |
| R-17 | 认证存储形态（**D-7 = A**：httpOnly Cookie + CORS 收敛 + CSRF 头） | §5.6 E-03 / §5.7 / §7 / §13 D-7 | `ledger_api.dart` / `middleware.go` / `handler/auth.go` | AC-24 / AC-32 | 已完成（批 0/1 落地） |
| R-18 | 同步库世代（`db_instance_id`）与恢复后客户端一致性 | §5.7 S-A05 / §7 / §6.6.1 #5 | `app_settings` / `migrate.go` | AC-30 | 待开工（P0） |
| R-19 | 旧版功能不降级（5 项落点） | §14.5 / §11 批 2~3 | — | AC-02 / AC-31 | **批 2 部分完成**：CSV 导出（`core/csv.ts` 4 用例）、分类排序（`core/ordering.ts` + `storage.ts`）已落地；导出不平告警 / 注册开关 / 默认账户管理需 P-14 / P-15 页面落点，待批 3 |
| R-20 | 依赖钉版与禁用清单（版本 / API / CSS 门禁） | §5.7 S-A03 / §14.7 / §6.5 | `package.json` / `browserslist` / `tsconfig` | AC-19 | **部分完成**：`package.json` 依赖版本与 `es2015` 基线已落；`.nvmrc` / `.npmrc` / lock 重生成按 v2.5 暂缓；**§14.7 API/CSS 特性扫描已由 `compat.mjs` 接上（es2020 语法门禁放行懒加载），PWA 待批 5** |

### 14.2 本轮证据清单

- **竞品**：`D:/Project/Self/ezbookkeeping/README.md`（Features 段，2026-11-09 读取）、`src/{DesktopApp,MobileApp}.vue`（双入口）、`src/views/{desktop,mobile}/`、`src/components/{common,desktop,mobile}/`（含 `NumberPadSheet.vue` / `TransactionCalendar.vue` / `ScheduleFrequency*.vue` / `insights/dialogs/Batch*.vue` / `ReconciliationStatementDialog.vue`）、`src/router/`、`src/stores/`、`src/core/`、桌面与移动 HTML 入口
- **幂等缺口实测**：`internal/handler/transaction.go:27-66`（在线请求体无幂等字段）、`internal/service/transaction.go` `CreateTransaction`（`UUID: uuid.NewString()`）、`internal/repository/transaction.go` `saveTransaction(ledgerID, txn, idempotent bool)`（离线路径 `idempotent=true`）
- **v2.0 新增实测**：`find frontend/lib/screens -name "*.dart"` = 28；`find frontend/lib -name "*.dart"` = 60 / 13,993 行；`find frontend/lib/widgets` = 14；`wc -l` 离线同步 5 文件 = 1,149 行、API 客户端 4 文件 = 1,164 行；`grep -c 'mux.HandleFunc("/api/'` = 31；`sed -n '55,90p' internal/server/static.go`（目录 index / 无扩展名回退根首页）；`ls frontend/` 无 `package.json`、`frontend/web/lite` 不存在；`ls docs/prototype` 4 份 HTML；`find frontend/test` 6 文件；`.github/workflows/docker-image.yml` 仅 `go test`；`git status --short` = 1 删 2 改 5 未跟踪
- **v2.1 新增实测（框架选型依据）**：`Dockerfile` 头部注释「单容器单端口：Go 进程同时提供 API 与前端静态资源」、Stage 1 Flutter SDK 3.35.1 / Stage 2 `golang:1.25-alpine` / Stage 3 `alpine:3.20` 且 `COPY --from=web-builder /src/frontend/build/web /app/web`、`ENV LEDGER_WEB_ROOT=/app/web`；`docker-entrypoint.sh` 用 `su-exec` 降权并 `exec` 单进程（运行时无 Node）；`docker-compose.yml` 注释「本产品面向内网」；`README.md` 第 20 行「PWA：可安装、离线壳、IndexedDB 本地真相源」、第 29 行「单容器单端口」；`internal/server/static.go:8-25` `spaHandler` 行为约定（`/api/` 永不回退、无扩展名回退 `index.html`）；`internal/config/config.go:79` `WebRoot` 默认 `./web`
- **v2.2 新增实测（工程可行性）**：`frontend/lib/core/api/ledger_api.dart` 注释「登录态 token 与当前账本 id 均由 LedgerApi 静态持久化于 localStorage」、`_tokenKey='fl_token'`、`X-Ledger-Id` 统一注入、有 `refresh()` 但无 401 统一拦截；`frontend/lib/core/store/local_store.dart` / `viewmodels/ledger_controller.dart` / `screens/reports/reports_screen.dart` 均 `import 'package:decimal/decimal.dart'` 用 `Decimal.parse` 累加；`schema.sql` 的 `transactions` 表仅 `uuid UNIQUE`、**无幂等列**；`internal/db/migrate.go` 的 `migrations` 数组已到 **`012_opening_balance`**（AGENTS.md 记录的「002 最新」已过期）；`internal/server/middleware.go` `cors()` 固定 `Access-Control-Allow-Origin: *`、`authMiddleware` 只读 Bearer、强制改密态返回 428；`internal/handler/handler.go` `writeError` + `frontend/lib/core/api/api_error.dart` `ApiException.fromBody` 约定 `{error, code?, ...details}`；`frontend/build/web/flutter_service_worker.js` 为 Flutter 生成、`frontend/web/manifest.json` 含 4 组图标与 `standalone` 可复用
- **FamBean 现状**：`CHANGELOG.md`、`docs/frontend-revamp-tasks.md`、`docs/m2-plan.md`、`docs/product-review-2026-11.md`、`docs/frontend-framework-rewrite-assessment.md`、`docs/no-upgrade-compat-plan.md`、`docs/redesign-acceptance.md`、`frontend/lib/app/navigation.dart`、`frontend/lib/screens/shell/mobile_shell.dart`、`.workbuddy/memory/2026-11-05.md` / `2026-11-06.md` / `2026-11-09.md`

### 14.3 数字口径说明

- 13,993 行 / 60 文件 / 28 屏 / 14 widget / 31 端点 / 675 行纯内核：**本轮本地实测**（v1.1 引自评估文档，本版复核一致）。
- **1,149 行离线同步相关代码** = 305 + 370 + 302 + 102 + 70，本轮 `wc -l` 实测；其中 675 行是 `sync_service.dart` + `local_store.dart` 两个纯内核文件，两个数不矛盾，口径不同。
- 87 Go 测试 / 33 前端用例：引自 2026-11-06 工作日志的验证记录；33 用例对应 6 个测试文件。
- 6.9 MB `canvaskit.wasm`、`iOS 14.8 / WebKit 14.1.2`：引自真机诊断页回报。
- 所有工作量、体积、耗时目标均标注「**估算**」，不作为排期承诺；竞品能力清单为**已查证的仓库事实**，借鉴判断为**本方案观点**，两者不混用。
- 「竞品未见独立预算模块 / 未见多账本模型」属**目录与文件名检索结论**，非逐行代码审计，仅用于印证优先级判断，不作为对外结论。
- G-04 为**本地代码实测**（在线路径每次 `uuid.NewString()`、请求体无幂等字段），不是推测；离线路径 `idempotent=true` 一并核实。
- 文中金额（如 `+38.50`）均为**虚构示例**，仅用于说明分录预览格式。
- **迁移编号以 `internal/db/migrate.go` 的 `migrations` 数组为准（v2.5 复核：当前 013）**；`AGENTS.md` 中「002 为最新」是历史记录。**013（幂等键）已于批 1 落地并提交**（`migrate013_test.go` / `server/idempotency_test.go` 覆盖）；**014（库世代 `db_instance_id`）仍是待新增编号、未开工**，属批 4 前置阻塞。v2.2 时期「013/014 均非既存事实」的表述已失效，勿再引用。
- §5.6 中「Vite 默认不转译 `node_modules`」「httpOnly Cookie 需收敛 CORS `*`」「refresh 并发互相失效」为**通用工程判断**，非对本仓库的黑盒结论；项目侧事实均已标注具体文件。

### 14.4 名词

| 术语 | 定义 |
|---|---|
| M7 | 本方案定义的新里程碑；v1.1 为「M2 + 轻量载体」，**v2.0 重定义为「前端全量重构 + M2 + 幂等 + 清退旧版」**；不改动 `product-review-2026-11.md` 的 M0~M6 编号 |
| 全量重构 | 一次性写完全部页面并整体切换，开发期分批、交付期 cutover；**不等于**两版长期并行或逐页流量切换 |
| cutover | 把根 `index.html` 从 Flutter 产物切到 Vue 产物的一次性切换动作 |
| `/legacy/` | 开发期与观察期保留的旧版 Flutter 构建产物目录，仅作对账基准与回滚兜底，不维护源码 |
| S1 / S2 | `no-upgrade-compat-plan.md` 定义的 `compileStreaming` 兼容补丁 / 轻量记账页；**v2.0 起整条支线作废** |
| 收敛 | 把多个 Dart 文件表达的同一功能（如记一笔的四种容器）合并为 1 个 Vue 组件，按「功能不减」验收 |
| SPA / SSR / SSG | 单页应用（浏览器端渲染）/ 服务端渲染 / 静态站点生成。本期选 **SPA**：产物是静态文件，由 Go 直接托管，运行时无 Node 进程 |
| Nuxt | 基于 Vue 3 的全栈框架，核心价值在 SSR / SSG / 文件路由 / Nitro 服务端路由；本期不选，理由见 §5.5 |

### 14.5 旧版功能不降级清单（5 项曾有落点缺口）

> 原则：**旧版已有功能一律 Must**；Should / Could 只留给新增增强。下表 5 项在 v2.2 中只覆盖到页面、没写功能点，v2.3 补落点。

| # | 旧功能 | 旧版落点（Flutter） | 新版落点 | 优先级 |
|---|---|---|---|---|
| 1 | **CSV 导出**（流水明细） | 流水页导出入口 | P-04 工具栏「导出 CSV」：前端生成，字段 / 表头 / 编码与旧版一致，金额用 `Money.toString()` | Must |
| 2 | **分类拖拽排序** | 分类页 `ReorderableListView` | P-09：原生 HTML5 draggable（**不引入拖拽库**），顺序写回本地并随下次 pull 校准 | Must |
| 3 | **导出不平告警** | 导出前借贷平衡检查并提示 | P-15：导出前按账户 / 币种校验，不平即阻断并给出差额明细；仍保证导出文件过 `bean-check` | Must |
| 4 | **注册开关** | 设置页「允许注册」 | P-14「应用与账号」组：`/api/settings/registration` 读写，关闭后登录页隐藏注册入口并给出说明 | Must |
| 5 | **默认账户管理** | 设置页默认账户（记账预选） | P-14「账本与成员」组维护，C-01 打开时读取；账户被软删时回退首个可用账户并提示 | Must |

### 14.6 用例覆盖矩阵（v2.5 修订：由「迁移映射表」改为「覆盖矩阵」）

> **修订理由**：v2.3 列出的 6 个「新落点」文件在 2026-11-11 实测**全部不存在**。批 0~2.5 实际是按 Vue 架构**重写**了 22 个测试文件 / 202 个用例，而非把 33 个 Dart 用例逐条搬过来。为避免「映射表全绿」的假象（RK-10），本表改为按覆盖点对照，**如实标注等价覆盖 / 部分覆盖 / 待补**，不再承诺旧文件一一对应。

| 旧用例覆盖点 | 实际新用例（2026-11-11 实测） | 覆盖判定 | 待补 |
|---|---|---|---|
| 定点金额 / 符号口径（`money_test.dart`） | `core/Money.test.ts`（8）、`core/record.edge.test.ts`（13）、`core/qa-batch25.core.test.ts`（16） | **等价覆盖** | `-0.001→0.00`、`0.005→0.01`、`1e21` 边界散落在 edge / qa 用例中，无独立 `money.vectors.ts` 向量文件 |
| 本地净资产求和（`local_store_networth_test.dart`） | `core/accounts.test.ts`（14）、`core/qa-batch2.core.test.ts`（24） | **部分覆盖**（sembast → 内存 / localStorage 模型变化） | `sync/LocalStore.atomic.test.ts` 事务级用例待批 5 与离线内核一并补 |
| 错误体解析 / 文案（`api_exception_test.dart`） | `api/client.contract.test.ts`（18）、`api/client.test.ts`（13）、`api/errors.ts` | **等价覆盖（形态不同）** | 13 个后端 `code` → 用户文案表的完整对照未见独立用例，建议批 3 补 |
| 身份横幅 / 只读态（`identity_banner_test.dart`） | `views/qa-batch2.views.test.ts`（5） | **部分覆盖** | `components/IdentityBanner` 组件与独立用例未落地（viewer 只读态 AC-33 待批 3） |
| 期初冲正 / 余额（`opening_test.dart`） | `core/opening.test.ts`（8）+ Go 侧迁移 / 服务用例 | **等价覆盖** | `opening_key` 幂等与重试的端到端用例（AC-27）待补 |
| 应用壳 / 布局冒烟（`widget_test.dart`） | `views/*.test.ts`（10）、`components/*.test.ts`（11） | **部分覆盖**（jsdom） | 真机布局仍须 iOS 14.8 冒烟门禁（AC-01），jsdom 不能替代 |
| 同步协议（旧版零用例） | 无 | **待补（最高风险）** | 批 5 必须先录旧版 pull/push 行为为契约样本，再逐条对齐（AC-17 / RK-05） |

> `sync_service.dart` 当前**零用例覆盖**：不能以「新内核测试全绿」替代「与旧版一致」。批 5 开工前须先补契约样本。
> 累计：22 个 `.test.ts` / **202 用例全过**（2026-11-11 实测）；数量上超过旧版 33 用例，但**不存在逐条映射关系**，勿据此宣称「33/33 已迁移」。

### 14.7 依赖钉版与禁用清单

| 依赖 | 钉版 | 理由 |
|---|---|---|
| Node.js | **22.23.4**（`.nvmrc` + `engines`） | Vite 5 的 LTS 区间；镜像 Stage 1 同版本 `node:22-alpine` |
| npm | 随 Node（`engines: >=10`） | `package-lock.json` **必须 Linux/WSL 生成**（Windows 会缺 rollup/esbuild 平台二进制） |
| Vite | `^5.4` + `@vitejs/plugin-vue ^5.1` + `@vitejs/plugin-legacy ^5.4` | 参考项目的 Vite 8 超出 Safari 14.1 可承受区间；plugin-legacy 兜底 |
| Vue / 路由 / 状态 | `vue ^3.5` / `vue-router ^4.5` / `pinia ^2.3` | 均为 Vue 3.5 生态稳定线；**不采用 vue-router 5 / Pinia 4**（参考项目版本，要求更高运行时） |
| 类型 | `typescript ~5.6` + `vue-tsc ^2.1` | `~` 锁补丁；TS 6 不采用 |
| 测试 | `vitest ^2.1` / `@vue/test-utils ^2.4` / `jsdom ^25` / `fake-indexeddb ^6` | 双 project（`node` / `jsdom`）；`setupFiles` 给 fake-indexeddb 补 `structuredClone`；`TZ=Asia/Shanghai`；clock 可注入 |
| 金额 | `decimal.js ^10.4` | 只收 string 构造；单一实现 + 私有构造；`toString()` 固定 `toFixed()`；**保留 ROUND_HALF_UP** |
| PWA / 兼容 | `vite-plugin-pwa ^0.21` / `postcss-preset-env ^9` / `es-check ^7` | `injectManifest` + 手写 `src/sw.ts`；`es-check` 语法门禁（v2.6 抬到 **es2020** 放行动态 `import()`）+ `compat.mjs` **已接上 §14.7 API / CSS 扫描** |
| 编译目标 | `build.target: 'es2015'`；`tsconfig lib: ["ES2019","DOM"]`；`browserslist: ["iOS >= 14.8","Safari >= 14.1"]` | 与真机基线一致；`lib` 不得写 ES2022（参考项目配置会放行新 API） |
| **API 扫描清单** | `structuredClone` / `crypto.randomUUID` / `.at()` / `findLast` / `Object.hasOwn` / `showModal` / `BroadcastChannel` / `navigator.locks` | Safari 14.1 缺失或 15.4+ 才有；命中即失败（AC-19） |
| **CSS 特性清单** | `aspect-ratio` / `:has()` / `dvh` / `inset` | 同上，构建产物扫描 |
| **禁装** | ECharts / Vuetify / Framework7 / moment / monaco / leaflet / swiper | 体积与兼容双重理由；图表用 Canvas 2D 自绘（P-11） |

> 版本策略：运行时 `^`、类型 `~`、Node/镜像精确锁定；升级须同时过 AC-19 与真机冒烟，不允许「本地能跑就升」。

> **v2.5 落地复核（2026-11-11）**：`package.json` 依赖与上表一致（`vue ^3.5` / `vue-router ^4.5` / `pinia ^2.3` / `decimal.js ^10.4` / `vite ^5.4` / `typescript ~5.6` / `vitest ^2.1` / `es-check ^7`），`build.target: 'es2015'` + plugin-legacy 已落地。**尚未落地**：`vite-plugin-pwa`（批 5）、`postcss-preset-env`（未引入）、独立 CSS/API 特性静态扫描（现只有 `es-check` 语法扫描 + `compat.mjs` 特征串校验）。**按老板决策暂缓**：`.nvmrc` / `.npmrc` 入库、`engines` 收紧（现为 `>=20`，未钉 22.23.4）、Linux/WSL 重生成 lock、CI `web-verify`。本机 Node 22.22.2。已复核 `package-lock.json` 含 42 处 Linux 平台 optional 包条目（`@esbuild/linux-x64`、`@rollup/rollup-linux-x64-gnu` 等），原「Windows 生成必缺平台二进制」的判断在本项目当前 lock 上不成立，风险降级，但批 6 切 Node 构建前仍需在 Linux 实机复核。

> **v2.6 门禁变更（2026-11-11，老板拍板）**：`es-check` 语法门禁由 `es2015` 抬到 **`es2020`**，**仅为了放行路由懒加载生成的动态 `import()`**（ES2020 语法，Safari 14.1 真机支持）；**`build.target: 'es2015'` 与 plugin-legacy 的 Safari >= 14 polyfills 一个字未动**，产物基线不变。语法门禁放宽后，方案 §14.7 承诺的 **API / CSS 特性扫描**由 `scripts/compat.mjs` 接上兜底（扫描 `polyfills`/`legacy` 插件垫片 chunk 除外，避免 "WebAssembly" 等能力探测串误伤）。批 3 的 7 个管理与设置页已恢复为路由懒加载，首屏 `index` + `polyfills` gzip 由 153KB 降到约 131KB。真机 iOS 14.8 Safari 冒烟门禁（AC-19）待老板实测。

---

> 合规声明：本方案为产品设计参考，具体实施请结合公司合规与法务要求确认。
