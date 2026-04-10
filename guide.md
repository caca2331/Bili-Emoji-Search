# 设计说明

## 1. 目标

项目的核心不是自己维护一套表情数据库，而是把 Bilibili 当前页面里已经存在的原生表情能力变成一个更快的 `/关键词` 搜索入口。

实现重点有三件事：

1. 找到不同页面里的真实输入框和原生表情面板
2. 把原生表情 code 抓出来并建立轻量索引
3. 在不干扰原生页面逻辑的前提下，把 `/查询` 替换成目标表情 code

## 2. 页面适配

### 评论区

- 视频页和 opus 页评论区都使用 `bili-comments` 组件
- 真正可编辑区域是 shadow root 内部的 `div.brt-editor[contenteditable=true]`
- 原生表情入口位于同一评论框组件里的 `button.tool-btn.emoji`
- 原生弹层容器是 `#emoji-popover`，内部挂载 `bili-emoji-picker`

### 动态发布框

- 动态首页顶部发布框使用 `div.bili-rich-textarea__inner[contenteditable=true]`
- 原生表情入口是 `.bili-dyn-publishing__tools__item.emoji`
- 表情面板是普通 DOM 节点 `.bili-emoji`
- 包标签直接放在 `.bili-emoji__pkg img[alt]` 上

## 3. 表情抓取

### 评论区抓取

- 程序会临时打开原生 `bili-emoji-picker`
- 优先读取 `bili-emoji-picker.__packages` 中的全量包数据
- 如果 `__packages` 不可用，再回退到 shadow root 内部的 DOM 抓取
- DOM 抓取时会读取 `.emoji img` / `.emoji span`，并对可滚动容器持续滚动，直到抓取数量稳定

### 动态发布框抓取

- 程序会依次点击每个 `.bili-emoji__pkg`
- 每个包内读取 `.bili-emoji__list__item img[alt]`
- 如果分页按钮还能翻页，就继续向后翻，直到内容签名不再变化

### 为什么不内置静态表情表

- Bilibili 表情包会变化
- 用户真正能用的表情包和页面上下文强相关
- 直接抓原生面板可以减少过期风险，也能自动支持新表情包

## 4. Slash 状态机

- `idle`: 等待手动输入 `/`
- `active`: 记录当前 slash 的文本位置，并持续根据光标位置重算查询词

退出条件：

- 光标离开 slash 起点后的 20 个字符范围
- slash 被删除
- 选区不再折叠
- 点击悬浮面板外区域
- 选择了一个表情

程序只维护一个活动 slash，会优先以最近一次手动输入的 `/` 为准。

## 5. 插入策略

当前版本直接把 `/查询词` 替换成表情 code 文本。

原因：

- 这是最稳定、最通用的路径
- 评论区和动态发布框都以 contenteditable 为核心，直接替换文本更容易保证一致性
- 不需要依赖原生点击插入时的内部私有逻辑

替换后会主动补发 `input` 事件，确保页面自身的状态更新逻辑能收到变更。

## 6. 搜索与排序

- 索引基于表情 code
- 搜索前会先把中文标点归一化为英文标点，再去掉方括号、下划线并忽略大小写
- 命中优先级：
  - 最近使用的指数衰减分数
  - 完全匹配
  - 前缀匹配
  - 连续子串匹配
  - subsequence 匹配
  - 原始顺序

空查询时会先展示当前仍存在于 registry 中的最近使用表情，再按原始顺序补齐其他所有可用表情。

## 7. 最近使用记录

- 优先使用 `GM_getValue` / `GM_setValue`
- 注入测试环境下自动回退到 `localStorage`
- 存储内容保留最小必要字段：`code`、`imageUrl`、`packageName`、`usedAt`、`score`
- 每次使用表情时，recent score 按下式更新：
  - `S_new = S_old * e^(-0.0231 * Δt_days) + 1`
- 脚本浮层选择和原生表情面板点击，都会走同一套 recent 记分逻辑
- 如果 storage 中存在已经不在当前 registry 里的旧表情，recent 展示时会自动跳过它们，但不会强制删除原始存储
- 默认最多保留 500 条

## 8. 测试路线

这次实际排查后，Chrome for Testing 的普通模式可以正常启动并连接本地 DevTools；headless 在当前环境下并不稳定。因此测试路线更新为：

- 用工作目录内的 Chrome for Testing 普通模式启动
- 通过 DevTools Protocol 注入构建后的脚本
- 在目标页面验证：
  - `/` 触发
  - 查询更新
  - 表情抓取
  - 插入 code
  - 最近使用排序

这一约束属于本地测试要求，不纳入仓库跟踪。

## 9. Debug 构建

- `scripts/build-userscript.sh` 会同时生成正式版和调试版
- 调试版文件为 `dist/bili-emoji-search.debug.user.js`
- 调试版会记录：
  - slash 键盘 / input 事件是否被捕获
  - session 是否激活、何时关闭
  - 表情注册表是否开始加载、是否命中缓存、最终抓到多少条
  - Enter 选择时是否真的触发插入
  - 文本替换是否走了 `execCommand` 还是 fallback
- 调试版还会暴露 `window.__BILI_EMOJI_SEARCH_DEBUG__`
  - `getState()`: 查看当前 session、缓存、最近事件
  - `getEvents()`: 查看最近日志缓冲
  - `clearEvents()`: 清空日志缓冲
