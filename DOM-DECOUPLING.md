# 消息动作 DOM 解耦设计

2026-07-19 调研产出（四条只读侦察线逐行核实锁定宿主 SillyTavern v1.18.0 /
commit 51ad27f，全部结论有 file:line 背书），随后三项关键决策已拍板。本文取代
PERFORMANCE.md「隐藏原生消息窗口实验」末段对产品化工作的粗分类——那里把
delete 与 swipe 错误地归入「可直接按 ID 调用」。

**2026-07-19 复审修订**：Tier 1 首次落地后经对抗性复审，发现三项高危问题并已
在同日修复（详见下方「逐动作裁决」delete（仅 swipe）行、「已拍板决策」#3 的修
订说明、「附带发现与残留风险」）：`deleteSwipe` 的 ST 自身数据损坏路径实际上还
连带卡死模块级 `swipeState`（无导出重置口子，堵住 app 全局发送与后续 swipe），
仅补 `mes` 同步并不足够，因此仅删 swipe 分支从「直接调用 ST `deleteSwipe()`」升
级为完整 mini-fork，彻底不再进入 `deleteSwipe()`/`swipe()`；仅删 swipe 分支恢复
了删除确认弹窗（此前静默绕开）；整条删除分支恢复了显式 DOM 门卫（此前被
Tier 1 的门卫撤除误伤，静默 no-op 而非报错）。

目标：原生消息窗口截断到 1（实测再省约 29% 切换耗时、切换 long task 归零）后，
所有消息动作在目标 `.mes` 节点不存在时依然正确。

## 逐动作裁决

| 动作 | 裁决 | 依据 |
| --- | --- | --- |
| copy | 直接按 id 调 | 改 `copyMessage` 收 mesId，走 `getMessageById` + `copyText`（utils.js:546，clipboard API 主路径零 DOM） |
| branch | 直接按 id 调 | `branchChat(mesId,{swipeId})`（bookmarks.js:449）全程不查 `.mes`；导航副作用是有意的 |
| checkpoint | 直接按 id 调 | `createNewBookmark` 唯一 DOM 触碰是装饰性 ribbon 标签更新，jQuery 空选择安全无操作（bookmarks.js:292-310） |
| hide / unhide | 本就 DOM-free | `hideChatMessageRange` 对缺失 DOM 逐条跳过而非中止（chats.js:160-162）；注意 ST 不发任何 hide 事件，同步只能重读 `is_system`（现状已如此） |
| delete（仅 swipe） | **mini-fork**（复审后修订，不再直调 `deleteSwipe()`） | 原计划「直接调 `deleteSwipe()`」，但 `deleteSwipe` 删除活跃 swipe 时内部调用的 `swipe()` 会在自己的 DOM 门卫**之前**把模块级 `swipeState` 置为 SWIPING（script.js:9935→9942），且 `swipeState` 无任何导出重置口子（script.js:415 `export let`）——未渲染消息会把它卡死，堵住 app 全局发送与后续 swipe。本文件资格判定保证仅删 swipe 分支删的必是活跃 swipe，直调会让该路径每次必现。改为对 `chat[]` 活对象直接复刻 `deleteSwipe()` 的纯函数体（splice swipes/swipe_info、重算 swipe_id、`tainted`、`MESSAGE_SWIPE_DELETED`、`syncSwipeToMes`、`saveChatConditional`），彻底不进入 `deleteSwipe()`/`swipe()`——与下一行「delete（整条）」的薄分叉是同一种策略，只是提前到 Tier 1 |
| delete（整条） | 薄分叉（~10 行）；**Tier 1 期间维持 DOM 门卫** | ST `deleteMessage()` 第一行即 DOM 门卫（script.js:1633-1636），挡住含确认弹窗在内的整个函数；门后仅 ~10 行纯数据簿记（splice、tainted、itemized-prompt 失效、`MESSAGE_DELETED`），全部 DOM 容忍，可分叉——**但分叉本身是 Tier 2 工作**，Tier 1 仍调用 ST 原生 `deleteMessage()`，因此 Tier 1 期间必须由 ChatUI 自己在调用前显式复核 `.mes` 是否存在并抛出说明「Tier 2 未落地」的错误，不能让 ST 内部门卫静默 no-op（复审发现：撤除外层门卫时曾误伤这一分支） |
| edit（保存） | 分叉 + 契约测试（已拍板） | `updateMessage()` 依赖的纯函数均有导出（getRegexedString / substituteParams / extractMessageBias / removeMacros / ensureSwipes）；分叉复刻其 ~15 行编排，用契约测试钉死行为，ST 升 pin 时 CI 大声失败而非静默漂移 |
| edit（取消） | 无需任何 ST 调用 | SillyLounge 草稿在自己手里，取消即丢弃本地状态（可选清 `setEditedMessageId(undefined)`，script.js:7101 有导出） |
| swipe（切换候选） | 无限期推迟（已拍板） | 成功路径本身 DOM 驱动（`addOneMessage` type='swipe' 原地更新节点，script.js:2513/10233）；但 ST 自身限制仅末条可 swipe（isMessageSwipeable，script.js:9136），截断留 1 条恰好保住末条 |
| 停用恢复 | 前置工作，独立实现 | 目前 src 中**尚无任何代码**覆盖 `chat_truncation`（只存在于测量工具）；上线顺序：激活时临时覆盖 → 停用时恢复真值 → shield 遮蔽下 `printMessages()`（script.js:1475）重建原生 DOM → 揭幕 |

## 已拍板决策（2026-07-19）

1. **edit 保存走分叉 + 契约测试**，不做按需 DOM 宿主。理由：与本项目版本锁定 +
   清单文化契合，升 pin 本就是显式 CI 事件。
2. **swipe 历史消息 UI 暂无计划**，其解耦无限期推迟；末条 swipe 由截断=1 天然兼容。
3. **删除确认由 SillyLounge 自实现**：读取并尊重 `power_user.confirm_message_delete`，
   在自家 UI 弹确认，不静默绕过用户偏好。
   **2026-07-19 复审修订**：「自家 UI」原计划是 Tier 2 才做的 ChatUI 自有确认组
   件；但 Tier 1 首次落地时误把仅删 swipe 分支的确认弹窗整个丢掉了（绕开 ST
   `deleteMessage()` 包装时连它自带的 `callGenericPopup` 确认一起绕开了），必须
   在 Tier 1 内立即补上，不能等到 Tier 2。补法是直接复用 ST 原生弹窗：
   `getContext()` 已经通过既有映射的 `@st/st-context` 模块重导出
   `callGenericPopup`/`POPUP_TYPE`/`POPUP_RESULT`/`t`（`public/scripts/
   st-context.js`，逐一核实过），措辞、按钮、三态行为（确认删 swipe / 升级删整
   条 / 取消零变更）与 ST 原生 `.mes_edit_delete` 处理器（script.js:1638-1647）
   逐字一致，不需要新增任何 `@st/*` 模块映射。这是过渡方案：Tier 2 的自实现
   ChatUI 确认组件建成后，应该替换掉这次直调 ST 原生弹窗的调用，换成完全由
   ChatUI 拥有视觉与交互的确认 UI。

## 推进顺序

1. **Tier 1（零风险，先行）**：copy / branch / checkpoint / hide / 仅删 swipe 五个动作
   改为按 id 直调；撤掉 `triggerMessageActionById` 对这五个动作的 `getMessageElementById`
   一票否决门卫。零保真损失。
   **2026-07-19 复审修订**：仅删 swipe 分支的「按 id 直调」实际内容从「直调
   `deleteSwipe()`」升级为 mini-fork（见上表），并补回了确认弹窗（上面决策 #3
   的修订）；整条删除分支的 `getMessageElementById` 门卫并未撤除——`triggerMessageActionById`
   分发入口无法区分 delete 的两个子分支，门卫下沉到 `deleteMessage()` 内部按子
   分支显式判定。
2. **停用恢复机制**：`chat_truncation` 覆盖 + 恢复 + `printMessages()` 重建；它阻塞
   整个截断上线，独立于任何动作层选择。
3. **Tier 2：delete 薄分叉** + 自实现确认 UI + 契约测试。delete（仅 swipe）的 mini-fork
   已在 Tier 1 提前完成并需要同等契约测试对待（见下）；Tier 2 剩下的范围收窄为
   delete（整条）本身的分叉、以及用 ChatUI 自有确认组件替换 Tier 1 过渡期直调
   的 ST 原生弹窗。
4. **Tier 3：edit 保存分叉** + 契约测试（见下）。

## 契约测试清单（防 ST 升 pin 静默漂移）

- `updateMessage()` 定序样张：固定输入 + regex/macro/bias 配置下，分叉产物与原生
  路径的 `mes.mes` / `swipes[swipe_id]` / `extra.bias` 字节一致；关键顺序：regex 的
  isEdit 分支 → bias 提取在 substituteParams 之前、赋值仅限特定角色类型 →
  `ensureSwipes` 先于 swipes 写入 → `tainted=true` → `MESSAGE_EDITED` 严格先于
  `MESSAGE_UPDATED`。
- `deleteMessage()` 门后体样张：分叉的 splice / tainted / itemized-prompt 失效 /
  `MESSAGE_DELETED` 载荷序列与原生可观测行为一致。
- `_deleteSwipeById` mini-fork（2026-07-19 提前到 Tier 1，已有 test/messages.test.mjs
  背书，见 INVARIANTS.md §7）：splice swipes/swipe_info、swipe_id 重算三分支
  （小于/大于/等于 currentSwipeId）、`chat_metadata.tainted`、`MESSAGE_SWIPE_
  DELETED` 载荷、`saveChatConditional` 与原生 `deleteSwipe()` 可观测行为字节一
  致；活跃/非活跃分支：删除**未渲染消息的当前活跃 swipe** 时，必须经由纯函数
  `syncSwipeToMes`（script.js:6895，已核实 DOM-free）同步 `mes`——mini-fork 从不
  进入 ST 的 `deleteSwipe()`/`swipe()`，因此不存在「或显式拒绝」的退路，同步是
  唯一路径。
- `this_edit_mes_id` 生命周期：异步编辑/删除前后成对调用 `setEditedMessageId`，
  保住原生 beforeunload 守卫与 swipe 门的诚实性。
- 停用恢复 smoke：ChatUI 卸载后 `#chat` 含完整（非截断）原生消息集，真 Chromium 验收。

## 附带发现与残留风险

- **ST 自身数据损坏路径**（2026-07-19 首次发现时以为分叉可以只补 `mes` 一处的
  坑，复审时发现范围更大，已通过完全 mini-fork 绕开，可考虑上游报告）：
  `deleteSwipe` 删除未渲染消息的当前活跃 swipe 时，swipes 数组与 swipe_id 已提
  交并持久化，但同步 `mes` 文本的步骤经由 `swipe()` 的 DOM 门卫静默失败——`mes`
  留存已删 swipe 的文本。**复审进一步发现**：`swipe()` 在这同一个 DOM 门卫之前
  就已经把模块级 `swipeState`（script.js:415，`export let`，无任何导出重置口
  子）置为 SWIPING，门卫早退导致它永久卡死——不只是 `mes` 数据损坏，而是
  app 全局的发送（`sendTextareaMessage()`，script.js:1711）与后续所有 swipe
  （`isSwipingAllowed()`，script.js:9111）全部静默失效，直到用户刷新整个页
  面。这比最初记录的「`mes` 留存旧文本」严重得多，也是仅删 swipe 分支从「直调
  `deleteSwipe()`」升级为完整 mini-fork 的直接原因——mini-fork 从不进入
  `deleteSwipe()`/`swipe()`，这两条损坏路径（`mes` 与 `swipeState`）随之一并
  消失，而不是逐一打补丁。
- `this_edit_mes_chname` 无导出 setter（script.js:608 模块私有）：分叉期间原生
  `.mes` 的显示名读取可能短暂过期；对 ChatUI 自有 formatter 无影响。
- reasoning 自动提交级联（script.js:8366 ↔ reasoning.js:1271）无非 DOM 入口；当前
  对 SillyLounge 为空操作，若未来做原生 reasoning 编辑 UI 需专项处理。
- translate 扩展监听 `MESSAGE_UPDATED` 后触碰原生 `.mes` DOM（translate/index.js:772），
  截断下行为未追踪——上线截断前需验证。
