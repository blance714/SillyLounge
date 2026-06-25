# SillyTavern-ChatUI · Roadmap

Last updated: 2026-06-25

三份文档的分工:`DESIGN.md` = 产品北极星(目标形态)、`STATUS.md` = 当前实现快照、
**本文 = 完整度地图 + 剩余工作的优先级排期**。架构记录见 `ARCHITECTURE.md`。

---

## 完整度快照(对照 DESIGN 五大区)

| 区域 | 状态 | 已落地 | 还缺 |
|---|---|---|---|
| **地基** 架构重写 | ✅ ~完成 | shield→adapter→store→Preact 四层、旧 Phase1/2 清理、增量 store、流式实时、toast 层;**写路径加固**(delete/swipe 已迁到 ST 导出函数)、**滚动守卫**(贴底才跟、不打断看历史) | adapter 上帝模块拆分 + store pub-sub 工厂(Codex 进行中) |
| **①② 顶栏** | 🔴 ~12% | ☰ 召唤侧栏 + 标题(写死 'ChatUI') | 选择框槽 A、**顶栏右整块**(对话操作 + ⋯ 更多:管理聊天文件/转群聊)、★、动态标题、手机【返回】 |
| **③ 内容区** | 🟢 ~92% | 角色整宽/用户气泡、操作行、思考块换皮、内联编辑、媒体、swipe `‹n/m›`、代码复制、回到底部钮;**M-D 收尾**:身份标头 3 档可配(群/单各一套)、代码块语言名头、生成回复钮、用户消息平铺全显菜单 | 代码块语言名头仅对声明围栏(自动检测不显,符合预期) |
| **④ 输入框** | 🟢 ~70% | ＋菜单(内置+wand 动态)、textarea、选择框 B、发送/停止、附件 chips | **QR 悬浮条**、**单/多行切换**、＋菜单**配置** |
| **⑤ 侧栏导航中心** | 🟢 ~72% | **Mode A 单角色导航中心全通**:切角色 / ＋新对话 / 重命名 / 删除 / 打开 —— 全部接 ST 真导出函数(非桩);桌面三形态(①横列表/②方块/③纯icon)、手机覆盖式滑出、上段配置 rail | Mode B 全局列表、群聊对话列表、**配置贴边浮层**(b)/modal、手机全屏 tab + 返回、搜索 🔍 |
| **配置系统**(§7 十项) | 🟡 ~25% | **薄地基**(M-E)+ **身份标头 群/单两套**(M-D):`config-store`(createStore 工厂)+ `adapter/config.js` 往返 + 设置面三个 select 双向同步;侧栏三形态记忆、群/单聊标头档位均已持久化 | §7 其余八项(硬编码默认)、独立(非内联)设置面、单/多行开关 |

**毛估**:北极星完整度 ≈52-57%;"能当日常聊天用"体感 ≈80%(已部分 live-test:删除/swipe/滚动/布局)。

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

---

## 剩余工作(按优先级 · 已按 价值/成本 + 避免返工 重排)

> 排序依据:分支已 live 但写路径刚加固,先求"可信赖"再堆功能;配置系统(M-E)是横切地基,**早落薄地基**以免后续 M-C/M-D 塞进更多硬编码默认、造成复利返工。

### 0 · live-test 收尾(进行中)
本次已测:删除、swipe、滚动、布局。**仍欠**:续写/代笔/重生成(走 `#options` 模拟点击,最可能哑火)、停止、切角色/新建/重命名/对话删除全链路。

### ~~M-E · 配置系统**薄地基**~~ ✅ 已落地(commit `abf212f`)
地基已立:`config-store`(createStore 工厂)+ `adapter/config.js`(ST extension_settings 往返)+ 设置面 select 双向同步。首个真功能 **侧栏三形态记忆** 已持久化(过去每次 mount 重置成 'list')。**单/多行开关** 留给 M-C(与输入框同刀做),§7 其余九项随各自归属 milestone 落。

### ~~M-D · 内容区收尾~~ ✅ 已落地(commit `50cb5e6`)
四项全做:生成回复钮(`lastMessageNeedsGenerate` → regenerate)、用户消息**平铺全显**菜单(DESIGN §5.C)、代码块语言名头(声明围栏)、身份标头 3 档可配(群/单各一套,§5.A)。经 4 视角对抗审查 + 逐条验证,修了 5 个真问题(生成钮收口到 isUser、代码块 padding 改 CSS `:has()` 去抖、菜单平铺全显对齐 DESIGN、类型对齐 SidebarForm 模式)。

### M-C · 输入框收尾
**QR 悬浮条**优先(复用 ST `#qr--bar`,无配置依赖)、单/多行切换(用 M-E 的开关持久化)、＋菜单配置(置顶磁贴/开关/拖拽 —— 最重,压最后,依赖 M-E 设置 UI)。

### M-B · 顶栏右 + 选择框槽 A
只做 adapter 已有能力的:顶栏右 ⋯ 菜单接现成 rename/delete/new、SelectorChip 支持槽位 A、标题绑 `getCurrentChatHeader()`。**转群聊 / 管理聊天文件先放** —— adapter 没有对应导出,是 M-B 真正的成本中心。

### 长尾
配置贴边浮层(§2.2 (b)/modal)+ 手机全屏 tab+返回(M-A 最大 UX 缺口)、群聊列表、搜索 🔍、Mode B、＋菜单拖拽配置、★ 收藏开关(需新 adapter 导出)、swipe 手势。

---

## 阻塞项 / 技术债

- ~~swipe/delete 从模拟点击切到 ST 导出函数~~ —— **已完成**。
- ~~adapter 上帝模块(1321 行)拆分 + store 的 pub-sub 工厂化~~ —— **已完成**(commit `8b8e203`:adapter 拆为 8 子模块 + `createStore` 工厂,行为不变)。
- 剩余 `#options`/抽屉等 **模拟点击写路径**(22 处)迁到 ST 导出 —— 待 live-test 确认导出可用后再迁(见 §0)。
- `content-visibility` 双重渲染优化 —— 等火焰图看实际性能。
- 人设 chip 懒加载 —— 现每次 selector-sync 都拉 `getUserAvatars`,小优化。

---

## 当前分支

`cleanup/remove-legacy-phase12`(main 仍在基线 `c97d8c2`)。已提交至 `50cb5e6`:
`bf72d9e`(Phase 3 全 5 刀)→ `8b8e203`(写路径加固 + 滚动/布局修复 + adapter 拆分 + store 工厂)→ `abf212f`(M-E 配置薄地基)→ `50cb5e6`(M-D 内容区收尾)。下一刀:M-C 输入框收尾(QR 悬浮条 → 单/多行 → ＋菜单配置)。
