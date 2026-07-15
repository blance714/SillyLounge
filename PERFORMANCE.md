# 长对话性能基线

本文记录 400 个用户楼层（800 条交替消息）的可重复性能样张、测量方法与当前诊断。
它是实现优化前的基线，不是跨机器通用的性能预算。

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

三种状态读取同一份 400 楼样张，视口固定为 1440×900。原生
`power_user.chat_truncation` 固定为 100，因此原生 DOM 只保留最后 100 条消息。

## 2026-07-15 基线

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

## 诊断

当前开销来自一条连贯的结构路径：

1. 固定版本 SillyTavern 只把最后 100 条消息放进原生 DOM；
2. `adapter/internals.ts` 的 `getCurrentMessageSnapshots()` 读取并投影整个 `ctx.chat`；
3. `store/chat-store.ts` 为每条消息构造完整 DTO，并逐条调用 SillyTavern formatter、
   附件投影和可选 reasoning 投影；固定宿主的 formatter 每次调用还会扫描聊天数组；
4. `ui/app.tsx` 对全部 `messageIds` 渲染 `MessageItem`，所以 400 楼会再挂载 800 条
   SillyLounge 消息，而原生的 100 条隐藏消息仍然存在；
5. 用户消息的平铺操作按钮进一步把这份普通文本样张扩张到 3,217 个按钮；
6. 追加消息会因消息总数改变而回退到完整 store 重建，生成态又作为同一个 prop 传给
   每一行，使长列表在生成边界发生全体更新。

这也解释了为什么只加 `content-visibility` 或隐藏按钮不能解决根因：它们不会消除首次
格式化、DTO 分配、订阅通知、effect 扫描或富内容 iframe 的启动。

## 后续实现方向

优化应保持完整对话语义，但把“全部消息索引”和“昂贵的可见消息 DTO/DOM”分开：

1. 维护轻量的全聊天索引，只保存楼层、角色、消息 ID 与预览所需字段；
2. 使用支持不定高消息的虚拟列表，只为可见窗口和少量 overscan 构造 formatter DTO；
3. 让楼层导航通过虚拟列表的 `scrollToIndex` 跳转，不再依赖所有消息都已经挂载；
4. 追加时保留未变化 DTO 的对象身份，不因总数改变重建整张消息表；
5. 只把生成态传给正在生成的最后一行，避免 800 行同时失效；
6. 另建少量富内容样张，单独测量代码块、附件与 HTML 卡片，避免和基础列表成本混在一起。

共享 CI 机器上的绝对耗时暂时只作为报告，不设硬阈值。等优化实现并积累稳定样本后，
再增加宽松的同轮相对预算和结构上限；功能门应继续断言“400 楼可预览、滚动和跳转”，
不要把“必须挂载 800 个 article”固化成契约。
