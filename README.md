# bili-emoji-search

给 Bilibili 网页端用的 userscript。输入 `/关键词` 就能搜索当前页面可用的原生表情，并把结果直接插入到输入框里。

## 效果展示

![搜索效果](asset/search.png)
![最近使用效果](asset/recent.png)

## 功能

- 输入 `/` 后开始搜索当前页面可用的原生表情
- 空查询优先显示最近使用
- 支持中文标点归一化和 code 的 subsequence 匹配
- 结果直接写入表情 code，例如 `[热词系列_再给一集]`

## 支持场景

- 所有评论区

## 安装

1. 运行构建脚本：

```bash
./scripts/build-userscript.sh
```

2. 打开 Tampermonkey、Violentmonkey 等 userscript 插件并新建脚本。
3. 将 [`dist/bili-emoji-search.user.js`](dist/bili-emoji-search.user.js) 的全部内容直接粘贴进去并保存。
4. 刷新 Bilibili 页面。

## 使用

1. 在输入框里输入 `/`
2. 继续输入关键词
3. 点击结果，或用 `ArrowUp` / `ArrowDown` 选择后按 `Enter`


## 注意

- 依赖当前页面能正常打开原生表情面板
- 以稳定插入表情 code 为主，不模拟原生点击动画

## Star Chart

[![Stargazers over time](https://starchart.cc/caca2331/Bili-Emoji-Search.svg?variant=adaptive)](https://starchart.cc/caca2331/Bili-Emoji-Search)
