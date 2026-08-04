# SillyTavern-ChatUI · Roadmap

Last updated: 2026-08-05

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

- `scripts/check-runtime.mjs` 现验证完整候选树:manifest JS/CSS 入口、所有
  static/dynamic/re-export 相对 import、唯一允许的 ST 越根 import、浏览器不可用
  Node global,以及 `.pnpm`/`node_modules`/本机绝对路径泄漏。
- `pnpm run runtime` 先 staging + 验证,再原子切 live release symlink;失败保留
  旧 runtime。`dev` 同路;`check:build` 只验候选、不改 live。

### ~~3. 构建脚本整理(2026-07-03)~~ ✅

- 已拆小 `scripts/build.mjs`:runtime build、UI build、ST external rewrite、
  browser define 分开命名。
- 保持当前行为不变,未引入没用到的 `vite.config.*`;重构前后产物 checksum 一致。

### ~~4. Adapter 类型边界收窄(2026-07-04 ~ 2026-07-05)~~ ✅

- 已收 `src/adapter/chats.ts` / `chats/`、`media.ts`、`messages.ts` 的显式 `any`。
- 已给 ChatUI 输出 DTO 和输入参数建立本地类型;未尝试一次性全类型化 ST host。

### ~~4.5 Adapter runtime schema / Zod 化(2026-07-05)~~ ✅

- 已引入 `zod`,把 `chats` / `media` / `messages` 的 ST raw input
  解析集中到 `src/adapter/schema.ts`。
- Zod 只停在 adapter 入站边界;UI/store 继续消费 ChatUI 自己的 DTO,不直接依赖
  ST schema。
- **2026-07-03 补强**(commit `9edc130`):初版每个字段都是 `z.unknown()`,
  只检查"是不是个对象",等于没校验,还因为 `safeParse` 克隆对象引入一个真
  bug——`openChatForCharacter` 跨角色开对话时改的是克隆体的 `.chat`
  字段,ST 读的是原对象,静默进错对话。已给三个 schema 补齐真实字段类型 +
  `z.catch()` 安全兜底(与之前手动 coercion 语义一致),新增 `_getLiveCharacter()`
  绕过校验层直接改活对象修好克隆语义 bug,顺手删掉 `chat-store.ts` 里重复的
  `_string`/`_numberOrNull`。

### 5. 回归清单落地(2026-07-06,部分完成)

- 写手动 checklist:加载、切角色、切对话、新对话/tempChat、发送、编辑、
  删除、settings drawer、附件、QR、selector、手机侧栏/settings。
- 已落 53 个 Node 内置 state/runtime/fixture/host-contract 测试并统一到
  `pnpm run verify`。
- 已固定 SillyTavern 版本并生成一次性合成用户/dataRoot；真实 Chromium smoke
  同时断言宿主状态、SillyLounge DOM、shield/composer 与楼层 hover，现已进入
  `main → dist` 发布门禁。广泛的手机/侧栏回归仍保留人工清单。

### 6. 产品缺口重启(2026-07-07)

- 回到 §7 config deepening:选择框槽位可配、＋菜单拖拽排序编辑器。
- 同时挑一个剩余 `#options` 写路径(continue / impersonate / regenerate / stop)
  做 adapter/export 化试点。

## 2026-07-11 Manuscript Flow 视觉复归

- title-page topbar 独立呈现角色 eyebrow 与会话题名，不再互相 fallback 覆盖。
- 发丝线拆为淡线、结构线、锈铜强调线；用户页边与当前篇目共用强调语法。
- 消息恢复长文阅读节奏，生成状态改为消息流末端的呼吸印玺。
- composer 恢复开放式账本横线、手记 placeholder 与轻箭头发送控制。
- 侧栏弱化联系人列表符号，回到安静的篇目索引。
- `DESIGN.md` 已改为可验收的 Manuscript Flow 唯一视觉真源。

## 2026-07-12 桌面楼层导航

- 阅读区左书脊新增 Codex 式用户回合刻度：只索引用户消息，`2px` 线高 / `6px`
  间距，距主区左缘 `16px`，短列表整体垂直居中。
- 浮层标题是用户原话，正文是下一条角色回复（剔除 reasoning/包装标签，三行截断）；
  点击和 slider 键盘操作跳到对应用户消息。
- 超量时按阅读区高度动态限窗，上下保留 `40px`；当前阅读到末端时窗口也停在
  末端，hover 后滚轮只翻刻度窗以浏览较早/较晚回合；滚动期间上下淡入当前窗
  首末用户回合编号，停止后自动淡出。
- topbar / 阅读流 / composer 共用 `54rem` 限宽；只有左侧真实书脊留白能容纳
  30px 波浪和正文间隔时才挂载，窄桌面不会覆盖内容。
- 仅在 `>768px` 且存在桌面指针时启用；移动端中置标尺/拖拽方案因防误触尚未
  定稿，明确延期而非移植 hover。

## 2026-07-15 固定宿主测试与 400 楼基线

- `test/e2e/st-version.json` 固定 SillyTavern `1.18.0` 的精确提交；生成器只写入
  新建空 dataRoot，产出合成角色、用户、设置和对话，并隔离宿主全局第三方扩展。
- Playwright smoke 在真实 Chromium 中执行宿主状态 + 可见 DOM 双重断言；失败时 CI
  上传 screenshot、trace、HTML report 与 SillyTavern stdout/stderr，失败会阻断
  `dist` 发布。
- `long-plain` 用声明式规则生成 400 个用户楼层/800 条普通消息；测量器轮换比较
  纯 ST、插件 bootstrap、完整 UI。五样本基线确认主要成本是全量 DTO/formatter/DOM，
  不是楼层 rail；详见 `PERFORMANCE.md`。
- 下一性能切片是“轻量全聊天索引 + 不定高虚拟消息窗口 + 稳定 DTO identity +
  rail scrollToIndex”。绝对耗时暂不在共享 CI 设硬阈值，避免把机器噪声当回归。

## 2026-07-10/11 已提交加固

以下架构加固已按语义拆分并提交到 `main`:

- **temp quarantine + 2026-07-11 修正**:7/10 先移除基于有损 `/get` 的猜测删除;
  7/11 将单 pointer 改为 per-conversation quarantine lease set。导航在真正进入 host
  lane 后才捕获 departing lease,所以能覆盖“new 尚未完成就点旧 chat”;无本地工作时
  只 deactivate、继续从普通历史隐藏,有草稿/发送/附件则 adopt。每个 lease 独立
  localStorage key 并用 storage event 跨 tab 同步;未完成草稿 shelf 可显式恢复,
  恢复前以 raw filename list 防止 ST 复活已缺失文件;dry-run/quiet generation 不 adopt。
- **手动删除分态确认**:破坏性请求始终携带 stable avatar + file name;用原始文件
  endpoint 做前/后确认并取消 chat/metadata 两类 timer。角色卡 pointer 写以
  `/api/characters/get` readback 为准,不信 transport 或 merge 2xx;删除当前 chat 前
  收敛 durable replacement,raw 确认 DELETE 后 seal queue + hard reload。reload 后才发
  cleanup event,versioned/absence-checked tombstone set 会跨后续 reload 幂等重试
  (上游 event 无 ack,多次删除也不会互相覆盖)。
- **rename 三元安全**:raw before/after 解 response loss 与 sanitized filename;pointer
  同样读回确认。current rename 最终证明 live filename 存在,否则持续恢复或 terminal
  reload 到真实 durable winner;native active rename 的 reload-before-event 也能迁 draft。
- **事务生命周期**:setup 按 `store → root → shield` 最后提交可见切换;失败逆序
  修复所有层。teardown 和 store subscription rollback 不因单个 cleanup 抛错中断。
- **typed chat locator**:`chat-key.ts` 用 character/group/none scope + session filename
  编码,避免名称碰撞并让 metadata-copy branch/checkpoint 保持 distinct;chat rename 与
  character rename 通过 CAS 迁移 draft/temp state,不再误把 `integrity` 当全局 ID。
- **统一 lifecycle mutation lane**:`host-operation-queue.ts` 串行化所有已知
  ChatUI chat-bound entry,入 ST 前复核 expected `chatKey`;未开始的旧导航被 supersede,
  可观察 completion 持有 lane,terminal reload 拒绝新旧任务,teardown epoch 取消旧队列
  工作。wand/QR 只能保证 click entry,第三方 async handler 没有 completion contract。
- **CAS + composer 双阶段**:temp pointer / optimistic draft 分别版本化;
  abandon/cancel/commit 只能改匹配版本。composer 草稿按 `chatKey` 持有,send token
  同时捕获 revision / lifecycle epoch;正常发送忽略裸 `MESSAGE_SENT`,只接受同 locator
  的 captured append index + `USER_MESSAGE_RENDERED` + user row,且不设超时;slash 还
  要求 native textarea 在 slash busy 下被清空的 ownership boundary,空续写等 full
  completion;独立 generation `completion` 结算前继续占住宿主 lane。
- **边界、粒度与 Query**:adapter 输出 immutable `MessageSnapshotDto`,store 不再解释
  raw ST message;每条消息独立订阅 DTO slot,streaming 的 rAF 刷新保持 O(1)。ST
  event → Query invalidation 矩阵补齐 update/delete/swipe;独立可测 bounded coordinator
  在 refetch 期间标 dirty 并只 requeue 一次;inactive first prefetch 等旧 promise 后直接
  `query.fetch()`,不被 React Query disabled filter 吞掉。
- **发布契约**:Zod 收口到稳定 `chunks/vendor/zod.js`;runtime staging 验证后原子
  发布;`verify` = typecheck + 53 Node tests + build + assembled-tree contract；真实
  Chromium smoke 通过后才允许更新 `dist`。
- **HTML card 信任模型不变**:unsandboxed iframe 是 TavernHelper/MVU 兼容所需,
  等价于运行受信任聊天代码;本轮不加 sandbox 或执行确认。
- **上游契约债**:ST 尚无 request-scoped textarea-send receipt;全局事件无法在真正
  并发 foreign user append 时证明调用归属。最终根修应由 host 返回一一对应的
  `{accepted, completion}`,本仓库当前采取保守匹配,不匹配就保留草稿。pointer
  merge 也缺 conditional write/idempotency token:transport ambiguous 时无法同时保证
  late commit 收敛与保留另一个 tab 的 winner;另缺 plugin click completion 与
  non-active native rename 的实际 sanitized target。

## 完整度快照(对照 DESIGN 五大区)

> 这张表描述的是**已合并的 `main`**,写在长廊剧场分支栈合并(2026-08-01,`b3d3bdb`)
> 之前,各行的「已落地」一列因此仍是旧形状:①② 顶栏、③ 内容区、⑤ 侧栏三行今天的
> 形状是书脊 + 场刊、统一操作条、swipe 刻度、topbar 就地改名。**「还缺」那一列不受
> 影响**——缺的仍然是缺的,只是又多了几条,统一记在下面的「长廊剧场收官 backlog」。
> 这张表本身仍欠一次重画(2026-08-05 复核时如实标注,而不是就地改一行冒充已重画)。

| 区域 | 状态 | 已落地 | 还缺 |
|---|---|---|---|
| **地基** 架构重写 | ✅ ~完成 | shield→adapter→store→Preact 四层、旧 Phase1/2 清理、增量 store、流式实时、toast 层;**写路径加固**(delete/swipe 已迁到 ST 导出函数)、**滚动守卫**(贴底才跟、不打断看历史)、adapter 拆分 + store pub-sub 工厂;**2026-07-10/11**:per-chat temp quarantine、stable-avatar 手动删除确认/分态、typed filename locator + rename migration、lifecycle mutation queue、composer revision/epoch + acceptance/completion、per-message O(1) streaming、Query dirty/requeue、typed snapshots、validated atomic runtime;**2026-07-15**:53 个 Node 测试 + 固定 ST/真实 Chromium 发布门禁 + 400 楼基线 | host request-scoped send receipt、server-side conditional temp delete、剩余模拟点击写路径迁移(降级为架构债,不阻塞)、手机回归脚本化、长对话不定高虚拟消息窗口 |
| **①② 顶栏** | 🟢 ~72% | **M-B**:☰ 召唤侧栏、动态标题(绑 chatHeader)、选择框槽 A(人设)、顶栏右 ⋯(重命名/删除,群聊态自动禁用;操作目标已捕获防串 chat) | ★ 收藏、管理聊天文件/转群聊(均缺 adapter 导出)、手机【返回】 |
| **③ 内容区** | 🟢 ~94% | 角色整宽/用户锈红页边、操作行、思考块换皮、内联编辑、媒体、swipe `‹n/m›`、代码复制、回到底部钮;**M-D 收尾**:身份标头 3 档可配(群/单各一套)、代码块语言名头、生成回复钮、用户消息平铺全显菜单;**2026-07-05**:HTML fenced card 挂载为同源 unsandboxed iframe(bootstrap 转发 TavernHelper/SillyTavern/Mvu),高度由 iframe 内部 ResizeObserver + postMessage 上报;unsandboxed 是明确兼容信任模型;**2026-07-12**:桌面用户回合刻度、user→reply 波形摘录、限窗滚轮与点击/键盘跳转 | 移动端防误触楼层导航待单独设计;代码块语言名头仅对声明围栏(自动检测不显,符合预期);TavernHelper 缺失提醒 toast 待做;当前契约下不把 sandbox/执行确认列为缺口 |
| **④ 输入框** | 🟢 ~90% | ＋菜单(置顶磁贴 + 工具列表 + wand 动态)、textarea、选择框 B、发送/停止、附件 chips;**M-C**:QR 悬浮条(镜像 #qr--bar,含 popout)、单/多行切换;**M-F**:＋菜单**置顶磁贴编辑器**(配置面内,封顶 4) | ＋菜单**拖拽排序**编辑器、批量删除磁贴(待 ChatUI 自有多选 UI) |
| **⑤ 侧栏导航中心** | 🟢 ~88% | **M-G**:Codex-app TWO-PANE `Sidebar | chat`;左栏为 ＋新对话 tab → 角色分组会话列表(单角色归属、每角色最多 5 条、末条预览、按角色最近会话排序)→ 设置;settings 是 two-pane mode swap(左 nav/返回 + ST drawers + ChatUI 区,右 live ST drawer/ChatUI 设置);新对话改 `tempChat` 草稿生命周期,替代旧 metadata/消息数启发式 | 群聊对话列表、手机适配、搜索 🔍、Mode B 更完整的全局视图 |
| **配置系统**(§7 十项) | 🟢 ~68% | **薄地基**(M-E)+ 标头群/单两套(M-D)+ 单/多行(M-C);**M-F** 迁入四项 select + 首个 §7 编辑器(＋菜单置顶磁贴);**M-G** 退役第三列 ConfigPanel,改为 settings mode swap 并用 embed engine move-not-clone 托管 ST live drawer + precise restore | §7 剩余项、选择框槽位可配、＋菜单拖拽排序、其余编辑器 |

**毛估**:北极星完整度 ≈80%;"能当日常聊天用"体感 ≈90%(已 live-test:删除/swipe/滚动/布局/配置面持久化/ST drawer POC + M-G review fixes)。

---

## 已完成

- **地基**:原"重排 ST 原生 DOM"方案退役,改为 Preact 自渲染(shield 以 `display:none` 隐藏原生 `#chat`/`#send_form`,DOM 仍作 runtime bridge)。四层边界:UI → `actions` → `chat-actions` → adapter;adapter 是唯一碰 ST 内部的模块。
- **第 1 期 输入框**(主干):composer + ＋菜单 + 选择框 chips + 附件 chips。
- **第 2 期 内容区**(主干):消息流、操作行、思考块、编辑、媒体、swipe、代码复制。
- **第 3 期 侧栏导航中心 = M-A 全部 5 刀**(Phase 3 Slice 1-5):对话列表(模式 A) → 角色切换 → 重命名/删除 → 上段配置 rail → 三形态常驻侧栏 + 响应式。
- **B/D**:store 增量更新 + 流式实时。**H1**:ChatUI 自有 toast 反馈层。
- **早期基础加固 + 体感修复**:
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
- **M-G · TWO-PANE sidebar/settings + tempChat 草稿生命周期**(commit `94c4df7`,2026-06-28):
  - 退役旧"三形态循环 + 配置 rail"和第三列 ConfigPanel;当前 shell 是 `Sidebar | chat`,settings 作为 mode swap 接管两 pane。
  - settings 左 pane 是返回 + ST drawers(默认顺序,含角色管理)+ ChatUI 区;右 pane 通过 embed engine move-not-clone 托管 live ST `.drawer-content`,并 precise restore。
  - sidebar 内容固定为 ＋新对话 → 角色分组会话列表 → 设置;角色 header 不高亮,＋新对话在草稿激活时作为 tab 高亮。
  - 新增 `store/temp-chat-store.js`,替代 `chat_metadata.chatui_isNewChat` / 消息数 freshness。2026-07-11 将 7/10 的 pointer-only 基线改为 per-conversation quarantine:草稿始终从普通列表隐藏;创建永远 `doNewChat`;导航在 host lane 内捕获并 deactivate lease,不做无法原子证明的后台 DELETE;任何消息 mutation 会 adopt,未完成草稿 shelf 提供恢复入口。
  - Codex adversarial review 修 3 个真问题并通过 browser live-test:topbar destructive target 改用权威 chat identity 并二次校验、temp-draft 创建串行化、群聊态 ＋新对话 disabled/inert。
- **侧栏迁移 TanStack Query + 渐进式加载**(commit `27d9bcb`,2026-07-01):
  侧栏 server-state 从自建 store 迁到 `@tanstack/react-query`(仅限 `ui/` 层,store 层不碰);角色分组懒加载(先 recents 后按需 backfill 全量)+ optimistic temp-chat draft(点击即时隐藏,不等 ST 落地)。经一轮 4-finding 对抗审查修正 placeholder/backfill/optimistic-draft 问题;2026-07-10 又为有界 active refetch 加 dirty/requeue,保证 in-flight 期间的新事件不会被旧响应吞掉。
- **全源码迁移 TypeScript + Vite**(commits `353beba`/`13af9bd`/`4c03f3d`/`84e9600`/`4f4a116`,2026-07-01):
  `adapter/`/`store/`/`ui/` 从 esbuild 时代的 `.js`/`.tsx` 整体搬到 `src/` 下并转 `.ts`,`tsconfig` 恢复 `strict`;构建从 esbuild 切到 Vite(`dist/runtime` 走 preserveModules,`dist/root-app.mjs` 单独打包);新增 `scripts/check-runtime.mjs` 拦截生成产物里的 `@st/*`/`process.env`/坏 import;`chats`/`media`/`messages` 的 adapter 边界收窄掉显式 `any`。
- **xhigh 对抗审查 + 修复**(commits `9edc130`/`be7c17f`,2026-07-03):
  对当时迁移 diff + 未提交 WIP 跑了一轮 10 角度对抗审查(31 agent、约 320 万 token),发现 14 个真问题,其中 1 个致命——`ui/` → `src/ui/` 目录迁移后 `root.ts` 的产物引用路径少算一层,构建出来的插件**完全无法挂载**,静态检查(`check-runtime.mjs`)测不出来,只有实际跑一遍构建才能复现。其余包括:`openChatForCharacter` 因 Zod 克隆语义静默进错对话、幽灵附件 chip、settings 面板开合后滚动状态失焦、`as any` 绕过配置写入校验、UI 层手抄 DTO 类型脱节、已删除模块残留,以及若干重复逻辑。全部修复后又跑了一轮独立的 15-agent 逐条对抗复核 + 回归扫描确认无遗留,实机 live-test 通过(角色切换比之前更快)。
- **卡片 iframe 渲染 + 消息级 HTML 缓存**(commits `d8f5d97`/`79bbff9`/`eb45558`/`075ca77`,2026-07-05):
  - 聊天消息里的完整 HTML fenced block 挂载为同源 unsandboxed iframe(bootstrap 脚本转发 `TavernHelper`/`SillyTavern`/`Mvu`/`EjsTemplate`/`YAML`/`showdown`/`toastr`/`z` 到 iframe 内);iframe 内部脚本自己用 `ResizeObserver` 观察 `body` 并 `postMessage` 上报高度,外部只管应用数字——避免了外部读 `documentElement.scrollHeight` 的两个坑:根元素 scrollHeight 是 `max(当前高度, 内容高度)`,卡片收起后会卡在曾经的最大高度;以及为绕开这坑而"归零再测"造成的可见塌缩闪烁。`display: flow-root` 给 body 一个 BFC,修了子元素 margin 穿透 body 导致内容矮报 40px 的问题(`overflow: hidden` 不行——浏览器会把 body 的 overflow 往 viewport 上传播)。
  - 消息级 HTML 缓存(`chat-store.ts`):按 `text`/`name`/`is_system`/`is_user`/`extra.uses_system_ui` 等字段比较(不是引用比较——ST 会原地 mutate 消息对象,已在 `script.js:3624`/`:6952` 验证)memoize `formatMessageHtml()`,修复切对话时 ST `{{random::a,b}}` 宏在每次冗余 store 刷新时重新解析、导致卡片反复消失又出现的闪烁 bug。
  - `useLayoutEffect`(不是 `useEffect`)挂载卡片,原始 HTML fence 源码不会在换成 iframe 前先 painting 出来一帧。
  - 信任边界:iframe 保持 unsandboxed 是为了 TavernHelper/MVU 完整兼容;执行卡片
    等价于执行受信任聊天代码。本轮加固明确保留该行为,不加 sandbox/确认门。
- **shield 切 `display:none` + 自补键盘快捷键**(commit `219bc1d`,2026-07-05):
  实测切对话时 ST 自己的 jQuery + jquery.transit 消息渲染/动画流水线跑在几万节点的原生 `#chat` 上(shield 此前只是裁剪成 1x1px,DOM 仍在渲染树里),布局+样式重算要 318ms+441ms,强制回流 795ms——这个 DOM 现在根本没人看得见。切 `display:none` 前跑了一轮 5-agent 静态审计,逐条查 ST `script.js`/`RossAscends-mods.js` 里每个模拟点击目标的原生 handler 有没有可见性判断:13 个调用点里 11 个本来就安全,尤其是 `#options`(续写/代笔/重生成/删除模式菜单)整个在 `#sheld` 之外、从来不在被裁剪区域里。真正需要补的是 ST 原生 Escape-停止生成 / Ctrl+Enter-确认编辑或重生成 / ↑-编辑最后一条这三个快捷键——原生实现依赖 `#chat`/`#send_form` 自身可见,`display:none` 后会静默失效——已在 ChatUI 侧用自己的组件状态重新实现(`hooks.ts` 的全局 Escape 监听、`Composer.tsx` 的 Ctrl+Enter/↑ 本地处理;`MessageEditor.tsx` 的取消编辑/确认编辑 Escape/Ctrl+Enter 处理补了 `stopPropagation`,避免跟新的全局 Escape 监听打架)。另发现 `openDeleteMessageMode()`(零调用死代码)会写 `#send_form` 的 inline display 并在退出时写回,跟 bare `display:none` 规则冲突,给 shield 规则加了 `!important` 防御。实测切对话开销:布局+样式重算降到 50ms/4328 元素,强制回流降到 74ms(且已不再是 ST 原生代码,是 ChatUI 自己的渲染)。

---

## 长廊剧场收官 backlog(2026-07-31)

整场重构是 `main`(基础层:token/字阶、宣纸浮层、宣纸确认弹窗)加上一条五节未合
分支栈:`pr4-stage-skin` → `pr5-actions-ia` → `pr6-swipe-segments` →
`pr9-spine-playbill` → `pr7-topbar-trio`,共 49 个提交(与本文末「当前分支与工作树」
那张栈图逐层相加同数)。沿途每一棒都如实报了自己
**没做**的事;下面把这些遗留合并成一张可执行清单。每条给「现状 → 落点 → 建议
做法 → 依赖」,不复述各棒的叙述。

自动化覆盖缺口不在这里重复:`INVARIANTS.md` §16 是那张清单的唯一权威(当前登记
了 TopbarTitle/⋯ 三行、ConfirmDialogHost、`vanished-chat-store` → Query 失效桥接
三处零浏览器驱动,以及更早的 swipe/regen 真实 DOM 依赖)。

### A · 设计稿里还空着的章节

**A1 开场白选择器(设计稿 §5)——未做,且 `DESIGN.md` 还没收编这一章。**
角色卡可带多个开场白,设计稿给了三种形态(消息流内嵌列表 / 520px 场刊弹层 /
「换一个开场 · N/M」胶囊切换器,后者仅在对话只有开场白一条消息时出现)。现在三种
都没有,读者只能吃 ST 选中的那一条。落点:新组件 + `adapter/chats` 侧一个「读角色
卡 greeting 列表 / 用第 N 条替换首条消息」的导出;先在 `DESIGN.md` 立这一节(含
「胶囊只在单条开场白态出现」这条判定归谁算),再动 UI。依赖:ST 侧改写首条消息的
安全语义(等同一次消息编辑,要走既有 host lane)。

**A2 空态(设计稿 §2)——只做了半张。**
场刊里那句「书架还空着。请一位角色,对话会列在这里。」已在
`CharacterConversationList.tsx`;舞台中央那张 300px「空戏单」卡(`rotate(-0.6deg)`、
竖排「虚 位 以 待」、「拖入 PNG / JSON 角色卡」、主按钮「浏览文件」+ 次链接
「从空白新建」)没做。落点:一个只在无角色时挂载的 stage 空态组件。依赖:ChatUI
自己没有导入动作——spine 的虚线 ＋ 现在是直接打开 ST 的角色面板(见 `Spine.tsx`
注释),所以这张卡要么复用同一个入口(那主按钮文案就不能叫「浏览文件」),要么先
补一个真的导入路径。**决定「叫什么」之前不要先画卡。**

**验证注意事项(方法学)**:真机验收这一格时,零角色空态**无法从 fixture 生成器
直接开局复现**——`scripts/e2e/generate-data-root.mjs` 的 `generateStDataRoot()`
只认单个 `fixture.character` 字段,写不出一个角色都没有的 dataRoot。要拿到真正的
零角色画面,得先用现有 fixture 正常起一次 ST,再在跑起来的实例里把那一个角色真
删掉,之后才能截图验收;改生成器参数指望它一开局就是零角色,这条路走不通。

**A3 ⋯ 菜单还差两行。**
设计稿 §7 给了五行,pr7 落了「从末楼开新分支」「角色卡设定……」「删除对话……」并把
「重命名对话」接到标题铅笔的同一份状态上;缺的是**让模型重拟题名**与**导出为纯
文本**。两者都缺 adapter 导出(前者要一次不写进对话的生成调用,后者要一个把整场
对话降级成纯文本的投影),而且 `DESIGN.md` §6 的交互契约目前只承认「⋯ 承载当前
对话重命名与删除」——要做**先更新契约**,否则实现会跑在规范前面。

**A4 群聊仍不可选。**
spine 只在群聊占台时画一个不可点的组图标槽位(`Spine.tsx` 注释写明了理由:
adapter 今天只能回答「现在是不是群聊」,画一个永远不可点的按钮等于承诺一个没人
实现的切换)。于是 `DESIGN.md` §8 验收清单里「群聊:选中后 playbill 给出降级提示
而不是空白」这后半条**今天无法触发**。落点:`adapter/chats` 补「列群聊 / 切群聊」
导出,再让 `spine-cast.ts` 把群聊当成一类座位。这是长尾里「群聊对话列表」那条的
前置。

**A5 persona 菜单缺头像与「管理身份……」(README §7)。**
README §7:「身份(persona)chip……弹 200px 宣纸菜单『以谁的身份落笔』,列表项带
20px 圆形渐变头像 + ✓ 选中标;底部『管理身份……』。」现状是 `SelectorChip.tsx` 的
`SelectorOption` 只有 `value`/`label`/`selected`,preset/model/persona 三种 kind
共用同一份纯文字列表项,没有头像位,也没有底部管理行。这是两件独立的事:

- **头像**:`adapter/selectors.ts` 的 `_personaOptions()` 已经把 ST 的 avatar
  文件名当 `value` 用,但没转成图片 URL——ST 自己的 `getUserAvatar(avatarImg)`
  (`@st/personas`,与已经在导入的 `getUserAvatars`/`setUserAvatar`/`user_avatar`
  同一模块)就是那个转换函数。落点:只给 persona 这一支的选项加一个
  `kind === 'persona'` 才有的 `avatarUrl` 字段,不污染 preset/model 共用的
  `SelectorOption` 形状,`SelectorChip.tsx` 按 kind 决定要不要画头像。**几何要
  重测**:第 2 棒的 480px 验收把 persona 菜单钉在 `max-content` 上限、390px 档
  最坏情况左沿只剩 57px 余量(`t3-480-topbar-persona-menu.png`),20px 圆头像会
  吃掉其中一部分,不能假定那次测量在加了头像之后还成立。
- **管理身份**:落点是 `openChatuiSettings('st:PersonaManagement')`——这个具名
  设置入口本来就在(`adapter/settings.ts:202`,标签正好叫「人设」),和
  `Spine.tsx` 的「＋」调 `openChatuiSettings('st:right-nav-panel')` 打开角色
  管理面板是同一个模式,不用新开一条路。这半条挂的是跟 **A2 同一枚决策**:
  「ChatUI 没有的管理面,是直接开 ST 原生面板,还是自己另起一个」——A2 那边悬而
  未决,是因为设计稿按钮文案「浏览文件」暗示一次真正的文件选择,复用面板会文不
  对题;这边不撞这个坑,设计稿文案本来就叫「管理身份……」,跟面板的实际标签语义
  对得上,可以直接照抄 `Spine.tsx` 的先例——但落笔顺序仍然是 A2 那条决策先拍板,
  这里跟着用同一个答案,不单独抢跑。

`DESIGN.md` 目前也没收编这半张菜单:§4.1 只写了 persona chip 折叠成图标按钮的
换皮,没提列表项该长什么样;§6「确认与浮层」的菜单互斥契约同样没提到头像或管理
行。要做**先更新契约**,再动 `SelectorChip.tsx`。

### B · 场刊/卡片的产品缺口

**~~B1 跨角色草稿不再同屏~~ 已随前提一起消失(2026-08-02,本条 2026-08-05 补记)。**
本条的两个前提——一个全局的租约集、一档「未完成草稿」卡——都不存在了:新对话就是普通
对话,列在它自己角色的场刊里,和这个角色其它对话没有区别。仅存的痕迹是那圈虚线边框
(`ui/blank-conversation.ts`),而它本来就是**按对话、按列**的呈现,不是一份需要全局
入口的清单。

**~~B2 卡片预览是原始 markdown~~ 已做(2026-08-05)。**
`ui/format.ts` 的 `toPlainConversationPreview` 是那个纯函数,在卡片渲染处调用
(`CharacterConversationList.tsx`),没有碰 adapter 的 DTO——`preview` 仍是宿主的原文,
「怎么显示」归 ui 管。按本条原来的约束办:不调 ST formatter(每次调用都会重解非确定宏,
pr5 的「复制」正是为此改成归约已缓存的渲染 HTML,而侧栏连那份缓存都没有)。
**实现时才发现的三件事**,都写进了函数注释与单测:① 输入是**尾巴**——ST 的
`getPreviewMessage()` 只留最后 400 字并补 `...`,所以字符串经常从语法中间开始,只处理
配对分隔符会在读者最先看的位置留下残渣;② 卡片只有一行,换行必须变空格而不是消失,
否则两句话黏成一个词;③ 反向的错更贵——`2 * 3`、`snake_case`、`5 < 7`、`他说 5 > 3`
都是散文,第一版「删到第一个 `>`」「从最后一个 `<` 删起」的断标签规则会把整句吃掉,
改成要求属性赋值/标签名才动手。表格竖线**故意不动**:`|` 在散文里是普通字符。

**~~B3 草稿卡标题的截断方式与普通卡不一致~~ 已被反向解决(`df83b22`)。**
本条原本的落点是把草稿卡并进普通卡的两行 clamp。owner review 第一轮反馈
(`df83b22`,先于本 backlog 落 pr7 之前)走的是相反方向:把
`.cui-root-nested-chat-row-name` 从两行 clamp 改成了跟 `.cui-root-draft-card-name`
一样的 `white-space: nowrap` + 尾部省略(预览行不动,仍是两行 clamp;两行 clamp 本身
的取舍理由——会话题名是散文,单行省略号恰好扔掉区分两个夜晚的那一半——只是被
owner 就单行更适合这一列这一点明确推翻)。两个类名现在都是
`overflow:hidden; text-overflow:ellipsis; white-space:nowrap`,截断方式已经一致。
**照本条原落点再把它们并回两行 clamp,会推翻这次 owner 决定,不要重做。**

**~~B4「复制」与「复制原文」的语义待 owner 拍板。~~ 已拍板(2026-08-02):默认那一枚
就是去标记的「复制」,维持现状,不动代码。**
pr5 把一个动作拆成两个:「复制」= 这一行真正渲染出来的文本(对已缓存 HTML 做归
约),「复制原文」= ST 存的 `chat[id].mes`(含标记)。实现按「读到的 vs 写下的」这
条线分,owner 选了「读到的」那一枚作默认——`⋯` 菜单里 `复制` 在前、`复制原文` 在后
(`ui/message-menu-rows.ts`),两者的落点各是 `chat-actions.ts` 的
`copyRenderedChatuiMessage` 与 adapter 的 `triggerMessageActionById`。

### C · 死代码与查询清理(低风险,落点明确)

**~~C1 `ChatuiSidebarState` 四个死字段~~ 已删(2026-08-05)。** `chats`、`loading`、
`error`、`charGroupsLoading` 连同只为 `chats` 存在的 `currentGroup` 计算一起退场。

**~~C2 `MessageSnapshotDto` 的 `canShowCharActions` / `canShowUserMenu`~~ 已删
(2026-08-05)。** 两个字段与其判定一并移除;本条原来写的「`schema`/DTO 契约测试要同步」
落空了——没有任何测试钉过这两个字段,这正是它们能白算这么久的原因。

**~~C1.5 五个只剩门面的 adapter 导出~~ 已删(2026-08-05,本轮夜审补出)。**
`listCharacterChats` 与 `listCharacterConversationHeaders` 自侧栏迁到 TanStack Query
之后就没有任何消费者(实现共 40 余行,其中 `listCharacterConversationHeaders` 还带着
一份与 `listCharacters` 重复的 `hasGreeting` 投影);
`clearAttachmentPickerRestore` 与 `triggerWandAction` 只在 `adapter/menu.ts` 内部被调用,
挂在冻结门面上白白放宽了 adapter 的对外契约;`--noUnusedLocals` 另照出三处拆除遗留的
死导入/死类型。**注意**:`openDeleteMessageMode` 虽然同样零调用,**故意保留**——它是
「阻塞项」那条模拟点击迁移的落点,退役它等于悄悄取消那件事。

**C3 recents 查询是否还值一次请求。**
场刊现在只有一列,并且**无条件**拉当前角色的完整列表(`hooks.ts` 的注释解释了为
什么);`recents`(每角色封顶 5 条)只剩「首屏先画几行」的价值。落点:
`sidebar-queries.ts` + `hooks.ts` + `use-st-query-bridge.ts` 的失效表。**先量再删**:
退役会让首屏在完整列表回来前空一拍,那一拍有多长要在真机上看,别凭感觉。
(C1 已删,所以本条不再连带喂着死字段,只剩首屏那一拍这一个理由。)

### D · 交互状态机与可访问性

**~~D1 菜单互斥~~ 已完成(2026-08-01);只余「三处浮层未接翻转函数」一条尾巴。**
`DESIGN.md` §6 要「打开任一菜单关闭其余;点击外部关闭全部;浮层向下打开为默认,
空间不足时才翻转,且不得被根容器裁切」。

- **翻转:已完成。**`src/ui/menu-placement.ts` 是那个「测得下就向下、测不下才翻」
  的纯函数(和 `floor-rail-math.ts` 同一档),消息 ⋯ 菜单已接入,九条单测见
  `INVARIANTS.md` §9。它先按行数估高只用于*判方向*,两个方向的偏移都锚在实测到
  的触发钮边沿上——估高绝不进入几何,所以估错只会换个方向,不会让菜单脱离按钮。
- **互斥/外点/Escape:已完成。**`src/store/menu-store.ts` 是全应用唯一的「当前打开
  的菜单」槽位,四类浮层(顶栏 ⋯、三枚 selector chip、＋菜单、消息 ⋯)全部接入,
  互斥因此是状态的形状而不是一条要被执行的规则(§9.1)。顶栏 ⋯ 的原生 `<details>`
  同批换成受控按钮——那个控件的开合存在 DOM 里,Escape 与外部点击对它都无效。
  消息 ⋯ 菜单的**渲染**一并提到 app 根(`MessageMenuHost.tsx`,仍 portal 到
  `document.body`),否则虚拟行被卸载后 store 里会留下一个没人画的 open 状态;行卸载
  因此成为一条正式的、按行身份定域的关闭路径。Escape 改为一条有次序的梯子
  (`src/ui/escape-ladder.ts`,§9.2),而不是再加一个和 `useChatuiEscapeKey` 抢注册
  顺序的 window 监听器。真机验收 27 项(真 ST + 真 Chromium,1280 与 390 两档:
  互斥经键盘路径、Escape、外点、行卸载、退出设置无幽灵、零 pageerror)。
- **尾巴:另外三处浮层仍各自写死开合方向**,没接 `menu-placement.ts`。这是有意留的:
  顶栏 ⋯ 永远在屏幕顶端、装得下;composer 的两枚 chip 与 ＋ 菜单是**向上**开的
  (手机上 ＋ 还是贴底 sheet),把通用函数套上去会改掉已实测过的几何而换不到东西。
  真要统一,前置是先给这三处补几何验收,否则是拿一次回归换一次整齐。

**~~D2 ConfirmDialog 缺焦点陷阱~~ 已完成(`9b2b7cc`,2026-08-01)。**
焦点陷阱落在 `ConfirmDialog.tsx` 的 `moveFocusWithin` + `isolateBackground`,判定
本身是 `confirm-store.ts` 的 `nextConfirmFocusIndex` 纯函数(把每一次无修饰键的
`Tab` 在捕获阶段转成 focus-next/focus-previous);背景用 `inert` 而不是
`aria-hidden`,因为只有 `inert` 连焦点一起挡住。同批还加了 `event.repeat` 守卫。
契约见 INVARIANTS §15.1,浏览器闸门是 `e2e/confirm-dialog-keyboard.spec.mjs`
(连按五次 `Tab`、三次 `Shift+Tab`,逐次断言落点;真按住 `Enter` 让守卫窗口在按键
底下过期)。**本条 2026-08-05 才划掉**——在此之前它一直被 §「下一阶段重心」当成
「剩下的那笔可访问性欠账」,会把接手的人送去重做一件已经上线并有 12 条不变量兜底
的事。

**D3 swipe 刻度零浏览器断言。**
pr6 的判定在 `src/ui/swipe-segment-math.ts`,单测钉死;但刻度**真的能点**、窗口
真的会随候选数滑动,浏览器层一条断言都没有。而 `swipeMessageById` 恰恰是
`INVARIANTS.md` §16 里仅存的「必须真实 DOM」的动作。落点:并进将来那条覆盖
copy/branch/checkpoint/hide/delete 的 Chromium 场景,一次性把消息动作补齐。

### E · 性能与几何

**E1 `VIRTUAL_MESSAGE_ESTIMATE_PX` 是一个常量,而真实行高跨两个数量级。**
`src/ui/app.tsx:73` 的 320 在 pr4 收尾时**实测过**才保留(见 `c44a0b8` 的提交信
息:两份 400 楼样张、改前改后、以及「抬高能买到什么」的追踪实验,区间内没有更优
值)。真正的发现是:一个常量服务不了 130px–16000px 的行,出路是**从已测行学习的
自适应估算**(虚拟化库已经在测每一行,数据是现成的)。落点:`app.tsx` 的
`estimateSize` + 一个可单测的估算器。验收要同时看跳转追踪比与落位时间,别只看
`content ready`。

**E2 结构计数基线随皮肤变了。**
pr5 的平铺按钮与 pr6 的刻度改变了「一条消息渲染多少个控件」,历史基线里的按钮数
已作废;新量级与出处见 `PERFORMANCE.md` 的 2026-07-31 一节。后续任何按钮/元素数
的回归判断以那节为准。

### F · 视觉方言还没覆盖的表面

**F1 设置页、代码块、QR bar 仍是旧文法(toast 已做完)。**
三处都读同一套 `--cui-*` token(所以颜色是对的),但形状没做。落点:各自一节
style.css,互不依赖,适合当碎片时间的收尾。

toast 这一格已按设计稿 §10 整只落地:底部居中距底 120px、新的浮起卡面
`--cui-color-raised`(#2a251e)+ 象牙 15% 描边、8px 圆角、12px 字、`.15s` fade-in,
契约收进 `DESIGN.md` §2.1 表格与 §6。它顺带解掉的不只是形状:旧的 `top:1rem` 每次
都盖住顶栏的双层题名。自动消失的时长与机制没动。

**F2 字体自托管暂缓。**
设计稿要 Noto Serif SC,而 §9.1 明确禁止任何外部 CDN,所以现在是「请求 Noto Serif
SC,拿不到就回退到本机已装的思源/宋体系」。真要按稿呈现只能自托管子集字体,代价
是三项:产物体积、字体许可、构建流水线多一个资产步骤。**这条不是忘了,是权衡后
暂缓**;要推翻先算这三项。

### G · 宿主行为遗留(真机 14 格矩阵实测,未修)

**G1 收尾落地会改写 `active_character`,即使宿主关着 autoload。**
`pendingnobody-noautoload` 格实测:`Lounge Test Character.png` → `default_Seraphina.png`。
宿主不读它时无害;但读者日后打开 autoload,「上次选的人」就是 ChatUI 在一次事务收
尾里替他选的。落点:`adapter/chats/navigation.ts` 那三行镜像写。要不要按 autoload
开关分叉,是产品判断,不是 bug 修复。

**G2 等待中的凭证会让一个零会话角色整会话领在鹤首。**
`pendingelsewhere` 格实测。这是规则的设计意图(「让读者能自己走过去」),但凭证若
始终不兑现,这个座位不会自己消失。落点:`spine-cast.ts` 的入列规则——要么给凭证
座位一个可见的「待认领」态,要么给它一个页内寿命。

**G3 `isCurrent` 依赖 header 与 chat store 短暂一致。**
`!header.isGroup` 这道门在 header 落后一拍时会有一帧把某角色标成当前。这是既有行
为,但 pr9 之后它**同时决定 spine 的入列**,多了一个后果面。群聊两格实测未观察
到。落点:让 `isCurrent` 只认一个真源(chat store 的 `currentChat`),header 只负
责显示。

**G4 点开一条文件已消失的普通历史行,得到的是一场崭新的对话,而不是一句实话。**
终审真机实测(smoke 样张 + 第二条普通会话,把 `.jsonl` 从盘上删掉再点那一行):
既没有 toast,那一行也不消失,`chatId` 照旧是那个名字,而 `chat.length === 1`——
ST 按新对话加载并放上角色的开场白。读者看不出任何异样,下一次保存就把这个名字
重新写实,变成一场与原来那场毫无关系的对话。根因在 `adapter/chats/navigation.ts` 的 `openChatForCharacter`:它只在
**角色卡不在名册**或文件名为空时回 `notfound`,而对已在台上的角色,打开一个不存在
的文件对 ST 根本不是错误,`openCharacterChat()` 就按空对话加载。收官轮补的
`vanished-chat-store` 广播因此覆盖不到这一格(草稿/租约两条路径已实测覆盖并做过
变异体验证,见 `INVARIANTS.md` §3)。落点:`openChatForCharacter` 在切换前先问一次
`hasCharacterChatFile`(同函数里草稿路径已经这么做),文件不在就回 `notfound`,让既
有广播接手。**注意成本**:那是每次打开都多一次目录读取,要么只在「读缓存里有、但
可能已过期」时问,要么接受这次读取——先量再定。

**G5 默认宿主上,「删当前对话」几乎每一次都把读者丢在空台上——不只是删空的那一次。**
(2026-08-05 夜审提出,**这是产品判断,不是 bug**,故只记不改。)落地凭证今天的排队
条件是 `result.fallbackChatFileName` 为真,也就是「这个角色的历史被删空了」。但
`reloadRequired` 在**任何**一次删当前对话时都为真,而 `power_user.auto_load_chat`
默认是 false——所以哪怕这个角色还有别的对话,那次强制刷新照样落在「一个角色都没选中」
的欢迎页上。两者的差别只在**严重程度**:删空那次连书脊都可能没有座位(`chat_size`
快照的问题,由台账兜住),而这次书脊有座位,读者自己点一下就回去了。
落点:把凭证的排队条件从「历史被删空」放宽到「这次删除强制了刷新」。要不要放宽是
owner 的判断——它等于让 ChatUI 在每次删当前对话后都替读者选一次角色,而
`selectCharacterIfNobodyIsOnStage` 的现有理由(「这是读者自己发起的事务的收尾,不是
替他改 autoload 偏好」)对这一格同样成立。

---

## 剩余工作(按优先级 · 已按 价值/成本 + 避免返工 重排)

> 排序依据:分支已 live 但写路径刚加固,先求"可信赖"再堆功能;配置系统(M-E)是横切地基,**早落薄地基**以免后续 M-C/M-D 塞进更多硬编码默认、造成复利返工。

### 0 · live-test 收尾(进行中)
本次已测:删除、swipe、滚动、布局、配置面持久化、ST drawer hosting POC;M-G review fixes 的 browser pass 已覆盖 topbar destructive target 二次校验、temp-draft 创建串行化、群聊态 ＋新对话 inert。**2026-07-05**:续写/代笔/重生成/停止经静态审计(见下)+ 实机验证(Ctrl+Enter 触发 regenerate、Escape 中途打断)确认安全,不再是"最可能哑火"项。**仍欠**:手机侧栏/settings 回归。

### ~~M-E · 配置系统**薄地基**~~ ✅ 已落地(commit `abf212f`)
地基已立:`config-store`(createStore 工厂)+ `adapter/config.js`(ST extension_settings 往返)+ 设置面 select 双向同步。首个真功能 **侧栏三形态记忆** 曾用于 M-A 常驻侧栏,已随 M-G two-pane sidebar 退役;config-store 地基保留。**单/多行开关** 留给 M-C(与输入框同刀做),§7 其余九项随各自归属 milestone 落。

### ~~M-D · 内容区收尾~~ ✅ 已落地(commit `50cb5e6`)
四项全做:生成回复钮(`lastMessageNeedsGenerate` → regenerate)、用户消息**平铺全显**菜单(DESIGN §5.C)、代码块语言名头(声明围栏)、身份标头 3 档可配(群/单各一套,§5.A)。经 4 视角对抗审查 + 逐条验证,修了 5 个真问题(生成钮收口到 isUser、代码块 padding 改 CSS `:has()` 去抖、菜单平铺全显对齐 DESIGN、类型对齐 SidebarForm 模式)。

### ~~M-C · 输入框收尾~~ ✅ 已落地(commits `f1c4d6b`/`e9e8185`/`4d8bb48`)
QR 悬浮条(镜像 `#qr--bar`,含 popout 模式)、单/多行切换(吃 config 地基)、＋菜单**基础**(配置驱动置顶磁贴 + 工具列表)。**拖拽/置顶/开关编辑器**仍延后(依赖 §7 独立配置面);批量删除磁贴撤下(需 ChatUI 自有多选 UI,ST 删除模式的勾选在被隐藏的 `#chat` 里)。

### ~~M-B · 顶栏右 + 选择框槽 A~~ ✅ 已落地(commit `6f2fa01`)
动态标题(绑 Query header)、顶栏右 ⋯(重命名/删除/＋新对话,群聊态自动禁用)、选择框槽 A(人设移顶栏,预设+模型留输入框)。**转群聊 / 管理聊天文件先放**(adapter 无导出)。

> M-C + M-B 经一轮 4 视角对抗审查(21 raw → 12 真)+ 逐条验证,修了 9 个(撤批量删除、群聊禁用重命名/删除、QR popout、标头去重、单行选择框弹窗方向、顶栏窄屏溢出等),commit `25b5620`。

### ~~M-F · 独立配置面(独立配置面)~~ ✅ 已落地(commit `d7a6025`)
ChatUI 自有设置面第一版:桌面**贴边推开列**(`Sidebar | ConfigPanel | 主区`,主区收缩不被遮)/ 手机**全屏接管**;该第三列 ConfigPanel 模型已在 M-G 被 settings mode swap 取代。开关态走新 `store/ui-store.js`(极简非持久 store,解耦触发器与面板)。四项 select(侧栏形态/群单标头/输入框行数)从 ST 抽屉**迁入**应用内(声明式 `ConfigSelect`,退役 `optionsHtml`/`bindConfigSelect`),ST 抽屉只留主启用开关。落地**首个 §7 编辑器**:＋菜单置顶磁贴编辑器(封顶 4)。`PlusMenu` 的 `PLUS_TOOL_META` 改由 `PLUS_TOOL_IDS`(config-store)派生 —— 菜单/编辑器/持久化单一来源。经 Codex 对抗审查修 1 个真问题:**在 config-store 收口** `normalizePlusPinned`(读写都过:已知 id + 去重 + 封顶),杜绝脏 `plusPinned` 锁死编辑器。

### 长尾
手机适配(侧栏/settings transitions + 返回)、群聊列表、搜索 🔍、Mode B、选择框槽位可配、＋菜单拖拽排序编辑器、★ 收藏开关(需新 adapter 导出)、swipe 手势。

---

## 阻塞项 / 技术债

- ~~swipe/delete 从模拟点击切到 ST 导出函数~~ —— **已完成**。
- ~~adapter 上帝模块(1321 行)拆分 + store 的 pub-sub 工厂化~~ —— **已完成**(commit `8b8e203`:adapter 拆为 8 子模块 + `createStore` 工厂,行为不变)。
- 剩余 `#options`/抽屉等 **模拟点击写路径**(22 处)迁到 ST 导出 —— **2026-07-05**:5-agent 静态审计逐条查过 ST `script.js`/`RossAscends-mods.js` 里每个目标的原生 handler,11/13 本来就安全,`#options`(续写/代笔/重生成/删除模式)整个在 `#sheld` 之外、从来不在被 shield 裁剪的区域里,不再是阻塞项。剩 `openDeleteMessageMode()`(零调用死代码)一处——它会写 `#send_form` 的 inline display,需要先处理跟 shield 规则的冲突才能接 UI(shield 规则已加 `!important` 防御)。迁移本身降级为纯架构债 / 代码整洁目标,不再紧急。
- `content-visibility` 双重渲染优化 —— 等火焰图看实际性能。
- 人设 chip 懒加载 —— 现每次 selector-sync 都拉 `getUserAvatars`,小优化。
- **Gecko 门禁只在 CI 上跑得动。** Playwright 的 Firefox 在维护者的 Mac 上无法启动
  (`RenderCompositorSWGL` 无法映射帧缓冲,无头/有头/软件渲染全试过;`xattr` 清隔离
  属性也无效),所以 `pnpm run test:e2e` 钉死 `--project=chromium`,双引擎矩阵靠 CI
  兜底。后果是**跨引擎缺陷的本地反馈环是断的**——只能靠推 PR 等 CI,或者请维护者在
  Zen 的 Console 里跑只读快照脚本(2026-08-02 定位 rails 宽度缺陷用的就是后者)。
  值得找的出路:换 Playwright 版本/Firefox 通道,或给这台机器找到能跑的图形后端。
- ~~**临时会话隔离区正在拆除,第二棍未做。**~~ —— **2026-08-03 两棍全部完成**。
  第一棍拆读者可见层(草稿卡、列表过滤、按钮高亮、只能有一个、选角条),第二棍拆掉
  `store/temp-chat-store.ts`(548 行)+ `temp-chat-navigation.ts`,以及
  `adapter/chats/deletion-finalization.ts` 里为它服务的凭证子系统的大半。
  - 书脊那个补偿改由 `store/session-characters.ts` 回答——**进程内、页级的一个 Set**,
    记「本会话里 ChatUI 自己给谁建过对话」;这才是「ST 的 `chat_size` 是启动期磁盘快照」
    这个问题该有的形状,而不是持久化租约的副产品。
  - 凭证只剩「刷新之后把读者送回哪个角色」一件事:丢掉了文件名、身份守卫、
    resolve/waiting/settled 协议和那个 CHAT_CHANGED 监听,连带丢掉它们文档里
    「接受」的那个 ~142ms 竞态窗口。存储键刻意沿用旧名,好让升级当口正在事务里的读者
    仍被送回去(有单测)。
  - INVARIANTS §5 整节退场(13 条),§3 的凭证条目换成落地版;新增会话台账 5 条 + 落地
    凭证 6 条 + 真机验收 `scripts/e2e/verify-last-chat-delete.mjs`(自带一次性宿主,
    因为它对固件是不可逆破坏性的)。
- ~~**本机跑浏览器门禁时，宿主 checkout 里已装的同名扩展会顶掉被测产物。**~~ ——
  **2026-08-05 已加拒跑闸**。ST 把 `express.static(public/)` 挂在 per-user 扩展路由
  之前（`src/server-main.js:242` vs `src/users.js:1219`），所以只要
  `public/scripts/extensions/third-party/SillyLounge-dist` 存在——而维护者自己就装着
  它——浏览器拿到的每一个文件都来自那份，固件写进一次性 dataRoot 的拷贝一次都没被读。
  门禁照常启动、照常全绿，断言的却是上一次发布的构建。CI 上不会发生（新 checkout 那
  里只有 `.gitkeep`），这恰恰是最坏的分布：**本地这条快反馈环在回答另一棵树的问题**。
  发现方式是一条怎么都过不去的卡片断言，而磁盘上的树明明是对的。现在
  `generate-data-root.mjs` 检出这种情况就直接报错，并给出把它挪开再挪回来的两行命令。
  **仍待改进**：拒跑是诚实但麻烦的做法（维护者每次跑 e2e 都要挪一次自己的安装）。
  想做得更好，得让固件那份拷贝落在 `express.static` 够不到的地方，而那要么改 ST，要么
  给固件换一个不会撞名的安装目录——后者会让门禁不再复现真实安装的目录名，而目录名正是
  2026-08-03 咬过一次的东西。
- **两个 workflow 有约 100 行完全重复的门禁步骤。** `pr-checks.yml` 与
  `publish-dist.yml` 从「装依赖」到「跑三个真机验收」逐字相同,只有末尾的发布步骤不同。
  加一道门禁就得记得改两处——`verify-last-chat-delete` 那次就是这么加的。抽成
  `workflow_call` 可以去重,但**有取舍**:发布步骤要拿到被验证的那棵树,而 job 之间不共享
  文件系统,于是要么在发布 job 里重新构建(那就不再是「过了门禁的那棵树就是发出去的那棵
  树」),要么走 artifact 上传/下载(多一层,也多一个可以出错的地方)。今天这条不变量是白拿
  的,值不值得用它换整齐,是 owner 的判断。
- **`scripts/e2e/*.mjs` 仍是 Chromium 独占。** 引擎矩阵目前只覆盖 `e2e/*.spec.mjs`;
  `measure-chat-switch` / `verify-truncation-guard` / `measure-long-chat` 都直接
  `chromium.launch()`。前者是性能基线,换引擎会让数字失去可比性,先不动;但**截断
  守卫是纯行为验收,没有理由只在 Blink 上跑**,是矩阵下一个该扩的地方。

---

## 当前分支与工作树

当前开发分支为 `main`，**没有任何未合并的分支栈**。长廊剧场分两批到位：pr0–pr3 早已
是 `86995df` 的亲提交链的一部分，pr4/pr5/pr6/pr9/pr7 连同 owner 第一轮反馈
（`df83b22`）由 `b3d3bdb` 于 2026-08-01 一次合入（相对 `86995df` 共 50 个提交）；
其后又落了隔离区拆除（08-02/03）与仓库拆分（08-03）。九条 `refactor/pr*` 分支一律
保留为 review 粒度的记录，**不是**变基目标：它们都落后于 `main`，从任何一条上开新
分支都会回到隔离区还在的那个世界。编号是章节的**拟稿顺序**而非叠放顺序（pr7 最后写、
叠在 pr9 上；没有 pr8 分支）。

桌面楼层导航的当前基线是 `2px` 高 / `8px` 间距（`10px` 节距，`85778e6` 从 `6px` 放宽
而来）、边缘淡出与预览气泡内左对齐的楼层号，并按 `DESIGN.md` §4.3 保留自有样式与
交互——设计稿的楼层轨规格不采用。阅读列宽度已在 pr9 随 spine 一起从 `54rem` 重标定到
`680px`（`DESIGN.md` §3.1 的联立方程；不改就会让楼层轨在 1280px 笔记本上静默消失）。

2026-07-10/11 hardening、Manuscript Flow 视觉复归、new-chat quarantine 修复与楼层导航均已
进入提交历史;本地 validated runtime 也已发布并通过 assembled-tree 检查。仓库现已由
`.github/workflows/publish-dist.yml` 在每次推送 `main` 后执行完整验证、固定版本的真实
SillyTavern 双引擎门禁与可安装树检查，并把产物推到独立的
[`SillyLounge-dist`](https://github.com/blance714/SillyLounge-dist) 仓库
（2026-08-03 由「同仓 `dist` 分支」改成两个仓库，理由见 README「两个仓库」）。

**五大区主干已闭环,settings 已转为 two-pane mode swap,独立配置面已解锁 §7,
侧栏已迁移到 TanStack Query,全源码已 TypeScript 化(Vite 构建)。**
2026-07-03 对整条迁移分支做了一轮 xhigh 10-角度对抗审查,发现 14 个问题
(含 1 个致命的挂载路径 bug,插件完全无法启动),全部修复并经独立第二轮
对抗复核 + 回归扫描确认无遗留,实机 live-test 通过。历史用户消息保存/重挂载与
character `⋯ → Edit` 已进入真实 Chromium 门禁。剩余模拟点击写路径已降级为普通架构债。

**下一阶段重心**(2026-08-05 重排):长廊剧场分支栈已于 2026-08-01 合入 `main`
(`b3d3bdb`),隔离区已于 08-02/03 拆完,按上面的「长廊剧场收官 backlog」排期即可
——C 组只剩 C3(recents 查询,先量再删),C1/C2 与本轮补出的 C1.5 已删;F1 只剩
设置页/代码块/QR bar 三处未覆盖(toast 已于 2026-08-01 落地);B1/B3/B4 与 D1/D2
都已结清,可访问性那笔欠账不再存在(D2 的焦点陷阱 `9b2b7cc` 已上线并有浏览器闸门)。
于是 **A 组(含 A5)是真正剩下的产品缺口**,多数卡在 adapter 导出上——A5 的
「管理身份」半条是例外,复用的设置入口已经现成。原有的长期项(手机回归覆盖与适配、删除确认等产品
行为的浏览器脚本、§7 深化、搜索、群聊列表与 Mode B)不变,其中群聊列表以 A4 为前置。
