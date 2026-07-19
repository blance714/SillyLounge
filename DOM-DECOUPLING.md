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

**2026-07-19 Tier 2 落地**：delete（整条）从「Tier 1 期间维持 DOM 门卫、直调 ST
`deleteMessage()`」升级为薄分叉——`src/adapter/messages.ts::_deleteFullMessageById`
逐字复刻原生 `deleteMessage()` 门后本体（splice、tainted、itemized-prompt 失
效、重编号、`saveChatDebounced`、`this_edit_mes_id` 重置、`refreshSwipeButtons`、
`MESSAGE_DELETED`），DOM-*容忍*而非 DOM 门卫，彻底不再调用 ST 的
`deleteMessage()`。删除确认弹窗同步从「Tier 1 过渡期直调 ST 原生
`callGenericPopup`」换成完全由 ChatUI 拥有视觉与交互的对话框（`store/confirm-
store.ts` + `ui/components/ConfirmDialogHost.tsx`），已拍板决策 #3 的过渡方案就
此收口。

**2026-07-19 复审再次发现并修复（重编号陷阱）**：Tier 2 首次落地时，重编号步骤
直接调用了原生 `updateViewMessageIds(startIndex)`（按 `[0,
minId].includes(id) ? id : null` 算 `startIndex`），理由是「它自身对 DOM 容
忍，且是 DOM-DECOUPLING.md 认可的『写回受遮罩原生窗口以维持宿主一致性』范
例」。这个理由不成立：原生 `updateViewMessageIds` 的 `null` 分支靠重新扫描
**当前** DOM 求 `minId = getFirstDisplayedMessageId()` 作为重编号基准，其正确
性默默依赖原生 `deleteMessage()` 自身的 DOM 门卫前提——被删行自己的 `.mes`
节点原本在 DOM 里、且刚被物理移除，DOM 的最小值因此真的变了。Tier 2 的整条
存在意义就是撤除这个门卫，于是当被删 id 本身从未渲染而更晚的行已渲染时（
chat_truncation 截断窗口下的常见形态），DOM 最小值压根没变，委托给原生函数
的重编号就悄悄退化成空操作——每个仍渲染行保留删除前的 `mesid`，而
`chat.splice` 早已把它们的数组下标全部减了 1。此后每一个按 mesid 寻址的动作
（编辑、swipe、regen 菜单）都会静默落到错误的 `chat[]` 条目——数据损坏，且
不会被冒烟测试发现。修复：`_renumberRenderedRowsAfterDelete`
（`src/adapter/messages.ts`）自己拥有重编号规则，只拿每行**自己删除前**的
`mesid` 属性跟被删 id 直接比较（大于则减 1，小于原样不动，等于说明该行已被
上一步移除），对任何渲染/未渲染组合都按构造正确，不再从 DOM 重新推导任何基
准值；`updateEditArrowClasses`（真正的逐行副作用之一，且从不自行推导基准）
仍委托原生实现。详见下方「逐动作裁决」delete（整条）行、已拍板决策 #3、推进
顺序 Tier 2、契约测试清单、INVARIANTS.md §2/§7/§15/§16。

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
| delete（整条） | **薄分叉，已在 Tier 2 落地（2026-07-19）；DOM 门卫已撤除** | ST `deleteMessage()` 第一行即 DOM 门卫（script.js:1633-1636），挡住含确认弹窗在内的整个函数；但门后仅约 10 行纯数据簿记（splice、tainted、itemized-prompt 失效、renumber、debounced save、this_edit_mes_id 重置、refreshSwipeButtons、`MESSAGE_DELETED`），全部经核实 DOM 容忍——`_deleteFullMessageById`（`src/adapter/messages.ts`）逐字复刻这段本体，彻底不再调用 ST 原生 `deleteMessage()`。`this_edit_mes_id` 本身模块私有、只导出 setter 没有 getter（script.js:7101 vs 610），分叉用一个模块私有影子变量精确镜像它（见该函数与 `_shadowEditedMessageId` 的文档注释，及 INVARIANTS.md §7）；重编号步骤**不**委托原生 `updateViewMessageIds`——该函数的 DOM-自重推基准在 Tier 2 撤除门卫后并不安全（2026-07-19 复审发现并修复，见上方「2026-07-19 复审再次发现并修复」段落），`_renumberRenderedRowsAfterDelete` 自己按「新旧 mesid 与被删 id 比较」的规则实现，只委托同样已导出、但从不自行推导基准因而安全的 `updateEditArrowClasses`。删「哪一部分」的编排（`getDeleteEligibility`/`getConfirmMessageDeleteSetting`/`deleteMessageWithIntent` 三件套 + 确认弹窗）整体上移到 `store/chat-actions.ts`，见已拍板决策 #3 |
| edit（保存） | 分叉 + 契约测试（已拍板） | `updateMessage()` 依赖的纯函数均有导出（getRegexedString / substituteParams / extractMessageBias / removeMacros / ensureSwipes）；分叉复刻其 ~15 行编排，用契约测试钉死行为，ST 升 pin 时 CI 大声失败而非静默漂移 |
| edit（取消） | 无需任何 ST 调用 | SillyLounge 草稿在自己手里，取消即丢弃本地状态（可选清 `setEditedMessageId(undefined)`，script.js:7101 有导出） |
| swipe（切换候选） | 无限期推迟（已拍板） | 成功路径本身 DOM 驱动（`addOneMessage` type='swipe' 原地更新节点，script.js:2513/10233）；但 ST 自身限制仅末条可 swipe（isMessageSwipeable，script.js:9136），截断留 1 条恰好保住末条 |
| 停用恢复 | **2026-07-19 机制已落地并复审修订（`adapter/native-window-guard.ts`），单测背书；标志默认关闭，浏览器级验收待补** | reload 方案：停用时尝试写回真值 → 经既有事务层 `reloadRequired` 终局机制（`sealHostOperationQueueForReload` + `enqueueHostTask`，`src/index.ts::disableChatuiLayers`）→ `location.reload()`，顺带清干净全部模块级残留状态（含无复位口的 `swipeState`）。覆盖值绝不永久污染用户配置的四层防线均已实现并单测：(a) 激活时先把真实 `chat_truncation` 写一次性备份进 SillyLounge 自有 `extensionSettings`（`backupOnce`，三态返回 `established`/`already-present`/`unreadable`），仅当存在有效恢复点（前两态之一）才做内存覆盖（`applyOverride`，值为 1——ST 把 0 解读为「无限制」，覆盖值绝不能是 0）——`unreadable`（读不出有限数字）时 `activateNativeTruncationGuard()` 拒绝激活并 `console.warn`，绝不裸奔覆盖；(b) 备份存在期间的再次激活绝不覆写（写一次语义）；(c) 每次启动（含 bootstrap / 标志关闭模式）在 `index.ts::init()` 最前面无条件跑自愈检查（`selfHealNativeTruncation`），发现「存有备份且当前仍是覆盖哨兵值」即写回并清空备份——防崩溃/强关标签页、也防停用时的 `saveSettingsDebounced` 与 `location.reload()` 赛跑；(d) `restoreForDisable()` 镜像 (c) 的守卫哲学：只有当前值仍是覆盖哨兵才真正写回备份，若用户已经过 ST 原生 `#AdvancedFormatting` 抽屉（不受 st-dom-shield.ts 遮罩）手动改过 `chat_truncation`，手动值权威，停用恢复按兵不动、只清掉过期备份，绝不用陈旧备份覆盖用户刚做的选择。激活被 `store/config-store.ts` 的 `nativeTruncationOverrideEnabled` 标志整体门控，默认 OFF——edit（保存）/delete（整条）在 Tier 2/3 前仍是 DOM 门卫，截断到 1 会打断非末条消息的这两个动作；但 `disableChatuiLayers()` 的停用分叉按 `isNativeTruncationGuardLive()` 报告的「本次会话覆盖是否真的在生效」分叉，而非按标志的当前取值分叉，故标志未来接出 UI 开关后半途翻掉也不会把仍在生效的覆盖错误地导向裸 `teardown()`（无写回、无 reload）。单测见 INVARIANTS.md §14；index.ts 接线本身（真实「停用即刷新」往返、真实 bootstrap 自愈）尚无浏览器级驱动，见 INVARIANTS.md §15 |

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
   **2026-07-19 Tier 2 收口（本条过渡方案已解决）**：直调 ST 原生弹窗的调用已
   经拆掉，替换为完全由 ChatUI 拥有视觉与交互的确认组件——`store/confirm-
   store.ts`（仿 toast-store.ts 写法的 promise 化 request/resolve 状态机，单测
   见 INVARIANTS.md §15）+ `ui/components/ConfirmDialogHost.tsx`（挂载在
   app 根，`ConfirmDialog.tsx` 加了一个可选的第三按钮「escalate」支撑三态弹
   窗，其余既有调用方不受影响）。编排本身（读 `confirm_message_delete`、判断
   `canDeleteSwipe`、决定弹两态还是三态、把用户的选择映射成
   `deleteMessageWithIntent` 的显式 intent）整体上移到 `store/chat-actions.ts`
   的 `deleteChatuiMessage`（单测见 INVARIANTS.md §2）——弹窗等待过程故意留在
   共享宿主队列**之外**，只有真正决定要执行的变更才入队，避免用户盯着对话框
   发呆时挡住其它排队操作。措辞（"Are you sure you want to delete this
   message?" / "Delete Swipe" / "Delete Message" / "Cancel"）与 ST 原生逐字一
   致，用户已经认得这套文案。adapter 层（`src/adapter/messages.ts`）现在完全
   不含任何 UI：`getDeleteEligibility()`/`getConfirmMessageDeleteSetting()` 只
   读不问，`deleteMessageWithIntent()` 只按调用方已经决定好的 intent 执行，从
   不弹窗、从不读设置。

## 推进顺序

1. **Tier 1（零风险，先行）**：copy / branch / checkpoint / hide / 仅删 swipe 五个动作
   改为按 id 直调；撤掉 `triggerMessageActionById` 对这五个动作的 `getMessageElementById`
   一票否决门卫。零保真损失。
   **2026-07-19 复审修订**：仅删 swipe 分支的「按 id 直调」实际内容从「直调
   `deleteSwipe()`」升级为 mini-fork（见上表），并补回了确认弹窗（上面决策 #3
   的修订）；整条删除分支的 `getMessageElementById` 门卫并未撤除——`triggerMessageActionById`
   分发入口无法区分 delete 的两个子分支，门卫下沉到 `deleteMessage()` 内部按子
   分支显式判定。
2. **停用恢复机制**（reload 方案，见上表 2026-07-19 修订）：真值备份 + 内存覆盖 +
   开机自愈 + 停用时写回并 `location.reload()`；它阻塞整个截断上线，独立于任何
   动作层选择。**2026-07-19：机制已实现并接线（`adapter/native-window-guard.ts` +
   `src/index.ts`），但仍挡在 Tier 2/3 之前（现已收窄为只挡 Tier 3）**——
   `nativeTruncationOverrideEnabled` 标志默认关闭；delete（整条）已在 Tier 2 落地
   摆脱了对 `.mes` 节点的依赖，但 edit（保存）在 Tier 3 落地前仍依赖非末条消息
   的 `.mes` 节点存在，截断到 1 会当场打断它；标志翻开仍需等 Tier 3 落地。
3. **Tier 2：delete 薄分叉** + 自实现确认 UI + 契约测试。**2026-07-19 已落地**：
   delete（仅 swipe）的 mini-fork 已在 Tier 1 提前完成（同等契约测试对待，见
   下）；delete（整条）本身的薄分叉（`_deleteFullMessageById`，DOM 门卫已撤除，
   逐字复刻原生门后本体）与 ChatUI 自有确认组件（`store/confirm-store.ts` +
   `ui/components/ConfirmDialogHost.tsx`，替换掉 Tier 1 过渡期直调的 ST 原生弹
   窗）均已完成并有单测背书（INVARIANTS.md §2/§7/§15）。删除相关的编排整体上移
   到 `store/chat-actions.ts`，adapter 层不再含任何 UI——本轮过后**只剩 Tier 3
   挡在标志翻开之前**。
4. **Tier 3：edit 保存分叉** + 契约测试（见下）。

## 契约测试清单（防 ST 升 pin 静默漂移）

- `updateMessage()` 定序样张：固定输入 + regex/macro/bias 配置下，分叉产物与原生
  路径的 `mes.mes` / `swipes[swipe_id]` / `extra.bias` 字节一致；关键顺序：regex 的
  isEdit 分支 → bias 提取在 substituteParams 之前、赋值仅限特定角色类型 →
  `ensureSwipes` 先于 swipes 写入 → `tainted=true` → `MESSAGE_EDITED` 严格先于
  `MESSAGE_UPDATED`。
- `deleteMessage()` 门后体样张（**2026-07-19 Tier 2 已落地，2026-07-19 复审后
  修复重编号陷阱**，`test/messages.test.mjs`，见 INVARIANTS.md §7）：分叉
  （`_deleteFullMessageById`，经 `deleteMessageWithIntent(id,'message')` 驱
  动）的 splice / tainted / itemized-prompt 失效 / 自有重编号
  （`_renumberRenderedRowsAfterDelete`，不再委托原生 `updateViewMessageIds`）/
  `saveChatDebounced`（非 `saveChatConditional`）/ `this_edit_mes_id` 影子重置 /
  `refreshSwipeButtons` / `MESSAGE_DELETED` 载荷——序列与原生可观测行为逐一对应，
  且严格按原生顺序。重编号规则本身另有专门契约测试直接对着真实（假 DOM）
  `#chat` 树断言：被删 id 未渲染、更晚行已渲染时全部减 1（含「被删 id 恰是渲染
  最小值」——两者在残余 DOM 上无法区分）；中间位置被删时删除点以下不动、以上减
  1；chat_truncation=1 下删除唯一渲染行；删除 id 0 的边界。
- `_deleteSwipeById` mini-fork（2026-07-19 提前到 Tier 1，已有 test/messages.test.mjs
  背书，见 INVARIANTS.md §7）：splice swipes/swipe_info、swipe_id 重算三分支
  （小于/大于/等于 currentSwipeId）、`chat_metadata.tainted`、`MESSAGE_SWIPE_
  DELETED` 载荷、`saveChatConditional` 与原生 `deleteSwipe()` 可观测行为字节一
  致；活跃/非活跃分支：删除**未渲染消息的当前活跃 swipe** 时，必须经由纯函数
  `syncSwipeToMes`（script.js:6895，已核实 DOM-free）同步 `mes`——mini-fork 从不
  进入 ST 的 `deleteSwipe()`/`swipe()`，因此不存在「或显式拒绝」的退路，同步是
  唯一路径。
- `this_edit_mes_id` 生命周期（**2026-07-19 Tier 2 已落地**，见 INVARIANTS.md §7）：
  ST 只导出 setter、没有 getter（script.js:7101 vs 610），删除分叉用一个模块私
  有影子变量（`_shadowEditedMessageId`）精确镜像真实值——仅当影子等于被删 id 才
  调 `setEditedMessageId(undefined)`，追踪另一条消息时绝不触碰；`saveMessageEditById`
  是唯一会写这个影子的路径（进入 ChatUI 自有编辑 UI 是纯本地状态，从不碰真实
  变量），且编辑保存与删除共享同一条全局串行宿主队列，不会交叠——已知残留缺口
  仅剩「绕过 ChatUI 遮罩、直接操作原生 DOM」，见 INVARIANTS.md §16。
- confirm-store 状态机（**2026-07-19 Tier 2 已落地**，`test/confirm-store.test.mjs`，
  见 INVARIANTS.md §15）：request/resolve/cancel 的 promise 语义、同一时刻至多一
  个待答请求（新请求抢占旧请求、旧请求以 'cancel' 结算绝不留空悬）、二态请求绝
  不带 escalateLabel。
- `deleteChatuiMessage`（`store/chat-actions.ts`，**2026-07-19 Tier 2 已落地**，
  `test/chat-actions.test.mjs`，见 INVARIANTS.md §2）：confirm_message_delete 为
  false 时跳过弹窗；true 时按 `getDeleteEligibility()` 决定两态还是三态弹窗，
  三态的默认项/升级项/取消分别映射到仅删 swipe / 整条删除 / 零变更；对话框仍开
  着时会话切换必须让最终执行按会话键拒绝。
- 停用恢复 smoke（按 reload 方案改写）：真 Chromium 验收——停用并刷新后
  `chat_truncation` 恢复为用户原值、`#chat` 含完整（非截断）原生消息集；另需
  自愈用例：人为把覆盖值持久化后以 bootstrap 模式启动，断言开机守卫写回原值。
- **2026-07-19 新增缺口**（浏览器层，见 INVARIANTS.md §16）：ChatUI 自有确认对
  话框组件（`ConfirmDialogHost`/`ConfirmDialog` 的真实渲染与三态按钮点击）与
  「点击删除 → 真弹窗 → 点击真按钮 → ST 真实 `chat`/`#chat` 发生预期变化」的端
  到端路径，目前零浏览器级驱动；`_deleteFullMessageById` 里真正依赖真实 DOM、
  且假 DOM 结构性做不到的一步——目标消息确实渲染时 `mesEl?.remove()` 真的移走
  渲染节点——同理仍待浏览器层验收。`_renumberRenderedRowsAfterDelete` 本身的重
  编号规则已改走 `#chat` 直接 `.children` + 纯 classList 树遍历（不依赖复合选
  择器），2026-07-19 复审后已由假 DOM 单测直接覆盖（见上方契约测试清单），不再
  是这条缺口的一部分。

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
