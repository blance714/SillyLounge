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
| 待删文件不存在时只做一次存在性检查、绝不发出破坏性请求，并如实上报 `absent`（供调用方清掉自己那条已无文件可指的租约） | `test/adapter-chats.test.mjs :: deleting a chat absent from the raw directory listing reports it as absent after one existence check, without issuing the destructive request` |
| 目录读取失败绝不冒充「文件不存在」：读不到不等于不在，否则会丢掉仍持有真实文件的隔离租约 | `test/adapter-chats.test.mjs :: a directory listing that could not be read is never reported as absence` |
| 「没有文件」不等于「没有这场对话」：待删名字正是运行时当前所在的会话时绝不上报 `absent`（它只是还没落盘，下一次保存就会写回来；报 absent 会让调用方丢掉活草稿的租约，落盘后变成无人认领的永久历史） | `test/adapter-chats.test.mjs :: a missing file that is still the live chat is not absence: the conversation is alive and unsaved, so the lease must survive` |
| 丢弃一条文件已消失的隔离草稿必须清掉租约并如实告知，绝不报「删除失败」（丢弃就是这一次调用，报失败等于租约永远清不掉） | `test/sidebar-actions.test.mjs :: discarding a quarantined draft whose file has already vanished drops the lease instead of reporting a failure that can never be retried` |
| 结算这条「文件已不存在」的删除同时必须广播该对话已消失：宿主什么都没删，就不会有 CHAT_DELETED，而侧栏缓存的角色列表仍握着这个文件名——不广播的话草稿卡不是消失，而是**转成**一条指向不存在文件的普通历史行（真机 danglinglease 格实测） | `test/sidebar-actions.test.mjs :: settling a delete against a file that is not there announces the vanished conversation, so the cached listing cannot go on serving it as ordinary history` |
| 恢复一条文件已消失的草稿、以及宿主回 `notfound` 的那次打开，走同一条广播：同一个消失的文件，「恢复」与「丢弃」不得给出不同的列表结局。注意 `notfound` 的范围比字面窄——`adapter/chats/navigation.ts` 只在**角色卡不在名册**或文件名为空时回它，从不为「聊天文件消失」回它（对已在台上的角色打开一个不存在的文件，ST 当作空对话加载，不报错），所以**普通历史行的文件消失走不到这里**，见 `ROADMAP.md` G4 | `test/sidebar-actions.test.mjs :: both of openChatuiChatForCharacter's "it is not there" exits announce the vanished conversation too: a restore whose draft file is gone, and a host-reported notfound` |
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
| 删除角色仅剩的一条对话时，指针被移到一个尚不存在的兜底文件名，并把该文件名如实上报（供调用方在下次启动时纳入草稿隔离） | `test/adapter-chats.test.mjs :: deleting a character's only remaining chat persists a fabricated fallback pointer and reports it back for draft quarantine` |

pr9 第 3 棒新增、第 4 棒收尾时重写的兜底规则（DESIGN §3、评估 §5 3.6）：删除当前
对话后绝不能停在「角色已选中、没有任何对话」的中间态。同角色还有其它对话时沿用上面
已有的替换指针逻辑；角色的对话被删空时，`delete-transaction.ts` 把指针指向一个尚未
写入磁盘的兜底文件名并通过 `fallbackChatFileName` 上报，`sidebar-actions.ts` 在强制
刷新前排下一张 `sessionStorage` 凭证（`queueCharacterChatDraftQuarantine`），下次
启动把那个文件折进 `temp-chat-store.ts` 的隔离集——和 ＋新对话走同一条路径，而不是
悄悄变成一条没人要求保留的永久历史记录。

**观察时机是这条规则的全部难点**，第一版就是在这里必输：它挂在 APP_READY 上、去查
目录里有没有那个文件。ST 的 `initRossMods()`（script.js:772）不 await
`RA_autoloadchat()`（RossAscends-mods.js:697），APP_READY 由另一条 async 链在
script.js:788 发出，所以物化那个文件的 `saveChatConditional()` **永远**排在
APP_READY 之后（真机 1.18.0 实测：目录读取 848ms 完成、凭证 855ms 被清、
`POST /api/chats/save` 949ms 才发出）。那道磁盘核验问的是「ST 保证会发生、但保证发生
在我们唯一的观察点之后」的事，本就不是本仓库该守的不变量。

现在磁盘核验连同这条链路上的全部网络请求一起去掉了，只留**身份核验**——「该角色此刻的
当前对话就是我们捏出来的那个文件名」。观察点也随之从 APP_READY 移到「兜底文件成为当前
对话的那一刻」：启动时若 ST 的 autoload 已经先到就当场成立，没到就等本页后续的
CHAT_CHANGED（autoload 关掉、读者自己点开该角色，或由下面那条事务收尾把角色选上，
同样成立）。

**这道核验能证明什么，两条分支并不相同**，早先这里把强的那条写成了两条都成立，现按
实测订正：走 **CHAT_CHANGED** 时文件确实已在盘上（`getChatResult()`，script.js:7625，
先 await `saveChatConditional()` 才发事件，事件不可能早于落盘）；而真机上实际走的是
**立即判定**那条（autoload 早于 APP_READY 完成），它读的
`getCurrentChatDetails().sessionName` 就是 `characters[this_chid].chat`
（script.js:8478）——正是我们自己在强制刷新前写进去的那个指针，与磁盘无关。真机 1.18.0
字节级记录：租约在 t=843ms 建立，`POST /api/chats/save` 到 t=985ms 才发出，隔离比文件
早约 142ms。两条已知边界如实记在这里，并且是**接受**而不是遗漏：

- 若那次 `saveChatConditional()` 直接失败，会留下一条指向永不出现的文件的草稿租约。
  这是可恢复态而非坏态，而且恢复刻意走**休眠卡**而不是活着的那一条：读者还站在这场
  对话里时，它只是「没落盘」而不是「不存在」，删除事务因此拒绝把它判成 `absent`，好
  让租约撑过下一次把文件写回来的保存；读者离开之后，恢复它会先查原始目录并清掉租约
  （`openChatuiChatForCharacter`），丢弃它会拿到 `absent` 同样清掉租约
  （`delete-transaction.ts`），两条路都不卡住。
- 那约 142ms 窗口内点「丢弃」，DELETE 会跑在 ST 的 CREATE 前面，文件随后被创建却不再
  被租约持有——正是这条规则要防的「兜底文件变普通历史」。接受的理由是这个窗口人手
  不可达：草稿卡要渲染出来、被找到、被点开、确认框还要被按下，全部发生在页面出现后的
  十分之一秒内。真要封死它，只能把立即判定挪到一个保证晚于落盘的信号上——那就是
  CHAT_CHANGED，而真机上那一次在本段代码首次运行前就已经发过了；改等下一次会让所有
  正常 autoload 启动全部落空。

ST 的 `power_user.auto_load_chat` **默认是 false**（power-user.js:335；本仓库 e2e
固件把它强制为 true，这也是先前全部真机证据都产自非默认设置的原因）。默认设置下那次
强制刷新会落在「一个角色都没选中」：ST 不会去载入该角色、兜底文件永不写出、凭证等一个
永远不来的信号，读者被留在比「角色已选中、没有对话」更糟的空台上。所以
`finalizeChatuiDraftQuarantine` 在凭证仍在等待、且**没有任何人占台**时，主动
`selectCharacterById` 凭证指向的那个角色——这是读者已经发起的删除事务的收尾（刷新本就
是 ChatUI 自己强制的），不是替读者改 autoload 偏好：只要 ST 落在了任何地方（角色或
群聊），adapter 一律拒绝
（`adapter/chats/navigation.ts` 的 `selectCharacterIfNobodyIsOnStage`），凭证按既有
语义继续等待。每次页面加载至多一次（认领盖章天然保证），落不下去不重试、不弹 toast。

这一次落地和本模块其它宿主变更一样走**共享串行通道**（`enqueueHostTask`）：
`selectCharacterById` 动的就是那个唯一的实时会话上下文，「它是启动工作」不构成豁免。
启动时通道本就可用（模块级状态在求值时已是「空闲尾 + epoch 0 + 未封印」），而唯一会
让入队时捕获的 epoch 作废的 `resetHostOperationQueueLifecycle` 只有 UI 拆卸与终局刷新
封印两个调用方——`index.ts` 紧接着做的挂载不是其中之一，所以挂载不会取消这次落地；
读者在这几百毫秒里关掉 ChatUI 则**会**取消它，而那正是应有的结果（不入队的旧写法会
在扩展已经关掉之后仍替他选中一个角色）。入队只可能推迟、不可能提前这次调用，所以
「CHAT_CHANGED 监听必须先于落地注册」这条时序约束只会更牢。

bootstrap 模式（`settings.enabled === false`）下唯一被摘掉的就是这一步落地
（`finalizeChatuiDraftQuarantine({ completeLanding: false })`）：此时屏幕上只有 ST 自己
的界面，一个被读者关掉的扩展不该在那上面替他选角色，而且没有 ChatUI 界面也就无人被
「空台」困住——空台就是 ST 自己的行为。其余全部照跑，且理由都超出本页：**认领**是把
凭证限死在它所属的那一次加载（不认领的话它会活到很久以后的某次启动，把读者早已当成
普通历史的文件追认成草稿），**监听**则保证 ST 真写出兜底文件时它仍进隔离集（租约是持
久化的，ChatUI 回来时它仍是草稿而不是无人认领的永久历史）。「关扩展→刷新→再开扩展」
的归宿即由此确定：重新打开扩展只是挂载、不重跑本函数，也不需要重跑——凭证已为本页认
领；文件已上台则租约在隔离集里等着，无人占台则凭证仍在等待且 spine 会把该角色摆出来
（`peek`），读者可以自己走过去收尾；再刷新一次就按既有过期规则丢弃。

凭证因此在不匹配时**保留**而不是销毁——它的语义是「这个文件名若成为当前对话即隔离」，
一次落在别的角色/别的对话上并不是反证。有界性不靠任何时间常数：`sessionStorage` 本身
已把它限定在本标签页内，`armPendingCharacterChatDraftQuarantine` 再给「拥有它的那一次
页面加载」盖章，该页没有兑现的意图由下一次启动直接过期丢弃。adapter 层只读判定，真正
写隔离集的动作留给 store 层，符合分层边界（`check-boundaries.mjs`）。

| 不变量 | 验证 |
| --- | --- |
| 没有排队的兜底草稿隔离凭证时，认领函数直接返回 null，不发任何请求、不写任何存储 | `test/adapter-chats.test.mjs :: armPendingCharacterChatDraftQuarantine resolves null and touches nothing when no tombstone was queued` |
| 缺角色 avatar 或文件名时排队函数是纯空操作，不写入任何凭证 | `test/adapter-chats.test.mjs :: queueCharacterChatDraftQuarantine with a missing avatar or filename is a no-op` |
| 启动时 ST 尚未载入兜底文件（真实时序）不算失败：凭证保留、判定为 waiting；兜底文件成为当前对话的那一刻才交还指针并清空凭证，且全程零网络请求 | `test/adapter-chats.test.mjs :: the draft-quarantine tombstone waits through the boot in which ST has not yet loaded the fallback file, then resolves the moment it becomes the live chat — without ever reading the chat directory` |
| 当前对话是别的文件、或同名文件挂在别的角色下时一律 waiting：绝不误隔离别人，也绝不因此丢弃仍待兑现的意图 | `test/adapter-chats.test.mjs :: the draft-quarantine tombstone keeps waiting while an unrelated chat holds the live slot, and never quarantines it` |
| 已被上一次页面加载认领却未兑现的凭证，由下一次启动过期丢弃，绝不无限悬挂；过期之后连只读的 peek 也读不到它（spine 拿它当入列来源且收不到任何变更通知，过期后仍读得到就会白占一个位子直到本会话结束） | `test/adapter-chats.test.mjs :: a draft-quarantine tombstone the previous page load already armed is expired by the next boot instead of dangling` |
| 没有凭证时判定函数报 settled 并短路，连当前对话身份都不去读 | `test/adapter-chats.test.mjs :: resolvePendingCharacterChatDraftQuarantine reports settled without reading the live chat when no tombstone is queued` |
| 删除角色仅剩对话时，`deleteChatuiChat` 在刷新前把兜底文件名连同既有的 CHAT_DELETED 回放凭证一起排队；下次启动 `finalizeChatuiDraftQuarantine` 先认领、再等 CHAT_CHANGED，兜底文件真正上台后才折进临时会话隔离集并标记为活跃，随即注销监听 | `test/sidebar-actions.test.mjs :: deleting a character's only chat queues the draft-quarantine tombstone before reload, and finalizeChatuiDraftQuarantine folds the fallback file into the same temp-chat quarantine ＋新对话 uses once ST's boot finally makes it live` |
| 删除后仍有真实剩余对话时绝不排队草稿隔离凭证，也绝不污染隔离集 | `test/sidebar-actions.test.mjs :: deleting a chat that leaves a real remaining conversation never queues a draft-quarantine tombstone` |
| 非兜底文件的 CHAT_CHANGED 既不隔离它、也不丢弃凭证，继续等真正那一条 | `test/sidebar-actions.test.mjs :: a pending draft quarantine ignores chat changes that are not its fallback file, and keeps waiting for the one that is` |
| 没有待处理凭证时 `finalizeChatuiDraftQuarantine` 是纯空操作：零网络请求、隔离集不变、不留下任何 CHAT_CHANGED 监听 | `test/sidebar-actions.test.mjs :: finalizeChatuiDraftQuarantine is a no-op when no draft-quarantine tombstone is pending` |
| 凭证不消费也不认领即可读出它指向哪个角色（供 spine 入列），peek 之后 arm/resolve 语义一字不变 | `test/adapter-chats.test.mjs :: peekPendingCharacterChatDraftQuarantine reports who a waiting credential is about without arming or consuming it` |
| ST 默认设置（不 autoload）下启动落在「没有角色」时，凭证指向的角色被主动选上，落地后按常规持久化 active_character | `test/adapter-chats.test.mjs :: a pending chat transaction lands on its character when ST's boot chose nobody, persisting the selection like any other landing` |
| 已经有人占台（读者 autoload 回来的角色，含下标 0；或群聊）时一律不抢，且什么都不持久化 | `test/adapter-chats.test.mjs :: a pending chat transaction never steals a stage somebody already holds — not a character ST autoloaded, not a group` |
| 角色卡已不存在、或 ST 拒绝这次选择时如实上报且不持久化，绝不假定落地 | `test/adapter-chats.test.mjs :: a pending chat transaction whose character is gone, or whose selection ST refuses, reports it and persists nothing` |
| 空台启动时事务收尾走完全程：选上角色 → ST 写出兜底文件并发 CHAT_CHANGED → 折进隔离集、凭证消费、监听注销 | `test/sidebar-actions.test.mjs :: a boot that lands on nobody finishes the delete transaction itself: ChatUI selects the credential's character and the fallback file lands in quarantine` |
| 启动落在别的角色上时绝不改动，凭证继续等待；读者之后走到该角色仍照常兑现 | `test/sidebar-actions.test.mjs :: a boot that landed on somebody else is never overridden: the credential simply keeps waiting` |
| ChatUI 关着时（bootstrap 模式）绝不替读者在 ST 原生界面里选角色，但凭证照常认领、监听照常挂：ST 若真写出兜底文件仍折进持久化隔离集，ChatUI 回来时它还是草稿 | `test/sidebar-actions.test.mjs :: with ChatUI switched off the boot still arms and watches the credential, but never selects a character inside ST's own interface` |
| 「关扩展→刷新→再开扩展」：bootstrap 页认领却没兑现的凭证由下一次启动过期丢弃，绝不在一页之后才选中某人，之后才上台的同名文件是普通历史而非被追认的草稿 | `test/sidebar-actions.test.mjs :: a credential the bootstrap page owned but never redeemed expires on the next boot instead of selecting somebody a page later` |
| 这次落地走共享串行通道：通道里已有宿主工作时必须排队等它做完才进 ST，且排队期间 CHAT_CHANGED 监听已经注册（解析凭证的那个事件正是从落地内部发出的），入队不影响兑现 | `test/sidebar-actions.test.mjs :: the boot landing enters ST through the same serialized lane as the reader's own clicks, never beside it` |

pr9 第 4 棒同时补上的另一条：ChatUI 换角色走 `selectCharacterById()`，它只动实时
选择（`this_chid`）；ST 把持久化的 `active_character` 写在自己
`.character_select` 点击处理器里（RossAscends-mods.js:849-854），任何不经过那行原生
列表的路径都不会更新它。spine 成为唯一换角色入口后，这意味着**任何**刷新（删除当前
对话强制的那次、手动刷新、停用扩展）都会回到读者上一次从 ST 原生列表里点过的角色。
`adapter/chats/navigation.ts` 的 `persistStActiveCharacter` 原样复刻那个处理器的三次
调用；`sidebar-actions.ts` 的 `_reloadForChatTransaction` 则在自己发起的强制刷新前
先 await 一次真正的 `saveSettings()`，因为 `saveSettingsDebounced()` 是全局共享的
cancel-and-re-arm 计时器，刷新落在它 1000ms 窗口内就会静默丢掉这次写入
（同一条理由见 `index.ts` 的 `disableChatuiLayers`）。

下标必须**以字符串**交给 `setActiveCharacter`，这不是风格问题：它先过一道真值门
（`active_character = entityOrKey ? getTagKeyForEntity(entityOrKey) : null`，
script.js:834-837），数字 `0`——也就是列表里的第一个角色——是假值，传进去不但不会
持久化该角色，反而会把指针清空；下次启动时 `RA_autoloadchat` 整段分支都不进，读者
落到「一个角色都没选中」，比这条写入本来要修的「落到旧角色」更糟（真机 1.18.0 实测：
切到 index 0 后 `active_character` 变成 `null`，刷新后 `characterId`/`chatId` 全空）。
ST 自己的处理器不会踩到，是因为 `$(this).attr('data-chid')` 是 DOM 属性、永远是字符串；
`String(index)` 传的就是同一个值。上面「不传 avatar」的理由只针对 avatar，与下标的
字符串化无关（`getTagKeyForEntity('0')` 仍经 `parseInt()` 解析回 `characters[0]`）。

| 不变量 | 验证 |
| --- | --- |
| 换角色成功落地后，按 ST 原生处理器的同一顺序持久化 active_character（传实时下标而非 avatar）并清空 active_group | `test/adapter-chats.test.mjs :: switchCharacter persists the character it just selected as ST's active character, mirroring the native list click` |
| 列表里第一个角色（下标 0）同样被持久化：交给 ST 的键必须是真值，否则等于持久化「没有角色」 | `test/adapter-chats.test.mjs :: the first character in the list persists like any other, even though its index is the one value ST would treat as "no character"` |
| 角色未找到或切换未落地（busy）时绝不持久化，刷新后不会落到一个从未切成功的角色上 | `test/adapter-chats.test.mjs :: a character switch that does not land persists nothing, so a reload never comes back on a character ChatUI failed to select` |
| 打开别的角色的对话同样持久化该角色；该路径被拒绝（busy 回滚）时同样不持久化 | `test/adapter-chats.test.mjs :: opening another character's conversation persists that character too, and rolls back without persisting when the switch is refused` |
| 持久化失败绝不连累读者真正要的那次切换 | `test/adapter-chats.test.mjs :: a failure to persist the active character never fails the switch the reader asked for` |
| 对话事务的强制刷新必须先 await 落盘 ST 设置，再 reload | `test/sidebar-actions.test.mjs :: a chat transaction's mandatory reload lands ST's pending settings write first, so the character ChatUI selected survives it` |

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
| 「复制」的正文归约：角色卡自带的 `<style>` 块（ST 自己的 `decodeStyleTags` 会把它原样放回正文 HTML）绝不当作散文读出，前后段落照常相接 | `test/messages.test.mjs :: _plainTextFromNode: a <style> block a character card carries is never read as prose, and the paragraphs around it still join normally` |
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
| 菜单盒模型常量取自 Chromium 实测（行 33px、分隔线 9px、外壳 10px、留白 4px），不是估算的整数 | `test/menu-placement.test.mjs :: the menu box constants are the ones measured against style.css, not round numbers` |
| 按行数与分隔线数估高，逐一复现浏览器实测的每一种菜单尺寸 | `test/menu-placement.test.mjs :: estimateMenuHeight reproduces every menu size measured in the browser` |
| 下方放得下时向下打开，顶边挂在触发钮下沿（设计 §6 默认方向） | `test/menu-placement.test.mjs :: placeMenuAgainstTrigger: room below opens downward, hung off the trigger bottom` |
| 触发钮贴近视口底边时向上翻转，底边挂在触发钮上沿（危险行不再被切掉） | `test/menu-placement.test.mjs :: placeMenuAgainstTrigger: the desktop bug — a trigger near the viewport floor flips up` |
| 翻转门是「比空间高」而非「与空间等高」：恰好装满仍向下，多 1px 才翻 | `test/menu-placement.test.mjs :: placeMenuAgainstTrigger: the flip boundary is "taller than the space", not "as tall as"` |
| 上方比下方更挤时绝不翻转（含两侧相等的平局判向下） | `test/menu-placement.test.mjs :: placeMenuAgainstTrigger: never flips into a space that is tighter than the one it left` |
| 翻转与否取决于该菜单自身的高度，同一位置的两行菜单照旧向下 | `test/menu-placement.test.mjs :: placeMenuAgainstTrigger: a two-row system menu keeps opening down where a five-row one flips` |
| 两个方向的偏移都只由实测到的触发钮边沿与留白决定，估高绝不进入几何（估错只会换个方向，不会让菜单脱离按钮） | `test/menu-placement.test.mjs :: placeMenuAgainstTrigger: both directions stay welded to an edge of the trigger` |
| 显式 gap 为 0 时对应方向的留白确实消失 | `test/menu-placement.test.mjs :: placeMenuAgainstTrigger: an explicit gap of 0 removes the air on whichever side is used` |
| 标头时间戳把 ST 写过的每种 `send_date`（ISO 8601 / `humanizedDateTime` / epoch 毫秒数与数字串）都渲染成时钟时间，无法辨认的原样透出而不臆造 | `test/format.test.mjs :: formatTimestamp renders every send_date shape SillyTavern writes as a clock time, and never invents one it cannot read` |
| 时长与体积格式化保持中文口径，且「没有数值」不被四舍五入成「零」 | `test/format.test.mjs :: formatDuration and formatBytes stay in the language the rest of the UI speaks and refuse to round a non-quantity into one` |
| 场刊卡片元信息按「N 条」计消息数、绝不写成「N 楼」（楼＝用户回合，会话列表只有 `chat_items` 总条数，写成楼就与楼层轨自相矛盾），缺失的一半连同分隔点一起消失 | `test/format.test.mjs :: the playbill card meta line counts messages under the name 「条」, never under 「楼」, and drops an absent half with its separator` |
| 只剥 ST 自己写的那个精确前缀「角色名 + 空格短横空格」，形近串（无空格短横、串中出现、空角色名下的裸「 - 」）一律不动 | `test/format.test.mjs :: stripChatNameCharacterPrefix drops the host-repeated cast name and nothing that merely resembles it` |
| 顶栏题名的回退判据是「这名字是宿主起的还是读者起的」而非「是否为空」：剥完只剩裸 `humanizedDateTime()` 戳（单聊「角色名 - 戳」、群聊裸戳）即视为无名，回退到角色/群名，再回退 `ChatUI`；读者起的名（含检查点后缀）原样呈现，且宿主戳绝不出现在题名里 | `test/format.test.mjs :: resolveConversationTitle treats a name ST generated as no name at all, and never repeats the eyebrow` |

### 9.1 菜单互斥状态机（store/menu-store.ts）

设计 §6 的「打开任一菜单关闭其余；点击外部关闭全部；Escape 关闭」。互斥不是一条被执行
的规则，而是**状态的形状**：全应用只有一个「当前打开的菜单」槽位，所以「打开 B」本身
就是「关闭 A」，没有任何菜单需要被通知、也没有任何菜单会忘记。此前是四套各自为政的
开合（topbar ⋯ 的原生 `<details>`、三枚 selector chip 各一个 `useState`、＋菜单一个、
消息 ⋯ 菜单内部一个），两个菜单能同时挂着，而 `<details>` 对 Escape 和外部点击都无动
于衷——它的开合状态存在 DOM 里，不在应用里。

消息 ⋯ 菜单是唯一带载荷的一档，因为它是唯一**渲染位置也必须上提**的一档：它的触发钮
住在虚拟行里，行会被 virtualizer 在读者没选择的时刻卸载。只把状态提到全局、渲染留在行
里，会得到两者中最坏的组合——store 说菜单开着，而已经没有组件画它。因此菜单改由
`components/message/MessageMenuHost.tsx` 在 app 根渲染（仍 portal 到 `document.body`，
`body > .cui-root-menu` 这一层级是 `scripts/e2e/measure-chat-switch.mjs` 的定位依据），
锚点里带着行身份与**实测到的触发钮 rect**；至于往哪个方向开，是 rect 加菜单自身行数的
纯函数（§9 的 `ui/menu-placement.ts`），留在知道行数的那一侧算，store 不必被教会菜单
长什么样。

关闭一律按 id 定域：卸载中的组件必须带走自己的菜单，但绝不能关掉**别人**的。这不是假想
的时序——虚拟行可以在另一行的菜单打开的同一次 commit 里被卸载。

| 不变量 | 验证 |
| --- | --- |
| 菜单 id 是闭集（topbar ⋯ / 三枚 selector chip / ＋菜单 / 消息 ⋯），且每一个都真的能开 | `test/menu-store.test.mjs :: the menu ids are a closed set, and every one of them is reachable` |
| 打开任一菜单必关闭当时开着的那个——对 id 全集两两穷举，而非抽查两个（抽查区分不出「一个槽位」与「四个恰好没打架的标志位」） | `test/menu-store.test.mjs :: opening any menu closes whichever menu was open — mutual exclusion is the shape of the state, not a rule applied to it` |
| 触发钮再按一次关自己、按别的直接切换，永不落到两个同开的中间态；消息 ⋯ 的「自己」按行身份判定 | `test/menu-store.test.mjs :: a trigger toggles its own menu and switches to any other, never landing in a state where two are open` |
| 消息 ⋯ 的锚点带齐根级宿主作画所需的一切：行 id、会话键、系统行与否、实测 rect（rect 原样过境，placement 由宿主推导而非入库） | `test/menu-store.test.mjs :: the message menu carries everything its root-level host needs: which row, which chat, and the rect the trigger was measured at` |
| 组件卸载只关自己那一格：`closeChatuiMenuById` 对「已经换成别人」的槽位是无操作 | `test/menu-store.test.mjs :: an unmounting component closes only its own menu: closeChatuiMenuById never touches the menu that replaced it` |
| 行卸载清理同时校验会话键：消息 id 是会话内下标，只按 id 关会让「刚离开的会话的第 12 行」关掉「刚进入的会话的第 12 行」刚打开的菜单 | `test/menu-store.test.mjs :: a virtualised row taking its menu with it matches on the chat as well as the message id` |
| 只有真实迁移才通知订阅者（重复打开同一菜单、空槽位关闭、不匹配的定域关闭一律静默） | `test/menu-store.test.mjs :: only real transitions notify: re-opening the menu that is already open, and closing when nothing is, are silent` |
| 同一行再次按 ⋯ 并带来新 rect 是一次更新而非无操作——两次按之间行可能已经移动 | `test/menu-store.test.mjs :: re-pressing the message ⋯ on the same row with a fresh rect is an update, not a no-op — the row may have moved under the reader` |
| teardown 清空槽位，重挂载后不会留着上一世的菜单 | `test/menu-store.test.mjs :: resetChatuiMenuStore empties the slot so teardown cannot leave a menu open across a remount` |

### 9.2 Escape 三级梯（ui/escape-ladder.ts）

Escape 在本应用有三种含义，分三处结算：获焦的编辑器/改名框在**自己的元素上**
`stopPropagation` 抢先（这一级由焦点在哪里决定，是对「这次 Escape 是干什么的」的真回
答）；剩下两级都是全局的，因此由同一个纯函数按值决出、同一个 window 监听器派发。

不能改成「再加一个 window 监听器」：同一个 target 上的两个监听器按注册顺序跑，彼此之间
`stopPropagation()` 不起作用（它拦的是事件在树上的上下行，而两者都已在树顶）。于是生成
中开着菜单时，一次 Escape 会既关菜单又中断回复。要让它不发生，只剩
`stopImmediatePropagation` 加一个有保证的注册顺序、或捕获阶段拦截——两者都把优先级编码
进「监听器碰巧何时安装」，正是本项目拒绝的那种靠时序运气的写法。

| 不变量 | 验证 |
| --- | --- |
| 菜单开着时 Escape 只关菜单：与生成中重叠的那一格必须解出**唯一**意图，关菜单绝不顺带中断回复 | `test/escape-ladder.test.mjs :: resolveEscapeIntent: an open menu answers the key before a running generation does, and answers it alone` |
| 无菜单时才落到停止生成 | `test/escape-ladder.test.mjs :: resolveEscapeIntent: with no menu on stage the key falls through to stopping the generation` |
| 两者都没有时判 `ignore`，调用方据此**不**调用 preventDefault——Escape 仍属于宿主与浏览器 | `test/escape-ladder.test.mjs :: resolveEscapeIntent: with nothing of ChatUI's on screen the keystroke is not ours to take` |

### 9.3 消息 ⋯ 菜单的行清单（ui/message-menu-rows.ts）

行清单被两个组件读：虚拟行据此决定要不要画 ⋯ **触发钮**，根级宿主据此画菜单本身。各自
推一份就会出现「触发钮存在、菜单是空的」或反之。每行只写 `ChatuiAction` 字符串而不带闭
包，这正是清单能跨越那道缝的原因——宿主拿 store 里的锚点派发，不回指那个已不保证还挂
着的行。

| 不变量 | 验证 |
| --- | --- |
| 普通楼按设计 §45 顺序给五行，分隔线画在破坏性那行之上，且「编辑」自 §42 重组后永不出现在菜单里 | `test/message-menu-rows.test.mjs :: buildMessageMenuRows: an ordinary turn carries design §45's five rows, in order, with the rule drawn above the destructive one` |
| 系统行不是任何人说的一句话，只给两种复制，且清单非空（触发钮正是靠这一点存在） | `test/message-menu-rows.test.mjs :: buildMessageMenuRows: a system row is not a turn anyone speaks, so it offers only the two copies` |
| 两种清单喂给翻转判定的估高，正是 Chromium 实测的 184px / 76px | `test/message-menu-rows.test.mjs :: the row lists feed the flip decision the sizes actually measured in Chromium` |

### 书脊入列规则（ui/spine-cast.ts）

spine 是 ChatUI 唯一的换角色入口（ST 原生列表在遮罩之下），所以「不在 spine 上」等于
「在 ChatUI 里走不到」。原规则只看 `chat_size > 0`，而 `chat_size` 是 ST 每次启动枚举
角色 chats 目录得到的**磁盘快照**（`calculateChatSize`，src/endpoints/characters.js），
本页内不再刷新——于是删空某角色最后一条对话并重载后，正站在台上的那个角色当场从轨上
消失，且再也回不去。入列改为四类来源的并集：磁盘上有对话 ∪ 当前在台 ∪ 持有 temp-chat
隔离租约 ∪ pending 草稿隔离凭证指向；「从未用过的角色不上 spine」这个原始目的保留。

排序是两段：第一段是「ChatUI 知道它此刻活着、而磁盘快照还报零」的（即仅靠后三类来源
入列的），第二段是其余；段内一律按 `dateLastChatTs` 降序，也就是 spine 一直用的那个
键。第一段之所以存在，是因为对这些条目而言那个键不是「旧」而是「没有」——同一次目录
扫描报 `chat_size: 0` 的角色，`date_last_chat` 同样是 0——按它排会把这条规则本要救的
角色压到一条会滚动的轨的最底下。段内并列（第一段全部并列）退回入册顺序即 ST 自己的
`characters` 数组序，`Array.prototype.sort` 自 ES2019 起由规范保证稳定，这是保证而非
引擎实现细节。磁盘快照已经能为其发言的角色一律留在第二段，所以普通 spine 的顺序一字
未动，只有本来会缺席的条目获得了位次。

| 不变量 | 验证 |
| --- | --- |
| 四类来源各自都能让角色入列，被多类同时指向也只占一个位子 | `test/spine-cast.test.mjs :: the spine enrols the union of the four sources and seats a character named by several of them exactly once` |
| 没有任何会话内来源时，spine 恰好等于「磁盘上有对话」那一批（原始过滤目的保留） | `test/spine-cast.test.mjs :: with no session sources at all the spine is exactly the characters that have conversations on disk` |
| 缺 avatar 或缺名字的条目任何来源都无法让它入列 | `test/spine-cast.test.mjs :: entries with no usable identity are refused no matter which source names them` |
| 仅靠会话内来源入列的角色排在最前（其 recency 键是「没有」而不是「旧」） | `test/spine-cast.test.mjs :: a character ChatUI knows is live leads the rail, because its recency key is absent rather than old` |
| 磁盘快照已能为其发言的角色保持原有 recency 位次，在台/持租约/被凭证指向都不改变它 | `test/spine-cast.test.mjs :: a character the disk snapshot already accounts for keeps its recency seat, on stage or not` |
| 并列时退回入册顺序（ST 的 characters 数组序），而不是任何从 avatar 推出来的次序 | `test/spine-cast.test.mjs :: ties fall back to the incoming cast order, so two session-known characters keep ST's own sequence` |
| 畸形的 size/recency 值一律读作 0，不污染排序 | `test/spine-cast.test.mjs :: malformed recency and size values are read as zero instead of poisoning the order` |
| 绝不就地改动传入的 cast 数组（它属于查询缓存，原地排序会改掉所有读者看到的顺序） | `test/spine-cast.test.mjs :: the source list is never mutated` |

### Topbar 改名与分支门禁（ui/topbar-menu-logic.ts）

pr7：topbar 标题改成就地改名（README §7 / DESIGN §4.1 铅笔钮 + 输入框），⋯ 菜单
的「重命名对话」行改为触发同一处编辑而不是自己另开一个输入框——两个入口共享
一份「这次提交该不该真的发生」的判定，因此判定本身被下沉成纯函数，可以脱离
TopbarTitle.tsx/TopbarMenu.tsx 两处渲染分别单测。`resolveTopbarRenameCommit`
把 pr7 之前散落在 TopbarMenu 内部 `commitRename`/`_isLiveTarget` 里的两条判断
（trim 后判空/判同名、改名过程中会话是否被切走）合并成一条：任何一条不成立都
返回 `null`，调用方据此决定要不要真的调 `renameChatuiChat`。`resolveBranchFromLastFloor`
则是「从末楼开新分支」这一行的启用判定与目标 id 解析，与 app.tsx 里
`handleEditLast`（编辑最后一楼）用的是同一条门槛——末楼正在生成时禁用，而不是
另发明一条规则。

| 不变量 | 验证 |
| --- | --- |
| 空白（含纯空格）改名草稿一律当空处理，拒绝提交 | `test/topbar-menu-logic.test.mjs :: resolveTopbarRenameCommit: a whitespace-only draft is refused as a no-op` |
| trim 后与原名相同的草稿拒绝提交（防止一次无意义按键占用宿主队列） | `test/topbar-menu-logic.test.mjs :: resolveTopbarRenameCommit: a draft identical to the name on record (after trim) is refused` |
| 改名期间会话已切走（avatar 或 fileName 任一变化，含彻底无当前会话）时拒绝提交，绝不改错文件 | `test/topbar-menu-logic.test.mjs :: resolveTopbarRenameCommit: a live identity that no longer matches the chat rename was started against is refused` |
| trim 后确有变化且会话仍是发起改名时的那个，提交返回 trim 后的目标名 | `test/topbar-menu-logic.test.mjs :: resolveTopbarRenameCommit: a genuine, trimmed rename against the still-live target commits` |
| 没有消息时「从末楼开新分支」禁用且不给出目标 id | `test/topbar-menu-logic.test.mjs :: resolveBranchFromLastFloor: no messages yields disabled with no target id` |
| 有消息且未在生成时启用，目标 id 取最后一条消息 | `test/topbar-menu-logic.test.mjs :: resolveBranchFromLastFloor: messages present and idle targets the last message id` |
| 即使有消息，正在生成时也禁用（末楼还没写完，不该从它分支） | `test/topbar-menu-logic.test.mjs :: resolveBranchFromLastFloor: generation in flight disables the row even with messages present` |

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
| style.css 里不存在提前闭合的注释：注释终止符只能出现在注释里，否则其后的整条规则块会被 CSS 解析器静默丢弃 | `test/stylesheet-integrity.test.mjs :: style.css has no comment terminator that lands in code, so no rule block is silently dropped` |
| 该扫描确实能识别它要防的那次真实回归（pr4 topbar 规则被注释吃掉），修好后不再误报 | `test/stylesheet-integrity.test.mjs :: the stray-terminator scan actually detects the pr4 topbar regression it exists to prevent` |

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

## 13. 浏览器门禁（真实 Chromium + 真实 Firefox + 一次性 SillyTavern 宿主）

这些不是 `node --test` 单测，按门禁位置登记。

**引擎矩阵**：CI 在 Blink 与 Gecko 上各跑一遍全部 `e2e/*.spec.mjs`
（`playwright.config.mjs` 两个 project）。这条是补上的欠账而非锦上添花：`.cui-root-rails`
的宽度缺陷（55af8f1）在 Chromium 下完全看不见、在维护者的 Firefox 里肉眼可见，连过三波
全绿的 QA——**只在一个引擎上跑的布局门禁不算门禁**。本地 `pnpm run test:e2e` 钉死
`--project=chromium`，因为 Playwright 的 Firefox 在维护者的 Mac 上根本起不来
（`RenderCompositorSWGL` 无法映射帧缓冲，无头有头皆然）；能起来的机器用
`pnpm run test:e2e:gecko`。

- **`e2e/smoke.spec.mjs`**（CI 门禁，dist 发布前必须通过）：真实 ST 服务器 + 真实
  Chromium 下，smoke 会话正确投影进 SillyLounge，含一次真实消息编辑往返（回读
  `context.chat` 验证落盘）。
- **`e2e/confirm-dialog-keyboard.spec.mjs`**（CI 门禁，与 smoke 同一次 Playwright
  运行）：以真实消息删除确认弹窗为固件（用户消息 → 两态弹窗），钉死 §15.1 里两件
  纯函数无从回答、只有真浏览器能回答的事。**焦点陷阱**：弹出后焦点在确认钮；连按
  五次 `Tab`（两整圈多一格）与三次 `Shift+Tab`，每一次都断言焦点仍在弹窗卡片内且
  落点序列精确匹配 `取消`/`删除` 的回卷顺序；弹窗存续期间 `body` 的每个直接子节点
  都被标 `inert`（除弹窗自己的 portal），关闭后全部还原为非 `inert`，焦点交还给当初
  打开弹窗的那个删除按钮。**自动重复**：真实按住 `Enter` 不放——第一次
  `repeat === false` 的按下就是激活删除按钮、弹出弹窗的那一次，此后不松手，让
  `300ms` 守卫窗口在被摁住的按键底下过期（按住时长 `3 ×` 守卫窗口）；断言弹窗仍在、
  `context.chat` 长度不变，并回读一份窗口捕获期按键日志**证明浏览器确实投递了带
  `repeat` 的 keydown**，否则「弹窗还在」可能是空过。最后用一次全新的 `Enter` 激活
  取消钮收场：既证明陷阱与守卫没有顺手弄坏弹窗正常的键盘回答，也让整条脚本对共享
  的一次性宿主**零改动**（全程不删任何消息）。
- **`e2e/rails-geometry.spec.mjs`**（CI 门禁，两个引擎各跑一遍）：在维护者的真实窗宽
  **889px** 上，聊天模式与设置模式各断言一次左侧骨架的**关系**而非像素——
  `.cui-root-rails` 宽度恒等于 spine 宽 + 它当下所持轨宽（聊天是 playbill，设置是设置
  导航）、该轨的右沿不越出 rails 自己的裁切边界、舞台列的左沿恰好落在 rails 的右沿。
  这三条一起封死一整类缺陷：rails 带 `overflow: hidden`，一旦它的宽度算小，就会裁掉
  自己存在的理由，同时让舞台钻到剩下的轨底下。**必须写成关系式**，因为原缺陷正是两个
  引擎对同一份 CSS 算出不同像素（Gecko 58+133，Blink 58+300）——钉死像素只会把其中
  一个引擎的答案固化成"正确答案"。
- **`e2e/settings-embed-width.spec.mjs`**（CI 门禁，两个引擎各跑一遍）：在 **976px**
  视口（ST 自己 `mobile-styles.css` 的 1000px 断点之下、而套件其余视口 1280/768/390
  都不巡的走廊）打开设置 → AI 配置，断言嵌入的 ST 抽屉面板只填满内容列而非整个视口、
  仍是 `position: static`、且穿的是 ST 桌面版皮肤（10px 圆角）而非移动抽屉皮肤。守的是
  `.cui-settings-host` 整平选择器必须带 `#chatui-root` 祖先才压得过 ST 用 ID
  加 `!important` 写的移动端规则（c745053）。
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

### 15.1 键盘模型：吞键守卫与焦点陷阱（设计稿 §6「确认与浮层」）

对话框把焦点交给**确认钮**（不再是取消钮），按键因此直接回答问题；换来的安全性
不靠焦点位置，而靠一段时间守卫：弹出后 300ms 内的激活键一律吞掉。危险的从来不是
「用户有意按了回车」，而是「弹窗在用户连打回车的手底下冒出来」。

整套键盘模型收在 `decideConfirmKeyAction(keystroke)` 这个纯函数里：给定按键、修饰
键、`repeat`、焦点落区（`inside` / `outside` / `none`）、挂载时刻与按键时刻，直接
判出该做什么（`ignore` / `stand-down` / `swallow` / `cancel` / `confirm` /
`focus-next` / `focus-previous`）。因此整张矩阵可以脱离 DOM 钉死；组件层只提供规则
无从知道的两件事（键落在哪、现在几点），再执行判决——把「吞」落实成
`preventDefault` **加** `stopPropagation`（前者杀掉已获焦确认钮的原生激活，后者拦住
这个 window 捕获期监听放走的按键去够到帘幕背后的控件），以及按 `nextConfirmFocusIndex`
的算术把焦点挪到下一站。

「激活键」是 Enter **与空格**两个：设计稿只点名 Enter，是因为它那份原型的按钮是
不可聚焦的 span，空格根本够不着；本项目用的是真 `<button>`，空格同样会原生激活它，
漏掉空格等于给守卫留一个正好一次按键宽的洞。空格没有「焦点不在按钮上时的兜底
确认」——对着空处敲空格不是对任何问题的回答。

**自动重复（`event.repeat`）视为同一次物理按键**。守卫只看时间是不够的：按住 Enter
不放，300ms 窗口会在**被摁住的那一次按键底下**自己过期，随后系统自动重复出来的
keydown 就顺理成章地确认了删除——而这正是守卫立意要挡的那次事故（「弹窗在已经在
打字的手底下冒出来」），只是写成了一次长按而非两次短按。所以带 `repeat` 的激活键
一律吞掉，无论开了多久。Tab 不受此限：按住 Tab 走浮层是正常键盘用法，且挪焦点不是
回答。

**焦点陷阱**。组件声明 `aria-modal="true"`，但确认钮是 portal 内最后一个可聚焦元素，
从前按一次 Tab 焦点就落到帘幕背后的宿主控件上（实测落在 ST 右侧菜单的图标上，完全
不可见）。现在 Tab / Shift+Tab 由 `nextConfirmFocusIndex(count, currentIndex,
backwards)` 在弹窗自己的可聚焦控件间循环，两端回卷，焦点不在环上（`-1`）时按浏览器
自己的方向从对应一端拉回来。同时 `isolateBackground()` 在弹窗存续期间给
`document.body` 的**直接子节点**加 `inert`（不是 `aria-hidden`：只有 `inert` 同时
挡住焦点与指针，才对得起「模态」二字）——这是注入宿主页面的扩展，所以隔离范围刻意
收窄：只标直接子节点、只在一个弹窗的生命周期内、只还原自己标过的那些（本来就
`inert` 的兄弟节点属于别人，两个方向都不碰），弹窗自己的 portal 跳过。卸载时先撤
`inert` 再把焦点交还给开弹窗前那个元素（元素已随删除消失就跳过）——顺序反了焦点进
不去仍然 inert 的子树。窗口级「焦点在外就吞键」的那条从此是**陷阱之下的兜底**（挂载
之后才出现的 body 子节点不在隔离范围内），不再是唯一的防线。

完整矩阵（守卫期＝弹出后 300ms 内；「外」＝焦点已在弹窗之外，「无」＝没有可聚焦元素
持有焦点，点击卡片正文即落此格）：

| 按键 | 焦点：内 | 焦点：外 | 焦点：无 |
| --- | --- | --- | --- |
| `Esc`（守卫期内外、含 `repeat`、含修饰键） | 取消 | 取消 | 取消 |
| `Tab` / `Shift+Tab`（守卫期内外、含 `repeat`） | 环内前移／后移 | 拉回环首／环尾 | 拉回环首／环尾 |
| `Ctrl`/`Alt`/`Meta` + `Tab` | 放行 | 放行 | 放行 |
| `Enter` / `空格`，`repeat === true` | 吞 | 吞 | 吞 |
| `Enter` / `空格`，守卫期内 | 吞 | 吞 | 吞 |
| `Enter` / `空格`，守卫期后 | 让位给原生激活 | 吞 | `Enter` 确认；空格与带修饰的 `Enter` 放行 |
| 其余按键 | 放行 | 放行 | 放行 |

| 不变量 | 验证 |
| --- | --- |
| 守卫窗口是「左闭右开」的 300ms：同一瞬间、1ms、299ms 都拒绝，正好 300ms 及以后接受 | `test/confirm-store.test.mjs :: shouldAcceptConfirmKey refuses an activation keystroke for the whole guard window and accepts it from the boundary onward` |
| 时间戳异常一律按拒绝处理（时钟倒流、Infinity、NaN、undefined）——坏时间戳绝不能反过来授权一次删除 | `test/confirm-store.test.mjs :: shouldAcceptConfirmKey fails closed on a clock that ran backwards or on a timestamp that is not a finite number` |
| 判定是纯函数：不读存储状态，有无在场请求都给同一答案 | `test/confirm-store.test.mjs :: shouldAcceptConfirmKey is pure: it reads nothing from the store, so an open dialog, a settled one and no dialog at all give the same answer` |
| `Esc` 在矩阵每一格都取消：守卫期内、任意焦点落区、按住自动重复、带修饰键 | `test/confirm-store.test.mjs :: decideConfirmKeyAction cancels on Escape from every cell of the matrix — inside the guard window, from any focus, and while a held Escape auto-repeats` |
| `Tab`/`Shift+Tab` 恒走弹窗自己的焦点环（守卫期不拦、`repeat` 不拦），但 `Ctrl`/`Alt`/`Meta`+`Tab` 属于浏览器与窗口管理器，放行 | `test/confirm-store.test.mjs :: decideConfirmKeyAction keeps Tab and Shift+Tab on the dialog's own focus cycle whatever the guard window says, but leaves browser/OS-level modified Tab alone` |
| 自动重复的激活键一律吞掉，开多久都一样；同格 `repeat === false` 不吞，证明拒绝的是重复而不是时钟 | `test/confirm-store.test.mjs :: decideConfirmKeyAction swallows an auto-repeated activation keystroke however long the dialog has been open — a held key is one physical press, not a stream of answers` |
| 守卫期内的激活键无论瞄向哪里都吞（不是「放行」——否则已获焦确认钮会自己原生点击）；坏时钟继承 fail-closed | `test/confirm-store.test.mjs :: decideConfirmKeyAction swallows every activation keystroke inside the guard window, whoever it was aimed at` |
| 守卫期后：焦点在弹窗内让位给原生激活（不重复回答），焦点在弹窗外一律吞掉（不回答也不放它去够帘幕后的控件） | `test/confirm-store.test.mjs :: decideConfirmKeyAction past the guard stands down for a control inside the dialog and swallows one aimed outside it, so one keystroke is never two answers` |
| 无焦点时只有裸 `Enter` 算确认：空格与任意修饰键 + `Enter` 都不是回答 | `test/confirm-store.test.mjs :: decideConfirmKeyAction answers confirm only for a bare Enter aimed at nothing: Space at nothing in particular, or a modified Enter, is not an answer` |
| 模型之外的按键一概不碰（不 preventDefault、不 stopPropagation） | `test/confirm-store.test.mjs :: decideConfirmKeyAction ignores every key that is no part of the dialog's model, in and out of the guard window` |
| 焦点环前后各走一格并在两端回卷（三态删除弹窗三个控件、其余两个、退化到一个也自环），Tab 绝不会走出弹窗 | `test/confirm-store.test.mjs :: nextConfirmFocusIndex walks the dialog's controls forwards and backwards and wraps at both ends, so Tab can never walk out of the dialog` |
| 焦点不在环上（`-1` 及任何越界/非整数索引）时按浏览器自己的方向从环首／环尾拉回；环上无可聚焦元素时给 null（调用方照吞不误，焦点原地不动） | `test/confirm-store.test.mjs :: nextConfirmFocusIndex pulls focus back in from outside the cycle at the end the browser itself would have entered from, and answers null when there is nothing to focus` |

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
- **新增（pr7）：topbar 标题的就地改名（铅笔钮悬停显影 → 输入框 → Enter/Esc）、
  ⋯ 菜单新增的「从末楼开新分支」「角色卡设定……」两行，三者的启用/禁用判定
  （§9 新增小节）与提交判定（`resolveTopbarRenameCommit`）都已单测覆盖，但组件
  本身（TopbarTitle.tsx 的悬停显影是否真的只在 hover/focus-within 时发生、
  input 是否真的拿到焦点、TopbarMenu.tsx 三行是否真的按设计稿 §7 的顺序渲染、
  disabled 属性是否真的挡住点击）零浏览器级驱动——与上面 ConfirmDialogHost 的
  缺口同一类，`e2e/smoke.spec.mjs` 只静态断言 `.cui-root-topbar-title`/
  `-eyebrow` 的文本，从不触发改名态。
  **2026-08-01 终审补记**：这条缺口被手工真机驱动了一轮（pinned 1.18.0 + 真
  Chromium，非入库脚本），当场抓到它存在的理由——两处就地改名的输入框**都拿不到
  焦点**（topbar 的停在 `<body>`，场刊卡的停在铅笔钮本身），因为 `autoFocus` 对
  「加载完成之后才挂载」的元素本就无效，而 Preact 没有 React 那层 shim。已按
  `MessageEditor.tsx` 的既有先例改成显式 focus（`hooks.ts` 的 `useCaretOnMount`，
  两处共用）。缺口本身**依然登记**：这一轮是手工的，仓库里仍没有任何自动化门禁会
  在下次回归时发现同样的事。要补的那条 Chromium 场景至少应断言：铅笔只在
  hover/focus-within 显影、点开后 `document.activeElement` 就是输入框、Enter 真的
  改名而 Esc 真的不改、⋯ 六行的顺序/danger/disabled、以及群聊态下三行禁用。
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
- **新增（pr7 收官）：`store/vanished-chat-store.ts` 的广播被 store 层单测钉死
  （§3 两行），但它到缓存失效的那一段接线在 `ui/use-st-query-bridge.ts` 里，
  仍是零自动化覆盖**——「广播 → `invalidateQueries(byCharacter(avatar))` ＋
  recents 重取 → 那一行真的从列表里消失」这条端到端只有真机手测过
  （danglinglease 格）。该桥接模块导入 React Query 与 preact/compat，不在
  `dist/runtime` 的可单测出口里（`scripts/build.mjs` 的 `RUNTIME_ENTRY_FILES`
  只收纯模块），要覆盖得起一个挂载 QueryClientProvider 的浏览器场景，与上面
  ConfirmDialogHost / TopbarTitle 的缺口同一类。
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
