# SillyTavern-ChatUI · Roadmap

Last updated: 2026-07-15

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

---

## 当前分支与工作树

当前开发分支为 `main`;桌面楼层导航纳入当前功能基线。
2026-07-10/11 hardening、Manuscript Flow 视觉复归、new-chat quarantine 修复与楼层导航均已
进入提交历史;本地 validated runtime 也已发布并通过 assembled-tree 检查。仓库现已由
`.github/workflows/publish-dist.yml` 在每次推送 `main` 后执行完整验证、固定版本的真实
SillyTavern Chromium 门禁与可安装树检查，并自动更新默认的 `dist` 分支；具体发布契约
见 README「自动发布 `dist`」。

**五大区主干已闭环,settings 已转为 two-pane mode swap,独立配置面已解锁 §7,
侧栏已迁移到 TanStack Query,全源码已 TypeScript 化(Vite 构建)。**
2026-07-03 对整条迁移分支做了一轮 xhigh 10-角度对抗审查,发现 14 个问题
(含 1 个致命的挂载路径 bug,插件完全无法启动),全部修复并经独立第二轮
对抗复核 + 回归扫描确认无遗留,实机 live-test 通过。下一阶段重心:手机回归覆盖与
适配、产品行为浏览器脚本化、§7 深化(选择框槽位 / ＋菜单拖拽排序),再推进搜索、
群聊列表与 Mode B。剩余模拟点击写路径已降级为普通架构债。
