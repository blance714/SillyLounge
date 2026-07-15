# SillyLounge 🍸

一套为 SillyTavern 设计、带有手稿与手记气质的替代聊天界面。

## 安装

1. 打开 SillyTavern，进入 **扩展 → 安装扩展**。
2. 复制下面的 Git 仓库地址，粘贴到安装框中：

   ```text
   https://github.com/blance714/SillyLounge
   ```

3. 点击安装并等待 SillyTavern 完成下载。
4. 按照 SillyTavern 的提示刷新页面，即可使用 SillyLounge。

仓库的默认分支是已经编译完成的 `dist`，所以安装时不需要 Node.js、pnpm，
也不需要在本地执行构建。

> GitHub 默认打开用于安装的 `dist` 分支。项目源码和开发历史位于
> [`main`](https://github.com/blance714/SillyLounge/tree/main)；如果要阅读源码、
> 修改项目或参与开发，请先切换到 `main`。

## 分支结构

- `dist`：默认安装分支，只包含经过验证的运行时文件和这份 README。
- `main`：开发分支，包含 TypeScript/TSX 源码、构建脚本、项目文档与本地工具。

SillyTavern 安装扩展时不会替仓库执行构建，因此默认安装分支必须提前包含可由
浏览器直接加载的完整产物。

## 本地开发

安装依赖：

```sh
pnpm install
```

开发环境需要 Node.js `>=22.13.0`，与项目固定的 pnpm 工具链保持一致。

执行完整的本地验证门：

```sh
pnpm run verify
```

`verify` 会依次运行类型检查、Node 测试、一次干净的 Vite 构建，以及组装后运行时
的构建契约检查。构建契约检查只验证候选产物，不会替换当前正在使用的本地运行时。

生成本地可安装运行时目录：

```sh
pnpm run runtime
```

在无交互自动化环境中，建议显式使用 CI 模式，避免 pnpm 停下来询问是否重建
依赖目录：

```sh
CI=true pnpm run typecheck
CI=true pnpm run verify
CI=true pnpm run runtime
```

`pnpm run build` 只会向 `dist/` 写入生成产物：

- 运行时模块：`dist/runtime/`
- 稳定的运行时依赖：`dist/runtime/chunks/vendor/`
- 打包后的 Preact 应用：`dist/root-app.mjs`

`pnpm run runtime` 会在 `.runtime/SillyTavern-ChatUI` 旁组装一棵完整候选树，
验证通过后才将它发布为新的本地运行时。验证器会检查：

- manifest 中声明的 JS/CSS 入口；
- 每一条生成后的相对导入；
- 明确列出的 SillyTavern 外部模块白名单；
- 不应出现在浏览器包中的 Node 全局变量；
- 生成文件内是否泄漏机器本地路径。

`node_modules`、`.pnpm`、未解析的裸导入和机器绝对路径都会阻止发布。

真实宿主测试固定使用 `test/e2e/st-version.json` 声明的 SillyTavern。首次运行先安装
Chromium，然后把环境变量指向该版本且已经安装依赖的检出：

```sh
pnpm exec playwright install chromium
SILLYTAVERN_TEST_ROOT=/path/to/SillyTavern pnpm run test:st
SILLYTAVERN_TEST_ROOT=/path/to/SillyTavern pnpm run test:e2e
```

`test:st` 验证一次性 dataRoot 与宿主进程边界；`test:e2e` 还会在真实 Chromium 中
同时核对 SillyTavern 内部状态、SillyLounge 可见 DOM 和楼层导航。400 楼的可重复
性能测量命令与当前基线见 `PERFORMANCE.md`。

本地 live 路径是一个指向已验证发布代次的符号链接。替换指针是原子的，因此
SillyTavern 只会看到完整旧版本或完整新版本；构建或验证失败不会破坏当前运行时。

- `pnpm run check:build`：组装并验证新的候选树，但不发布。
- `pnpm run check:runtime`：验证当前 live 运行时。

若要让本地 SillyTavern 直接加载开发版本，可建立下面的符号链接：

```text
<SillyTavern>/public/scripts/extensions/third-party/SillyLounge
  -> <SillyLounge 仓库>/.runtime/SillyTavern-ChatUI
```

然后运行：

```sh
pnpm run dev
```

`dev` 只轮询 Vite/运行时源码输入，不监听 `node_modules`。每次重建都会经过与
`runtime` 相同的组装、验证和原子发布路径；损坏的中间构建不会覆盖 live 版本。

## 自动发布 `dist`

SillyTavern 的扩展安装器不会运行本仓库的构建工具，所以 `dist` 分支根目录必须
直接包含经过验证的运行时树：`manifest.json`、`style.css`、`index.js`、编译后的
模块目录（包括 `chunks/vendor/`），以及 `dist/root-app.mjs`。

不要直接发布开发分支里的 `dist/` 目录：它有意不包含 manifest、样式表和完整的
扩展根目录结构。

每次向 `main` 推送提交都会触发 `.github/workflows/publish-dist.yml`。流水线会：

1. 使用锁定的 Node.js 与 pnpm 工具链安装依赖；
2. 执行完整验证门；
3. 检出 `test/e2e/st-version.json` 固定的 SillyTavern 版本，并在 Chromium 中加载合成测试用户；
4. 同时核对宿主状态、SillyLounge 可见 DOM 与楼层导航；保留截图、trace 和宿主日志；
5. 组装并验证 `.runtime/SillyTavern-ChatUI`；
6. 从 `main` 原样复制这份 README；
7. 将精确的可安装文件树提交到 `dist`。

不要手动修改 `dist`。自动发布会维护普通的线性 Git 历史，以便已经安装的
SillyTavern 扩展可以正常更新。

## HTML 卡片信任模型

HTML 卡片 iframe 有意不启用 sandbox，以便可信卡片能够与 TavernHelper、MVU 和
SillyTavern 运行时集成。运行这类卡片，等同于让对话提供的代码获得扩展页面权限。

请只加载你信任的卡片、角色数据和聊天记录。项目没有加入 sandbox 或执行前确认，
因为那会破坏上述兼容性契约。

## 项目文档

- `DESIGN.md`：产品视觉北星与可验证的 Manuscript Flow 设计契约。
- `ARCHITECTURE.md`：架构、迁移策略与依赖关系说明。
- `PERFORMANCE.md`：400 楼长对话基线、诊断与可重复测量方法。
- `STATUS.md`：当前进度、重要边界与下一阶段状态。
- `ROADMAP.md`：功能完整度和后续工作优先级。

## 运行时文件边界

生成后的安装运行时有意排除：

- `node_modules/`
- `.pnpm/`
- `.pnpm-store/`
- `package.json`
- `tsconfig.json`
- `scripts/`
- `src/`
- 项目文档和仅供源码阶段使用的契约

手写源码位于 `src/`。Vite 将运行时模块编译到 `dist/runtime/`，将 Preact 应用
编译到 `dist/root-app.mjs`；随后 `pnpm run runtime` 把 SillyTavern 可直接加载的
完整文件树同步到 `.runtime/SillyTavern-ChatUI`。

```text
src/
  -> dist/runtime/ + dist/root-app.mjs
  -> .runtime/SillyTavern-ChatUI
  -> SillyTavern public/scripts/extensions/third-party/SillyLounge 符号链接
```

Vite 可能会提示 React Query 包级别的 `"use client"` 指令被忽略。这是当前浏览器
打包方式下的预期警告。`scripts/build.mjs` 会将 `process.env.NODE_ENV` 定义为
`"production"`，运行时产物检查也会确保生成的 JS/MJS 中不再残留 `process.env`。
