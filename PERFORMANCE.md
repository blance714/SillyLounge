# 长对话性能基线

本文记录 400 个用户楼层（800 条交替消息）的可重复性能样张、测量方法、历史基线与
当前优化进展。它不是跨机器通用的性能预算。

## 怎样复现

测试固定使用 `test/e2e/st-version.json` 声明的 SillyTavern 版本。准备好该版本及其
运行时依赖，并安装 Playwright Chromium 后运行：

```sh
SILLYTAVERN_TEST_ROOT=/path/to/SillyTavern \
  pnpm run test:perf -- --warmups 1 --repetitions 5
```

报告、截图和每次 SillyTavern 的日志会写入 `test-results/performance/`。这个目录不进
Git；提交的是生成规则和测量器，而不是某台机器的一次偶然结果。

测量器为每个样本创建全新的 dataRoot、SillyTavern 进程与 Chromium context，并轮换
三种状态的顺序：

1. `disabled`：禁用 SillyLounge，只保留 SillyTavern 原生聊天界面；
2. `bootstrap`：加载 SillyLounge 扩展，但关闭替代聊天界面；
3. `active`：启用完整 SillyLounge。

三种状态读取同一份 400 楼样张，当前测量视口固定为 1920×1080。原生
`power_user.chat_truncation` 固定为 100，因此原生 DOM 只保留最后 100 条消息。

## 2026-07-15 基线

这组历史数据采集于 1440×900；视口现已改为 1920×1080，后续结果不应直接与这里的
绝对耗时比较。

下面是一次 1 轮预热、每种状态 5 个正式样本的中位数。墙钟时间会受机器噪声影响，
结构计数和同轮增量更适合定位问题。

| 状态 | 就绪时间 | long task 总时长 | 主线程任务 | 脚本 | 布局 | JS 堆 | DOM 元素 | SillyLounge 消息 | 按钮 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `disabled` | 2292 ms | 84 ms | 557 ms | 118 ms | 32.8 ms | 23.0 MiB | 15,444 | 0 | 0 |
| `bootstrap` | 2249 ms | 83 ms | 558 ms | 122 ms | 32.8 ms | 25.1 MiB | 15,457 | 0 | 0 |
| `active` | 2317 ms | 250 ms | 804 ms | 158 ms | 53.6 ms | 54.8 MiB | 27,624 | 800 | 3,217 |

`bootstrap` 与纯原生的差异很小；主要增量出现在完整界面。`active - bootstrap` 为：

- long task 总时长 `+167 ms`；
- 主线程任务 `+245 ms`，其中脚本 `+36.7 ms`、布局 `+20.8 ms`；
- JS 堆 `+29.6 MiB`；
- DOM 元素 `+12,167`，CDP 节点计数 `+20,204`；
- 新增 800 个消息 article 和 3,217 个按钮。

楼层导航的 5 次功能采样均正确完成滚轮窗口移动、Home/End 跳转及首楼预览；滚轮没有
改变消息列表的 `scrollTop`。采样期间没有超过 50 ms 的帧间隔，单次最大值在
16.8–18.6 ms 之间。因此楼层标尺不是这份样张中的主要热点。

## 2026-07-16 TanStack Virtual 兼容性试验

消息列表现已用 `@tanstack/react-virtual` 做第一层 DOM 窗口化。当前实现仍保留全部
800 条消息的索引和 store DTO，但只挂载视口及 5 条 overscan 附近的 `MessageItem`；
消息高度由 `ResizeObserver` 实测，楼层导航改用消息索引和 `scrollToIndex`，不再查询
尚未挂载的消息 DOM。

下面是 1920×1080、复杂富文本样张各状态 1 个正式样本的本地兼容性采样。单样本只
用于确认结构方向和数量级，不替代多轮中位数基线：

| 状态 | 就绪时间 | long task 总时长 | DOM 元素 | 已挂载消息 | 按钮 | iframe |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `disabled` | 2707 ms | 291 ms | 25,028 | 0 | 0 | 0 |
| `bootstrap` | 2598 ms | 293 ms | 25,041 | 0 | 0 | 0 |
| `active` | 2513 ms | 492 ms | 25,747 | 6 | 43 | 2 |

与同机、同视口、同样张的窗口化前一次采样相比，`active` 的已挂载消息从 800 降到
6，按钮从 3,399 降到 43，long task 总时长从约 1,112 ms 降到约 492 ms。就绪时间
也从约 3,238 ms 降到约 2,513 ms；由于两边都只有单样本，耗时差只作方向性证据，
结构计数才是这一阶段的主要验收结果。

## 双 400 楼切换场景

`test:e2e` 会额外生成同一角色下两个相互带有唯一标记的富文本会话；每个会话包含
400 个用户楼层、800 条消息、2 个 Choice iframe 和 3 个 Thought 块。测试通过真实
SillyLounge 侧栏完成 A → B → A，而不是直接改 store，并逐次断言：

- SillyTavern `chatId` 与当前侧栏行一致；
- 当前消息标记正确，另一个会话的标记没有残留；
- 虚拟列表声明完整 800 条消息，但实际只挂载一个有界窗口；
- Home/End 能从未挂载的首楼跳到末楼，并同时覆盖即时滚动与平滑动画；
- iframe 高度稳定后，相邻虚拟消息行的几何区域不重叠；
- 没有页面异常、ChatUI 控制台错误或未关闭弹窗；
- 截图实际为 1920×1080。

窗口化前的本地功能采样中，往返切换约为 1.8–1.9 秒，每次产生约 1.1–1.3 秒 long
task，并挂载 800 个消息 article。只完成 DOM 窗口化、尚未懒构造 DTO 时，完整
`test:e2e` 采样约为 0.94–0.98 秒，long task 约 0.45–0.46 秒，底部窗口挂载 8 个
消息 article；强制 GC 后堆内存约 41 MiB，CDP 节点约 81,700。绝对耗时只作诊断，
不作为 CI 硬阈值。

### 10 楼对照实验

为了分开“切换本身的固定成本”和“随完整聊天长度增长的成本”，另有一组
`long-rich-switch-10` 对照样张。它与 400 楼样张使用相同角色、长度分布、thinking、
代码块、Choice HTML 正则和 1920×1080 浏览器路径，只把每个会话从 400 个用户楼层
缩短为 10 个。两组都实际通过侧栏执行 A → B → A。

计时拆成两个阶段：`content ready` 表示 SillyTavern `chatId`、当前会话标记、末条
消息和楼层栏均已切换正确；`settled` 还要求 DOM 连续 200 ms 没有变化并等待两个
动画帧。后者是功能验收时间，不等同于用户第一次看到新内容的时间。

只做 DOM 窗口化时的对照结果：

| 会话长度 | content ready | settled | long task 总时长 | 已挂载消息 |
| --- | ---: | ---: | ---: | ---: |
| 10 楼，A → B | 188 ms | 555 ms | 0 ms | 8 |
| 10 楼，B → A | 157 ms | 540 ms | 0 ms | 8 |
| 400 楼，A → B | 713 ms | 965 ms | 458 ms | 8 |
| 400 楼，B → A | 656 ms | 931 ms | 453 ms | 8 |

这组数据证明剩余的主要长度相关成本发生在虚拟列表选择可见项之前：两边都只挂载
8 个 article，400 楼的平均 `content ready` 仍接近 10 楼的 4 倍。

### 按虚拟窗口懒构造 DTO

第二阶段把全历史数据分成两层：

- 轻索引只读取消息 ID、角色、小型系统消息和 tool-call 标记，用于 `messageIds`、
  用户楼层配对和末条消息判断；
- 完整 snapshot、ST formatter、附件和 reasoning 只在 `useChatuiMessage(id)` 第一次
  读取当前虚拟行或楼层 popover 时构造；
- 完整 DTO 使用最多 96 条的内存 LRU，正在挂载/订阅的消息不会被淘汰；formatter
  HTML 缓存按 chat key 隔离并限制为 1024 项；
- 编辑、swipe 和流式更新只让对应消息 ID 失效；会话切换清空上一会话的 DTO。

同一套 1920×1080 样张的结果如下。`完整 DTO` 是达到 `content ready` 时实际构造的
数量，不是 DOM 间接推测：

| 会话长度 | content ready | settled | long task 总时长 | 完整 DTO / 索引 |
| --- | ---: | ---: | ---: | ---: |
| 10 楼，A → B | 192 ms | 576 ms | 0 ms | 6 / 20 |
| 10 楼，B → A | 152 ms | 540 ms | 0 ms | 6 / 20 |
| 400 楼，A → B | 404 ms | 788 ms | 129 ms | 6 / 800 |
| 400 楼，B → A | 346 ms | 729 ms | 126 ms | 6 / 800 |

400 楼平均 `content ready` 从约 685 ms 降到约 375 ms，减少约 45%；平均 long task
从约 456 ms 降到约 128 ms，减少约 72%。10 楼仍约为 172 ms，没有把工作转移成新的
固定成本。Home/End 功能验收完成后，两端窗口合计也只构造了 16 条 DTO，仍远低于
800 条完整历史。

同轮 `long-rich` 单样本归因中，原生、bootstrap、active 的页面就绪时间分别约为
2531、2308、2333 ms，long task 分别约为 285、297、199 ms。单样本的绝对排序会受
机器噪声影响，但 active 相对 bootstrap 只增加约 25 ms，同时仍正确挂载 6 个消息、
43 个按钮和 2 个 iframe；剩余的页面加载成本大部分已与 ST 自身加载原生富消息处于
同一数量级。

### 隐藏原生消息窗口实验

CDP trace 进一步确认：切换已有长对话时，SillyTavern 会先读取并解析完整 JSONL，
然后在发出 `CHAT_CHANGED` 前格式化、构造最后 `chat_truncation` 条原生消息。即使
SillyLounge 的 shield 隐藏了 `#chat`，这部分正则、Markdown、DOMPurify、模板 clone
和 DOM 构造仍会完整执行。

因此测量工具支持仅在一次性浏览器进程内覆盖原生窗口，比较 `100 / 40 / 1 / 0`。
这里的 `0` 是测试工具的逻辑零条，不是 ST 设置里的数值零；ST 会把设置值 `0` 解释
为“不限数量”。每档都使用同一 1920×1080、双 400 楼 `long-rich-switch` 样张，
实际完成 A → B → A、Home/End、富文本 iframe、thinking 和楼层几何验收。

| 原生消息 | 平均 content ready | 平均 long task | GC 后元素 | SillyLounge DTO / 索引 |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 369 ms | 122 ms | 25,942 | 6 / 800 |
| 40 | 314 ms | 67 ms | 16,880 | 6 / 800 |
| 1 | 262 ms | 0 ms | 10,634 | 6 / 800 |
| 0 | 258 ms | 0 ms | 9,908 | 6 / 800 |

从 100 条降到 1 条使平均内容可用时间减少约 29%，并消除了这组样张中的切换 long
task；完全移除最后一条只再节省约 5 ms，不值得单独承担额外兼容代价。

这还不是可发布实现。产品化的逐动作解耦设计与已定决策见 DOM-DECOUPLING.md（其中
修正了下文按 ID 调用可行性的粗分类）。当前部分消息动作通过原生 `.mes` 定位目标：
`saveMessageEditById` 需要原生编辑 textarea，统一 action/swipe 入口也先查原生元素。
因此零条会破坏全部这类动作，一条也只能覆盖末条。产品化必须先把可直接按 ID 调用的
copy、branch、checkpoint、hide、delete、swipe 从 DOM 身份中解耦；编辑则需要一个
按需构造、完成后销毁的单条原生编辑宿主。停用 SillyLounge 时还应在 shield 下恢复
原值并重新绘制当前原生聊天，完成后再暴露原生界面。

## 诊断

历史开销来自一条连贯的结构路径：

1. 固定版本 SillyTavern 只把最后 100 条消息放进原生 DOM；
2. 旧版 `adapter/internals.ts` 会读取并完整投影整个 `ctx.chat`；
3. 旧版 `store/chat-store.ts` 为每条消息构造完整 DTO，并逐条调用 SillyTavern
   formatter、附件投影和可选 reasoning 投影；固定宿主的 formatter 每次调用还会
   扫描聊天数组；
4. 旧版 `ui/app.tsx` 对全部 `messageIds` 渲染 `MessageItem`，所以 400 楼会再挂载
   800 条 SillyLounge 消息；用户消息的平铺操作按钮又把按钮数扩张到数千个；
5. 追加消息会因消息总数改变而回退到完整 store 重建，生成态又作为同一个 prop 传给
   每一行，使长列表在生成边界发生全体更新。

当前实现已经切断第 2、3、4 条的主要昂贵部分：切换时仍线性扫描全部槽位，但只生成
轻索引；完整 snapshot、formatter、附件和 reasoning 随虚拟窗口懒构造，DOM 和按钮
也不再随完整楼层数线性增长。TanStack Virtual、动态 iframe、楼层导航和真实消息编辑
均已通过固定 ST 的浏览器验收。

剩余成本主要来自 ST 自己加载并渲染最后 100 条被 shield 隐藏的原生消息、轻索引的
O(N) 扫描，以及少数可见 formatter 调用内部仍可能扫描完整聊天。只加
`content-visibility` 或隐藏按钮不会消除这些成本。

## 后续实现方向

后续应保持完整对话语义，并继续把“全部消息索引”和“昂贵的可见消息 DTO”分开：

1. 追加消息时增量扩展轻索引，不因消息总数改变重新扫描完整聊天；
2. 同一会话的 generation start/stop 保留未变化 DTO，不清空整个有界缓存；
3. 测量可见 formatter 的内部时间，确认其完整聊天扫描占比，再决定是否需要稳定的
   内容版本键或更窄的宿主格式化入口；
4. 为会话切换保存有界滚动锚点，不写入长期持久化存储；
5. 只把生成态传给正在生成的最后一行；
6. 补齐图片加载、swipe、流式生成、快速连续跳转和移动端滚动的浏览器验收；真实消息
   编辑已经进入当前 smoke 门。

共享 CI 机器上的绝对耗时暂时只作为报告，不设硬阈值。等优化实现并积累稳定样本后，
再增加宽松的同轮相对预算和结构上限；功能门应继续断言“400 楼可预览、滚动和跳转”，
不要把“必须挂载 800 个 article”固化成契约；当前功能门反而明确要求挂载数小于完整
消息数。

## 2026-07-19 真实 flag 性能验收（停用恢复决策数据）

DOM-DECOUPLING.md“停用恢复”行落地后，这组数据为 owner 的翻默认值决策提供依据。
**决策已于 2026-07-19 做出：默认值已翻为 `true`**（见 src/store/config-store.ts
的定义注释），验收脚本同日接入 CI 发布门禁。以下为决策时采集的原始证据。

### 方法：走产品 flag，而不是工具级覆盖

“隐藏原生消息窗口实验”一节里 100/40/1/0 那组数据，是 `measure-chat-switch.mjs` 在
页面已经加载完之后用 `page.evaluate` 直接改写 `power_user.chat_truncation`，完全
绕开了 `adapter/native-window-guard.ts` 的备份 / 应用 / 自愈 / 回滚逻辑——它测的是
“原生窗口大小”这个变量本身，不是这个功能。这一轮改为让
`scripts/e2e/generate-data-root.mjs` 按“真实 flag”生成数据根：
`extensionMode: 'active'` 且 `nativeTruncationOverrideEnabled: true`，这正是
src/index.ts 的 `setup()` 在 `APP_READY` 时从 `getConfig()` 读到、并交给
`activateNativeTruncationGuard()` 应用的同一个配置位（写入
`extension_settings.chatui_composer.config`）。为此给
`scripts/e2e/measure-chat-switch.mjs` 和 `scripts/e2e/measure-long-chat.mjs` 都加了
`--truncation-guard on|off`（`truncationGuardFlag` 参数），转发进
`generateStDataRoot()` 的同名参数；`measure-chat-switch.mjs` 在 flag 开启时额外跳过
了原有的 `page.evaluate` 覆盖（否则会用工具级值把真实 flag 已经生效的结果盖掉），
断言用的期望原生消息数改读 `generated.manifest.nativeTruncation.overrideSentinel`。

两组测量都固定 1920×1080、`SILLYTAVERN_TEST_ROOT` 指向本机 pinned 的 SillyTavern
1.18.0（51ad27f）：

- 会话切换用 `long-rich-switch`（双 400 楼富文本）样张，走真实侧栏 A→B→A；脚本本身
  单样本，为取中位数另写了一个一次性驱动脚本，各方向重复 3 次。诚实声明：该驱动
  脚本未入库，逐次中间报告已被末次运行覆盖，墙钟中位数因此不可独立复核；结构计数
  （原生消息数、DOM 元素、挂载窗口）在存续的末次 JSON 里可复核，且为本文约定的
  主要信号；
- 三态首屏对照用 `long-plain`（400 楼单会话）样张，`pnpm run test:perf -- --warmups
  1 --repetitions 3` 的调用方式（1 轮预热 + 3 个正式样本）。

本轮不测“真实点击禁用 + reload 往返”的性能——那是
`scripts/e2e/verify-truncation-guard.mjs` 的功能验收范围（Scenario A/B），已经通过，
不是这里的性能对照对象。

### 对照 1：会话切换（`long-rich-switch`，各方向 3 次中位数）

| 切换方向 | flag | content ready | settled | long task 总时长 | 原生消息 | DOM 元素 | GC 后堆 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A→B | 关闭 | 402 ms | 783 ms | 125 ms | 100 | 26,061 | 40.3 MiB |
| A→B | 开启 | 322 ms | 706 ms | 0 ms | 1 | 10,754 | 39.8 MiB |
| B→A | 关闭 | 346 ms | 744 ms | 124 ms | 100 | 26,061 | 40.5 MiB |
| B→A | 开启 | 261 ms | 645 ms | 0 ms | 1 | 10,754 | 39.9 MiB |

两个方向平均：content ready 从约 374 ms 降到约 292 ms（-22%），settled 从约 764 ms
降到约 676 ms（-11%），long task 总时长从约 125 ms 降到 0（消失），DOM 元素从
26,061 降到 10,754（-59%）。方向和量级与历史工具级 100→1 档一致，但这次是产品化
之后真正会跑的代码路径产生的，不是工具直接改设置——这是“翻默认值能拿到与历史实验
同量级收益”的第一次直接证据。

### 对照 2：首屏三态对照（`long-plain`，1 轮预热 + 3 个正式样本中位数）

| 状态 | flag | 就绪时间 | long task 总时长 | 原生消息 | DOM 元素 | CDP 堆 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `disabled` | 关闭 | 2743 ms | 198 ms | 100 | 15,440 | 21.6 MiB |
| `disabled` | 开启 | 2739 ms | 193 ms | 100 | 15,440 | 20.1 MiB |
| `bootstrap` | 关闭 | 2001 ms | 197 ms | 100 | 15,453 | 24.6 MiB |
| `bootstrap` | 开启 | 2707 ms | 195 ms | 100 | 15,453 | 22.0 MiB |
| `active` | 关闭 | 1855 ms | 233 ms | 100 | 15,845 | 35.7 MiB |
| `active` | 开启 | 2003 ms | 110 ms | 1 | 9,410 | 24.7 MiB |

**意外发现，与本轮任务预设的假设相反**：预设假设是“如果首屏行不受 flag 影响，就把
会话切换数据当主要结论”；实测首屏 `active` 行的原生消息数也从 100 降到 1，DOM 元素
减少 41%，CDP 堆减少 31%，long task 中位数从 233 ms 降到 110 ms——三次重复样本里这
几个结构指标零方差（每次都是 100/15,440、100/15,453 或 1/9,410，两组 flag 状态各自
稳定），`disabled`/`bootstrap` 两行的结构指标在两轮之间完全没有变化（符合预期：
`setup()`、进而 `activateNativeTruncationGuard()`，只在 `settings.enabled` 即
`extensionMode: 'active'` 时才会跑）。

原因不是 flag 语义变了，是 SillyTavern 自己的启动时序给了一次稳定的竞态窗口：
`power_user.auto_load_chat` 走 `RossAscends-mods.js` 的 `RA_autoloadchat()`，在
`initRossMods()` 里是**不 await** 调用的（`initApp()` 继续往下跑其余同步初始化，
最终 `await eventSource.emit(event_types.APP_READY)`），而 SillyLounge 挂在
`APP_READY` 上的 `init()` → `setup()` → `activateNativeTruncationGuard()` 在这台
机器上稳定地在 `RA_autoloadchat()` 内部异步的 `selectCharacterById()` → 原生
`printMessages()` 真正跑完之前完成，于是把 `chat_truncation` 提前钉在了覆盖哨兵值
上。这个结构性结果在本轮两组、各 3 次重复里都是零抖动，**但这只是两条独立异步链路
之间的一次竞态，不是 `eventSource.emit(APP_READY)` 承诺的顺序**——网络、磁盘或机器
负载不同时这条竞态完全可能翻过来，因此“首屏也会被压缩”只能记录为这次单机验收观察
到的现象，不能当成跨环境的稳定契约写进产品行为说明。

就绪时间（`navigationToReadyMs`）本身的噪声大到不能直接归因：`disabled`/
`bootstrap` 两行按设计根本不会被这个 flag 触碰，但它们在两轮独立调用之间的绝对
耗时摆动，比 `active` 行 flag 开关之间的差异还大（`bootstrap` 从 2001 ms 摆到
2707 ms，相差 706 ms；`active` 开关之间只差 148 ms）。逐样本明细：

| 状态 | flag | 就绪时间样本（ms） |
| --- | --- | --- |
| `disabled` | 关闭 | 2743, 1918, 2761 |
| `disabled` | 开启 | 2767, 2695, 2739 |
| `bootstrap` | 关闭 | 1994, 2695, 2001 |
| `bootstrap` | 开启 | 1944, 2728, 2707 |
| `active` | 关闭 | 1809, 1855, 2659 |
| `active` | 开启 | 2721, 2003, 1806 |

三态、两组 flag 状态下的就绪时间区间彼此重叠（约 1800–2760 ms），看不出可信的方向
性信号，因此这份验收把 `active` 行就绪时间的差异计为单机噪声，不作为结论；结构计数
（原生消息数、DOM 元素、CDP 节点/堆）和 long task 总时长才是这一节可信的信号，这和
本文档一贯的“结构计数优先、墙钟时间只做诊断”的方法是一致的。

### 样本数与噪声说明

- 单机（本地开发机）一次性跑完两组对照，不是多机重复实验，仅供这轮停用恢复 flip
  决策参考，不建立 CI 硬阈值，也不追加进任何自动化门禁。
- 会话切换：脚本本身单样本，各方向另行重复 3 次取中位数；首屏三态对照：1 轮预热 +
  3 个正式样本，与 `pnpm run test:perf -- --warmups 1 --repetitions 3` 的调用方式
  完全一致。3 个正式样本是这次任务要求的“诚实最小对照”样本量，比 2026-07-15 基线
  的 5 样本更薄，方向性结论可信，但没有资格覆盖 2026-07-15 那组基线。
- 结构计数在两组内部的重复样本里零方差，可信度高；`navigationToReadyMs` 的噪声显著
  大于 flag 造成的差异，不能单独作为证据，已在上面逐样本列出而不是被中位数掩盖。
- 这一节就是 DOM-DECOUPLING.md“停用恢复”行所要求的那轮基线重新测量；owner 依据
  本节数据于 2026-07-19 显式拍板翻开默认值。上面“意外发现”一节给出的竞态机制解释，与
  DOM-DECOUPLING.md 同一行里记录的停用-reload 时序缺陷诊断（`RA_autoloadchat()` 同样
  是不 await 的 fire-and-forget 调用，`activateNativeTruncationGuard()` 同样稳定
  抢在它前面完成）互相印证，不是本节独立猜测的新机制。
