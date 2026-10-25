---
title: 专栏目录
date: 2026-10-24 10:00:00
layout: page
---

按模块整理的写作计划，写完一篇就把标题换成链接。建议按顺序阅读：先了解系统启动和 Binder，后面的模块都依赖它们。

## 1. 系统启动

- init 进程与 init.rc
- Zygote 启动与应用进程孵化
- SystemServer 启动与系统服务注册

## 2. Binder 与 IPC

- Binder 整体架构：Client、Server、ServiceManager、驱动
- 一次 Binder 调用的完整流程
- AIDL 生成代码解析

## 3. 消息机制

- Handler、Looper、MessageQueue
- 同步屏障与异步消息
- epoll 与 native 层消息循环

## 4. AMS 与四大组件

- startActivity 全流程
- 应用进程的创建与 bindApplication
- Service、BroadcastReceiver、ContentProvider 的启动

## 5. WMS 与窗口

- Window、WindowManager 与 ViewRootImpl
- 窗口的添加、层级与布局

## 6. 渲染与显示

- Vsync 与 Choreographer
- View 的 measure、layout、draw
- RenderThread 与 HWUI
- SurfaceFlinger 系列
  - [SurfaceFlinger（一）：整体架构与启动流程](/2026/10/24/surfaceflinger-01-architecture/)
  - [SurfaceFlinger（二）：Surface、Layer 与 BufferQueue](/2026/10/25/surfaceflinger-02-bufferqueue/)
  - SurfaceFlinger（三）：Vsync 信号的产生与分发
  - SurfaceFlinger（四）：一帧的合成流程
  - SurfaceFlinger（五）：HWC 合成与 GPU 合成
  - SurfaceFlinger（六）：Transaction 机制
  - SurfaceFlinger（七）：用 Perfetto 分析合成卡顿

## 7. Input 系统

- InputReader 与 InputDispatcher
- 事件从内核到 View 的传递路径

## 8. PMS 与应用安装

- APK 安装流程
- 包解析与权限管理

## 9. 性能与稳定性

- ANR 的产生与分析
- Perfetto 抓取与分析 Trace

## 10. 工具与环境

- 下载与编译 AOSP
- 使用 Android Studio 调试 Framework 源码
