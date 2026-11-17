# FamBean 研发进度审查报告

> 审查日期：2026-11-11 ｜ 分支：`develop` ｜ 基准：`docs/next-phase-frontend-plan.md` v2.4
> 审查方式：文档通读 + `git log/status` + 前后端全量测试实跑 + 代码结构逐项核验（**不以文档自述代替现状**）
> 结论性质：**只读审查**，零代码改动、零提交。

---

## 一、结论先行

**代码进度与方案声称的「批 0~2.5 已落地」基本一致，核心记账闭环质量扎实；但工程护栏与文档留档明显落后于代码。**

三句话：

1. **功能侧**：按 6 批口径走完 4 批（0 / 1 / 2 / 2.5），按页面口径 **11 / 20 页（约 55%）**；核心记账闭环（登录 → 记一笔 → 流水 → 账户 → 分类/币种 → 期初/关户 → 回收站 → 改密）已打通且测试全绿。
2. **质量侧**：Vitest **202/202**、Go 全量 + `BEAN_CHECK_STRICT=1` 全绿、`vue-tsc` 零错误；账芯约束（31 端点、append-only、导出校验）未被破坏。
3. **风险侧**：**批 0 的「CI 前端门禁」交付点未兑现**，方案文档 / AGENTS.md / CLAUDE.md / README.md 存在大面积口径漂移，且**方案文档与批 2.5 文档更新尚未入库**。批 4 的迁移 014 是 M2 的硬阻塞，仍未开工。

> **推荐动作**：先做一次「批 2.5 收口包」（文档入库 + CI 门禁 + 版本链修订），再开批 3。理由见 §六。

---

## 二、实测验证结果（本次实跑，非引用文档）

| 检查项 | 命令 / 方式 | 实测结果 |
|---|---|---|
| 前端单测 | `cd frontend && npm run test` | **22 个测试文件 / 202 用例全过**，21.79s |
| 前端类型检查 | `npx vue-tsc --noEmit` | **exit 0**，无输出 |
| 后端全量 | `bash scripts/local.sh test`（含 `go vet` + `BEAN_CHECK_STRICT=1 go test ./...`） | **全过**，`internal/server` 15.088s；严格模式下 PASS 计数 110（含子测试，与方案「87」口径不同，不宜直接比） |
| 前端源码规模 | `find frontend/src -name '*.ts' -o -name '*.vue'` | **57 文件 / 14,067 行**（与文档一致；含 CSS 则为 58 / 14,210，属口径差异） |
| 测试文件数 | `find -name '*.test.ts'` | 22 个，含 `qa-batch2` / `qa-batch25` 双审计回归 |
| API 契约 | `router.go` / `api/routes.ts` | 后端 **31** 个 `/api/` 端点，前端 **31** 个路由常量，数量对齐 |
| 页面 | `router/index.ts` | **12 条路由 / 11 个 view**（含 catch-all），目标 20 页 |
| 迁移 | `internal/db/migrate.go` | **至 013**；`014` / `db_instance_id` / `instance_id` 在 `internal/` 零命中 |
| 安全边界 | `grep` | `frontend/src` 无硬编码 `http(s)://`；`localStorage` 仅用于清理旧版 `fl_token` 与分类顺序持久化，**token 不落本地** |
| 回滚产物 | `frontend/dist/legacy/` | 存在（`flutter_bootstrap.js` / `canvaskit` 等），可用 |
| 工作区 | `git status --short` | `M AGENTS.md`；`?? docs/frontend-framework-rewrite-assessment.md`；`?? docs/next-phase-frontend-plan.md` |

> 未做：未起服务做 curl 冒烟、未跑 `web-build` / `web-compat`（`web-build` 会清空 `dist/` 导致 `dist/legacy/` 丢失，属写操作，审查阶段不触发）。后端已由 `httptest` 集成测试覆盖关键链路。

---

## 三、批次进度对照（方案 §11）

| 批次 | 方案内容 | 声称状态 | **实测** | 判定 |
|---|---|---|---|---|
| 批 0 | 工程底座 / 钉版 / `web-*` 命令 / **CI `web-verify` job** / 版本校验 / `/legacy/` / D-7 | ✅ 已完成 `c4ce399` | 主体已落地，**CI `web-verify` 未建**、`verify-version.sh` 仍读 `pubspec.yaml`、`.nvmrc`/`.npmrc` 缺失 | **部分完成**（交付点打折） |
| 批 1 | 登录·首页·记一笔 + 401·428 + 迁移 013 幂等 | ✅ `814627a`/`4feccaf` | `client.ts` 契约/并发/latch 测试齐全，013 已落 | ✅ 一致 |
| 批 2 | 流水 / 账户 / 分类 / 币种 + 期初·关户 + CSV 导出 | ✅ `e018cc0` | 对应 view 与 `core/{csv,opening,filters,calendar}` 均存在且有测试 | ✅ 一致 |
| 批 2.5 | 口径对齐 fava/beancount 双审计 | ✅ `20fd5d8` | `qa-batch25.core.test.ts` 16 用例 + `record.edge.test.ts` 13 用例 | ✅ 一致 |
| 批 3 | P-11~P-18（报表/成员/账本/设置/数据安全/会话/同步状态） | 未开工 | 路由中无对应页面 | ✅ 符合计划 |
| 批 4 | M2 四端点 + 迁移 014 库世代 + P-19/P-20 向导 | 未开工 | 无 `014`、无 `instance_id`、无 M2 端点 | ✅ 符合计划，**硬阻塞仍在** |
| 批 5 | 离线内核 `sync/` + 契约测试 + SW/PWA | 未开工 | `frontend/src/sync` 不存在；仅有 `manifest.json` + icons，无 `sw.ts` / `sw-kill.js` / `vite-plugin-pwa` | ✅ 符合计划 |
| 批 6 | cutover + Dockerfile Node 化 + 清退 Dart | 未开工 | `Dockerfile` 仍是 Flutter 三阶段（3.35.1），根路径仍托管 `frontend/build/web` | ✅ 符合计划 |

**关键路径**：批 3（页面）→ 批 4（**014 必须先落**，否则 restore 后 `sync_log` 水位回退会静默丢同步）→ 批 5（最高风险 RK-05）→ 批 6。

---

## 四、偏差与风险清单

### P0 — 建议立刻收口（低成本、影响判断）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 1 | **方案文档与批 2.5 文档更新未入库** | `git status`：`?? docs/next-phase-frontend-plan.md`（892 行，v2.4）、`?? docs/frontend-framework-rewrite-assessment.md`、`M AGENTS.md`（11 行） | 方案里写「均已提交」「AGENTS.md 同步更新」**不成立**。换机 clone 会丢掉唯一权威方案与最新现状约定，后续会话必然误判 |
| 2 | **CI 无 `web-verify` job** | `.github/workflows/docker-image.yml` 仅 `verify`（go vet / go test strict / bean-check 自检 / 版本校验）+ `build` | 批 0 交付点「CI 有前端门禁」未兑现，**AC-20 无法验**；202 用例只在本地跑，RK-10「假绿」敞口 |
| 3 | **多份文档口径漂移** | 见下表 | `CLAUDE.md` 是 AI 会话速查入口，过时描述会直接带偏后续所有开发动作 |
| 4 | **版本链与 CHANGELOG 未跟上** | `verify-version.sh` 仍读 `frontend/pubspec.yaml`；`CHANGELOG.md` [Unreleased] 无任何 M7 记录，顶部仍写「tag / CHANGELOG / pubspec.yaml 三处一致」 | 切 Node 构建链时版本门禁断链；发版追溯缺一段 |

**文档漂移明细（本次全仓扫描）**

| 文件 | 位置 | 过时内容 | 实际 |
|---|---|---|---|
| `CLAUDE.md` | L7 | 「Vue 处于批 0/1 骨架阶段，只有 **10 个源文件**」 | 57 文件 / 14,067 行 / 11 view / 202 用例 |
| `CLAUDE.md` | L3 / L8 / L79 | 引 v2.3；「工作区有大量未提交改动（M7 批 0/1）」 | 方案 v2.4；工作区仅 1 改 2 未跟踪 |
| `README.md` | L13 / L254 | 「M7 全量重构方案 **v2.3**」 | v2.4 |
| `AGENTS.md` | L84 / L231 | 「方案 v2.3」「按方案 v2.3」 | v2.4 |
| 方案 §1 | L74 / L78 | 「`frontend/` 下**无 `package.json`**」；工作区「1 删 2 改 5 未跟踪」 | 已有 `package.json` + lock；工作区 1 改 2 未跟踪 |
| 方案 §9 | L649 / L652 | Node 工具链「**未引入 / 阻塞（开工）**」；幂等「**未动 / 阻塞**」 | 批 0 / 批 1 已完成 |
| 方案 §14.1 | R-05/06/07/09 | 标「待开工」 | 金额隐私（`stores/privacy`）、兼容基线（es-check / vite 配置）、幂等+连续记账+草稿（`RecordSheet`）、筛选 query 化（`core/filters`）**均已落地**；仅 R-06 的 CI 门禁缺，应标「部分完成」 |
| 方案 §14.3 | L830 | 「迁移编号……**当前 012**」「013/014 是待新增编号，**不是既存事实**」 | 013 已实现，**与 v2.4 自相矛盾** |
| 方案 §14.6 | 映射表 6 行 | `ApiError.test.ts` / `IdentityBanner.test.ts` / `money.vectors.ts` / `sync/LocalStore.atomic.test.ts` / `App.shell.test.ts` 等落点 | **6 个目标文件实测全部不存在**；202 个新用例是重写覆盖，不是逐条迁移，§14.6 对齐证据缺失 |

### P1 — 影响可复现性与上线门禁

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 5 | 工具链钉版未收口 | `.nvmrc` / `.npmrc` 不存在；`engines` 仅 `>=20`（未钉 22.23.4）；`package-lock.json` 为 Windows 生成（11-09 17:38） | 镜像内 `npm ci` 会缺 rollup/esbuild 平台二进制（RK-09 / AC-20），**本地能跑 ≠ 镜像能构建** |
| 6 | 33 用例未逐条对齐 | §14.6 六个落点全缺；`sync_service.dart` 仍零用例 | 批 5 契约样本未录，RK-05（离线内核最高风险）缺「与旧版一致」的基线 |
| 7 | 回滚产物只在开发机 | `dist/legacy/` 为 gitignore，CI / 镜像内无产出脚本接入 | 方案 §9 已列为 RK-09：`web-build` 清空 `dist/` 后须补 `web-legacy`，否则回滚只在本地成立 |

### P2 — 按计划未开工（符合预期，列出便于排期）

- 页面缺口：P-11 报表 / P-12 成员 / P-13 账本 / P-14 设置 / P-15 数据安全 / P-17 会话 / P-18 同步状态 / P-19 导入向导 / P-20 恢复向导。
- 后端缺口：迁移 014 + `instance_id`（`/api/health`、`sync/pull`、`sync/push` 均未带）；M2 四端点；旧版功能不降级清单 §14.5 中「导出不平告警 / 注册开关 / 默认账户管理」尚无对应页面落点。
- 离线与 PWA：`sync/` 内核、`sw.ts`、`sw-kill.js`、更新提示、租约 / 死信 / 隔离区。
- 部署链：Dockerfile Node 化、根路径 cutover、真机 iOS 14.8 全主流程冒烟、观察期后清退 Dart。

---

## 五、API 变更影响（列计划必附）

| 阶段 | 端点变化 | 兼容性 |
|---|---|---|
| **收口包 / 批 3** | **0 个新增端点**。报表 / 成员 / 账本 / 设置 / 会话 / 同步状态页面全部复用现有 31 端点（`/api/ledger/members`、`/api/auth/sessions`、`/api/settings/registration`、`/api/backup/*`、`/api/export` 等已注册） | 无契约变化；仅需前端补 API 层调用与 `X-Ledger-Id` 断言 |
| **批 4** | 新增 **4 个**：`POST /api/backup/restore/preview`、`/api/backup/restore`、`/api/import/beancount/preview`、`/api/import/beancount`；另对 `/api/health`、`GET /api/sync/pull`、`POST /api/sync/push` 响应**追加** `instance_id` 字段 | 追加字段为 additive，旧客户端忽略即可；但**前端必须按 `{ledger_id: {instance_id, last_seq}}` 比对**，否则 restore 后静默丢同步 |
| **批 6 cutover** | 无新增；`LEDGER_AUTH_EXPOSE_TOKEN` 由 `true` → `false`，响应体不再返回 `token` | **破坏性**：仅影响仍依赖 Bearer 的 `/legacy/` 旧版，须在观察期结束后、删除 Dart 前切换 |

> 幂等实现边界仍需留意：当前并发安全隐式依赖 `MaxOpenConns=1`，放开连接数或切 Postgres 前必须补齐 `ON CONFLICT` / `BEGIN IMMEDIATE`（方案 §7、AGENTS.md §4 均已记录）。

---

## 六、下一步建议（推荐顺序与理由）

**推荐：先做「批 2.5 收口包」，再开批 3。**

| 顺序 | 动作 | 理由 |
|---|---|---|
| 1 | 单独一次 **docs 提交**：方案 v2.4 + 评估文档 + `AGENTS.md` + 同步 `CLAUDE.md` / `README.md` 版本号与现状段、补 `CHANGELOG.md` [Unreleased] 的 M7 段、**修正方案 §1/§9/§14.1/§14.3/§14.6 的滞后与自相矛盾** | 零代码风险、成本最低；这些文档是后续所有会话的上下文入口，漂移会随批次放大。**不与代码混在同一次提交**（D-5 已定口径） |
| 2 | 补 **CI `web-verify` job**（`web:typecheck` / `web:test` / `web:build` / `web:compat`）+ `verify-version.sh` 改读 `frontend/package.json` + `.nvmrc` / `.npmrc` 入库 + **Linux/WSL 重生成 lock** | 门禁是批 3~6 的安全网；先建再写页面，否则 202 用例继续只在本机有效，且镜像构建链在 cutover 时集中爆雷 |
| 3 | 再开 **批 3**（P-11~P-18，先做 Must：成员 / 账本 / 设置 / 数据安全） | 无后端改动、可独立中断；补齐 §14.5 不降级清单的落点 |
| 4 | 批 4 开工前**先落迁移 014 + `instance_id`**，再动 M2 四端点与两个向导 | 方案已定性为「唯一技术阻塞」，顺序反了会返工 |
| 5 | 批 5 之前**先录旧版 pull/push 契约样本**，再重写 `sync/` 内核 | AC-17 要求「与旧版逐条一致」，不能拿新内核自测全绿替代 |

**需老板拍板/确认的口径**：
- 上述 docs 提交是否现在做（本次审查**未提交任何内容**，遵守「测试前不要 commit」）。
- 方案 §14.6 的 33 用例映射表：是继续按旧文件逐条补测，还是承认「202 新用例重写覆盖」并**改写映射表为覆盖矩阵**（当前表述与代码不符，二选一即可，不留悬空）。
- 观察期长度（方案建议 3~7 天）与真机 iOS 14.8 冒烟的排期。

---

## 六之一、后续决策记录（2026-11-11 同日）

老板「按你的推荐来吧」后追加「**CI 前端门禁与工具链钉版暂不做**」，故收口范围收窄为**仅文档**：

- **已执行（本地修订）**：方案升 v2.5 并对齐 §1 / §9 / §11 / §14.1 / §14.3 / §14.6 / §14.7；同步 `AGENTS.md` / `CLAUDE.md` / `README.md` / `CHANGELOG.md`；评估文档加「结论已被 v2.0 决策取代」横幅。
- **老板再追加「docs\ 目录中的文件暂时不提交」**：方案 v2.5 / 换框架评估 / 本审查报告**均保持未跟踪、不入库**，本次仅提交根目录 4 份文档。后果：根文档已引用方案 v2.5，clone 到其他机器时 `docs/next-phase-frontend-plan.md` 不存在（链接断）；等老板放行 docs 后补一次提交即可消解。
- **未执行（保持未完成，文档一律标「暂缓」）**：CI `web-verify` job、`verify-version.sh` 改读 `frontend/package.json`、`.nvmrc` / `.npmrc`、`engines` 收紧、Linux/WSL 重生成 `package-lock.json`。
- **复核发现（不改变主结论）**：`package-lock.json` 已含 42 处 Linux 平台 optional 包条目，原报告 P1-5「镜像 `npm ci` 会缺 rollup/esbuild 平台二进制」风险**降级**；本机 WSL 被安全策略禁用、Docker 不可用，无法实机验证 Linux `npm ci`，批 6 前仍需复核。本机 Node 22.22.2，方案钉版目标 22.23.4。
- §六 的第 2 步（CI 门禁）不再属于本次交付；第 1、3、4、5 步顺序不变。§七 描述的是审查当时的边界，后续文档改动以本节为准。

## 七、本次审查边界

- 只读核验 + 跑测试；**未修改任何源码、配置、文档（本报告除外），未执行 `git commit`**。
- 未起服务做 curl 冒烟，未运行 `web-build` / `web-compat` / `smoke` / `rehearse`（避免写 `data/` 或清空 `dist/legacy/`）。
- 未做真机 Safari 14.1 / 双标签页实时同步验证（属批 6 门禁，方案已列）。
- 未评审 UI 视觉与设计稿一致性（本次仅审研发进度）。
