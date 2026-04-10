# 当前进展

本文档用于新 session 交接，只保留当前仍然有效的实现状态、验证结论、环境约束和后续接手时最需要知道的信息。

## 1. 当前状态

- 分支: `main`
- 当前版本: `1.0.0`
- 当前产物:
  - `dist/bili-emoji-search.user.js`
  - `dist/bili-emoji-search.debug.user.js`
- 项目形态:
  - 无构建框架的模块化 userscript 源码
  - 通过 `scripts/build-userscript.sh` 拼装正式版和调试版

## 2. 已实现能力

### 2.1 支持范围

- 视频页评论区
- opus / 专栏 / 动态详情页评论区
- (TODO)动态首页顶部发布框
- 动态卡片下方评论框

### 2.2 slash 搜索行为

- 只响应手动输入的 `/`
- `/` 激活后，以 slash 到当前 caret 之间的文本作为 query
- 光标离开 `[slashIndex, slashIndex + 20]` 自动关闭
- 点击浮层外关闭
- 选中结果后，会把 `/query` 替换为目标表情 code
- 空 query 时显示 recent 前缀，并按原始顺序补齐当前 registry 中其余表情
- 搜索前会先把中文标点归一化为英文标点
- 搜索匹配采用 subsequence，而不是 substring

### 2.3 recent 逻辑

- recent 使用指数衰减分数:
  - `S_new = S_old * e^(-0.0231 * Δt_days) + 1`
- 脚本浮层选择表情和原生表情面板点击表情，都会更新同一套 recent score
- recent 只持久化点击历史，不持久化全量表情 registry
- recent 持久化上限为 `500`
- storage 中即使残留已失效表情，也只会在展示层被忽略，不会阻塞当前可用表情
- recent history 在读入和写回时都会去重、排序、归一化，避免重复 code 污染排序或展示

### 2.4 调试能力

- 正式版: `dist/bili-emoji-search.user.js`
- 调试版: `dist/bili-emoji-search.debug.user.js`
- 调试版暴露:
  - `window.__BILI_EMOJI_SEARCH_DEBUG__.getState()`
  - `window.__BILI_EMOJI_SEARCH_DEBUG__.getEvents()`
  - `window.__BILI_EMOJI_SEARCH_DEBUG__.clearEvents()`

## 3. 关键实现点

### 3.1 源码入口

- `src/app.js`
  - slash session 状态机
  - `beforeinput` / `input` / `keydown` 监听
  - overlay 渲染、键盘选择、recent/search 切换
- `src/bootstrap.js`
  - 公共常量
  - contenteditable / textarea 文本替换
  - selection 解析
  - 原生 emoji 面板强制隐藏工具
- `src/registry.js`
  - 评论区 / 动态发布框上下文识别
  - 原生表情抓取
  - registry cache
- `src/search.js`
  - recent 前缀构造
  - subsequence 搜索与排序
- `src/storage.js`
  - recent history 存储、衰减记分、去重归一化
- `src/ui.js`
  - 浮层布局和样式

### 3.2 关键技术结论

- 评论区表情抓取的最佳入口不是 DOM tab 切换，而是 `bili-emoji-picker.__packages`
- 某些编辑器下 caret 不会在 `/` 输入后立刻稳定，因此 slash 激活必须重试，不能只做单次 selection 读取
- 评论区原生表情面板涉及 shadow DOM，隐藏它不能只靠 document 级样式，必须直接写目标节点 inline style
- 收集表情时，必须在隐藏状态下先关闭原生面板，再恢复样式，否则首次搜索可能会闪出原生 UI
- `tv` 等动态表情在评论区数据源里优先取 `gif_url`

## 4. 已验证结论

### 4.1 曾完成的真实页面验证

以下验证都基于用户给定的已登录工作目录 profile，且未执行真实发评、发动态、点赞等写操作。

- 视频评论区:
  - `/doge` 返回预期结果
- opus 评论区:
  - `/doge` 返回预期结果
- 动态发布框:
  - `/tv` 返回 `tv_*` 相关结果
  - 选择结果后插入 code 成功
  - 再输入 `/` 时 recent 排序已更新
- 动态卡片评论框:
  - 打开卡片评论框后，`/doge` 返回预期结果
- 动态详情页评论区:
  - 页面结构检查确认仍可复用当前 `comment-box` 适配器

截图文件:

- `dist/video-comment-overlay.png`
- `dist/opus-comment-overlay.png`
- `dist/dynamic-comment-overlay.png`
- `dist/dynamic-publisher-overlay.png`

### 4.2 逻辑级验证

- 原生表情点击会进入 recent 统计
- 中文标点归一化后可正常命中
- empty slash recent 会先显示有效 recent，再补齐当前 registry 中的其他表情
- recent 去重、失效项过滤、标题数量与可见 recent 前缀一致

## 5. 已知状态与剩余关注点

- 核心功能已闭环，当前没有已知的结构性缺口
- 更值得继续关注的是用户真实已登录 Tampermonkey 环境里的交互细节
- 需要优先留意的残余风险:
  - 首次搜索时原生表情 UI 是否还会在某些页面时机下闪出
  - Bilibili 后续 DOM 结构变动是否影响 `comment-box` / `dynamic-publisher` 适配器

如果用户再次反馈“首次搜索原生 UI 仍会闪”，优先收集:

- `window.__BILI_EMOJI_SEARCH_DEBUG__.getState()`
- `window.__BILI_EMOJI_SEARCH_DEBUG__.getEvents()`

重点看这些日志:

- `collect comment registry:start`
- `collect comment registry:done via packages`
- `emoji ui cleanup:start`
- `emoji ui cleanup:done`

## 6. 环境约束

后续任何 agent 继续工作时，必须遵守以下规则:

1. 不要再启动工作目录外的空白 profile
2. 如果需要连接浏览器调试，只能优先复用用户当前已登录的工作目录 profile
3. 禁止执行任何真实发布、评论、点赞、修改个人资料等写操作
4. 若要做浏览器验证，先确认环境中没有旧版 userscript 在干扰当前 bundle 的行为

## 7. 常用命令

构建:

```bash
./scripts/build-userscript.sh
```

语法检查:

```bash
node --check dist/bili-emoji-search.user.js
node --check dist/bili-emoji-search.debug.user.js
```

查看当前改动:

```bash
git status --short
git diff
```
