# SillyLounge 🍸

一套为 SillyTavern 设计、带有手稿与手记气质的替代聊天界面。

**这个仓库只放编译好的安装包。** 源码、开发历史、issue 都在
[blance714/SillyLounge](https://github.com/blance714/SillyLounge)。

## 安装

1. 打开 SillyTavern，进入 **扩展 → 安装扩展**。
2. 把下面这行粘进安装框：

   ```text
   https://github.com/blance714/SillyLounge-dist
   ```

3. 直接点安装——**「Branch or tag name」那栏留空**。
4. 按 SillyTavern 的提示刷新页面。

安装不需要 Node.js、pnpm，也不需要在本地跑构建：这个仓库的默认分支根目录就是
浏览器可以直接加载的完整运行时。

之后 SillyTavern 的「更新扩展」会照常工作。

## 这里的内容是怎么来的

每次向源码仓的 `main` 推送提交，都会跑一次完整门禁——类型检查、单元测试、
构建契约，以及在固定版本的真实 SillyTavern 里用 Chromium 和 Firefox 双引擎跑的
浏览器验收。**全绿之后**，流水线才把验证过的运行时树推到这里。

所以这个仓库的提交历史是一串 `build: publish <源码提交>`，每一条都能对回源码仓的
一个提交。

**请不要手动改这个仓库。** 下一次发布会用 `rsync --delete` 覆盖掉。

> 这个仓库的名字不能改：SillyTavern 用仓库名决定扩展的安装目录名，改名会让所有
> 已有安装失联。

## 许可与信任模型

HTML 卡片 iframe 有意不启用 sandbox，以便可信卡片能与 TavernHelper、MVU 集成。
运行这类卡片等同于让对话提供的代码获得扩展页面权限——请只加载你信任的卡片、
角色数据和聊天记录。完整说明见源码仓的 README。
