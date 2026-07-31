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

`triggerChatuiMessageAction(id, 'delete', chatKey)`（DOM-DECOUPLING.md Tier 2，
2026-07-19）是本模块唯一特殊编排的动作：先读 `confirm_message_delete` +
`getDeleteEligibility()`，按需 `await` 一次 ChatUI 自有确认对话框
（store/confirm-store.ts，见 §15）之后才决定删「swipe」还是「message」，最后才把
真正的变更入队——弹窗等待过程本身故意留在共享宿主队列**之外**，避免用户盯着对话
框发呆时挡住其它排队操作。

| 不变量 | 验证 |
| --- | --- |
| confirm_message_delete 为 false 时跳过确认对话框，直接整条删除 | `test/chat-actions.test.mjs :: triggerChatuiMessageAction("delete"): confirm_message_delete === false skips the confirm dialog entirely and runs a full-message delete immediately` |
| 仅删 swipe 资格具备 + confirm 开启时请求三态对话框（措辞照设计稿 §9，2026-07-31 起不再与 ST 原生逐字一致），选择默认项按该消息的已选 swipe id 执行仅删 swipe | `test/chat-actions.test.mjs :: triggerChatuiMessageAction("delete"): swipe-eligible + confirm on requests a three-way dialog with the design's own wording; choosing "confirm" runs the swipe-only mini-fork with the message's selected swipe id` |
| 三态对话框选择「升级」项时改执行整条删除，绝不二次弹窗 | `test/chat-actions.test.mjs :: triggerChatuiMessageAction("delete"): swipe-eligible + confirm on — choosing "escalate" in the three-way dialog runs the full-message fork instead, with no second dialog` |
| 任一对话框变体选择取消时零变更、零删除相关宿主调用 | `test/chat-actions.test.mjs :: triggerChatuiMessageAction("delete"): choosing "cancel" (either dialog variant) leaves the chat untouched and never calls any delete-execution host function` |
| 不具备仅删 swipe 资格 + confirm 开启时请求纯两态对话框，确认后整条删除 | `test/chat-actions.test.mjs :: triggerChatuiMessageAction("delete"): not swipe-eligible + confirm on requests a plain two-way dialog; confirming deletes the whole message` |
| 对话框仍开着时会话切换：最终执行必须按会话键拒绝、零变更，并给出与其它动作一致的「已切换」错误 toast | `test/chat-actions.test.mjs :: triggerChatuiMessageAction("delete"): a chat switch while the confirm dialog is still open aborts the eventual execution instead of mutating the now-different chat, and surfaces the same stale-operation toast as every other action` |
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
| 楼层号（第 N 楼）随 DTO 下发：用户回合与它引出的首条回复同号且与楼层轨编号一致；开场白/系统消息/群聊次条回复无楼层号 | `test/chat-store.test.mjs :: message DTO floor projection: both members of a user turn carry that turn's 1-based floor, and every message outside a turn carries none` |
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
（2026-07-19，2026-07-19 复审后修订）：copy / branch / checkpoint / hide 改为按 id
直调，不再要求存活的 `.mes` 节点。

**复制一分为二（2026-07-31，设计 §45）**：菜单里「复制」与「复制原文（含标记）」
是两件不同的事，因此是两条不同的通路。「复制原文」＝ `copyMessageSource(mesId)`
＝原来的 `copyMessage`，逐字节转发 `chat[id].mes`，与原生 `.mes_copy`
（script.js:11752-11763）一致，仍走共享按 id 分发入口（动作名 `copySource`）。
「复制」＝ `copyMessageAsPlainText(html)`，把**已经渲染过的那段格式化 HTML**归约
成读者看见的散文。它收 HTML 而不是 id 是有原因的：ST 的格式化器每次调用都会重解
非确定性宏（`{{random::a,b}}`），在这里重新格式化就会把一段从未出现在屏幕上的文本
塞进剪贴板——chat-store 的格式化 HTML 缓存本就是为这件事存在的，所以正文由
store 从 DTO 取出后交给 adapter（编排见 §2 的 `triggerChatuiMessageAction`），
adapter 只负责归约与剪贴板。归约用 `DOMParser`（惰性文档，正文里的 `<img src>`
不会因为一次复制而发起网络请求），解析这一步是**只在真实浏览器里成立的接缝**——
假宿主 DOM 不解析 HTML——所以判断全落在纯函数 `_plainTextFromNode` 上并在那里钉死，
与 `_deleteFullMessageById` 的 `mesEl?.remove()` 同一处置。

Tier 2（2026-07-19）：delete（整条）也分叉为薄分叉，DOM-*容忍*而非 DOM 门卫——不
再调用 ST 的 `deleteMessage()`，也不再要求存活的 `.mes` 节点（chat_truncation=1
下唯一常驻渲染的是末条消息，非末条消息必须依然能删）。确认弹窗与「删哪一部分」
的编排整体上移到 store/chat-actions.ts（见 §2 新增行）；adapter 层因此拆成三块纯
接口：

- `getDeleteEligibility(mesId)`：结构性资格判定（非用户消息 + 多 swipe + 末条 +
  已选 swipe），完全不含 `confirm_message_delete` ——是否要问用户是调用方
  （store）的事。
- `getConfirmMessageDeleteSetting()`：只读一个强制布尔化的设置值，不触发任何 UI。
- `deleteMessageWithIntent(mesId, intent, swipeId?)`：意图显式的纯执行——调用方已
  经决定好删「swipe」还是「message」，这个函数从不读设置、从不弹窗、从不问。

`_deleteFullMessageById`（`deleteMessageWithIntent` 的 'message' 分支）逐字复刻
ST 原生 `deleteMessage()` 门后本体（script.js:1618-1673）的可观测顺序：splice
`chat[]`→（若有）移除 `.mes` 节点→`chat_metadata.tainted=true`→
`deleteItemizedPromptForMessage(id)`（新增 `@st/itemized-prompts` 映射，
`public/scripts/itemized-prompts.js`，与 `@st/utils` 同款 up-3 模式）→
`_renumberRenderedRowsAfterDelete(id)`（**自有重编号，不再委托原生
`updateViewMessageIds`**，见下）→`saveChatDebounced()`（注意不是
`saveChatConditional`，两者是原生两个不同函数各自的选择，仅删 swipe 的
mini-fork 用后者）→`refreshSwipeButtons()`→
`eventSource.emit(MESSAGE_DELETED, chat.length)`。**2026-07-19 Tier 3**：原生
`this_edit_mes_id` 重置步骤（script.js:1663-1665）不再复刻，见下方
「`this_edit_mes_id` 影子变量」段落末尾的更新说明。

**重编号陷阱（2026-07-19 复审发现并修复）**：早期实现按原生
`updateViewMessageIds(startIndex)` 的 `[0, minId].includes(id) ? id : null` 公式
算 `startIndex` 后直接调用原生函数（`script.js:9407-9419`）代劳重编号，理由是
「它自身对 DOM 容忍，且正是 DOM-DECOUPLING.md 认可的『写回受遮罩原生窗口以维持宿主
一致性』」——这个理由不成立：原生 `updateViewMessageIds` 的 `null` 分支会重新扫描
**当前** DOM 算 `minId = getFirstDisplayedMessageId()`，其正确性默默依赖原生
`deleteMessage()` 自身的前提——被删行自己的 `.mes` 节点原本在 DOM 里、且刚刚被
物理 `.remove()`（`script.js:1633-1636` 的门卫正是为此存在）。Tier 2 恰恰打破了
这个前提：一旦被删 id 本身从未渲染而更晚的行已渲染（chat_truncation 截断窗口的
典型形态），DOM 的最小值根本没变，原生的重新扫描就悄悄退化成空操作——每一个仍在
渲染的行都保留了它删除前的 `mesid`，尽管 `chat.splice(deletedId, 1)` 刚把它之后
每一条的数组下标都减了 1。用逐字复刻的原生 `updateViewMessageIds`/
`getFirstDisplayedMessageId` 函数体对着真实 DOM 复现过（该复审轮次的 scratch
repro，未纳入本仓库）：删除未渲染的 id 5、仅 6-9 已渲染时，「编辑消息 7」会静默
落到 `chat[7]`（此刻已是原消息 8 的内容）；chat_truncation=1（仅末条渲染）下删除
更早的未渲染 id，剩下那唯一渲染行的 `mesid` 会指向越界的 `chat[]` 槽位。

修复：`_renumberRenderedRowsAfterDelete`（`src/adapter/messages.ts`）自己拥有
重编号规则，不再从 DOM 重新推导任何基准值——只拿每一行**自己删除前**的
`mesid` 属性跟被删 id 直接比较，对任何渲染/未渲染组合都按构造正确：
`mesid === deletedId` 的行此刻已不存在（若曾渲染，其元素已被上一步
`.remove()`）；`mesid > deletedId` 的行 `mesid` 恰好减 1（因为它对应的
`chat[]` 条目恰好被 splice 顶了一格）；`mesid < deletedId` 的行原样不动。同时
复刻原生 `updateViewMessageIds` 对同一批行产生的其余逐行可观测效果——
`.mesIDDisplay` 文本镜像、`last_mes` class 移交给 DOM 序上新的末行——并在最后
无条件调用原生 `updateEditArrowClasses()`（`script.js:9427`，已导出，直接调用
未重新实现：它从不从 DOM 重新推导基准，只是把真实的 `this_edit_mes_id`
（经 `setEditedMessageId()` 保持同步，见下）跟*此刻*的 `mesid` 属性比较——而
此刻的属性已经被本函数改对了，所以委托是安全的）。`.mes` 行读取走
`#chat` 的直接 `.children` 加一个纯 classList 树遍历（`_findDescendantByClass`），
不用复合 CSS 选择器——这正是单测假 DOM（`test/helpers/fake-st-host.mjs`）能
真正验证这条重编号规则的原因，见 §7 的四条新测试。

**`this_edit_mes_id` 影子变量（2026-07-19 Tier 3 已移除）**：ST 的
`this_edit_mes_id`（script.js:610）模块私有，只导出了 setter
`setEditedMessageId()`（script.js:7101），没有任何 getter。Tier 2 期间
`src/adapter/messages.ts` 曾用模块私有的 `_shadowEditedMessageId` 镜像它，
因为当时 `saveMessageEditById()` 会经 `messageEdit()` 真的设上这个变量、再经
完成的 `.mes_edit_done` 点击间接经 ST 自己的 `messageEditDone()` 清空——是
ChatUI 唯一会触碰真实值的路径。Tier 3 把 `saveMessageEditById()` 分叉成完全
DOM-free 的实现，从此再也不打开原生编辑会话（详见下方 edit 保存分叉段落），也就
再也不会去设这个真实变量——影子仅剩的意义（镜像 ChatUI 唯一的写入路径）随之消
失，继续留着 `_deleteFullMessageById` 里那个「影子等于被删 id 才调
`setEditedMessageId(undefined)`」的条件只会是一个永远为假、误导人的机制，因此
连同影子变量本身一起删除，不再调用 `setEditedMessageId()`。残留的唯一缺口——
用户绕开 ChatUI 遮罩、直接在原生 DOM 里打开编辑会话，再经 ChatUI 删除同一条消
息——在 Tier 2 时代影子本就观察不到这种绕过写入，从未真正覆盖过；Tier 3 只是不
再假装覆盖，没有让已有行为变差。无条件调用 `setEditedMessageId(undefined)` 本
身也不安全：没有 getter 就无法判断真实变量此刻是否正指向这条被删消息，无条件重
置可能误伤另一条消息上合法的（绕过遮罩打开的）编辑会话。见 §16。

regen / swipe（候选切换）本 tier 不变，仍要求存活元素。delete 不再经共享
`triggerMessageActionById` 分发（同步 switch 语句容不下「先读设置、按需等
弹窗」的异步编排），改由 store/chat-actions.ts 直接调用上面三个新接口（见 §2）；
edit（保存）**2026-07-19 Tier 3 起也不再经共享分发入口**，且从未真正被真实 UI
经它触发过——见下方 edit 保存分叉段落。

**edit（保存）分叉（2026-07-19 Tier 3 落地）**：`saveMessageEditById`
（`src/adapter/messages.ts`）从 Tier 1/2 时代驱动原生 `.mes_edit`/
`.mes_edit_done` 按钮的合成点击实现，改为完全 DOM-free 的分叉——逐字复刻 ST 原生
`updateMessage()`（script.js:8080-8134）+ `messageEditDone()`
（script.js:8337-8375，门后本体去掉全部 DOM 渲染步骤）的可观测编排：查
`chat[id]`（找不到抛错）→`mes.extra ??= {}`→regexPlacement 三分支选择
（`is_user` → USER_INPUT；`extra.type === 'narrator'` → SLASH_COMMAND；否则
AI_OUTPUT，逐支复刻，`is_system` 完全不参与这次判定）→`getRegexedString(text,
regexPlacement, { characterOverride: extra.type==='narrator' ? undefined :
mes.name, isEdit: true })`（`mes.name`，不是模块私有、无 setter 的
`this_edit_mes_chname`——原生 `updateMessage()` 自己也从未读过后者，所以群聊场景
下也不需要另外推导，读法与原生逐字一致）→`power_user.trim_spaces` 时
`.trim()`（经 `getContext().powerUserSettings`，与
`getConfirmMessageDeleteSetting()` 同一活引用，不是新映射）→
`bias = substituteParams(extractMessageBias(text))`（**在 text 被
substituteParams 处理主文本之前**提取 bias，与原生顺序一致）→
`text = substituteParams(text)`→bias 为真时 `text = removeMacros(text)`→
`mes.mes = text`→`swipe_id !== undefined` 时先 `ensureSwipes(mes)` 再写
`mes.swipes[mes.swipe_id] = text`（顺序不可颠倒）→`extra.bias` 仅在
`is_system || is_user || extra.type === system_message_types.NARRATOR` 时才
赋成算出的 bias，其余消息类型一律强制 `null`（即使 bias 计算结果非空、且已经
用于门控上面的 `removeMacros` 分支）→`chat_metadata.tainted = true`→
`await eventSource.emit(MESSAGE_EDITED, id)`→`_healRenderedMessageRow(id,
mes)`（见下）→`await eventSource.emit(MESSAGE_UPDATED, id)`→
`await saveChatConditional()`→`refreshSwipeButtons()`（代替原生
`showSwipeButtons()`——后者唯一的额外效果是重置模块私有 `swipesHidden`，而
ChatUI 的调用链从不把它置真，所以等价）。

`getRegexedString`/`regex_placement` 新增 `@st/regex-engine` 映射
（`public/scripts/extensions/regex/engine.js`，与 `@st/itemized-prompts` 同款
up-3 模式，`scripts/build.mjs`/`check-runtime.mjs`/`st-externals.d.ts`/
`test/helpers/fake-st-host.mjs` 均已同步）——script.js 自己只 `import` 这两个符
号、从不在文件底部的兼容 `export {...}` 块里再导出它们（逐一核对过），
`getContext()` 与既有 `@st/script` 映射都够不到，必须新增映射。
`substituteParams`/`ensureSwipes`/`system_message_types` 三者本就是 script.js
的顶层 `export`（`system_message_types` 经文件底部兼容导出块转发自
system-messages.js），只需要在既有 `@st/script` 映射里补声明，不需要新映射。

**渲染行愈合（`_healRenderedMessageRow`）**：Tier 3 之前编辑保存全程驱动真实原
生编辑 UI，原生 DOM 自然保持一致；分叉后直接改 `chat[]`，若目标消息当前仍在原
生窗口渲染（今天的遮罩下不可见，但停用截断标志翻开、或 flag-off 就地卸载后会
立刻暴露），残留旧文本。解法是经 `getContext().updateMessageBlock(id, mes)`
（script.js:1974，`st-context.js` 早已转发，无需新映射）愈合——但**必须先判断
该行是否真的渲染**，不能像其它 DOM 容忍的调用一样无条件调：原生
`updateMessageBlock` 把 jQuery 选择结果（可能为空）传进
`updateReasoningUI`→`ReasoningHandler#initHandleMessage`
（reasoning.js:319-326），后者只特判 `number`/`HTMLElement`，空 jQuery 选择会
落到 `$(messageIdOrElement)[0]` 求值成 `undefined`，紧接着对 `undefined` 调用
`.getAttribute(...)` 直接抛 TypeError——不是静默空操作。`_findRenderedMessageRow`
（渲染行是否存在的判断本身）复用 `_renumberRenderedRowsAfterDelete` 已经验证过
的思路——走 `#chat` 直接 `.children` 加纯 classList 比较，不用复合 CSS 选择
器——因此这条「该行是否渲染」的分支也能被假 DOM 单测真正覆盖到（而不是像
`_deleteFullMessageById` 的 `mesEl?.remove()` 那样只能靠浏览器层）。

| 不变量 | 验证 |
| --- | --- |
| `getDeleteEligibility` 的 {is_user} x {swipes>1} x {isLast} x {swipe_id 已选} 四维矩阵与 ST 原生 `.mes_edit_delete` 处理器的结构性判定逐一对应，且完全不含 confirm_message_delete | `test/messages.test.mjs :: getDeleteEligibility: {is_user} x {swipes>1} x {isLast} x {swipe_id defined} matrix matches ST's own structural check (script.js:11922-11928) exactly, excluding confirm_message_delete — that gate is the caller's job now (store/chat-actions.ts)` |
| 非法消息 id 在读取聊天记录前抛错 | `test/messages.test.mjs :: getDeleteEligibility: rejects a negative or non-integer message id before reading the chat` |
| 找不到消息记录时抛错 | `test/messages.test.mjs :: getDeleteEligibility: throws when the message record cannot be found at that id` |
| confirm_message_delete 强制转严格布尔，缺失/空的 powerUserSettings 视为 false 且绝不抛错 | `test/messages.test.mjs :: getConfirmMessageDeleteSetting: coerces a truthy non-boolean setting to strict true, and a missing/empty powerUserSettings to false without throwing` |
| deleteMessageWithIntent 在非法消息 id 前先抛错，绝不触达宿主 | `test/messages.test.mjs :: deleteMessageWithIntent: rejects a negative or non-integer message id before touching the host` |
| intent='swipe' 缺失 swipeId 时先抛错，零变更、零宿主调用 | `test/messages.test.mjs :: deleteMessageWithIntent: "swipe" intent without a swipeId throws before mutating anything or calling the host` |
| intent='swipe' 原样转发到 _deleteSwipeById，绝不触碰整条删除分叉专属的宿主调用 | `test/messages.test.mjs :: deleteMessageWithIntent: "swipe" intent forwards mesId/swipeId straight to _deleteSwipeById, never touching the full-delete host calls` |
| intent='message'（整条删除薄分叉）复刻原生门后本体的完整可观测序列——splice、tainted、itemized-prompt 失效、DOM 容忍的重编号、debounced 保存、refreshSwipeButtons、MESSAGE_DELETED 载荷——严格按原生顺序，且全程没有渲染的 `.mes` 节点 | `test/messages.test.mjs :: deleteMessageWithIntent: "message" intent (the full-message fork) reproduces the exact native post-gate sequence — splice, tainted, itemized-prompt invalidation, DOM-tolerant renumber, debounced save, refreshSwipeButtons, MESSAGE_DELETED payload — in ST's exact order, entirely without a rendered .mes node` |
| 重编号陷阱修复：被删 id 本身未渲染、更晚的行已渲染时（chat_truncation 截断窗口的典型形态，也覆盖「被删 id 恰是删除前渲染最小值」——因为两者留下的残余行集合在 DOM 上无法区分），已渲染行的 mesid 全部恰好减 1，mesIDDisplay 文本与 last_mes class 同步跟随 | `test/messages.test.mjs :: deleteMessageWithIntent: "message" intent — rendered-row renumber (mesid-renumber trap fix): unrendered-deleted + later-rendered rows all shift down by exactly one (the truncation core case; also covers "deleted id === the pre-delete rendered minimum", since a still-rendered row's own DOM state after a delete cannot distinguish "this id was rendered and just got removed" from "this id was never rendered at all" — both leave an identical residual row set, which is exactly why comparing against the deleted id is the only correct rule)` |
| 重编号陷阱修复：中间位置渲染行被删（其自身节点已被上一步移除）时，被删 id 以下的行原样不动，以上的行 mesid 恰好减 1，last_mes 移交给新的末行 | `test/messages.test.mjs :: deleteMessageWithIntent: "message" intent — rendered-row renumber: rows below the deleted id are left untouched, only rows above it shift down (post-removal DOM shape a rendered mid-list delete leaves behind — mesEl.remove() itself is a real-browser-only concern here, see the module doc comment)` |
| 重编号陷阱修复：chat_truncation=1 下删除唯一渲染的末行（其自身节点已被移除）后无行可重编号，且仍不抛错、仍调用 updateEditArrowClasses | `test/messages.test.mjs :: deleteMessageWithIntent: "message" intent — rendered-row renumber: deleting the sole rendered row under chat_truncation=1 (its own element already removed) leaves nothing to renumber, without throwing` |
| 重编号陷阱修复：删除未渲染的 id 0（旧 startIndex 公式的特判分支，但该特判只在原生自身 DOM 门卫下才安全）时，已渲染行同样全部恰好减 1 | `test/messages.test.mjs :: deleteMessageWithIntent: "message" intent — rendered-row renumber: deleting id 0 while it is itself unrendered still shifts every rendered row down by one (the id===0 edge case the old startIndex formula special-cased, but which is only ever safe under native's own DOM gate)` |
| 删除的 swipe 恰是消息当前活跃 swipe 时，mini-fork 必须原地 splice swipes/swipe_info、重算 swipe_id、标记 chat_metadata.tainted、发出 MESSAGE_SWIPE_DELETED，并经 syncSwipeToMes 强制重同步 mes | `test/messages.test.mjs :: _deleteSwipeById: splices the deleted swipe out of the live chat entry, reassigns swipe_id, marks chat_metadata tainted, emits MESSAGE_SWIPE_DELETED, and resyncs mes via syncSwipeToMes when the deleted swipe was the message's active swipe` |
| 删除的 swipe 不是当前活跃 swipe 时，护栏绝不多余触发 syncSwipeToMes，但仍持久化并广播事件 | `test/messages.test.mjs :: _deleteSwipeById: leaves mes untouched (no syncSwipeToMes call) when the deleted swipe was not the message's active swipe` |
| 仅剩一个 swipe 时拒绝删除且不产生任何变更（镜像 ST「不能删最后一个 swipe」的警告） | `test/messages.test.mjs :: _deleteSwipeById: throws without mutating when the message has only one swipe left` |
| swipe id 越界时拒绝删除且不产生任何变更 | `test/messages.test.mjs :: _deleteSwipeById: throws for an out-of-range swipe id, without mutating swipes` |
| 「复制原文」按 id 读取实时消息并原样转发 mes 文本（与原生 `.mes_copy` 逐字节一致），全程无需 DOM 元素 | `test/messages.test.mjs :: copyMessageSource: reads the live message by id and forwards its mes text to copyText, with no DOM element required` |
| 「复制原文」在消息 id 非法时先抛错，绝不触达宿主 | `test/messages.test.mjs :: copyMessageSource: rejects a negative or non-integer message id before touching the host` |
| 「复制原文」在找不到消息记录时抛错且绝不调用 copyText | `test/messages.test.mjs :: copyMessageSource: throws when no message record exists at that id, without calling copyText` |
| 「复制」的正文归约：块级边界与 `<br>` 落成读者看见的换行，行内标记只贡献文字本身 | `test/messages.test.mjs :: _plainTextFromNode: block boundaries and <br> become the line breaks a reader sees, and inline markup contributes nothing but its text` |
| 「复制」的正文归约：列表逐条换行、表格单元格沿行分隔，注释等非元素非文本节点整体丢弃 | `test/messages.test.mjs :: _plainTextFromNode: list items break per row, table cells separate along the row, and comment/attribute nodes are dropped entirely` |
| 空的格式化 HTML 直接归约为空串，根本不去碰解析器 | `test/messages.test.mjs :: plainTextFromMessageHtml: empty formatted HTML reduces to an empty string without reaching for a parser` |
| 「复制」只把归约后的文本交给 copyText，全程不读 chat 数组（正文来自 store 缓存的已渲染 HTML，不是重新格式化） | `test/messages.test.mjs :: copyMessageAsPlainText: forwards the reduced text to copyText and never reads the chat array` |
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
| 共享按 id 分发入口对 copySource/branch/checkpoint/hide 撤销了「必须存在 `.mes` 节点」的一票否决门卫，DOM 全无时仍能全部成功 | `test/messages.test.mjs :: triggerMessageActionById: copySource/branch/checkpoint/hide all resolve with no #chat .mes element present in the DOM (Tier 1)` |
| delete 不再经共享分发入口执行（Tier 2）：一个运行期传入的 'delete' 字符串落到显式安全的 default no-op 分支，零变更、零宿主调用——真正的编排在 store/chat-actions.ts | `test/messages.test.mjs :: triggerMessageActionById: "delete" is not dispatched here at all (Tier 2) — a silent no-op, zero mutation, zero host calls; orchestration lives in store/chat-actions.ts now` |
| 共享按 id 分发入口对 regen 保留「必须存在 `.mes` 节点」门卫，本 tier 不变（生成菜单路径，与 edit/delete 无关） | `test/messages.test.mjs :: triggerMessageActionById: "regen" still throws when no #chat .mes element is present (unchanged this tier — a generation-menu path, untouched by the edit fork)` |
| edit 不再经共享分发入口执行（Tier 3）：本就从未被真实 UI 经它触发过；一个运行期传入的 'edit' 字符串落到与 'delete' 相同的显式安全 default no-op 分支，零变更 | `test/messages.test.mjs :: triggerMessageActionById: "edit" is not dispatched here at all (Tier 3) — never reachable from the real UI to begin with (entering edit mode is local Preact state), a runtime "edit" string falls through to the same silent default no-op "delete" already uses` |
| regexPlacement 三分支选择（is_user → USER_INPUT；narrator → SLASH_COMMAND；否则 AI_OUTPUT）与 ST 原生逐支对应，数值经真实 regex_placement 常量核对 | `test/messages.test.mjs :: saveMessageEditById: regexPlacement selection matches ST's own 3-branch is_user / narrator-type switch exactly (regex_placement.USER_INPUT=1, SLASH_COMMAND=3, AI_OUTPUT=2 — public/scripts/extensions/regex/engine.js)` |
| characterOverride 直接读每条消息自己的 name 字段（群聊场景下按成员各自正确），narrator 类型强制 undefined，与该消息自己的 name 无关 | `test/messages.test.mjs :: saveMessageEditById: characterOverride passed to getRegexedString is each message's own name field (the correct per-member override in group chats, not a shared default), and is explicitly undefined for narrator-typed messages regardless of their own name` |
| getRegexedString → substituteParams → removeMacros 严格按此顺序复合，extractMessageBias 作用于「已过 regex、未过主文本 substituteParams」的文本，mes.mes 与 swipes[swipe_id] 字节一致 | `test/messages.test.mjs :: saveMessageEditById: getRegexedString -> substituteParams -> removeMacros compose in ST's exact order, extractMessageBias runs on the post-regex/pre-main-substitution text, and mes.mes/swipes[swipe_id] end up byte-identical` |
| extra.bias 仅对 is_system/is_user/narrator 三类消息写入算出的 bias 值，其余消息类型一律强制写 null（即使同一个 bias 已经用于门控 removeMacros） | `test/messages.test.mjs :: saveMessageEditById: extra.bias is set to the computed bias only for is_system/is_user/narrator messages; every other message type gets extra.bias forced to null even though the same truthy bias still gated removeMacros for all of them` |
| ensureSwipes 严格先于 swipes[swipe_id] 的写入——写入必须落在 ensureSwipes 刚创建的数组之上 | `test/messages.test.mjs :: saveMessageEditById: ensureSwipes runs strictly before the swipes[swipe_id] write — the write must land on top of whatever ensureSwipes just created, not the other way around` |
| power_user.trim_spaces 为真时才对（regex 之后的）文本做首尾去空白 | `test/messages.test.mjs :: saveMessageEditById: trims text after regex, only when power_user.trim_spaces is truthy` |
| 缺失的 extra 对象在触碰前先初始化（镜像原生 mes.extra ??= {} 守卫） | `test/messages.test.mjs :: saveMessageEditById: initializes a missing extra object before touching it, mirroring native's mes.extra ??= {} guard` |
| MESSAGE_EDITED 严格先于 MESSAGE_UPDATED，两者载荷都恰好是数字消息 id | `test/messages.test.mjs :: saveMessageEditById: emits MESSAGE_EDITED strictly before MESSAGE_UPDATED, both with exactly the numeric message id as their sole argument` |
| 保存走 saveChatConditional（不是 saveChatDebounced），之后才 refreshSwipeButtons，顺序严格 | `test/messages.test.mjs :: saveMessageEditById: saves via saveChatConditional (not saveChatDebounced), and refreshes swipe buttons afterward, in that exact order` |
| 目标行未渲染时绝不调用 getContext().updateMessageBlock（该原生函数本身对未渲染行不安全，见 §7 上方「渲染行愈合」段落） | `test/messages.test.mjs :: saveMessageEditById: never calls getContext().updateMessageBlock when the message row is not currently rendered` |
| 目标行已渲染时经 getContext().updateMessageBlock 愈合——参数为 id 与刚被本函数修改过的同一个活引用，且严格发生在 MESSAGE_EDITED 与 MESSAGE_UPDATED 之间 | `test/messages.test.mjs :: saveMessageEditById: heals a currently-rendered native row via getContext().updateMessageBlock — called with the id and the exact same live mes reference it just mutated, strictly between MESSAGE_EDITED and MESSAGE_UPDATED` |
| 非法（非有限数字）消息 id 在触达宿主前抛错 | `test/messages.test.mjs :: saveMessageEditById: rejects a non-finite message id before touching the host` |
| 找不到消息记录时抛错，且绝不污染 chat_metadata.tainted 或发出 MESSAGE_EDITED | `test/messages.test.mjs :: saveMessageEditById: throws when no message record exists at that id, without tainting chat_metadata or emitting MESSAGE_EDITED` |

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
| swipe 分段刻度窗口的容量恒为 5（设计 §43 定值） | `test/swipe-segment-math.test.mjs :: SWIPE_SEGMENT_CAPACITY is 5 — the design's fixed tick-row width` |
| 总数不超过窗口容量时全量显示且不进入「窗口化」状态 | `test/swipe-segment-math.test.mjs :: computeSwipeSegmentWindow: total at or under the cap always shows every swipe, unwindowed` |
| 总数为 0 时结果确定，不是空指针或 NaN | `test/swipe-segment-math.test.mjs :: computeSwipeSegmentWindow: total 0 is deterministic and yields an empty, unwindowed window` |
| 总数刚超过窗口容量时按当前项居中并标记窗口化，窗口宽度恒等于容量 | `test/swipe-segment-math.test.mjs :: computeSwipeSegmentWindow: total just past the cap (6) centers the active tick and reports windowed` |
| 长历史下窗口起点与原型 `Math.max(0, Math.min(activeIndex-2, total-5))` 逐点一致，且激活项恒落在窗口内 | `test/swipe-segment-math.test.mjs :: computeSwipeSegmentWindow: a long swipe history (total=101) mirrors the prototype's Math.max/Math.min formula exactly` |
| 窗口宽度与起点永不越出 `[0, total]` 边界 | `test/swipe-segment-math.test.mjs :: computeSwipeSegmentWindow: never returns a window wider than the total, even for tiny totals above the cap` |
| 贴底门 80px 与「回到最新」门 240px 是两个独立常量，且前者恒小于后者 | `test/follow-scroll-math.test.mjs :: follow-scroll gates: the two thresholds are 80px and 240px, and the jump gate is the far one` |
| 距底距离恒为 scrollHeight - scrollTop - clientHeight（不是滚动偏移本身） | `test/follow-scroll-math.test.mjs :: readFollowGates: distance is the content below the viewport, not the scroll offset` |
| 贴底门严格开区间：79px 仍粘滞、恰好 80px 已松手 | `test/follow-scroll-math.test.mjs :: readFollowGates: the follow gate holds up to but not at 80px` |
| 胶囊门严格开区间：恰好 240px 仍不出现、241px 才浮出 | `test/follow-scroll-math.test.mjs :: readFollowGates: the 「回到最新」 gate opens past 240px, never at it` |
| 80–240px 死区既不自动贴底也不显示胶囊（防两门被并回一个常量） | `test/follow-scroll-math.test.mjs :: readFollowGates: the 80–240px dead zone follows nothing and offers nothing` |
| 两道门永不同时开（胶囊绝不浮在仍在自动贴底的视图上） | `test/follow-scroll-math.test.mjs :: readFollowGates: the two gates are never open at the same time` |
| 过卷（负距离）与不可滚动容器一律判为贴底且不出胶囊 | `test/follow-scroll-math.test.mjs :: readFollowGates: over-scroll and unscrollable containers both count as pinned` |
| 标头时间戳把 ST 写过的每种 `send_date`（ISO 8601 / `humanizedDateTime` / epoch 毫秒数与数字串）都渲染成时钟时间，无法辨认的原样透出而不臆造 | `test/format.test.mjs :: formatTimestamp renders every send_date shape SillyTavern writes as a clock time, and never invents one it cannot read` |
| 时长与体积格式化保持中文口径，且「没有数值」不被四舍五入成「零」 | `test/format.test.mjs :: formatDuration and formatBytes stay in the language the rest of the UI speaks and refuse to round a non-quantity into one` |

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
| 原生截断守卫的 overrideEnabled/pollution 两个开关与 extensionMode 正交，各自落在 chatui_composer 设置的正确字段（.config / .nativeTruncationBackup / power_user.chat_truncation） | `test/e2e/generate-data-root.test.mjs :: native truncation guard flags are orthogonal to extension mode and land in the right settings slots` |
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
| 截断守卫验收器要求锁定版本的 SillyTavern checkout | `test/e2e/verify-truncation-guard.test.mjs :: truncation-guard harness requires the pinned SillyTavern checkout` |
| 截断守卫验收器在启动浏览器前拒绝固件路径穿越 | `test/e2e/verify-truncation-guard.test.mjs :: truncation-guard harness rejects fixture path traversal before browser launch` |
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
  背书）。两次性能样本及其 DOM/heap 采集全部结束后，再在最终 A 会话跑独立的
  **编辑验收**，避免把超长富文本保存成短 marker 后污染性能数据：(1) 先采集未编辑
  时真实的顶部虚拟窗口，再对靠底部的历史用户消息开编辑并输入 marker；Home 跳顶后
  编辑行仍挂载（rangeExtractor 钉行）且 textarea 保有 marker，除钉住行外其余挂载
  行必须与编辑前基线逐项一致——不再用固定「相隔 50 条」阈值，因此同一规则也适用
  10 楼对照样张；End 返回后真实点击 Save，断言底层 `chat[id].mes`、渲染文本和
  message-edit-draft-store 的草稿清除状态；再 Home/End 一次，证明钉行释放后的普通
  卸载/重挂载仍读回保存结果。(2) 对 character 角色消息真实进入编辑：先开 ⋯ 菜单，
  断言它恰好承载重排后的五行（复制 / 复制原文 / 从此楼开分支 / 在此楼设检查点 /
  隐藏此楼，设计 §45）且「编辑」确已不在其中，经 backdrop 关闭后再点平铺的
  「编辑」钮——2026-07-31 操作条 IA 重排把编辑挪出了 ⋯，入口路径随之重写，但它
  守的不变量（历史 character 行的编辑往返落盘）逐条原样保留；保存后同样回读 ST
  状态、DOM 与草稿清除状态。JSON 报告 schema v3 的 `editAcceptance` 记录目标消息、
  基线/钉行窗口计数及上述结果。
- **`scripts/e2e/measure-long-chat.mjs`**（`test:perf`，手动）：400 楼样张三态性能
  归因 + 楼层标尺功能验收。⚠️ 不在任何 CI 门内——楼层标尺的浏览器级窗口断言目前
  只能靠手动运行。
- **`scripts/e2e/verify-truncation-guard.mjs`**（`test:e2e:guard`；**2026-07-19 起
  为 CI 发布门禁的显式步骤**，随所有者拍板翻开默认值一并接入）：闭合 §16 曾经
  登记的两条 native-window-guard 浏览器层缺口。场景自带 flag-on 固件，不依赖
  代码默认值，因此无论默认值未来如何变化都保持有效门禁。
  - **场景 A（flag-on 激活 + 真实停用-刷新往返）**：flag-on 激活后，断言 live
    `power_user.chat_truncation` 为覆盖哨兵而持久化的 SillyLounge 备份仍是固件原
    值；原生 `#chat` 只挂载截断窗口，ChatUI 自身仍展示/可导航完整会话；无控制台
    错误。同一次开机原样重跑一遍激活（折入 backupOnce 的 already-present 分支）：
    覆盖照常应用，且绝不会用覆盖值顶替既有备份。随后驱动与用户等价的真实停用控件
    （侧栏「设置」→ Settings 面板「关闭 ChatUI」按钮 → 确认对话框，途经
    `CHATUI_DISABLE_EVENT`），断言确有一次真实页面刷新（sealed-queue 路径）而非
    原地 `teardown()`。刷新后：live 与持久化的 `chat_truncation` 都等于固件原值、
    SillyLounge 备份字段已清空、`#chat` 重新渲染完整（按用户真实设置，非截断）的
    原生消息集；全程无控制台错误。
    ⚠️ **首次真实运行发现的时序缺陷（已修复）**：ST 的 `power_user.chat_truncation`
    只在 `printMessages()`（开机或切换会话的那一次打印）读取一次，纯内存改写不
    会触发重打印——这本身是产品既有语义，脚本对此不作任何放松。真正的缺陷是
    `disableChatuiLayers()`（`src/index.ts`）在停用时只调了防抖的
    `saveSettingsDebounced()` 就几乎同步 `location.reload()`；`saveSettingsDebounced`
    是 ST `utils.js::debounce()` 包出的单个共享 1000ms 定时器，每次调用都会
    `clearTimeout` 重新起跳，而 reload 摧毁页面 JS 上下文的时机远早于这个窗口能
    走完——停用点击因此**必然**丢掉「`enabled: false`」与「截断恢复」两笔落盘写
    入，下次开机读到磁盘上仍是 `enabled: true` 而重新整套激活 ChatUI，其激活流程
    总能抢在 ST 自己 fire-and-forget 的开机打印（`RA_autoloadchat()`）之前把
    `chat_truncation` 摁回哨兵值，原生 `#chat` 从此钉死在哨兵计数、没有任何后续
    事件会去重打印。诊断用真实往返 + 磁盘/DOM 双重插桩复现确认。修复：
    `disableChatuiLayers()` 在写回真值之后、reload 之前改为 `await` 一次 ST 未包
    装的真实 `saveSettings()`（而非 `saveSettingsDebounced()`），把「reload 大概
    率能抢在防抖前面」换成「reload 只在写入真正落盘后才会发生」，与本仓库其余
    reload 路径（如 `store/sidebar-actions.ts` 当前会话删除，reload 前已 `await`
    过真正的删除请求）的既有约定一致。见 DOM-DECOUPLING.md「停用恢复」行的完整
    时序缺陷补充说明。
  - **场景 B（bootstrap 自愈）**：生成一个 settings 已预置崩溃现场（持久化
    `chat_truncation` 等于覆盖哨兵、SillyLounge 备份持有原值）、扩展已安装但替换
    UI 处于 bootstrap 关闭态的数据根；开机后断言 `init()` 顶部的自愈先于任何其他
    可观察行为跑过：live 与持久化的 `chat_truncation` 都恢复为原值、备份已清空、
    原生 chat 按恢复后的值渲染，全程无控制台错误。

## 14. 原生截断窗口守卫（adapter/native-window-guard）

`power_user.chat_truncation` 覆盖机制（DOM-DECOUPLING.md「停用恢复」行，2026-07-19
拍板：reload 方案）。ST 把 `chat_truncation === 0` 解读为「无限制」而非零，覆盖值恒为
1、绝不为 0；覆盖绝不能永久污染用户真实设置（写一次的备份 + 每次开机自愈）。这些测
试直接经假宿主驱动编译后的 `adapter/native-window-guard.js`，不涉及 index.ts 的 DOM
接线（后者见 §13 的浏览器验收）。机制被 store/config-store.ts 的
`nativeTruncationOverrideEnabled` 标志整体门控；DOM-DECOUPLING.md Tier 2/3
（edit 保存 / 整条删除分叉）落地并通过真实浏览器验收后，该标志已于 2026-07-19
默认开启。

复审（2026-07-19，见下方「未覆盖缺口」之前的接线路径复审）补上三层此前缺失的守卫：
(1) `restoreForDisable()` 镜像 `selfHealNativeTruncation()` 的守卫哲学——只有当前值仍
是覆盖哨兵才写回备份，若用户已经过 ST 原生的 `#AdvancedFormatting` 抽屉手动改过
`chat_truncation`（该抽屉不受 st-dom-shield.ts 遮罩），手动值权威，停用恢复按兵不动、
只清掉过期备份；(2) `backupOnce()` 返回三态结果（`established` / `already-present` /
`unreadable`），`activateNativeTruncationGuard()` 只有存在有效恢复点时才应用覆盖，读不
出真实值时拒绝激活并 `console.warn`，绝不裸奔——没有性能收益的会话总好过永久搁浅哨兵
值、无路可退的会话；(3) 新增 `isNativeTruncationGuardLive()` 查询「本次会话覆盖是否真
的在生效」，与 `nativeTruncationOverrideEnabled` 标志的当前取值解耦——`src/index.ts` 的
`disableChatuiLayers()` 现在按这个会话态分叉，而非按标志值分叉，未来标志接出 UI 开关后
半途翻掉也不会把停用路径错误地导向裸 `teardown()`。

| 不变量 | 验证 |
| --- | --- |
| 备份对真实值 0（无限制）保真，随后覆盖把内存值精确改写为哨兵值 1 | `test/native-window-guard.test.mjs :: backupOnce takes a value-faithful backup of a real chat_truncation of 0 (unlimited), and applyOverride then flips the live value to the sentinel` |
| 备份写一次：备份存在期间的第二次激活绝不能用覆盖值顶替真实值 | `test/native-window-guard.test.mjs :: backupOnce is write-once: a second activation cannot clobber an existing backup with the override value` |
| 无法读出有限数字时备份拒绝捏造数值 | `test/native-window-guard.test.mjs :: backupOnce refuses to fabricate a backup when the live chat_truncation cannot be read as a finite number` |
| 标志关闭时绝不触碰 power_user，也绝不写入任何持久化记录 | `test/native-window-guard.test.mjs :: activateNativeTruncationGuard(false) never touches power_user or persists anything` |
| 激活失败闭合：读不出有限数字时拒绝覆盖，不捏造备份，返回值体现拒绝 | `test/native-window-guard.test.mjs :: activateNativeTruncationGuard fails closed when the live chat_truncation is unreadable: no override applied, no backup fabricated, return value reflects the refusal` |
| 已有备份（already-present）本身就是有效恢复点，激活照常应用覆盖，不重复写备份 | `test/native-window-guard.test.mjs :: activateNativeTruncationGuard applies the override when a valid restore point already exists (already-present outcome)` |
| 自愈在崩溃留下覆盖值的现场下，对真实值 0（无限制）照样保真还原并清空备份 | `test/native-window-guard.test.mjs :: selfHealNativeTruncation restores a backed-up real chat_truncation of 0 (unlimited) after a crash left the override persisted, and clears the backup` |
| 无备份时自愈直接空操作 | `test/native-window-guard.test.mjs :: selfHealNativeTruncation no-ops without a backup` |
| 备份存在但当前值不是覆盖哨兵时，自愈绝不覆盖用户手动设的活值，并把过期备份作废（防再激活时借尸还魂） | `test/native-window-guard.test.mjs :: selfHealNativeTruncation keeps a manually-changed live value authoritative and discards the stale backup` |
| 崩溃残留备份 + 手动改值 + 再激活 + 停用的完整链路里，最终恢复的必须是用户手动值，绝不是崩溃年代的旧备份 | `test/native-window-guard.test.mjs :: a stale backup surviving a crash-after-manual-change is never resurrected across reactivation and disable` |
| 停用恢复：写回真实值、持久化，并清空备份记录 | `test/native-window-guard.test.mjs :: restoreForDisable restores the backup, persists it, and clears the backup record` |
| 本次会话从未激活过（无备份）时停用恢复是空操作 | `test/native-window-guard.test.mjs :: restoreForDisable is a no-op when the guard was never activated this session` |
| 停用恢复镜像自愈的守卫哲学：当前值已不是覆盖哨兵（用户经 ST 原生设置手动改过）时，手动值权威，停用恢复按兵不动，只清掉过期备份 | `test/native-window-guard.test.mjs :: restoreForDisable leaves a manually-changed live value alone (the user's own setting is authoritative) and clears the now-stale backup instead of stomping it` |
| 「本次会话是否已激活覆盖」的查询与 nativeTruncationOverrideEnabled 标志的后续取值解耦：激活后即使标志被翻回 false 也不回退会话在场状态，直到停用恢复真正跑过 | `test/native-window-guard.test.mjs :: isNativeTruncationGuardLive reflects whether the override actually applied this session, independent of the enabled flag on later calls` |

## 15. 删除确认对话框（store/confirm-store）

ChatUI 自有确认对话框存储（DOM-DECOUPLING.md 决策 #3 的 Tier 2 落地：不再直调 ST
原生 `callGenericPopup`）。仿 toast-store.ts 的写法：单值 createStore + 一组纯函数，
promise 化的 request/resolve API。同一时刻至多一个待答请求——挂载在 app 根的对话
框宿主组件只能同时渲染一个弹窗；更晚的请求会抢占更早、尚未回答的请求（把它的
promise 用 'cancel' 结算，绝不留空悬 promise），这是钉死的设计而非偶然状态。

| 不变量 | 验证 |
| --- | --- |
| 两态请求往返：待答期间 getChatuiConfirmRequest() 能读到它，resolveChatuiConfirm 结算其 promise 并清空存储；cancelLabel/danger 缺省值正确，二态请求绝不带 escalateLabel | `test/confirm-store.test.mjs :: a two-way request round-trips: getChatuiConfirmRequest() reflects it while pending, resolveChatuiConfirm settles its promise and clears the store` |
| 三态请求带着 escalateLabel，三种结果都精确结算 promise | `test/confirm-store.test.mjs :: a three-way request carries its escalateLabel through, and each of the three outcomes settles the promise with exactly that value` |
| variant='two-way' 请求会丢弃调用方误传的 escalateLabel | `test/confirm-store.test.mjs :: a variant: "two-way" request drops any escalateLabel the caller mistakenly passes — the dialog host must never render a third button for it` |
| cancelChatuiConfirm 与 resolveChatuiConfirm(id,'cancel') 行为一致 | `test/confirm-store.test.mjs :: cancelChatuiConfirm settles the promise with "cancel" and clears the store, same as resolveChatuiConfirm(id, "cancel")` |
| 待答期间的新请求抢占旧请求：旧请求的 promise 以 'cancel' 结算（不留空悬），存储立即只反映新请求 | `test/confirm-store.test.mjs :: a second request while one is still pending pre-empts it: the first promise resolves "cancel" (never left dangling), and the store immediately reflects only the newer request` |
| 用过期 id（已回答或已被抢占）调用 resolve 是静默空操作，绝不误伤当前在场的新请求 | `test/confirm-store.test.mjs :: resolving a stale id (already answered, or pre-empted by a newer request) is a silent no-op — it must never resolve a different, newer pending request out from under it` |
| 用从未请求过的 id 调用 resolve/cancel 是静默空操作，不抛错 | `test/confirm-store.test.mjs :: resolving an id that was never requested at all is a silent no-op, not a throw` |
| 整体重置（teardown）会把在场的待答请求以 'cancel' 结算并清空存储 | `test/confirm-store.test.mjs :: resetChatuiConfirmStore resolves any outstanding pending request with "cancel" and clears the store` |
| 无待答请求时整体重置是无害空操作 | `test/confirm-store.test.mjs :: resetChatuiConfirmStore with nothing pending is a harmless no-op` |
| 订阅在请求发起时收到该请求、回答后收到 null；取消订阅后不再收到通知 | `test/confirm-store.test.mjs :: subscribeChatuiConfirm notifies with the request on request and with null once answered; unsubscribing stops further notifications` |
| 连续多轮请求各自拿到独一无二的 id | `test/confirm-store.test.mjs :: sequential requests each get a distinct id, even across many round trips` |

### 15.1 吞键守卫（设计稿 §9）

对话框把焦点交给**确认钮**（不再是取消钮），按键因此直接回答问题；换来的安全性
不靠焦点位置，而靠一段时间守卫：弹出后 300ms 内的激活键一律吞掉。危险的从来不是
「用户有意按了回车」，而是「弹窗在用户连打回车的手底下冒出来」。判定被抽成
`shouldAcceptConfirmKey(openedAtMs, nowMs)` 这个纯函数，因此可以脱离 DOM 钉死；
组件层只负责记下自己何时挂载、以及把「吞」落实成 preventDefault（否则已获焦的确认
钮会自己原生点击一次）。

守卫按**时间**而非按键判定，所以「激活键」由组件层定义为 Enter **与空格**两个：
设计稿只点名 Enter，是因为它那份原型的按钮是不可聚焦的 span，空格根本够不着；本项
目用的是真 `<button>`，空格同样会原生激活它，漏掉空格等于给守卫留一个正好一次按键
宽的洞。空格没有「焦点不在按钮上时的兜底确认」——对着空处敲空格不是对任何问题的
回答。

| 不变量 | 验证 |
| --- | --- |
| 守卫窗口是「左闭右开」的 300ms：同一瞬间、1ms、299ms 都拒绝，正好 300ms 及以后接受 | `test/confirm-store.test.mjs :: shouldAcceptConfirmKey refuses an activation keystroke for the whole guard window and accepts it from the boundary onward` |
| 时间戳异常一律按拒绝处理（时钟倒流、Infinity、NaN、undefined）——坏时间戳绝不能反过来授权一次删除 | `test/confirm-store.test.mjs :: shouldAcceptConfirmKey fails closed on a clock that ran backwards or on a timestamp that is not a finite number` |
| 判定是纯函数：不读存储状态，有无在场请求都给同一答案 | `test/confirm-store.test.mjs :: shouldAcceptConfirmKey is pure: it reads nothing from the store, so an open dialog, a settled one and no dialog at all give the same answer` |

## 16. 未覆盖缺口（❌ 补测待办）

2026-07-19 第一批六个单元层缺口已全部补齐（§3、§4 新增行），滚动中编辑的浏览器
验收已入 §13；2026-07-26 又把原先只取消的路径升级为真实保存、草稿清除和普通
卸载/重挂载读回，并补齐 character 角色消息的 `⋯ → Edit` 入口。同日第二批：
native-window-guard 的两条 index.ts 接线路径浏览器层
缺口**已闭合**——`scripts/e2e/verify-truncation-guard.mjs`（§13）新增两个真实
Chromium 场景，直接驱动 index.ts 本身的 `setup()`/`disableChatuiLayers()` 接线
（而不再只在假宿主里调用编译后的 `adapter/native-window-guard.js`）：场景 A 覆盖
「停用即刷新」（flag-on 激活 → 真实停用控件 → 断言走的是 sealed-queue 刷新而非
原地 `teardown()` → 刷新后原值/备份/原生窗口全部恢复，并顺带折入一次
already-present 再激活的回归），场景 B 覆盖「bootstrap 自愈」（预置崩溃现场的数
据根开机后，`init()` 顶部的自愈先于一切其他可观察行为跑过）。**这条浏览器层缺口
不是「补个测试就绿」——首次真实运行时场景 A 在停用-刷新往返上 120s 超时，诊断
（真实往返 + 磁盘/DOM 插桩复现）查明是 `disableChatuiLayers()` 的真实产品缺陷：
停用时只调防抖的 `saveSettingsDebounced()` 就几乎同步 `location.reload()`，而
`saveSettingsDebounced` 是 ST 单个共享定时器（每次调用都重置整个防抖窗口），
reload 摧毁页面上下文的时机必然早于该窗口，导致 `enabled: false` 与截断恢复两
笔落盘写入必然丢失、ChatUI 在下次开机又整套重新激活，原生 `#chat` 因此钉死在
截断哨兵计数上。已在 `src/index.ts` 修复（reload 前 `await` 真实 `saveSettings()`，
不再依赖防抖），详见本节场景 A 描述与 DOM-DECOUPLING.md「停用恢复」行的时序缺
陷补充说明；两个场景现已全绿。`nativeTruncationOverrideEnabled` 已于 2026-07-19
经 owner 显式决策默认开启，`verify-truncation-guard.mjs` 同日接入 CI 发布门禁。

2026-07-22 又闭合了翻默认值后遗留的主门禁固件缺口：数据根生成器、Playwright
smoke、chat-switch 与 perf 默认都走 flag-on；生成器始终把请求的布尔值显式写入
`chatui_composer.config`，因此显式 flag-off 不会因缺键而回退到产品默认 true。
Playwright smoke 直接断言 live `chat_truncation`、备份与原生 `.mes` 数量为
`1 / 100 / 1`，并在原生只挂最后一行时保存编辑历史消息；chat-switch 默认按产品
flag 断言原生只挂 1 行。性能对照仍可用 `--truncation-guard off` 显式请求，不再让
默认门禁暗中覆盖产品路径；该 off 路径会在任何可选工具级截断改写之前断言持久配置
为 `false`、live 值仍是用户原值且不存在守卫备份，避免测试自己把误激活的守卫覆盖
回 100 后洗绿。当前剩余：

浏览器层：

- 双滚动系统（useAutoScroll 与 virtualizer 内建 end-anchoring）的一致性——待合并为
  单一机制后补断言，当前为已知重构待办。**2026-07-31 起这笔债还了第一笔**：两道
  阈值判定已下沉到纯模块 `src/ui/follow-scroll-math.ts` 并被 §9 的七条单测钉死
  （其中 80px 贴底门与 virtualizer 的 `scrollEndThreshold: 80` 是同一个数，两者
  失配正是这条债的核心风险）。仍留在浏览器层的是 hook 的接线本身：scroll 监听、
  `wasAtBottomRef` 与 rAF 合帧、切换对话时的落底，这些没有 DOM 就无法验证。

需要 src 级注入口子或只能在浏览器层验证：

- DOM-DECOUPLING.md Tier 1（2026-07-19，2026-07-19 复审后修订）已把
  `triggerMessageActionById` 对 copy/branch/checkpoint/hide 的
  `#chat .mes[mesid="X"]` 依赖撤除，这四个动作现在完全在单测层覆盖。
- **DOM-DECOUPLING.md Tier 2（2026-07-19）之后，delete（整条）的核心逻辑本身也已
  下沉到单测**（`deleteMessageWithIntent`/`_deleteFullMessageById`，§7）——它不再
  依赖 `.mes` 节点存在与否，假 DOM 的「无法解析复合选择器」限制不再是它的阻碍，
  这条湮灭的缺口不再登记。**2026-07-19 复审曾在此发现一个真实数据损坏缺陷**（被
  删 id 本身未渲染、更晚的行已渲染时，旧实现委托的原生 `updateViewMessageIds`
  会静默把重编号变成空操作——见 §7 上方「重编号陷阱」段落），已用自有的
  `_renumberRenderedRowsAfterDelete` 修复，且该函数改走 `#chat` 直接 `.children`
  加纯 classList 树遍历（不用复合选择器），所以修复后的重编号规则本身**已经**
  被假 DOM 单测真正练习到（§7 的四条新测试直接断言仍渲染行的 `mesid`/
  `mesIDDisplay`/`last_mes` 被改对，不再只是断言「调用时传了对的参数」）。仍留在
  浏览器层的，是分叉里唯一真正依赖真实 DOM、且假 DOM 结构性做不到的一步：目标消
  息**确实渲染**时，`mesEl?.remove()` 是否真把那个节点从真实 `#chat` 移走（假
  DOM 里 `getMessageElementById` 永远解析不出复合选择器，这一步在单测里天然是空
  对象分支，从未被真正练习过——§7 的新测试改用「直接不渲染被删 id 对应的行」来
  模拟移除后的 DOM 形态，绕开了这个限制去验证重编号本身，但没有、也不能验证移除
  这一步的真实发生）。
- **新增（Tier 2）：ChatUI 自有确认对话框（ConfirmDialogHost + ConfirmDialog 的
  三态渲染）目前零浏览器级驱动**——store/confirm-store.ts 的状态机本身有完整单测
  （§15），store/chat-actions.ts 的编排逻辑经假宿主有完整单测（§2），但组件本身
  （挂载位置、三个按钮是否真的渲染在正确的 variant 下、Escape/背景点击是否真的
  触发 cancel、`resolveChatuiConfirm` 是否真的把 store 状态清空进而让对话框消
  失）从未在真实浏览器里点击过。同理，「点击 UI 上的删除 → 真弹窗出现 → 点击真
  按钮 → ST 真实 `chat`/`#chat` DOM 发生预期变化」这条端到端路径也是空白——这是
  比上一条「mesEl?.remove() 的真实效果」更外层、更贴近用户可感知行为的一层缺口，
  没有便宜地折进现有任何一道浏览器门禁（`e2e/smoke.spec.mjs`、
  `scripts/e2e/measure-chat-switch.mjs`），需要专门补一条 Chromium 场景。
- **2026-07-19 Tier 3 后现状更新**：`saveMessageEditById` 本身（DOM-DECOUPLING.md
  Tier 3 分叉）已完全 DOM-free，不再依赖 `#chat .mes[mesid="X"]` 复合选择器，
  这条湮灭的缺口不再登记——契约测试（regexPlacement/characterOverride/
  组合顺序/bias 分支/ensureSwipes 顺序/trim_spaces/事件顺序/保存口味/渲染行
  愈合/入参校验）全部下沉到 §7 单测。仍然依赖 `#chat .mes[mesid="X"]` 复合选
  择器与 jQuery 委托、假 DOM 不支持、只能由 Chromium e2e 覆盖的仅剩
  `swipeMessageById`（含 `triggerMessageActionById` 里的 `regen` 分支）——即
  swipe（候选切换）与 regen（生成菜单）本身；若要下沉到单测需给元素查找加注
  入 seam。`_healRenderedMessageRow` 的 `getContext().updateMessageBlock` 愈合
  调用本身**已被浏览器门禁真实驱动**（2026-07-19 复审实证：shield 只是 CSS 隐藏
  原生窗口、`.mes` 行仍挂载，smoke 的编辑往返每次都实际触发愈合并回读到已编辑
  文本）；仍属浏览器层缺口的只剩 `updateMessageBlock` 更丰富的副作用断言——
  reasoning UI、code-block 复制按钮、媒体重挂目前无显式断言（smoke 只验证
  `.mes_text` 文本），可并入未来的浏览器场景补测。
- **2026-07-19 复审 meta-finding（Tier 2 后现状更新）**：现有两道真实 Chromium
  门禁（`e2e/smoke.spec.mjs`、`scripts/e2e/measure-chat-switch.mjs`）均未驱动任
  何消息动作分发路径——前者只验证会话渲染 + 一次消息**编辑**往返，后者只做切换
  性能测量；对 `triggerMessageActionById`/`copyMessage`/`deleteMessageWithIntent`/
  `branchChat`/`createNewBookmark`/`hideChatMessage` 等符号的 grep 结果为零命
  中。也就是说 copy/branch/checkpoint/hide/delete 五个动作的浏览器级驱动目前完
  全是空白——§13 的「消息编辑往返」是这批动作里唯一被真实 Chromium 验收过的一
  个。是比「需要 src 级注入口子」更基础的一层缺口，记在此处防止随时间被忽略。

低价值备忘：

- 附件投影与 reasoning 格式化缓存在同一次消息投影中的交叉组合测试（两者已分别
  覆盖，交叉场景价值有限）。
