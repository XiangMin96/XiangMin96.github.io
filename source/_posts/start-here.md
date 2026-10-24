---
title: 写在前面：这个博客写什么
date: 2026-10-24 10:00:00
sticky: 100
categories: 导读
tags:
  - Android Framework
  - AOSP
---

这个博客专门写 Android Framework 的技术原理：从 AOSP 源码出发，讲清楚系统启动、Binder、AMS、WMS、渲染显示、Input 这些模块是怎么工作的。

<!-- more -->

## 适合谁读

- 写过一段时间 App，想知道 API 背后系统做了什么的 Android 开发者
- 准备做 Framework、ROM 或性能优化方向的同学

## 怎么读

文章按模块组织，完整计划见 [专栏目录](/series/)。建议先读系统启动和 Binder，这两块是理解其他模块的基础。

每篇文章开头会注明对应的 AOSP 版本，源码可以在 [cs.android.com](https://cs.android.com) 对照查看。

## 文章结构

每篇基本按这个顺序展开：

1. 背景：这篇要回答什么问题
2. 整体流程：先给出调用链或时序图
3. 源码分析：逐段看关键代码
4. 总结：用几句话复述核心结论
