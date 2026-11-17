# M2-g 验收记录：备份还原 + Beancount 导入

> 日期：2026-11-11 ｜ 依据：`docs/m2-plan.md` §8 验收标准 ｜ 结论：**通过（含 2 处验收过程发现的真 bug，已修复并有回归测试守卫）**

本记录逐条核对 m2-plan §8 的恢复 8 项 / 导入 7 项验收标准，证据为可重复执行的 Go 单测与 curl 冒烟。测试落点：`internal/restore/restore_test.go`、`internal/service/imports_test.go`、`internal/beancount/beancount_test.go`、`internal/service/sync_instance_test.go`。

## 一、恢复（m2-plan §8 · 8 项）

| # | 验收项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 预检不改动任何数据 | ✅ | `TestPreviewDoesNotMutate`：预检前后核心表行数与表清单逐一相等 |
| 2 | 损坏 / 非本系统 / 未来版本 均拒绝且原因明确 | ✅ | `TestPreviewRejectsNonSQLite`（reason=not_sqlite）、`TestPreviewRejectsFutureVersion`（reason=future_version）；integrity_failed / not_our_backup 走同一 reason 分支（`Preview` 5 项校验序贯短路），冒烟覆盖 not_sqlite 与超限文件 |
| 3 | 还原后 bean-check 通过 | ✅（间接） | 还原是整库替换，数据本身来自曾通过 bean-check 的导出/备份；导出→bean-check 闭环由 `TestImportExportRoundTrip`（bean-check 3.2.3）证明，恢复冒烟核对行数与可登录性 |
| 4 | 还原后行数与预检摘要完全一致 | ✅ | `TestPreviewAndExecuteRoundTrip`：还原后 users 行数与预检一致；结果结构 `replaced` 回带四表行数供前端展示比对 |
| 5 | pre-restore 快照可再还原回去 | ✅ | `TestRestoreSnapshotRoundTrip`（本验收新增）：还原 → 用返回的快照再还原 → 被覆盖数据恢复 |
| 6 | 还原中途失败 → 数据保持原样 | ✅（设计保证） | `replaceAll` 全程单事务（ATTACH→逐表 DELETE/INSERT→COMMIT），任一步失败整体 ROLLBACK；失败注入未单测，依赖事务边界论证 |
| 7 | 旧 schema 备份缺列还原成功且迁移补齐 | ✅ | `TestRestoreOldSchemaBackupMigratesBackfill`（本验收新增）：降级备份（删 013 列+迁移记录）→ 还原 → 列与迁移记录均恢复 |
| 8 | 非管理员访问两端点 403 | ✅ | service 层 `IsAdmin` 硬校验 + handler `requireAdmin`；冒烟实测 403 |

### 验收过程中发现并修复的 2 个真 bug

| # | bug | 影响 | 修复 | 回归守卫 |
|---|---|---|---|---|
| 1 | **ATTACH 不摘除**：`bak` 是连接级挂载，连接归还池后仍保持；第二次还原必报 `database bak is already in use` | 验收项 #5（用快照还原回去）及任何「同进程第二次 restore」必失败 | `replaceAll` 的 defer 在提交/回滚后统一 `DETACH DATABASE bak` | `TestRestoreSnapshotRoundTrip` |
| 2 | **schema_migrations 不随备份替换**：主库仍记录「新迁移已应用」，还原旧 schema 备份后 `ApplyMigrations` 不重跑，备份缺失的列**永远缺**（运行期 SQL 报错） | 验收项 #7 与 RK-M2-03 缓解措施失效；任何低于当前版本的备份还原后必然损坏 | `excludedTables` 收窄为仅 `db_instance`；schema_migrations 随备份替换后由迁移重跑补齐（迁移均有 columnExists / IF NOT EXISTS 守卫，可安全重入） | `TestRestoreOldSchemaBackupMigratesBackfill` |

> bug 2 属高风险项：迁移 011~014 期间（约 11 月上旬）产生的任何旧备份一旦还原即损坏，且报错出现在后续业务写入而非还原动作本身。本次验收的价值主要在此。

## 二、导入（m2-plan §8 · 7 项）

| # | 验收项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 导入自家导出文件 → 账户/交易/金额一致 | ✅ | `TestImportExportRoundTrip`：4 账户 1 交易 1 价格 2 分录逐项核对 |
| 2 | **round-trip**：导出→导入→再导出，文本等价且过 bean-check | ✅ | 同上：再导出解析计数一致；bean-check 3.2.3（项目 venv `python -m beancount.scripts.check`）通过 |
| 3 | plugin / include / cost 注解 → 整体拒绝含行号 | ✅ | `TestImportRejectsUnsupported` + `internal/beancount` 单测（拒绝指令全清单）；前端 `ImportView.test.ts` 断言全部行号展示且无执行入口 |
| 4 | 语法错误一次列出全部错误行 | ✅ | 解析器收集全部错误后才返回（`beancount.ParseResult.Errors`）；前端 `formatImportErrors` 保序展示 |
| 5 | 导入失败不留半个账本 | ✅ | `ImportBeancount` 单一大事务（建账本→币种→账户→价格→交易→sync_log），失败整体回滚；冒烟：引用未声明账户被 400 拒后无残留 |
| 6 | 导入账本能被其他成员看到（sync_log 已写） | ✅ | 每类实体写入 `sync_log(create)`；同步通道本身由 `TestSyncPushPullAndNaturalKeyMerge` 覆盖 |
| 7 | 重复导入提示（同名+同交易数），不阻断 | ✅ | `TestImportManualText`（同名自动加序号、原账本不破坏）+ 冒烟「Cookie导入 (2)」；前端 `duplicate` 提示卡不禁用执行按钮 |

## 三、本轮追加的同步口径（#1 instance_id 三通道）

`docs/next-phase-frontend-plan.md` §621 要求 health / pull / push 响应追加 `instance_id`（additive）。已落地：

- `GET /api/health`：读取失败时降级为不带字段，status 恒 ok（公开端点永不失败）
- `GET /api/sync/pull` / `POST /api/sync/push`：`PullResult.InstanceID` / `PushResultOut.InstanceID`
- 测试：`TestSyncResponsesCarryInstanceID`（库内一致）+ `TestPullJSONShapeHasInstanceID`（wire 格式含字段，防 tag 漏写）
- 前端类型 `HealthResponse` / `SyncPullResponse` / `SyncPushResponse` 已加 `instance_id?: string`；客户端消费逻辑（比对→清本地→全量 pull）属批 5 离线内核，本期不实现

## 四、遗留与说明

- **恢复 e2e 冒烟**（11-11 早间，:18080 临时库）覆盖：预检 valid=true（schema 14=14）、无确认词 400、执行成功回带快照与新 instance_id、instance_id 轮换、非管理员 403、非 SQLite 拒绝。
- **中途失败注入**（恢复 #6）与 **integrity_failed / not_our_backup 独立单测**未做：前者依赖事务边界论证，后者与 not_sqlite 共用校验链路；如需穷尽可在后续批次补。
- 验收测试新增 4 个（restore_test.go：DoesNotMutate / RejectsFutureVersion / OldSchemaBackfill / SnapshotRoundTrip）；修复涉及 `internal/restore/restore.go` 两处 + 注释对齐。
- 全量验证：`go build/vet` exit 0；`BEAN_CHECK_STRICT=1 go test ./...` 全包 ok；Vitest 33 文件 275/275；`vue-tsc` exit 0。
