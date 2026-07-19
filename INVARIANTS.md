# 不变量清单（INVARIANTS.md）

这份文件是本项目「审测试而不是通读实现」评审模式的入口：每一行把一条**用户可感知的
行为承诺**映射到背书它的**具体测试**。评审一次改动时，先看这张表的差异——新增了哪些
承诺、哪些承诺换了背书、哪些已知缺口被补上——而不是从头读实现。

维护规则（由 `scripts/check-invariants.mjs` 强制，已接入 `pnpm run verify`）：

- 引用格式为反引号包裹的「文件路径 :: 测试标题原文」，例如
  `test/state-contracts.test.mjs :: a failed host task does not poison the serialized lane`。
  正向校验：清单里引用的每条测试必须真实存在；反向校验：`test/` 顶层每个单元测试都
  必须在清单登记。两边任何脱节都会让 `verify` 失败。
- 测试数量不手写。需要数量时运行 `node --test`，需要范围时看这份清单。
- 已知未覆盖的承诺记在文末「未覆盖缺口」，它是补测待办，不是装饰。

---

## 1. 宿主操作队列与生命周期

对 SillyTavern 单一可变会话上下文的所有写操作串行通过一条队列；队列的正确性是全部
上层操作（发送、编辑、删除、切换）的地基。

| 不变量 | 验证 |
| --- | --- |
| 所有宿主变更操作严格串行；排队中的导航采取"最后意图胜出" | `test/state-contracts.test.mjs :: host operations serialize and queued navigation uses last-intent-wins` |
| 单个任务失败不污染串行通道，后续任务照常执行 | `test/state-contracts.test.mjs :: a failed host task does not poison the serialized lane` |
| 生命周期重置会拒绝已声明可拒的排队变更，且不与活跃任务重叠执行 | `test/state-contracts.test.mjs :: lifecycle reset rejects opted-in queued mutations without overlapping the active task` |
| 新生命周期等待旧活跃任务收尾，同时取消旧的排队工作 | `test/state-contracts.test.mjs :: a new lifecycle waits for the old active task while cancelling old queued work` |
| 终局重载封印后，排队中与新入队的变更一律被拒绝 | `test/state-contracts.test.mjs :: terminal reload seal rejects both queued and newly-enqueued mutations` |
| 有界工作协调器限制并发上限，脏标记只补跑一次 | `test/state-contracts.test.mjs :: bounded work coordinator caps concurrency and runs one dirty follow-up` |
| 销毁有界工作协调器时丢弃排队与补跑工作 | `test/state-contracts.test.mjs :: disposing bounded work drops queued and follow-up work` |

## 2. 动作门禁与生成队列（chat-actions）

| 不变量 | 验证 |
| --- | --- |
| 排队操作执行前若会话已切换，必须拒绝且绝不触达宿主（不把内容写进错误会话） | `test/chat-actions.test.mjs :: a composer send queued for a chat that changed before it runs is rejected and never reaches the host` |
| 会话未变时排队发送恰好触达宿主一次，文本原样送达 | `test/chat-actions.test.mjs :: a composer send queued for the still-current chat reaches the host exactly once with the sent text` |
| 生成型操作独占串行通道直到生成结束，之后才放行下一个任务 | `test/chat-actions.test.mjs :: generation holds the serialized host lane until it stops, then releases the next queued task` |
| 队列中单个操作抛错不拖垮后续操作 | `test/chat-actions.test.mjs :: a queued operation that throws does not poison the lane for the next queued operation` |
| 过期的生成操作必须给用户可见的错误 toast，不允许静默失败 | `test/chat-actions.test.mjs :: a stale generation operation surfaces an error toast the UI can observe` |
| 后台 quiet/dryRun 生成事件不得冒充本次触发的真实生成，既不满足启动判定也不释放锁 | `test/chat-actions.test.mjs :: a quiet-typed or dry-run GENERATION_STARTED during the wait neither satisfies the start nor releases the lane` |
| 宿主 `isGenerating()` 仍为 true 时，GENERATION_ENDED 不足以释放串行锁 | `test/chat-actions.test.mjs :: a GENERATION_ENDED that fires while isGenerating() still reports true does not release the lane` |
| 群聊重新生成实际上报 type 为 "normal"，且必须等 GROUP_WRAPPER_FINISHED 才释放锁 | `test/chat-actions.test.mjs :: a group regenerate reports type "normal" and only releases the lane once GROUP_WRAPPER_FINISHED fires, even though isGenerating() reads true through every member turn` |
| 合成点击被宿主静默丢弃时，启动超时以独立错误拒绝、清理监听器、队列继续服务 | `test/chat-actions.test.mjs :: a started-timeout rejects the stuck operation with a distinct toast, keeps serving the queue, and removes its listeners` |

## 3. 会话事务：选择指针 / 重命名 / 删除（adapter/chats）

全库并发最凶险的子系统。共同原则：**从不信任 HTTP 状态码，每次写入用回读确认；
状态不明时不放锁，但墙钟受共享重试预算约束，超限后落到契约里诚实的模糊结论**
（`unknown` / `uncertain` / `reloadRequired`），绝不编造确定结果。

| 不变量 | 验证 |
| --- | --- |
| 写入被接受且回读确认落在目标上时返回 persisted | `test/adapter-chats.test.mjs :: persistCharacterChatSelection resolves persisted when the write is accepted and readback confirms the target` |
| 并发写入胜出（回读见到别的选择）时立即如实返回 different，不做无谓重试 | `test/adapter-chats.test.mjs :: persistCharacterChatSelection resolves different immediately when an accepted write is confirmed to have lost to another selection` |
| 写入被明确拒绝且回读确认未落地时直接返回 rejected，不进入重试 | `test/adapter-chats.test.mjs :: persistCharacterChatSelection resolves rejected without retrying once an HTTP-rejected write is confirmed never to have landed` |
| 网络异常导致结果不明时绝不假定失败，持续重试直到有明确证据 | `test/adapter-chats.test.mjs :: a network-throwing write is treated as ambiguous and only resolves once a later write proves the outcome` |
| 写入已被接受后，回读的暂时性失败只重试回读本身，绝不重复写入 | `test/adapter-chats.test.mjs :: an accepted write survives transient HTTP failures on the readback and resolves once a read finally confirms the target` |
| 持续故障耗尽重试预算后，指针持久化诚实返回 unknown 而不是永久重试 | `test/adapter-chats.test.mjs :: persistCharacterChatSelection gives up and resolves unknown once the retry budget is exhausted by a sustained outage` |
| 读取指针遇到非成功响应必须抛错，不返回过期值 | `test/adapter-chats.test.mjs :: readCharacterChatSelection throws on a non-ok response instead of returning a stale value` |
| 原始文件列表按 file_id 取值、去 .jsonl 后缀、丢弃空白条目 | `test/adapter-chats.test.mjs :: listRawCharacterChatNames strips .jsonl and drops blank entries from the raw directory listing` |
| 重命名参数非法时在任何网络请求之前短路，结果落安全默认值 | `test/adapter-chats.test.mjs :: rename requests that fail basic input validation short-circuit before touching the host` |
| 目标文件不在目录列表时只做一次存在性检查，绝不发出真正的重命名请求 | `test/adapter-chats.test.mjs :: renaming a file absent from the raw directory listing returns invalid after one existence check, without issuing a rename request` |
| 无指针竞态的干净重命名报告成功，并以确认后的文件名广播 CHAT_RENAMED | `test/adapter-chats.test.mjs :: a clean rename with no card-pointer race reports success and emits CHAT_RENAMED with the confirmed filenames` |
| 对账落在非目标文件上的当前会话重命名必须判 uncertain，绝不报干净成功 | `test/adapter-chats.test.mjs :: a current-chat rename is uncertain, not clean, when reconciliation lands on a different durable file than the rename target` |
| 回滚撞上文件名冲突时整体报 uncertain，绝不出现虚假的 renamed+reconciled | `test/adapter-chats.test.mjs :: a rename rollback that lands in a file conflict is reported uncertain, never a false clean success` |
| 正向重命名在回读持续失败耗尽预算后报 uncertain+reloadRequired | `test/adapter-chats.test.mjs :: a current-chat forward rename gives up and reports uncertain+reloadRequired once the retry budget is exhausted by a sustained readback outage` |
| 重命名安全对账在持续故障下最终放弃并要求刷新，不永久占用串行通道 | `test/adapter-chats.test.mjs :: reconcileCurrentRenameSafety gives up and reports uncertain+reloadRequired once the retry budget is exhausted by a sustained outage` |
| 删除请求缺参时不发任何网络请求，直接返回未变更 | `test/adapter-chats.test.mjs :: deleting with a missing avatar or filename resolves unchanged without contacting the host at all` |
| 待删文件不存在时只做一次存在性检查，绝不发出破坏性请求 | `test/adapter-chats.test.mjs :: deleting a chat absent from the raw directory listing resolves unchanged after one existence check, without issuing the destructive request` |
| 删除非当前、非指针会话时干净成功并广播 CHAT_DELETED | `test/adapter-chats.test.mjs :: deleting a non-current chat that is not the character-card pointer resolves cleanly and emits CHAT_DELETED` |
| 删除后核实读取暂时性失败时有界重试，直到确认文件消失才报 deleted | `test/adapter-chats.test.mjs :: the post-delete existence check retries through transient read failures and resolves deleted once the listing confirms removal` |
| 核实读取成功但文件仍在时立即如实报 deleted:false，不进入轮询 | `test/adapter-chats.test.mjs :: a listing that successfully reads back but still shows the file resolves deleted:false immediately, without polling` |
| 删除当前会话必须先持久化替换指针、要求刷新，且绝不向将失效的运行时广播 CHAT_DELETED | `test/adapter-chats.test.mjs :: deleting the current chat persists the replacement pointer before deleting and always requires a reload, never emitting CHAT_DELETED` |
| 删除后轮询耗尽预算时只能报 uncertain，绝不回滚指针（防止指向已不存在的文件） | `test/adapter-chats.test.mjs :: the post-delete existence poll gives up and reports uncertain, without rolling back the pointer, once the retry budget is exhausted` |
| 重命名响应体不可解析时，目录差集唯一新增匹配目标即判定成功 | `test/adapter-chats.test.mjs :: a rename response with an unparseable body infers a clean success from a single matching directory addition` |
| 响应体不可解析且旧名仍在时判定冲突（uncertain），不谎报干净成功 | `test/adapter-chats.test.mjs :: a rename response with an unparseable body infers a conflict when the old name and a single addition coexist` |
| 目录差集含多个新增无法唯一定位时诚实报 unknown，不臆测文件名 | `test/adapter-chats.test.mjs :: a rename response with an unparseable body honestly reports unknown when the directory diff is ambiguous, without guessing a filename` |
| 非当前会话重命名输掉指针竞态时就地跟随胜者，文件改名本身仍报干净成功 | `test/adapter-chats.test.mjs :: a non-current rename that loses the character-card pointer race still reports a clean success and follows the winner locally` |
| 当前会话重命名的指针竞态分支自身绝不改写实时记录，结果完全交给安全对账 | `test/adapter-chats.test.mjs :: a current-chat rename that loses the character-card pointer race defers entirely to reconcileCurrentRenameSafety, never acting on the race itself` |
| live 文件消失但持久指针仍指向真实文件时，直接采用该指针且零写入，要求刷新 | `test/adapter-chats.test.mjs :: reconcileCurrentRenameSafety uses an already-valid durable pointer directly once the live session file is gone, without writing anything` |
| live 文件与持久指针均失效时，回退定位重命名目标并持久化，干净收敛 | `test/adapter-chats.test.mjs :: reconcileCurrentRenameSafety falls back to the renamed file when the live session file is gone and the durable pointer is stale, converging cleanly` |
| 仅剩原文件名可回退时持久化成功，但因与重命名目标不符必须标记 uncertain | `test/adapter-chats.test.mjs :: reconcileCurrentRenameSafety falls back to the original file when neither the live session file nor the renamed file survives, and flags the mismatch as uncertain` |
| 回退到重命名目标对齐指针时被并发写抢先，必须报 uncertain 并要求刷新 | `test/adapter-chats.test.mjs :: reconcileCurrentRenameSafety reports uncertain and forces a reload when a concurrent write wins while recovering onto the renamed file` |
| 回退到原文件名对齐指针时被并发写抢先，同样报 uncertain 并要求刷新 | `test/adapter-chats.test.mjs :: reconcileCurrentRenameSafety reports uncertain and forces a reload when a concurrent write wins while recovering onto the original file` |
| 删除当前会话时替换指针竞态失利，立即放弃删除并要求刷新，绝不发出破坏性请求 | `test/adapter-chats.test.mjs :: deleting the current chat abandons the operation and requires a reload when a concurrent writer wins the pointer race, never issuing the destructive request` |
| 删除非当前会话时竞态失利，跟随胜者对齐本地指针后仍安全继续删除 | `test/adapter-chats.test.mjs :: deleting a non-current chat that loses the character-card pointer race still safely proceeds with the destructive request and follows the winner locally` |
| 指针已持久化到发出 DELETE 的间隙内生成开始，必须回滚指针并放弃删除 | `test/adapter-chats.test.mjs :: deleting the current chat rolls the pointer back and abandons the delete when generation starts in the gap between persisting the replacement and issuing DELETE` |
| 同一间隙内聊天保存开始，同样回滚指针并放弃删除（覆盖两个析取分支） | `test/adapter-chats.test.mjs :: deleting the current chat rolls the pointer back and abandons the delete when chat saving begins in the gap between persisting the replacement and issuing DELETE` |

## 4. 消息视图模型与流式（chat-store）

| 不变量 | 验证 |
| --- | --- |
| 进入会话只建轻量索引，DTO 按需物化且总量不超过缓存上限（96） | `test/chat-store.test.mjs :: lazy materialization: indexing a chat builds no message DTOs, and requesting more than the cache limit keeps the live cache at the limit` |
| 有活跃订阅的消息绝不被淘汰，DTO 引用跨无关物化保持稳定（useSyncExternalStore 契约） | `test/chat-store.test.mjs :: subscriber pinning: a message with an active subscription is never evicted, and its DTO reference is stable across unrelated materializations` |
| 切换会话整体清空旧会话 DTO 与格式化 HTML 缓存，杜绝跨会话串内容 | `test/chat-store.test.mjs :: chat switch clears the previous chat DTO cache: no cross-chat leakage of materialized DTOs or formatted HTML` |
| 流式 token 更新只重建被改动的一行，绝不退化为全量重建（O(1) 流式承诺） | `test/chat-store.test.mjs :: refreshChatuiMessage targets exactly the changed row: unrelated DTOs, the top-level state reference, and materialization counters are all left untouched` |
| 切换会话不清空其它会话的输入框草稿 | `test/chat-store.test.mjs :: composer drafts for chats other than the one being switched away from survive a CHAT_CHANGED refresh` |
| 轻量索引投影不携带昂贵内容字段（全文/swipes/extra） | `test/state-contracts.test.mjs :: message index projection ignores expensive content fields` |
| 原始宿主消息在 adapter 边界规范化为不可变 DTO，畸形字段回退安全默认值 | `test/state-contracts.test.mjs :: raw messages are normalized into an immutable adapter-boundary DTO` |
| 现代数组形状附件（extra.media/files）按序精确投影，无附件消息投影空列表不抛错 | `test/chat-store.test.mjs :: message DTO attachment projection: array-shaped media/files extras project ids, urls, titles, and order exactly, including display/inline/mediaIndex overrides` |
| 旧版单字段附件（extra.image/video/file）按固定顺序经回退形状投影 | `test/chat-store.test.mjs :: message DTO attachment projection: legacy single image/video/file extras project through the fallback shape without throwing` |
| 格式化 HTML 缓存超过上限（1024）后持续裁剪收敛，不无界增长 | `test/chat-store.test.mjs :: the formatter HTML cache trims to FORMAT_HTML_CACHE_LIMIT once distinct formatted messages exceed it` |
| 同一消息的正文与推理文本 HTML 各占独立缓存槽，互不覆盖、互不代答 | `test/chat-store.test.mjs :: the formatter HTML cache keeps a message's reasoning-text HTML and body HTML in independent slots, so editing one never reformats or leaks into the other` |

## 5. 临时会话隔离（temp-chat）

新建但尚未被采纳的会话被隔离在版本戳保护的隔离区里；所有清理/移动/采纳操作都要
通过版本比对拒绝 ABA 竞态。

| 不变量 | 验证 |
| --- | --- |
| 指针与乐观草稿拒绝过期的 ABA 清理 | `test/state-contracts.test.mjs :: temp-chat pointer and optimistic draft reject stale ABA cleanup` |
| 过期的临时会话完成记录文件名，但不抹掉更新的草稿意图 | `test/state-contracts.test.mjs :: stale temp-chat completion records its file without erasing a newer draft intent` |
| 离开临时会话只使其失活，不发布也不阻塞下一个草稿 | `test/state-contracts.test.mjs :: leaving a temp chat deactivates it without publishing or blocking the next draft` |
| 采纳活跃临时会话时保留其它隔离中的草稿 | `test/state-contracts.test.mjs :: adopting the active temp preserves other quarantined drafts` |
| 恢复并重命名隔离草稿后仍被追踪 | `test/state-contracts.test.mjs :: restoring and renaming a quarantined draft keeps it tracked` |
| 结果不明的重命名将两个可能的文件身份同时隔离 | `test/state-contracts.test.mjs :: an uncertain rename quarantines both possible file identities` |
| 单条损坏的持久化租约不能连带发布其它隔离草稿 | `test/state-contracts.test.mjs :: one corrupt persisted lease cannot publish other quarantined drafts` |
| 无关的隔离区变动不使串行化的新会话槽位失效 | `test/state-contracts.test.mjs :: unrelated quarantine churn does not invalidate a serialized new-chat slot` |
| 过期的离开操作不能使更新的活跃临时会话失活 | `test/state-contracts.test.mjs :: stale departure cannot deactivate a newer active temp` |
| 排队导航能捕获用户点击离开之后才创建完成的具体临时会话 | `test/state-contracts.test.mjs :: queued navigation captures a concrete temp created after the user clicked away` |
| 本地工作先于导航采纳临时会话，导航不能重置未决 UI 状态 | `test/state-contracts.test.mjs :: local work adopts a temp before navigation can reset pending UI state` |
| 空操作导航保持当前临时会话活跃以待采纳 | `test/state-contracts.test.mjs :: a no-op navigation keeps the current temp active for later adoption` |
| dry-run 与 quiet 生成探针不采纳未被触碰的临时会话 | `test/state-contracts.test.mjs :: dry-run and quiet generation probes do not adopt an untouched temp chat` |

## 6. 输入框与编辑草稿

| 不变量 | 验证 |
| --- | --- |
| 输入框草稿按会话隔离，过期发送不能抹掉更新的文本 | `test/state-contracts.test.mjs :: composer drafts remain chat-scoped and stale sends cannot erase newer text` |
| 修订号与生命周期纪元双重校验防止文本 ABA 与门闩过早重置 | `test/state-contracts.test.mjs :: composer revision and lifecycle epochs prevent text ABA and premature gate reset` |
| 编辑草稿按 chatKey+messageId 精确写入并原样读回 | `test/message-edit-draft-store.test.mjs :: a draft round-trips through set/get for its exact chatKey + messageId` |
| 从未设置的草稿返回 undefined，与用户主动清空的空串严格区分 | `test/message-edit-draft-store.test.mjs :: no draft ever set reads as undefined, distinct from an explicit empty draft` |
| 保存只清除该消息的草稿，不波及其它草稿 | `test/message-edit-draft-store.test.mjs :: save clears exactly the drafted message and nothing else` |
| 同一会话不同消息的草稿彼此独立 | `test/message-edit-draft-store.test.mjs :: drafts for different messages in the same chat are independent` |
| 不同会话中相同 messageId 的草稿按 chatKey 隔离 | `test/message-edit-draft-store.test.mjs :: the same message id in two different chats keeps separate drafts` |
| ChatUI 整体卸载时的 reset 清空所有草稿 | `test/message-edit-draft-store.test.mjs :: teardown reset clears every retained draft across all chats and messages` |
| 清除不存在的草稿或重复写入相同文本不惊动订阅者 | `test/message-edit-draft-store.test.mjs :: clearing an unset draft and re-setting the same text are both no-ops on subscribers` |
| 未经保存/取消的卸载不丢草稿，重新挂载可恢复原文 | `test/message-edit-draft-store.test.mjs :: an unmount without save or cancel leaves the draft intact for the next mount to seed from` |

## 7. 消息动作参数（adapter/messages）

传错参数就是删错内容。这一节把传给宿主的参数矩阵钉死。DOM-DECOUPLING.md Tier 1
（2026-07-19，2026-07-19 复审后修订）：copy / branch / checkpoint / hide / delete
（仅删 swipe 分支）改为按 id 直调，不再要求存活的 `.mes` 节点。

复审三项高危发现的根因修复（详见 src/adapter/messages.ts 对应函数的文档注释）：

1. **`_deleteSwipeById` 从「直调 ST `deleteSwipe()`」升级为完整 mini-fork**：ST 自
   身 `deleteSwipe()` 在删除活跃 swipe 分支内部会调用其 `swipe()`，后者在自己的
   DOM 门卫前先把模块级 `swipeState` 置为 SWIPING，且该变量无任何导出的重置口
   子——未渲染消息会把 `swipeState` 卡死，app 全局的发送与后续 swipe 全部静默失
   效。由于本文件的资格判定策略保证仅删 swipe 分支删除的必是当前活跃 swipe，走
   ST 的 `deleteSwipe()` 会让这条损坏路径每次必现，因此彻底不再调用 ST 的
   `deleteSwipe`/`swipe`：直接对 `chat[]` 活对象复刻其纯函数体（splice
   swipes/swipe_info、重算 swipe_id、`chat_metadata.tainted`、`MESSAGE_SWIPE_
   DELETED`、`syncSwipeToMes`、`saveChatConditional`）。
2. **恢复删除确认弹窗**：仅删 swipe 分支不再绕开确认弹窗——`getContext()` 已经通
   过既有映射的 `@st/st-context` 模块重导出 `callGenericPopup`/`POPUP_TYPE`/
   `POPUP_RESULT`/`t`（`public/scripts/st-context.js`），无需新增 `@st/*` 映射。
   取消（含转义）零改动中止；「Delete Message」自定义按钮升级为整条删除（仍走
   DOM 门卫，不二次弹窗）——完整复刻 ST 原生措辞与三态行为。
3. **整条删除分支恢复显式 DOM 门卫**：`_deleteFullMessageById` 在目标 `.mes` 节
   点缺失时抛出说明「Tier 2 落地前维持门卫」原因的描述性错误，而不是让 ST 内部
   门卫静默 no-op；仅删 swipe 分支保持无门卫。`triggerMessageActionById` 自身不
   下判——只有读到消息记录后的 `deleteMessage()` 才能分辨两个子分支，门卫因此放
   在 `deleteMessage()` 内部而非分发入口。

edit / regen / swipe（候选切换）本 tier 不变，仍要求存活元素。

| 不变量 | 验证 |
| --- | --- |
| 仅当「确认删除 + 非用户消息 + 多 swipe + 末条」四条件齐备才走仅删 swipe 分支（背后弹确认弹窗、结果 AFFIRMATIVE 时才调用 mini-fork）；否则整条删除分支才调 DOM 门卫后的 stDeleteMessage | `test/messages.test.mjs :: deleteMessage: full {confirm} x {is_user} x {swipes>1} x {isLast} matrix routes to the swipe-only mini-fork (behind a confirm popup) or the DOM-gated full-message path exactly as ST's own policy would` |
| 缺失 swipe_id 时即使其余条件齐备也回退为整条删除（DOM 门卫下必须显式抛错，不凭空传索引也不静默 no-op） | `test/messages.test.mjs :: deleteMessage: an undefined swipe_id blocks swipe-only delete even when every other condition aligns` |
| confirm 设置强制转严格布尔（非布尔真值仍能触发仅删 swipe 分支的确认弹窗）且缺失时视为无需确认（跳过弹窗，落到 DOM 门卫） | `test/messages.test.mjs :: deleteMessage: confirm_message_delete is coerced to a strict boolean before gating the swipe-only branch on, not forwarded as-is` |
| 非法消息 id 在触达宿主删除接口前抛错 | `test/messages.test.mjs :: deleteMessage: rejects a negative or non-integer message id before touching the host` |
| 找不到消息记录时抛错且绝不调用宿主删除 | `test/messages.test.mjs :: deleteMessage: throws when the message record cannot be found at that id` |
| 整条删除的 DOM 门卫错误必须说明「Tier 2 未落地」的原因，而非仅报「未找到」，让后续读者理解这一不对称 | `test/messages.test.mjs :: deleteMessage: the full-message DOM gate error explains the Tier 2 asymmetry, not just "not found"` |
| 用户在确认弹窗点击取消（或转义）时零变更、零宿主调用，弹窗措辞与按钮文案与 ST 原生 askConfirmation 分支逐字一致 | `test/messages.test.mjs :: deleteMessage: swipe-only branch aborts with zero mutation and no host call when the user cancels the confirm popup` |
| 用户在确认弹窗点击「Delete Message」自定义按钮时升级为整条删除（仍受 DOM 门卫约束），且绝不二次弹窗 | `test/messages.test.mjs :: deleteMessage: swipe-only branch escalates to the DOM-gated full-message delete when the user picks "Delete Message" in the popup, with no second confirmation` |
| 仅删 swipe 分支从不调用 ST 的 deleteSwipe/swipe，宿主级 swipeState 全程不受触碰——堵死 swipeState 卡死损坏路径 | `test/messages.test.mjs :: deleteMessage: swipe-only branch never calls ST's deleteSwipe/swipe internals and leaves swipeState untouched (closes the swipeState-lockout corruption path)` |
| 删除的 swipe 恰是消息当前活跃 swipe 时，mini-fork 必须原地 splice swipes/swipe_info、重算 swipe_id、标记 chat_metadata.tainted、发出 MESSAGE_SWIPE_DELETED，并经 syncSwipeToMes 强制重同步 mes | `test/messages.test.mjs :: _deleteSwipeById: splices the deleted swipe out of the live chat entry, reassigns swipe_id, marks chat_metadata tainted, emits MESSAGE_SWIPE_DELETED, and resyncs mes via syncSwipeToMes when the deleted swipe was the message's active swipe` |
| 删除的 swipe 不是当前活跃 swipe 时，护栏绝不多余触发 syncSwipeToMes，但仍持久化并广播事件 | `test/messages.test.mjs :: _deleteSwipeById: leaves mes untouched (no syncSwipeToMes call) when the deleted swipe was not the message's active swipe` |
| 仅剩一个 swipe 时拒绝删除且不产生任何变更（镜像 ST「不能删最后一个 swipe」的警告） | `test/messages.test.mjs :: _deleteSwipeById: throws without mutating when the message has only one swipe left` |
| swipe id 越界时拒绝删除且不产生任何变更 | `test/messages.test.mjs :: _deleteSwipeById: throws for an out-of-range swipe id, without mutating swipes` |
| copy 按 id 读取实时消息并原样转发 mes 文本，全程无需 DOM 元素 | `test/messages.test.mjs :: copyMessage: reads the live message by id and forwards its mes text to copyText, with no DOM element required` |
| copy 在消息 id 非法时先抛错，绝不触达宿主 | `test/messages.test.mjs :: copyMessage: rejects a negative or non-integer message id before touching the host` |
| copy 在找不到消息记录时抛错且绝不调用 copyText | `test/messages.test.mjs :: copyMessage: throws when no message record exists at that id, without calling copyText` |
| branch 原样转发消息 id 给 branchChat，全程无需 DOM 元素 | `test/messages.test.mjs :: createBranch: forwards the message id to branchChat, with no DOM element required` |
| branch 在消息 id 非法时先抛错，绝不触达宿主 | `test/messages.test.mjs :: createBranch: rejects a negative or non-integer message id before touching the host` |
| checkpoint 原样转发消息 id 给 createNewBookmark，全程无需 DOM 元素 | `test/messages.test.mjs :: createCheckpoint: forwards the message id to createNewBookmark, with no DOM element required` |
| checkpoint 在消息 id 非法时先抛错，绝不触达宿主 | `test/messages.test.mjs :: createCheckpoint: rejects a negative or non-integer message id before touching the host` |
| swipe 原样透传 forceMesId、方向与消息原始引用 | `test/messages.test.mjs :: swipeMessage: forwards forceMesId, the exact raw message reference, and direction unmodified` |
| swipe 在消息 id 非法时先抛错 | `test/messages.test.mjs :: swipeMessage: rejects a negative or non-integer message id before touching the host` |
| swipe 在消息记录不存在时抛错且不触达宿主 | `test/messages.test.mjs :: swipeMessage: throws when no message record exists at that id, without calling stSwipe` |
| 已隐藏消息只调 unhide，绝不同时触发 hide | `test/messages.test.mjs :: toggleHideMessage: is_system true delegates to unhideChatMessage(mesId) only` |
| 可见消息只调 hide，绝不同时触发 unhide | `test/messages.test.mjs :: toggleHideMessage: is_system false delegates to hideChatMessage(mesId) only` |
| 隐藏切换在消息 id 非法时先抛错 | `test/messages.test.mjs :: toggleHideMessage: rejects a negative or non-integer message id before touching the host` |
| 共享按 id 分发入口对 copy/branch/checkpoint/hide/delete（仅删 swipe 子分支）撤销了「必须存在 `.mes` 节点」的一票否决门卫，DOM 全无时仍能全部成功 | `test/messages.test.mjs :: triggerMessageActionById: copy/branch/checkpoint/hide/delete(仅 swipe) all resolve with no #chat .mes element present in the DOM (Tier 1)` |
| delete 的整条删除子分支在共享分发入口下仍保留门卫，DOM 缺失时抛出「未找到」而非静默 no-op（Tier 2 前维持不对称） | `test/messages.test.mjs :: triggerMessageActionById: delete throws "Message element not found" for the full-message sub-case when no #chat .mes element is present (stays DOM-gated this tier)` |
| 共享按 id 分发入口对 edit / regen 两个动作保留「必须存在 `.mes` 节点」门卫，本 tier 不变 | `test/messages.test.mjs :: triggerMessageActionById: edit and regen still throw when no #chat .mes element is present (unchanged this tier)` |
| 委托点击无可等待结果时以描述性错误拒绝，绝不返回永久挂起的 Promise | `test/messages.test.mjs :: _dispatchClickAndWait rejects with a descriptive error instead of hanging forever when the delegated handler returns no awaitable result` |
| 委托处理器正常结算时以其值 resolve | `test/messages.test.mjs :: _dispatchClickAndWait resolves with the delegated handler's settled value when it returns a real promise` |
| 委托处理器永不结算时在超时后以独立错误拒绝，不挂死宿主队列 | `test/messages.test.mjs :: _dispatchClickAndWait rejects with a distinct timeout error instead of hanging forever when the delegated handler's promise never settles` |
| 委托处理器的拒绝原因原样传播 | `test/messages.test.mjs :: _dispatchClickAndWait propagates a rejection from the delegated handler's promise` |

## 8. 活动元素注册表（wand / quick-reply）

| 不变量 | 验证 |
| --- | --- |
| 重建前捕获的 id 绝不误触发重建后占据同一位置的不同元素（代数戳失败关闭） | `test/live-element-registry.test.mjs :: an id captured before a quick-reply bar rebuild can never trigger the element that now occupies its old position` |
| 已从文档分离的元素即使同代也不被派发点击 | `test/live-element-registry.test.mjs :: triggerQuickReply refuses to click an element that was detached from the document without a registry rebuild` |
| 畸形或非当前代的 id 被拒绝并返回 false，不抛异常 | `test/live-element-registry.test.mjs :: an id that was never issued by the current registry is rejected without throwing` |

## 9. 会话键与 UI 几何

| 不变量 | 验证 |
| --- | --- |
| 会话键区分角色/群组域，且不被类似分隔符的名字碰撞 | `test/state-contracts.test.mjs :: chat keys separate character/group domains and delimiter-like names` |
| 文件名身份能区分元数据拷贝分支，且对旧版重载保持稳定 | `test/state-contracts.test.mjs :: filename identity distinguishes metadata-copy branches and is stable for legacy reloads` |
| 窗口起点钳制严格限制在合法区间 | `test/floor-rail-math.test.mjs :: clampWindowStart: pins the min/max clamp arithmetic exactly` |
| 奇数容量时激活刻度精确居中 | `test/floor-rail-math.test.mjs :: centerWindowStart: odd capacities center the active tick exactly, unclamped` |
| 偶数容量时偏向窗口前半（防 Math.floor(capacity/2) 型 off-by-one） | `test/floor-rail-math.test.mjs :: centerWindowStart: even capacities bias the active tick to the earlier half of the window` |
| 对话开头处钳制为 0 | `test/floor-rail-math.test.mjs :: centerWindowStart: clamps at the start of the conversation` |
| 对话末尾处钳制为上限 | `test/floor-rail-math.test.mjs :: centerWindowStart: clamps at the end of the conversation` |
| 容量覆盖全对话时窗口起点恒为 0 | `test/floor-rail-math.test.mjs :: centerWindowStart: capacity covering the whole conversation always yields windowStart 0` |
| 容量 1 时窗口恰好跟随激活刻度 | `test/floor-rail-math.test.mjs :: centerWindowStart: degenerate capacity 1 tracks the active tick exactly, one turn per window` |
| 容量 0 时仍有确定性结果且不越界 | `test/floor-rail-math.test.mjs :: centerWindowStart: degenerate capacity 0 is still deterministic and clamps within range` |

## 10. 构建与运行时契约

| 不变量 | 验证 |
| --- | --- |
| 完整运行时树 + 显式 ST 导入白名单被接受 | `test/check-runtime.test.mjs :: accepts a complete runtime tree and the explicit SillyTavern import allowlist` |
| 缺失清单条目被拒绝 | `test/check-runtime.test.mjs :: rejects a missing manifest entry` |
| 缺失的树内相对导入被拒绝 | `test/check-runtime.test.mjs :: rejects a missing in-tree relative import` |
| 生成模块图中的 re-export 与动态导入边被校验 | `test/check-runtime.test.mjs :: checks re-export and dynamic-import edges in the generated module graph` |
| 越出运行时树的路径穿越被拒绝 | `test/check-runtime.test.mjs :: rejects unexpected traversal outside the runtime tree` |
| 未解析的裸导入被拒绝 | `test/check-runtime.test.mjs :: rejects unresolved bare imports` |
| 包管理器路径不得出现在名称与 source map 中 | `test/check-runtime.test.mjs :: rejects package-manager paths in names and source maps` |
| 生成的元数据中不得含本机绝对路径 | `test/check-runtime.test.mjs :: rejects absolute machine-local paths in generated metadata` |
| 完整代次发布在可原子替换的活动指针之后 | `test/check-runtime.test.mjs :: publishes complete generations behind an atomically replaceable live pointer` |
| dev 监视器忽略生成树、只观察运行时输入 | `test/check-runtime.test.mjs :: dev watcher ignores generated trees and observes runtime inputs` |
| 运行时 Zod 门面覆盖 adapter schema 用到的每个值级 z 成员 | `test/check-runtime.test.mjs :: runtime Zod facade covers every value-level z member used by adapter schema` |

另有两个源码级静态校验（无对应测试文件，由脚本直接接入 `verify`）：
`scripts/check-boundaries.mjs`（分层规则：`@st/*` 仅 adapter 与 index.ts 可导入、
adapter/store 不得向上依赖、shield 零依赖、UI 组件必须经由 hooks/actions 访问
store）与 `scripts/check-invariants.mjs`（本清单的双向一致性）。

## 11. 测试基建自证（fake-st-host）

| 不变量 | 验证 |
| --- | --- |
| 关键编译模块能从假宿主树干净导入 | `test/fake-st-host.test.mjs :: the three modules author agents rely on import cleanly from the scratch tree` |
| 桩函数收到编译代码实际传出的参数 | `test/fake-st-host.test.mjs :: a stubbed host function receives the arguments the compiled code passed` |
| 两棵假宿主树的模块状态互不泄漏 | `test/fake-st-host.test.mjs :: two hosts have independent module state — nothing leaks across scratch trees` |
| config.write() 在 extensionSettings 缺失时像 read() 一样自动初始化 | `test/fake-st-host.test.mjs :: config.write() initializes a missing extensionSettings namespace instead of throwing, mirroring read()'s null-tolerance` |

## 12. 测量与数据生成基建（test/e2e，不参与反向校验）

| 不变量 | 验证 |
| --- | --- |
| 相同固件输入生成字节级一致的数据根 | `test/e2e/generate-data-root.test.mjs :: same fixture inputs generate byte-identical data roots` |
| 生成的单用户设置选中固件并启用 SillyLounge | `test/e2e/generate-data-root.test.mjs :: generated single-user settings select the fixture and enable SillyLounge` |
| 扩展模式隔离 native/bootstrap/active 三态基线 | `test/e2e/generate-data-root.test.mjs :: extension modes isolate native, bootstrap, and active performance baselines` |
| 生成的角色卡指向既有 smoke 会话 | `test/e2e/generate-data-root.test.mjs :: generated character card points at the existing smoke chat` |
| 生成的 JSONL 具有声明的用户轮次与交替角色 | `test/e2e/generate-data-root.test.mjs :: generated JSONL has the declared user turns and alternating roles` |
| long-plain 生成器物化恰好 400 用户楼层与回复 | `test/e2e/generate-data-root.test.mjs :: long-plain generator materializes exactly 400 user floors and replies` |
| long-rich 生成器复现匿名化结构画像 | `test/e2e/generate-data-root.test.mjs :: long-rich generator reproduces the anonymized structural profile` |
| long-rich 可关闭作用域正则而不改变固件消息与卡片 | `test/e2e/generate-data-root.test.mjs :: long-rich generator can disable scoped regex without changing the fixture messages or card` |
| 切换固件生成两个相互隔离的 400 楼会话 | `test/e2e/generate-data-root.test.mjs :: long-rich switch fixture generates two isolated 400-floor conversations` |
| 10 楼对照固件保持富文本画像 | `test/e2e/generate-data-root.test.mjs :: long-rich 10-floor switch fixture preserves the rich profile for a small control pair` |
| 生成的扩展是已验证运行时的完整拷贝 | `test/e2e/generate-data-root.test.mjs :: generated extension is a complete copy of the validated runtime` |
| 生成文件不含私有路径、密钥或真实用户标识 | `test/e2e/generate-data-root.test.mjs :: generated files contain no private paths, secrets, or real-user identifiers` |
| 生成器拒绝写入非空目标 | `test/e2e/generate-data-root.test.mjs :: generator rejects a non-empty target instead of touching existing data` |
| 生成器在写出前拒绝固件路径穿越 | `test/e2e/generate-data-root.test.mjs :: generator rejects fixture path traversal before writing output` |
| 生成器拒绝版本不符的 SillyTavern checkout | `test/e2e/generate-data-root.test.mjs :: generator rejects a SillyTavern checkout at the wrong version` |
| 切换测量器要求锁定版本的 SillyTavern checkout | `test/e2e/measure-chat-switch.test.mjs :: chat-switch harness requires the pinned SillyTavern checkout` |
| 切换测量器在启动浏览器前拒绝固件路径穿越 | `test/e2e/measure-chat-switch.test.mjs :: chat-switch harness rejects fixture path traversal before browser launch` |
| 切换测量器在启动浏览器前拒绝不安全的原生截断值 | `test/e2e/measure-chat-switch.test.mjs :: chat-switch harness rejects an unsafe native truncation before browser launch` |
| 性能测量器在启动浏览器前拒绝固件路径穿越 | `test/e2e/measure-long-chat.test.mjs :: performance harness rejects fixture path traversal before launching a browser` |
| 性能测量器拒绝未知正则模式 | `test/e2e/measure-long-chat.test.mjs :: performance harness rejects unknown regex modes before launching a browser` |
| checkout 锁定接受未跟踪文件、拒绝提交或跟踪树漂移 | `test/e2e/st-process.test.mjs :: checkout pin accepts untracked files but rejects commit or tracked-tree drift` |
| 固件守卫拒绝未签名或跨运行的数据根 | `test/e2e/st-process.test.mjs :: fixture guard rejects unsigned or out-of-run data roots` |
| 服务器生命周期传递隔离路径、探测就绪并释放进程 | `test/e2e/st-process.test.mjs :: server lifecycle passes isolated paths, probes readiness, and releases the process` |

## 13. 浏览器门禁（真实 Chromium + 一次性 SillyTavern 宿主）

这些不是 `node --test` 单测，按门禁位置登记：

- **`e2e/smoke.spec.mjs`**（CI 门禁，dist 发布前必须通过）：真实 ST 服务器 + 真实
  Chromium 下，smoke 会话正确投影进 SillyLounge，含一次真实消息编辑往返（回读
  `context.chat` 验证落盘）。
- **`scripts/e2e/measure-chat-switch.mjs`**（CI 门禁，publish-dist 的显式步骤）：双
  400 楼会话经真实侧栏 A→B→A 切换；断言 chatId 一致、无跨会话标记残留、虚拟列表
  声明 800 条但只挂载有界窗口、Home/End 可从未挂载楼层跳转、iframe 几何不重叠、
  无控制台错误；`materializedMessages` 恒低于索引总量（DTO 缓存有界性的浏览器级
  背书）。每次切换样本还各跑一遍**滚动中编辑验收**：对靠底部消息开编辑并输入
  marker → Home 跳顶后编辑行仍挂载（rangeExtractor 钉行）且 textarea 保有
  marker → 除钉住行外其余挂载行仍是紧邻视口的有界连续块 → End 返回后草稿完整
  （message-edit-draft-store）→ 取消后渲染文本与底层 `chat[id].mes` 与编辑前完全
  一致。
- **`scripts/e2e/measure-long-chat.mjs`**（`test:perf`，手动）：400 楼样张三态性能
  归因 + 楼层标尺功能验收。⚠️ 不在任何 CI 门内——楼层标尺的浏览器级窗口断言目前
  只能靠手动运行。

## 14. 未覆盖缺口（❌ 补测待办）

2026-07-19 第一批六个单元层缺口已全部补齐（§3、§4 新增行），滚动中编辑的浏览器
验收已入 §13。当前剩余：

浏览器层：

- 滚动往返后的**保存**路径（当前浏览器验收只走取消路径以保证练习自包含；保存的
  草稿清除语义已有单测背书）。
- character 角色消息的编辑入口藏在溢出菜单里，同一滚动往返场景未在浏览器层驱动
  （实现对角色无分支逻辑，风险有限）。
- 双滚动系统（useAutoScroll 与 virtualizer 内建 end-anchoring）的一致性——待合并为
  单一机制后补断言，当前为已知重构待办。

需要 src 级注入口子或只能在浏览器层验证：

- DOM-DECOUPLING.md Tier 1（2026-07-19，2026-07-19 复审后修订）已把
  `triggerMessageActionById` 对 copy/branch/checkpoint/hide/delete（仅删 swipe
  子分支）的 `#chat .mes[mesid="X"]` 依赖撤除，这四个动作加 delete 的仅删 swipe
  子分支（连同其 mini-fork `_deleteSwipeById` 与确认弹窗 `_confirmSwipeOnly
  Delete`）现在完全在单测层覆盖。**delete 的整条删除子分支不在此列**：复审发现
  该子分支必须保留 DOM 门卫（Tier 2 前不能整体撤除），门卫**拒绝**路径（`.mes`
  缺失时抛出「Tier 2 未落地」错误）已单测覆盖，但门卫**放行后**的成功路径（真
  实存在 `.mes` 节点、`stDeleteMessage()` 实际执行完整删除）与 edit/regen/swipe
  同样受限于假 DOM 不支持复合选择器，只能由 Chromium e2e 覆盖——归入下面这条。
- 仍然依赖 `#chat .mes[mesid="X"]` 复合选择器与 jQuery 委托、假 DOM 不支持、
  只能由 Chromium e2e 覆盖的：`saveMessageEditById`、`swipeMessageById`（含
  `triggerMessageActionById` 里的 `edit`/`regen` 分支）、delete 整条删除子分支
  在 DOM 门卫**放行后**的成功路径——即 edit（保存）、swipe（候选切换）、
  full-delete 本身（不只是其 DOM 定位前置步骤）；若要下沉到单测需给元素查找加
  注入 seam。DOM-DECOUPLING.md Tier 2/3 将分叉 delete（整条）与 edit（保存）本
  身的门后逻辑，但其入口的元素解析仍是 DOM 层动作，预计仍留在此清单。
- **2026-07-19 复审 meta-finding**：现有两道真实 Chromium 门禁（`e2e/smoke.spec.mjs`、
  `scripts/e2e/measure-chat-switch.mjs`）均未驱动任何消息动作分发路径——前者只验证
  会话渲染 + 一次消息**编辑**往返，后者只做切换性能测量；对
  `triggerMessageActionById`/`copyMessage`/`deleteMessage`/`branchChat`/
  `createNewBookmark`/`hideChatMessage` 等符号的 grep 结果为零命中。也就是说
  copy/branch/checkpoint/hide/delete 五个动作的浏览器级驱动目前完全是空白——
  §13 的「消息编辑往返」是这批动作里唯一被真实 Chromium 验收过的一个。本节
  「delete 整条删除成功路径」之外，copy/branch/checkpoint/hide 四个动作本身
  （连同 delete 仅删 swipe 子分支的确认弹窗真实点击）也还没有任何浏览器级驱动，
  是比「需要 src 级注入口子」更基础的一层缺口，记在此处防止随时间被忽略。

低价值备忘：

- 附件投影与 reasoning 格式化缓存在同一次消息投影中的交叉组合测试（两者已分别
  覆盖，交叉场景价值有限）。
