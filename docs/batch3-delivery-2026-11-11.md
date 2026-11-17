# FamBean M7 批 3 交付说明

> 日期：2026-11-11 ｜ 范围：P-11~P-15 / P-17 / P-18（P-16 改密批 1 已存在）
> 状态：**本地全量验证通过，未提交、未 push**（按老板「docs\ 目录暂时不提交」及项目「改完先本地测试」的口径，代码提交等老板一句话）

---

## 一、结论

7 个页面全部落地并接入路由 / 导航，**后端零改动、零新增端点**，复刻了旧版对应页面的功能点；补齐 §14.5「旧版功能不降级」5 项的落点；新增 47 个用例，全量 249 用例通过。构建、es2020 语法门禁 + §14.7 API/CSS 扫描、Go 全量、curl 端到端冒烟、回滚产物均验证通过。

有三处**刻意留白**，不是遗漏：导入 / 恢复向导（批 4 M2）、离线同步内核（批 5）、cutover 与清退（批 6）。同步状态页因此只做只读可视，不伪造「立即同步 / 待推送 N 条」。

---

## 二、页面清单

| 编号 | 路由 | 文件 | 复刻的功能点 |
|---|---|---|---|
| P-11 | `/reports` | `ReportsView.vue` | 周/月/年 + 前后翻页、#tag 下钻、币种切换、4 指标、收支趋势（Canvas 2D）、分类占比（Canvas 2D）与排行、成员贡献、试算平衡 |
| P-12 | `/members` | `MembersView.vue` | owner 权限门、邀请（用户名 + 角色）、角色翻转、移除二次确认、重置密码（≥6 位） |
| P-13 | `/ledgers` | `LedgersView.vue` | 列表 + 当前徽章 + 角色、新建（CNY）、改名、切换、期初日期（owner 专属 + 二次确认 + 上界校验） |
| P-14 | `/settings` | `SettingsView.vue` | 身份卡（系统管理员 / 账本角色分层）、默认账户卡、7 个入口、注册开关（isAdmin）、退出登录 |
| P-15 | `/data-safety` | `DataSafetyView.vue` | 备份（仅管理员渲染）列表 / 立即备份 / 下载 / 错误文案；导出 beancount / zip / CSV；导出前不平阻断；导入占位 |
| P-17 | `/sessions` | `SessionsView.vue` | 设备列表、逐台吊销二次确认、退出其他设备、吊销当前设备=登出、404 重载 |
| P-18 | `/sync` | `SyncStatusView.vue` | 连通性、当前账本、账户/交易数、协议说明与边界标注（只读） |

配套组件：`components/ReportCharts.vue`（Canvas 2D 折线 + 环形占比，禁 WebGL/WASM/ECharts）。
纯逻辑层：`core/reports.ts`（分录级、单币种、定点聚合）、`core/batch3.ts`（错误/时间/差额文案/下载）、`core/storage.ts` 扩展默认账户。
`LoginView.vue` 补了注册开关消费与注册表单（§14.5 #4）。

---

## 三、API 变更（列计划必附）

**新增后端端点：0 个。** 31 个既有端点全部够用。

前端 `api/client.ts` 扩展：

- 新增 `requestWithMeta<T>()` 返回 `{ data, headers }`，`request<T>()` 改为薄包装，**既有调用零改动**；支持 `responseType: 'blob'`，错误响应仍按 JSON 解析文案。
- 新增封装：`memberApi` / `ledgerManageApi` / `settingsApi` / `sessionApi` / `backupApi` / `exportApi` / `identityApi` / `syncStatusApi`。
- 导出读 `X-Ledger-Balanced` / `X-Ledger-Diffs` 响应头（冒烟确认服务端已通过 `Access-Control-Expose-Headers` 暴露）。
- `syncStatusApi` **刻意不提供 pull 探测水位**：服务端 `SyncPull` 会按 `client_id` 写回 `sync_checkpoints`，用 `since=0` 探测既拉全量、又静默篡改设备水位。

---

## 四、§14.5 旧版功能不降级（5 项）

| # | 项 | 本批落点 | 状态 |
|---|---|---|---|
| 1 | CSV 导出 | 批 2 已在 P-04（`core/csv.ts`），P-15 增加入口，表头与转义与旧版一致 | ✅ |
| 2 | 分类拖拽排序 | 批 2 P-09 已落地，本批未改 | ✅ |
| 3 | 导出不平告警 | P-15 **导出前**跑 `GET /api/identity/check`，不平即**阻断**并列出按币种差额；导出后再读响应头二次提示。比旧版「导出后告警、不阻断」更严 | ✅ 补强 |
| 4 | 注册开关 | P-14 仅 isAdmin 渲染 + P-01 登录页消费公开开关（关闭时不切注册态、查询失败按开放）；顺带补了此前缺失的注册表单 | ✅ |
| 5 | 默认账户管理 | P-14 查看 / 清除全部；`core/storage.ts` 按账本命名空间存 4 类 uuid；`RecordSheet` 打开预选、切 Tab 预选、提交成功后回写、失效（删除/关户）回退首个可用并提示 | ✅ |

---

## 五、验证结果（全部本地实跑）

| 检查 | 命令 / 方式 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | **exit 0**，无错误 |
| 前端单测 | `npm run test` | **29 文件 / 249 用例全过**（批 2.5 为 22/202，本批 +47） |
| 构建 | `npm run build` | 118 modules，CSS 58.34 KB + 主 JS 278.73 KB + polyfills 110.22 KB |
| es2015 门禁 | `npm run compat` | **PASS**，批 1 特征串 5/5，es-check 无版本错误，`dist/legacy/` 不变量校验通过 |
| 后端全量 | `bash scripts/local.sh test` | `go vet` + `BEAN_CHECK_STRICT=1 go test ./...` **全绿** |
| 版本一致性 | `bash scripts/verify-version.sh` | tag / CHANGELOG / pubspec 三处均 **0.5.0** |
| 端到端冒烟 | 独立临时库 + `:18080` curl | health `200`、注册开关 `{"enabled":true}`、未登录备份 `401`、注册/me/成员/会话/恒等式/账本清单/备份清单全部符合预期；导出响应头 `X-Ledger-Balanced: true` + `Content-Disposition` 正常 |
| 回滚产物 | `bash scripts/local.sh web-legacy` | Flutter `--base-href /legacy/` 重建 + 基路径校验通过（`web-build` 清空 `dist/` 后已恢复） |
| 静态扫描 | Grep | 硬编码后端 URL **0**、禁用 API（structuredClone / randomUUID / `.at()` / BroadcastChannel / WebGL…）**0**（仅注释提及）、禁用 CSS 特性 **0** |

冒烟用独立 `data/batch3-smoke.db` 与 `:18080`，服务已停止、临时文件已清理，未触碰 `data/ledger.db` 与备份目录。

**冒烟实测发现**：`GET /api/auth/me` 的 `role` 恒为空串，注册响应里才是 `owner`。因此成员管理 / 设置页的权限判定取 `session.ledgers` 中**当前账本**的 role，不用 `user.role`——否则切账本后会把 owner 误判成未加入。

---

## 六、已知遗留与风险

1. **首屏体积**：JS+CSS 未压缩合计约 **447 KB**（gzip 后约 153 KB），超方案 §8 的 300 KB 估算上限（该目标未定义压缩口径，且标注「需真机实测校准」）。曾尝试 7 页路由懒加载把主包降到 237 KB，但 Vite 生成的动态 `import()` 是 ES2020 语法，**`es-check es2015` 门禁（AC-19）直接失败**，已回退并在 `router/index.ts` 留注释。要拆包需先由老板拍板调整兼容门禁口径并补真机冒烟，不擅自改门槛。
2. **同步状态只读**：离线内核（IndexedDB / pending / 租约 / 死信）属批 5，服务端水位需批 4 迁移 014 的 `instance_id`。页面如实标注，不自动轮询、不伪造同步能力。
3. **报表数据源在线**：新版尚无 IndexedDB 本地真相源，报表需联网；批 5 内核落地后切换。
4. **导入 / 恢复向导**（P-19/P-20）与 **M2 四端点**未做，属批 4。
5. **CI `web-verify` 门禁与工具链钉版**按 2026-11-11 老板决策暂缓，本批未动；249 个用例目前只在本地跑。
6. **真机 iOS 14.8 全主流程冒烟**未做（cutover 门禁，批 6）。
7. `docs/` 下 3 份文档（方案 v2.5 / 换框架评估 / 进度审查报告）按指示未提交；根文档已引用 v2.5，clone 到其他机器会断链，待放行后补一次纯 docs 提交。
8. **本批代码未提交**，等老板确认。

---

## 七、关键文件

**新增**：`frontend/src/views/{Reports,Members,Ledgers,Settings,DataSafety,Sessions,SyncStatus}View.vue`、`components/ReportCharts.vue`、`core/{reports.ts,batch3.ts}`、6 个 `*.test.ts`。
**修改**：`api/client.ts`、`api/types.ts`、`router/index.ts`、`components/AppLayout.vue`、`components/RecordSheet.vue`（§14.5 #5）、`core/storage.ts`、`views/LoginView.vue`、`components/RecordSheet.idempotency.test.ts`（补 storage mock）。

---

## 八、启动命令

```bash
# 后端（cutover 前仍托管 Flutter 旧版产物）
bash scripts/local.sh dev

# 新版 Vue 开发服务器（/api 代理到 127.0.0.1:8080）
cd frontend && npm run dev

# 门禁四件套（CI 暂缓期，提交前手动跑）
cd frontend && npm run typecheck && npm run test && npm run build && npm run compat
# 跑过 web-build 后必须补：bash scripts/local.sh web-legacy
```

---

## 九、下一步建议

1. 老板确认后提交本批代码（建议一次 `feat(m7)` 提交，不与 docs 混提）。
2. **批 4 开工前必须先落迁移 014 + `instance_id`**（`health` / `sync/pull` / `sync/push` 追加字段），否则 restore 后 `sync_log` 水位回退会静默丢同步；之后再做 M2 四端点与 P-19/P-20 向导。
3. 批 5 前先录旧版 pull/push 契约样本，再重写离线内核（AC-17）。
4. **v2.6 门禁已调整（本次后续追加）**：`es-check` 语法门禁由 es2015 抬到 es2020，仅放行动态 `import()`；`build.target: 'es2015'` 与 plugin-legacy 不变。批 3 的 7 个管理页已恢复路由懒加载，首屏 `index` + `polyfills` gzip 约 131KB（此前 153KB）。**真机 iOS 14.8 Safari 冒烟门禁（AC-19）待老板实测**，本地真机测试环境要求见下节。

---

## 十、真机本地测试环境要求（老板实测前）

> 仓库锁文件是 `frontend/package-lock.json`（npm），**请用 `npm`，不要用 `pnpm`**——混用会漂 lockfile、让本地依赖树与 CI 不一致。

**推荐：构建后用 Go 后端直接托管（单源、同源、无 CORS，最贴近生产）**

```bash
cd /d/Project/Self/FamBean/frontend
npm install                       # 用仓库 lockfile（npm）
npm run build                    # → frontend/dist/（含 7 个懒加载 chunk）
cd /d/Project/Self/FamBean
bash scripts/local.sh web-legacy # 补 Flutter /legacy/ 回滚兜底（web-build 会清空 dist/）
LEDGER_WEB_ROOT=frontend/dist go run ./cmd/server
# 真机 Safari 打开 http://<本机局域网IP>:8080
```

**备选：构建后 nginx 托管（若你已习惯 nginx）**

```bash
cd /d/Project/Self/FamBean/frontend && npm install && npm run build
# nginx 静态托管 frontend/dist/，并将 /api 反代到 http://127.0.0.1:8080
# 真机打开 http://<本机局域网IP>:<nginx端口>
```

**不推荐：Vite dev 服务器（`npm run dev`）做 14.7 兼容门禁**

Vite dev 不注入 plugin-legacy polyfill、按源码直出未降级 ESM，不代表生产产物；仅适合桌面快速冒烟，**不能**作为 iOS 14.7 兼容验收。且需 `--host` 才能被真机访问。

**真机清单（iOS 14.7/14.8 Safari）**：① 7 个懒加载页首次进入能正常加载（动态 import 不白屏）；② 记一笔 / 报表 Canvas 2D 渲染正常；③ 导出 beancount 不平正确阻断；④ console 无语法/兼容报错；⑤ 切账本后角色判定正确。详细清单见本次对话附带的真机测试指南（需要我存成文件可说一声）。
