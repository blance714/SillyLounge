# 消息动作 DOM 解耦设计

2026-07-19 调研产出（四条只读侦察线逐行核实锁定宿主 SillyTavern v1.18.0 /
commit 51ad27f，全部结论有 file:line 背书），随后三项关键决策已拍板。本文取代
PERFORMANCE.md「隐藏原生消息窗口实验」末段对产品化工作的粗分类——那里把
delete 与 swipe 错误地归入「可直接按 ID 调用」。

目标：原生消息窗口截断到 1（实测再省约 29% 切换耗时、切换 long task 归零）后，
所有消息动作在目标 `.mes` 节点不存在时依然正确。

## 逐动作裁决

| 动作 | 裁决 | 依据 |
| --- | --- | --- |
| copy | 直接按 id 调 | 改 `copyMessage` 收 mesId，走 `getMessageById` + `copyText`（utils.js:546，clipboard API 主路径零 DOM） |
| branch | 直接按 id 调 | `branchChat(mesId,{swipeId})`（bookmarks.js:449）全程不查 `.mes`；导航副作用是有意的 |
| checkpoint | 直接按 id 调 | `createNewBookmark` 唯一 DOM 触碰是装饰性 ribbon 标签更新，jQuery 空选择安全无操作（bookmarks.js:292-310） |
| hide / unhide | 本就 DOM-free | `hideChatMessageRange` 对缺失 DOM 逐条跳过而非中止（chats.js:160-162）；注意 ST 不发任何 hide 事件，同步只能重读 `is_system`（现状已如此） |
| delete（仅 swipe） | 直接调 `deleteSwipe()` | 绕开外层 `deleteMessage()` 包装；`deleteSwipe` 顶部无 DOM 门卫（script.js:9279-9346）。⚠️ 见下方 ST bug |
| delete（整条） | 薄分叉（~10 行） | ST `deleteMessage()` 第一行即 DOM 门卫（script.js:1633-1636），挡住含确认弹窗在内的整个函数；门后仅 ~10 行纯数据簿记（splice、tainted、itemized-prompt 失效、`MESSAGE_DELETED`），全部 DOM 容忍，可分叉 |
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

## 推进顺序

1. **Tier 1（零风险，先行）**：copy / branch / checkpoint / hide / 仅删 swipe 五个动作
   改为按 id 直调；撤掉 `triggerMessageActionById` 对这五个动作的 `getMessageElementById`
   一票否决门卫。零保真损失。
2. **停用恢复机制**：`chat_truncation` 覆盖 + 恢复 + `printMessages()` 重建；它阻塞
   整个截断上线，独立于任何动作层选择。
3. **Tier 2：delete 薄分叉** + 自实现确认 UI + 契约测试。
4. **Tier 3：edit 保存分叉** + 契约测试（见下）。

## 契约测试清单（防 ST 升 pin 静默漂移）

- `updateMessage()` 定序样张：固定输入 + regex/macro/bias 配置下，分叉产物与原生
  路径的 `mes.mes` / `swipes[swipe_id]` / `extra.bias` 字节一致；关键顺序：regex 的
  isEdit 分支 → bias 提取在 substituteParams 之前、赋值仅限特定角色类型 →
  `ensureSwipes` 先于 swipes 写入 → `tainted=true` → `MESSAGE_EDITED` 严格先于
  `MESSAGE_UPDATED`。
- `deleteMessage()` 门后体样张：分叉的 splice / tainted / itemized-prompt 失效 /
  `MESSAGE_DELETED` 载荷序列与原生可观测行为一致。
- `deleteSwipe` 活跃/非活跃分支：删除**未渲染消息的当前活跃 swipe** 时，必须经由
  纯函数 `syncSwipeToMes`（script.js:6895，已核实 DOM-free）同步 `mes`，或显式拒绝。
- `this_edit_mes_id` 生命周期：异步编辑/删除前后成对调用 `setEditedMessageId`，
  保住原生 beforeunload 守卫与 swipe 门的诚实性。
- 停用恢复 smoke：ChatUI 卸载后 `#chat` 含完整（非截断）原生消息集，真 Chromium 验收。

## 附带发现与残留风险

- **ST 自身数据损坏路径**（分叉必须补坑，可考虑上游报告）：`deleteSwipe` 删除
  未渲染消息的当前活跃 swipe 时，swipes 数组与 swipe_id 已提交并持久化，但同步
  `mes` 文本的步骤经由 `swipe()` 的 DOM 门卫静默失败——`mes` 留存已删 swipe 的文本。
- `this_edit_mes_chname` 无导出 setter（script.js:608 模块私有）：分叉期间原生
  `.mes` 的显示名读取可能短暂过期；对 ChatUI 自有 formatter 无影响。
- reasoning 自动提交级联（script.js:8366 ↔ reasoning.js:1271）无非 DOM 入口；当前
  对 SillyLounge 为空操作，若未来做原生 reasoning 编辑 UI 需专项处理。
- translate 扩展监听 `MESSAGE_UPDATED` 后触碰原生 `.mes` DOM（translate/index.js:772），
  截断下行为未追踪——上线截断前需验证。
