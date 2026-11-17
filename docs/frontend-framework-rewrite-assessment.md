# 换框架重构评估：要不要推倒重来

> ⚠️ **本文结论已被后续决策取代，仅作决策链证据存档**：v1.0 推荐「渐进式替换 / 不一次性推倒重来」，老板 2026-11-09 已拍板改为**前端全量重构 + 一次性 cutover**（见 `docs/next-phase-frontend-plan.md` v2.0 起）。文中「换 Vue 3 + Vite、`es2015`、禁 WASM」的技术判断仍有效，**「不要全量重写」的结论不再适用**，勿据此判断当前范围。

> 2026-11-09 · v1.0 · 背景：iOS 14.8 不升级、Windows 电脑、Flutter Web 白屏、原生 App 打包受阻
> 关联：`docs/no-upgrade-compat-plan.md`、`docs/ios-native-app-feasibility.md`、`docs/ios14-white-screen-plan.md`
> 状态：**仅评估，零代码改动**

---

## 一、结论

**能换，而且长期看确实值得换；但不该为了修这台手机的白屏而换，也不该一次性推倒重来。**

| 问题 | 答案 |
|---|---|
| 换框架能解决 iOS 14.8 白屏吗 | ✅ 能，且是唯一「一次解决、永久不受浏览器基线牵制」的根治方案 |
| 能解决的是框架问题吗 | ❌ **不是**。白屏死在 CanvasKit/WASM，不是死在 Dart 或 Flutter 本身 |
| 现在就该全量重写吗 | ❌ 不建议。13,993 行 Dart / 28 页面 / 离线同步协议要重做，big-bang rewrite 是经典反模式 |
| 推荐做法 | **Vue 3 + Vite（`build.target: 'es2015'`）+ 渐进式替换（绞杀者模式）**，先做 `/lite/` 切片 |
| 后端要改吗 | **零新增 API**；最多 2 处小调整（CORS 收敛、子目录 SPA 回退），且都能避开 |
| 最省的一条路 | S1 补丁真机探针已落地，**先花 10 分钟验**；失败则 `/lite/` 成为重构的第一块积木 |

一句话：**换框架是对的长期决策，但它的第一步不是「重写」，是「先做一个能跑在 iOS 14.8 上的最小切片」——这恰好就是上一轮说的 S2。**

---

## 二、先把「重构」拆成两个不同目标

老板这句话可能指两件事，成本差一个数量级，先分清：

| 目标 | 最小解 | 是否要换框架 |
|---|---|---|
| **A. 让这台 iPhone 能用** | S1 补丁（已落地）/ S2 `/lite/` 轻量页 | 不需要为一个页面换框架 |
| **B. 长期摆脱 Flutter Web 的浏览器基线** | 换框架（Vue 3 推荐）+ 渐进替换 | 需要，但分期做 |

如果是 A，重构是杀鸡用牛刀；如果是 B，重构值得立项，但要用渐进式替换而不是停机重写。

---

## 三、核心判断：白屏不是框架的错

| 事实 | 推论 |
|---|---|
| 根因是 `flutter_bootstrap.js` 用 `WebAssembly.compileStreaming(fetch(canvaskit.wasm))` 且无回退 | 只要产物是**纯 DOM + 普通 JS**，任何框架都能跑 |
| 真机探针实测：动态 `import()` 支持、`?.` 支持、`??=` 支持、WebAssembly 基础支持、WebGL 1.0 支持 | Safari 14.1 能跑 ES2020 语法与原生 ESM |
| **Vite 官方文档**：默认目标 = 原生 ESM / 动态 import / `import.meta`，**Safari >=14**；`build.target` 最低 `es2015` | Vue / React / Svelte + Vite 在语法层面**天然兼容 iOS 14.8** |
| **Vue 官方 FAQ**：3.x 只支持原生 ES2016（主要是 `Proxy`）浏览器；Safari 10+ 即有 | Vue 3 不会成为新的版本墙 |
| 真机缺的是 `compileStreaming` / WebGL2 / WASM GC / `structuredClone` / OffscreenCanvas | 新前端只要**不碰 WASM/WebGL/新 Web API**，就没有对应的坑 |

**反过来说**：换成 Vue 或 React 却仍引一个依赖 WASM/WebGL 的图表库、或用默认 `esnext` target 不设降级，照样白屏。**决定兼容性的是「构建目标 + 渲染方式」，不是框架名字。**

---

## 四、重构的真实成本（实测代码量）

| 项 | 数量 | 说明 |
|---|---|---|
| Dart 文件 / 总行数 | **60 个 / 13,993 行** | 全部重写，无自动转换路径 |
| 页面（screens） | **28 个** | 认证 2、账户 4、记录 4、流水 3、设置 6、报表 1、仪表盘 1、成员/分类/币种/导入导出等 |
| 通用 widgets | 14 个 / 2,189 行 | 含图表、金额、标签、恒等式提示条等 |
| 离线优先内核 | **675 行**（`sync_service.dart` 305 + `local_store.dart` 370） | append-only 同步协议、水位增量、待推队列、自然键合并、uuid 重映射 —— **最容易出错、必须重写且必须重写对** |
| API 客户端 | 1,164 行 / 4 文件 | 但协议已有，可直译 |
| 图表 | 4 处 `fl_chart` | 需换 ECharts / Chart.js 的 **Canvas 2D** 版本（不用 WebGL） |
| 响应式双布局 | `>1024 PC 侧边栏 / <1024 移动底栏` | 用 CSS 媒体查询比 Dart 更简单，这项反而省事 |
| 现有前端测试 | 6 文件 / 33 用例 | 全部重写为 JS 测试；且 **CI 目前只跑 `go test`，不跑 `flutter test`**，新前端必须补 CI 门禁 |
| 构建链 | Dockerfile 内 Flutter 3.35.1 + 本机 3.38.9 | 换成 Node + Vite 后要改镜像、`pubspec.lock` 版本差问题一并消失 |

**可复用的资产（重要利好）**：
- **后端 31 个 REST 端点零改动**，账核、Beancount 导出、同步协议、鉴权全保留 —— 硬约束不破。
- `internal/server/static.go:66-74` 实测：**请求目录时自动尝试该目录下的 `index.html`** → `/lite/` 放一个 `index.html` 就能直接被 Go 后端托管，**零后端改动**。
- `docs/prototype/` 下 **4 份 HTML 高保真原型共 2,528 行**（含 PC / 移动 / 移动 v2），自带 CSS 与交互脚本，可直接拆成 Vue 组件的样式底稿，比从 Dart widget 反推快得多。
- 设计决策、PRD、验收文档齐全（`redesign-plan.md` / `redesign-prd.md` / `redesign-acceptance.md` 等），需求侧不用重新澄清。

---

## 五、框架对比与推荐

| 框架 | iOS 14.8 | 产物体积 | 与现有 HTML 原型距离 | 单人开发效率 | 结论 |
|---|---|---|---|---|---|
| **Vue 3 + Vite** | ✅ 官方只要求 ES2016；显式 `build.target: 'es2015'` | 几十~几百 KB | **最近**（SFC 模板就是 HTML） | 中文资料最多、Pinia/Vue Router/ECharts 齐全 | **✅ 推荐** |
| Svelte 5 | ✅ 编译成无运行时 vanilla JS | 最小 | 较近 | 生态与中文资料弱，单人踩坑成本高 | 备选，更极致但不必 |
| React 18 + Vite | ✅ 只要求 ES2015 | 中 | 远（JSX ≠ HTML） | 生态最大但样板代码多 | 不推荐（本项目收益不抵成本） |
| 原生 ES2017 / Alpine.js / htmx | ✅ 100% | 最小 | 最近 | 无响应式抽象，28 页面会写成面条 | 只适合 `/lite/` 单页切片 |
| Flutter 降级 3.27 HTML renderer | ⚠️ 理论可行 | 大 | — | Dart 3.10→3.6 回退、`pubspec.lock` 与 Docker 3.35.1 冲突 | ❌ 不算换框架，且引爆版本链 |
| React Native / Capacitor / Ionic | ❌ 原生需 Mac；WebView 仍是系统 WebKit 14.1 | — | — | — | ❌ 不解决问题 |

**推荐 Vue 3，理由按权重排序**：① 兼容边界最确定（官方 ES2016，Vite 默认已含 Safari 14）；② 与现有 4 份 HTML 原型同构，复用成本最低；③ 老板一个人全栈，中文生态与组件库能省最多时间；④ Vite 的 `build.target` 是显式可控的单一开关，不依赖框架内部黑盒。

**但要写进工程约束**：`build.target: 'es2015'`、禁用 WASM/WebGL 依赖、图表用 Canvas 2D、禁用 `structuredClone` 等未支持 API、上线前在真机 Safari 14.1 跑一次冒烟。

---

## 六、推荐路线：渐进式替换，不要停机重写

```
阶段 0（已在手，10 分钟）  S1 补丁真机探针
   └─ 成功 → 白屏收口，重构转为「长期优化」独立立项，不赶进度
   └─ 失败 → 进阶段 1

阶段 1（切片验证）  /lite/ 用 Vue 3 写最小可用集
   范围：登录 / 记一笔（简化模式）/ 流水 / 余额 4 个页面
   技术：Vue 3 + Vite + Pinia + hash 路由（createWebHashHistory，见下）
   部署：frontend/build/web/lite/index.html，Go 后端原生支持目录 index
   验收：iOS 14.8 Safari 真机四个页面可用 + bean-check 无回归 + 老 Flutter 版不受影响

阶段 2（逐页替换）  按流量与风险从低到高迁
   设置/成员/币种/分类 → 报表/仪表盘 → 账户 → 记录（双录）→ 离线同步
   两版并行、按路径分流，随时可回滚

阶段 3（内核迁移）  重写 sync_service / local_store
   这是风险最高的一块：水位、幂等、自然键合并、uuid 重映射必须逐条对齐
   用后端现有 /api/sync/pull|push 做契约测试，不靠人工点

阶段 4（下线 Flutter）  改 Dockerfile 为 Node 构建、CI 加前端测试门禁、清 Dart 目录
```

**为什么不用 big-bang**：账本应用的错误是静默的（上一轮刚修过净值符号问题），一次性重写最容易在金额口径、符号约定、期初交易标记这些地方引入难以察觉的偏差。分片替换每步都有旧版可对照。

---

## 七、API 变更范围（列计划必附）

| 类型 | 内容 | 是否必须 |
|---|---|---|
| 新增业务端点 | **0 个**。31 个现有 REST 端点全复用，请求/响应结构不变 | — |
| 静态托管 | `/lite/` 目录 index.html 已被 `static.go` 原生支持，**0 改动** | — |
| SPA 子路由回退 | 现有逻辑把「无扩展名且未命中」一律回退到**根** `index.html`（Flutter 首页），会吞掉 `/lite/xxx`。**用 hash 路由即可完全绕开**；若坚持 history 模式，需加 1 处前缀判断 | 可避开 / 可选 1 处 |
| CORS | 当前 `Access-Control-Allow-Origin: *`（`middleware.go:18`）。两套前端并存时应收敛为显式来源白名单 | 建议（安全债） |
| 缓存头 | 现有 `setStaticCacheHeaders` 按「文件名是否带 hash」区分。Vite 产物带 hash → immutable，`/lite/index.html` → no-cache 已覆盖；需实测确认 | 需验证 |
| 令牌存储 | 新版**禁止 localStorage**（沿用项目现有实现会继承风险）；建议内存 + `sessionStorage`，或推动后端改 httpOnly Cookie + CSRF | 建议 |
| 静态资源 MIME / 安全头 | 沿用现有 `serveStatic`，无需改 | — |

**账核硬约束不变**：Beancount 复式账、每笔借贷平衡、`bean-check` 必须过、`assets+expenses+liabilities+income+equity=0`、append-only 不可变交易 —— 重构不触碰这些。

---

## 八、关键风险

| 编号 | 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|---|
| RK-01 | 一次性重写引入金额/符号口径偏差，静默错账 | 高 | 致命 | 分片替换、每片与旧版对账、恒等式校验卡、导出 bean-check 回归 |
| RK-02 | 离线同步协议重写出错，离线记账数据丢失或重复 | 中 | 致命 | 阶段 3 单列，用 `/api/sync/*` 契约测试 + 自然键合并逐条对齐 |
| RK-03 | 两套前端并行维护，需求要改两遍 | 高 | 中 | 冻结 Flutter 版功能，只修 bug；新功能只进 Vue 版 |
| RK-04 | 新前端引入 WASM/WebGL 依赖或 target 没降级，白屏重演 | 中 | 高 | `build.target: 'es2015'` 写进 CI 校验 + 真机 Safari 14.1 冒烟门禁 |
| RK-05 | 33 个前端测试重写后 CI 仍不跑前端 | 中 | 中 | workflow 的 verify job 补 `npm test` / `npm run build`，别重蹈覆辙 |
| RK-06 | 图表库吃 WebGL2 或 `structuredClone` | 中 | 中 | 明确选 Canvas 2D 渲染的 ECharts/Chart.js 版本，禁用新 Web API |
| RK-07 | 工期与单人精力：13,993 行 + 后端 + 设计全由老板一人 | 高 | 高 | 先切片验证收益再决定要不要全量，避免半途而废留下两套半成品 |

---

## 九、待老板拍板（5 个决策点）

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 目标是 A（这台手机能用）还是 B（长期换掉 Flutter Web）？ | **先 A 后 B**：A 用 S1/S2 收口，B 另立项不赶进度 |
| 2 | 是否接受「渐进式替换」而非一次性重写？ | **是**，风险与可回滚性都更好 |
| 3 | 框架选 Vue 3 吗？ | **是**，理由见第五节；Svelte 作为备选 |
| 4 | `/lite/` 首个切片范围是否就是「登录 / 记一笔 / 流水 / 余额」？ | **是**，最小可验证闭环；离线同步放最后一期 |
| 5 | 是否同意把「最低 Safari 14.1 / `build.target: es2015` / 禁用 WASM-WebGL」写进 README 与 AGENTS.md？ | **是**，把兼容基线固化，避免下次再踩 |

另：上一轮提到的 `apple-mobile-web-app-capable` 缺一行、`CORS: *`、CI 不跑前端测试，这三件都可以在阶段 1 顺手收掉。

---

## 十、本轮证据清单

- 本地实测：`find frontend/lib`（60 文件 / 13,993 行）、按目录行数分布、28 个 screen 清单、`fl_chart` 4 处、`sync_service.dart` + `local_store.dart` 675 行、`router.go` 31 个端点、`internal/server/static.go:60-85` 目录 index 与回退规则、`docs/prototype/` 4 份 HTML 共 2,528 行、CI workflow 仅 `go test`
- 官方资料：Vite Building for Production（默认 Safari >=14、`build.target` 最低 es2015、不含 polyfill）、Vue 3 FAQ（只支持原生 ES2016 浏览器）
- 真机数据：`compat.html` 回报 iOS 14.8 / Safari 14.1.2，动态 import / `?.` / `??=` 支持，`compileStreaming` / WebGL2 / WASM GC 不支持

> 合规声明：本方案为产品设计参考，具体实施请结合公司合规与法务要求确认。
