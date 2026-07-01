# SillyTavern-ChatUI · Roadmap

Last updated: 2026-07-01

三份文档的分工:`DESIGN.md` = 产品北极星(目标形态)、`STATUS.md` = 当前实现快照、
**本文 = 完整度地图 + 剩余工作的优先级排期**。架构记录见 `ARCHITECTURE.md`。

---

## 短期计划(2026-07-01 ~ 2026-07-07)

前提:TS/Vite 大迁移已落地,`strict` 已恢复,`process.env.NODE_ENV`
浏览器 bundle 修复已提交;2026-07-01 的手动 smoke test 看起来正常。

### ~~1. 迁移尾巴 / 文档固化(2026-07-01)~~ ✅

- 已把 Vite build warning、`pnpm run build` vs `pnpm run runtime`、软链目标、
  `CI=true pnpm ...` 非交互运行方式写入 `README.md` / `STATUS.md`。
- 已明确当前 runtime 链路:`src/` → `dist/runtime` + `dist/root-app.mjs` →
  `.runtime/SillyTavern-ChatUI` → SillyTavern third-party symlink。

### ~~2. 产物检查脚本(2026-07-02)~~ ✅

- 已新增 `scripts/check-runtime.mjs`,阻止 `dist/` / `.runtime/` 残留:
  `@st/*`、`process.env`、错误绝对 import、明显的浏览器不可用 Node global。
- 已接入 `pnpm run runtime` 末尾;也可单独跑 `pnpm run check:runtime`。

### 3. 构建脚本整理(2026-07-03)

- 拆小 `scripts/build.mjs`:runtime build、UI build、ST external rewrite、
  browser define 分开命名。
- 保持当前行为不变,只降低维护成本;不引入没用到的 `vite.config.*`。

### 4. Adapter 类型边界收窄(2026-07-04 ~ 2026-07-05)

- 优先收 `src/adapter/chats.ts`、`media.ts`、`messages.ts` 的显式 `any`。
- 目标不是一次性全类型化 ST,而是给 ChatUI 输出 DTO 和输入参数建立本地类型。

### 5. 回归清单落地(2026-07-06)

- 写手动 checklist:加载、切角色、切对话、新对话/tempChat、发送、编辑、
  删除、settings drawer、附件、QR、selector、手机侧栏/settings。
- 当前 smoke test 通过先记为人工结果;后续再考虑自动化。

### 6. 产品缺口重启(2026-07-07)

- 回到 §7 config deepening:选择框槽位可配、＋菜单拖拽排序编辑器。
- 同时挑一个剩余 `#options` 写路径(continue / impersonate / regenerate / stop)
  做 adapter/export 化试点。

## 完整度快照(对照 DESIGN 五大区)

| 区域 | 状态 | 已落地 | 还缺 |
|---|---|---|---|
| **地基** 架构重写 | ✅ ~完成 | shield→adapter→store→Preact 四层、旧 Phase1/2 清理、增量 store、流式实时、toast 层;**写路径加固**(delete/swipe 已迁到 ST 导出函数)、**滚动守卫**(贴底才跟、不打断看历史)、adapter 拆分 + store pub-sub 工厂 | 剩余模拟点击写路径迁移、浏览器回归脚本化 |
| **①② 顶栏** | 🟢 ~72% | **M-B**:☰ 召唤侧栏、动态标题(绑 chatHeader)、选择框槽 A(人设)、顶栏右 ⋯(重命名/删除,群聊态自动禁用;操作目标已捕获防串 chat) | ★ 收藏、管理聊天文件/转群聊(均缺 adapter 导出)、手机【返回】 |
| **③ 内容区** | 🟢 ~92% | 角色整宽/用户气泡、操作行、思考块换皮、内联编辑、媒体、swipe `‹n/m›`、代码复制、回到底部钮;**M-D 收尾**:身份标头 3 档可配(群/单各一套)、代码块语言名头、生成回复钮、用户消息平铺全显菜单 | 代码块语言名头仅对声明围栏(自动检测不显,符合预期) |
| **④ 输入框** | 🟢 ~90% | ＋菜单(置顶磁贴 + 工具列表 + wand 动态)、textarea、选择框 B、发送/停止、附件 chips;**M-C**:QR 悬浮条(镜像 #qr--bar,含 popout)、单/多行切换;**M-F**:＋菜单**置顶磁贴编辑器**(配置面内,封顶 4) | ＋菜单**拖拽排序**编辑器、批量删除磁贴(待 ChatUI 自有多选 UI) |
| **⑤ 侧栏导航中心** | 🟢 ~88% | **M-G**:Codex-app TWO-PANE `Sidebar | chat`;左栏为 ＋新对话 tab → 角色分组会话列表(单角色归属、每角色最多 5 条、末条预览、按角色最近会话排序)→ 设置;settings 是 two-pane mode swap(左 nav/返回 + ST drawers + ChatUI 区,右 live ST drawer/ChatUI 设置);新对话改 `tempChat` 草稿生命周期,替代旧 metadata/消息数启发式 | 群聊对话列表、手机适配、搜索 🔍、Mode B 更完整的全局视图 |
| **配置系统**(§7 十项) | 🟢 ~68% | **薄地基**(M-E)+ 标头群/单两套(M-D)+ 单/多行(M-C);**M-F** 迁入四项 select + 首个 §7 编辑器(＋菜单置顶磁贴);**M-G** 退役第三列 ConfigPanel,改为 settings mode swap 并用 embed engine move-not-clone 托管 ST live drawer + precise restore | §7 剩余项、选择框槽位可配、＋菜单拖拽排序、其余编辑器 |

**毛估**:北极星完整度 ≈80%;"能当日常聊天用"体感 ≈90%(已 live-test:删除/swipe/滚动/布局/配置面持久化/ST drawer POC + M-G review fixes)。

---

## 已完成

- **地基**:原"重排 ST 原生 DOM"方案退役,改为 Preact 自渲染(shield 把原生 `#chat`/`#send_form` 移出屏幕只作回退面)。四层边界:UI → `actions` → `chat-actions` → adapter;adapter 是唯一碰 ST 内部的模块。
- **第 1 期 输入框**(主干):composer + ＋菜单 + 选择框 chips + 附件 chips。
- **第 2 期 内容区**(主干):消息流、操作行、思考块、编辑、媒体、swipe、代码复制。
- **第 3 期 侧栏导航中心 = M-A 全部 5 刀**(Phase 3 Slice 1-5):对话列表(模式 A) → 角色切换 → 重命名/删除 → 上段配置 rail → 三形态常驻侧栏 + 响应式。
- **B/D**:store 增量更新 + 流式实时。**H1**:ChatUI 自有 toast 反馈层。
- **本次会话 · 加固 + 体感修复**:
  - delete → ST `deleteMessage(id, swipeIdx, confirm)`(复刻原生确认/单 swipe 删除语义)、swipe → ST `swipe(null, dir, {forceMesId})`,**退役模拟点击**。
  - 补订阅 `MESSAGE_DELETED`(修删除后列表不刷新的现存 bug)。
  - `useAutoScroll`:贴底守卫 + **回到底部钮**;以 `chatKey` 判断换对话(替掉脆弱启发式)。
  - swipe 控件解锁(最后一条 AI 消息总能翻)+ **补渲染 `n/m` 计数**。
  - **核心布局重构**:只让消息列表内部滚,topbar/输入框固定 —— 修"长对话输入框消失"。
- **2026-06-27 · 并行 review stabilization**:
  - lint 修复:`adapter/settings.js` 中 `AI 格式化` entry 的属性间隔错误已修正,focused ESLint 通过。
  - settings embed-engine 加固:`mountStDrawer`/`unmountStDrawer` 快照 live drawer / icon / drag-grabber 状态,失败时 parking,不再失败后误删 restore 记录;`StDrawerHost` 只在 adapter 确认 restore 后清 mounted flag。
  - sidebar/chat 一致性修复:charGroups full rebuild 与 targeted patch 分 token,当前角色强制纳入最近列表,`isCurrent` 同时校验 owner+file,删除按目标 avatar 刷新并确认文件消失,跨角色打开 chat 失败会回滚预写。
  - UI 状态隔离:message edit/key 加 `chatKey`,Topbar rename/delete 捕获目标,移动端导航后关闭 sidebar,selector refresh 加 stale guard,teardown 清 toast timers。
  - 统一验证:direct `tsc --noEmit`、`build`、`runtime`、focused ESLint、`node --check`、dist/runtime bundle hash 均通过。
- **M-G · TWO-PANE sidebar/settings + tempChat 草稿生命周期**(2026-06-28, just-landed/uncommitted):
  - 退役旧"三形态循环 + 配置 rail"和第三列 ConfigPanel;当前 shell 是 `Sidebar | chat`,settings 作为 mode swap 接管两 pane。
  - settings 左 pane 是返回 + ST drawers(默认顺序,含角色管理)+ ChatUI 区;右 pane 通过 embed engine move-not-clone 托管 live ST `.drawer-content`,并 precise restore。
  - sidebar 内容固定为 ＋新对话 → 角色分组会话列表 → 设置;角色 header 不高亮,＋新对话在草稿激活时作为 tab 高亮。
  - 新增 `store/temp-chat-store.js`:localStorage `chatui:tempChat` 的 `{avatar,fileName}` 指针,替代 `chat_metadata.chatui_isNewChat` / 消息数 freshness / navigation-time GC。草稿始终从列表隐藏;创建永远 `doNewChat`;替换时安全删除上一草稿;发送或编辑首楼即清指针并保留会话。
  - Codex adversarial review 修 3 个真问题并通过 browser live-test:topbar destructive target 改用权威 chat identity 并二次校验、temp-draft 创建串行化、群聊态 ＋新对话 disabled/inert。

---

## 剩余工作(按优先级 · 已按 价值/成本 + 避免返工 重排)

> 排序依据:分支已 live 但写路径刚加固,先求"可信赖"再堆功能;配置系统(M-E)是横切地基,**早落薄地基**以免后续 M-C/M-D 塞进更多硬编码默认、造成复利返工。

### 0 · live-test 收尾(进行中)
本次已测:删除、swipe、滚动、布局、配置面持久化、ST drawer hosting POC;M-G review fixes 的 browser pass 已覆盖 topbar destructive target 二次校验、temp-draft 创建串行化、群聊态 ＋新对话 inert。**仍欠**:续写/代笔/重生成(走 `#options` 模拟点击,最可能哑火)、停止、手机侧栏/settings 回归。

### ~~M-E · 配置系统**薄地基**~~ ✅ 已落地(commit `abf212f`)
地基已立:`config-store`(createStore 工厂)+ `adapter/config.js`(ST extension_settings 往返)+ 设置面 select 双向同步。首个真功能 **侧栏三形态记忆** 曾用于 M-A 常驻侧栏,已随 M-G two-pane sidebar 退役;config-store 地基保留。**单/多行开关** 留给 M-C(与输入框同刀做),§7 其余九项随各自归属 milestone 落。

### ~~M-D · 内容区收尾~~ ✅ 已落地(commit `50cb5e6`)
四项全做:生成回复钮(`lastMessageNeedsGenerate` → regenerate)、用户消息**平铺全显**菜单(DESIGN §5.C)、代码块语言名头(声明围栏)、身份标头 3 档可配(群/单各一套,§5.A)。经 4 视角对抗审查 + 逐条验证,修了 5 个真问题(生成钮收口到 isUser、代码块 padding 改 CSS `:has()` 去抖、菜单平铺全显对齐 DESIGN、类型对齐 SidebarForm 模式)。

### ~~M-C · 输入框收尾~~ ✅ 已落地(commits `f1c4d6b`/`e9e8185`/`4d8bb48`)
QR 悬浮条(镜像 `#qr--bar`,含 popout 模式)、单/多行切换(吃 config 地基)、＋菜单**基础**(配置驱动置顶磁贴 + 工具列表)。**拖拽/置顶/开关编辑器**仍延后(依赖 §7 独立配置面);批量删除磁贴撤下(需 ChatUI 自有多选 UI,ST 删除模式的勾选在被 park 的 `#chat` 里)。

### ~~M-B · 顶栏右 + 选择框槽 A~~ ✅ 已落地(commit `6f2fa01`)
动态标题(绑 sidebar-store header)、顶栏右 ⋯(重命名/删除/＋新对话,群聊态自动禁用)、选择框槽 A(人设移顶栏,预设+模型留输入框)。**转群聊 / 管理聊天文件先放**(adapter 无导出)。

> M-C + M-B 经一轮 4 视角对抗审查(21 raw → 12 真)+ 逐条验证,修了 9 个(撤批量删除、群聊禁用重命名/删除、QR popout、标头去重、单行选择框弹窗方向、顶栏窄屏溢出等),commit `25b5620`。

### ~~M-F · 独立配置面(独立配置面)~~ ✅ 已落地(commit `d7a6025`)
ChatUI 自有设置面第一版:桌面**贴边推开列**(`Sidebar | ConfigPanel | 主区`,主区收缩不被遮)/ 手机**全屏接管**;该第三列 ConfigPanel 模型已在 M-G 被 settings mode swap 取代。开关态走新 `store/ui-store.js`(极简非持久 store,解耦触发器与面板)。四项 select(侧栏形态/群单标头/输入框行数)从 ST 抽屉**迁入**应用内(声明式 `ConfigSelect`,退役 `optionsHtml`/`bindConfigSelect`),ST 抽屉只留主启用开关。落地**首个 §7 编辑器**:＋菜单置顶磁贴编辑器(封顶 4)。`PlusMenu` 的 `PLUS_TOOL_META` 改由 `PLUS_TOOL_IDS`(config-store)派生 —— 菜单/编辑器/持久化单一来源。经 Codex 对抗审查修 1 个真问题:**在 config-store 收口** `normalizePlusPinned`(读写都过:已知 id + 去重 + 封顶),杜绝脏 `plusPinned` 锁死编辑器。

### 长尾
手机适配(侧栏/settings transitions + 返回)、群聊列表、搜索 🔍、Mode B、选择框槽位可配、＋菜单拖拽排序编辑器、★ 收藏开关(需新 adapter 导出)、swipe 手势。

---

## 阻塞项 / 技术债

- ~~swipe/delete 从模拟点击切到 ST 导出函数~~ —— **已完成**。
- ~~adapter 上帝模块(1321 行)拆分 + store 的 pub-sub 工厂化~~ —— **已完成**(commit `8b8e203`:adapter 拆为 8 子模块 + `createStore` 工厂,行为不变)。
- 剩余 `#options`/抽屉等 **模拟点击写路径**(22 处)迁到 ST 导出 —— 待 live-test 确认导出可用后再迁(见 §0)。
- `content-visibility` 双重渲染优化 —— 等火焰图看实际性能。
- 人设 chip 懒加载 —— 现每次 selector-sync 都拉 `getUserAvatars`,小优化。

---

## 当前分支

`cleanup/remove-legacy-phase12`(main 仍在基线 `c97d8c2`)。已提交至 `e0d4199`;当前 M-G two-pane + tempChat work 仍在工作区,准备下一次提交:
`8b8e203`(写路径加固 + adapter 拆分 + store 工厂)→ `abf212f`(M-E 配置薄地基)→ `50cb5e6`(M-D 内容区)→ `6f2fa01`(M-B 顶栏)→ `f1c4d6b`/`e9e8185`/`4d8bb48`(M-C 输入框)→ `25b5620`(M-B/M-C 审查修复)→ `d7a6025`(M-F 独立配置面 + 对抗审查修复)→ `e0d4199`(M-G S0 settings embed-engine POC checkpoint)。
`e0d4199` 之后的当前未提交工作区完成 M-G:two-pane sidebar/settings shell、`tempChat` 草稿生命周期,以及 3 个 Codex adversarial-review fixes(topbar avatar/file mismatch、temp-draft creation serialization、group-chat New Chat inert)。
**五大区主干已闭环,settings 已转为 two-pane mode swap,独立配置面已解锁 §7。** 下一阶段重心:提交 M-G、手机适配、§7 深化(选择框槽位 / ＋菜单拖拽排序)、剩余模拟点击写路径迁移。
