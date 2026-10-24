---
title: SurfaceFlinger（一）：整体架构与启动流程
categories: 渲染与显示
tags:
  - SurfaceFlinger
  - 图形系统
date: 2026-10-24 22:14:48
---

> 本文基于 AOSP android-15.0.0_r1 源码，SurfaceFlinger 代码位于 `frameworks/native/services/surfaceflinger/`，可在 [cs.android.com](https://cs.android.com) 对照查看。文中代码均为节选，省略部分用 `// ...` 标出。

App 画好的一帧，最终由 SurfaceFlinger 合成并送到屏幕上。这篇先讲清楚两件事：SurfaceFlinger 在图形栈里处于什么位置，以及它从 init 拉起到开始按 Vsync 节奏工作的完整启动流程。

<!-- more -->

## 背景

每个 App 窗口、状态栏、导航栏、壁纸，各自都在画自己的内容。屏幕只有一块，需要有一个角色把这些内容按层级、位置、透明度叠在一起，再交给显示硬件。这个角色就是 SurfaceFlinger。

它负责的事情：

- 接收各个进程提交的图形 buffer，管理对应的 Layer（图层）
- 在每个 Vsync 周期决定这一帧要显示哪些 Layer、怎么叠
- 把合成工作交给 HWC（硬件合成器）或者 GPU（RenderEngine）
- 管理显示设备：热插拔、分辨率与刷新率切换、亮屏灭屏

它不负责的事情：

- 不负责 App 内部怎么画。View 的 measure、layout、draw 和 RenderThread 的渲染都在 App 进程里完成
- 不负责窗口策略。窗口的层级、焦点、动画由 system_server 里的 WMS 决定，再通过 Transaction 告诉 SurfaceFlinger

## 整体架构

### 在图形栈中的位置

从 App 到屏幕，一帧数据大致经过这些环节：

```text
App 进程                         surfaceflinger 进程                    硬件
┌──────────────────────┐        ┌──────────────────────────────┐
│ View 绘制             │        │ Layer 管理                    │
│ RenderThread / HWUI  │ buffer │ Scheduler（Vsync 调度）         │       ┌──────────┐
│ BLASTBufferQueue     │ ─────▶ │ CompositionEngine             │ ────▶ │ HWC HAL  │ ──▶ 屏幕
└──────────────────────┘        │  ├─ HWComposer（硬件合成）      │       └──────────┘
        ▲                       │  └─ RenderEngine（GPU 合成）    │
        │ Vsync-app             └──────────────────────────────┘
        └──────────────────────────────┘
system_server（WMS）── Transaction（窗口层级、位置、可见性）──▶ SurfaceFlinger
```

App 和 WMS 都是 SurfaceFlinger 的客户端，通过 Binder 和它通信。App 侧通过 BLASTBufferQueue 把画好的 buffer 随 Transaction 一起提交，这部分放到第二篇细讲。

### 核心模块

SurfaceFlinger 的代码量很大，单 `SurfaceFlinger.cpp` 就有一万多行。先认识几个核心模块，后面的文章会逐个展开：

| 模块 | 作用 | 代码位置 |
| --- | --- | --- |
| Scheduler | 管理 Vsync、驱动 SurfaceFlinger 主线程的每一帧，也负责给 App 分发 Vsync | `Scheduler/` |
| Layer / LayerSnapshot | 每个 Surface 在 SurfaceFlinger 里对应一个 Layer，保存 buffer、位置、透明度等状态 | `Layer.cpp`、`FrontEnd/` |
| CompositionEngine | 合成的总调度，决定每个 Layer 走硬件合成还是 GPU 合成 | `CompositionEngine/` |
| HWComposer | 对 HWC HAL 的封装，负责和显示硬件打交道 | `DisplayHardware/` |
| RenderEngine | 用 GPU（Skia）把无法硬件合成的 Layer 画到一个 buffer 上 | `libs/renderengine/` |

## 启动流程

整个启动过程可以概括成一条链：

```text
init 解析 surfaceflinger.rc
  └─ main()                         main_surfaceflinger.cpp
       ├─ 配置 Binder 线程池、调度优先级
       ├─ createSurfaceFlinger()    构造 SurfaceFlinger 对象
       ├─ flinger->init()           初始化 RenderEngine、HWC、显示设备、Scheduler
       ├─ addService("SurfaceFlinger") / addService("SurfaceFlingerAIDL")
       └─ flinger->run()            主线程进入消息循环，按 Vsync 处理每一帧
```

下面按顺序看源码。

### init 启动 surfaceflinger 进程

SurfaceFlinger 是一个独立的 native 进程，由 init 根据 `surfaceflinger.rc` 拉起：

```text
service surfaceflinger /system/bin/surfaceflinger
    class core animation
    user system
    group graphics drmrpc readproc
    capabilities SYS_NICE
    onrestart restart --only-if-running zygote
    task_profiles HighPerformance
```

几个值得注意的配置：

- `class core animation`：属于 core 类服务，在开机早期启动。它比 Zygote 和 system_server 都早，开机动画也依赖它。
- `capabilities SYS_NICE`：允许进程调整自己线程的调度策略和优先级。后面 main 函数里把线程设成 `SCHED_FIFO`，靠的就是这个权限。
- `onrestart restart --only-if-running zygote`：SurfaceFlinger 崩溃重启时，如果 Zygote 正在运行，会连带重启 Zygote。因为所有 App 和 system_server 都持有 SurfaceFlinger 的连接，它一重启，上层的图形状态就全部失效，只能整体重来。这也是为什么 SurfaceFlinger 崩溃时手机会"软重启"。

### main 函数

入口在 `main_surfaceflinger.cpp`。去掉错误处理后，主干如下：

```cpp
int main(int, char**) {
    signal(SIGPIPE, SIG_IGN);

    hardware::configureRpcThreadpool(1 /* maxThreads */,
            false /* callerWillJoin */);

    startGraphicsAllocatorService();

    // When SF is launched in its own process, limit the number of
    // binder threads to 4.
    ProcessState::self()->setThreadPoolMaxThreadCount(4);

    // ... 把当前线程临时设为 SCHED_FIFO 最低实时优先级
    sp<ProcessState> ps(ProcessState::self());
    ps->startThreadPool();
    // ... 恢复当前线程原来的调度策略

    // instantiate surfaceflinger
    sp<SurfaceFlinger> flinger = surfaceflinger::createSurfaceFlinger();

    setpriority(PRIO_PROCESS, 0, PRIORITY_URGENT_DISPLAY);
    set_sched_policy(0, SP_FOREGROUND);

    // initialize before clients can connect
    flinger->init();

    // publish surface flinger
    sp<IServiceManager> sm(defaultServiceManager());
    sm->addService(String16(SurfaceFlinger::getServiceName()), flinger, false,
                   IServiceManager::DUMP_FLAG_PRIORITY_CRITICAL | IServiceManager::DUMP_FLAG_PROTO);

    // publish gui::ISurfaceComposer, the new AIDL interface
    sp<SurfaceComposerAIDL> composerAIDL = sp<SurfaceComposerAIDL>::make(flinger);
    sm->addService(String16("SurfaceFlingerAIDL"), composerAIDL, false,
                   IServiceManager::DUMP_FLAG_PRIORITY_CRITICAL | IServiceManager::DUMP_FLAG_PROTO);

    startDisplayService(); // dependency on SF getting registered above

    // ... setSchedFifo(true)

    // run surface flinger in this thread
    flinger->run();

    return 0;
}
```

按顺序看：

1. **Binder 线程池最多 4 个线程**。客户端的 Binder 调用（创建 Layer、提交 Transaction 等）都在这些线程上执行，不占用主线程。
2. **线程池用实时调度**。启动线程池前，先把当前线程临时改成 `SCHED_FIFO` 的最低实时优先级，这样新建的 Binder 线程会继承这个策略，之后再把当前线程恢复原样。源码注释写得很清楚：希望 Binder 线程池是 `SCHED_FIFO`、优先级 1。
3. **创建 SurfaceFlinger 对象**。`createSurfaceFlinger()` 用一个静态的 `DefaultFactory` 构造 `SurfaceFlinger`。Factory 负责创建 HWComposer、CompositionEngine 等依赖，单元测试里可以换成 mock 实现。
4. **`init()` 必须在注册服务之前完成**，注释是 "initialize before clients can connect"。注册之后客户端就能连进来，那时显示设备和调度器必须已经就绪。
5. **注册两个服务**。`SurfaceFlinger` 是传统接口，`SurfaceFlingerAIDL` 是新的 AIDL 接口 `gui::ISurfaceComposer`。
6. **`run()` 不会返回**，main 线程从这里变成 SurfaceFlinger 的主线程。

### SurfaceFlinger 的构造函数

构造函数主要做两件事：通过 Factory 创建核心组件，读取一批系统属性。

```cpp
SurfaceFlinger::SurfaceFlinger(Factory& factory, SkipInitializationTag)
      : mFactory(factory),
        mPid(getpid()),
        mTimeStats(std::make_shared<impl::TimeStats>()),
        mFrameTracer(mFactory.createFrameTracer()),
        mFrameTimeline(mFactory.createFrameTimeline(mTimeStats, mPid)),
        mCompositionEngine(mFactory.createCompositionEngine()),
        mHwcServiceName(base::GetProperty("debug.sf.hwc_service_name"s, "default"s)),
        // ...
        mPowerAdvisor(std::make_unique<Hwc2::impl::PowerAdvisor>(*this)),
        // ...
{
    ALOGI("Using HWComposer service: %s", mHwcServiceName.c_str());
}

SurfaceFlinger::SurfaceFlinger(Factory& factory) : SurfaceFlinger(factory, SkipInitialization) {
    ALOGI("SurfaceFlinger is starting");

    maxFrameBufferAcquiredBuffers = max_frame_buffer_acquired_buffers(2);
    mSupportsWideColor = has_wide_color_display(false);
    defaultCompositionPixelFormat = static_cast<ui::PixelFormat>(
            default_composition_pixel_format(ui::PixelFormat::RGBA_8888));
    // ... 更多 ro.surface_flinger.* 属性
}
```

`max_frame_buffer_acquired_buffers`、`has_wide_color_display` 这类函数读的是 `ro.surface_flinger.*` 系统属性，由设备厂商在产品配置里设置。到这一步只是把对象和配置准备好，硬件还没有初始化。

### SurfaceFlinger::init

真正的初始化在 `init()` 里，日志里那句 "Initializing graphics H/W..." 就出自这里。按顺序分成几步：

```cpp
void SurfaceFlinger::init() {
    ALOGI(  "SurfaceFlinger's main thread ready to run. "
            "Initializing graphics H/W...");
    Mutex::Autolock lock(mStateLock);

    // 1. 创建 RenderEngine（GPU 合成）
    auto builder = renderengine::RenderEngineCreationArgs::Builder()
                           .setPixelFormat(static_cast<int32_t>(defaultCompositionPixelFormat))
                           .setImageCacheSize(maxFrameBufferAcquiredBuffers)
                           // ...
    chooseRenderEngineType(builder);
    mRenderEngine = renderengine::RenderEngine::create(builder.build());
    mCompositionEngine->setRenderEngine(mRenderEngine.get());

    // 2. 创建 HWComposer（硬件合成），并注册回调
    mCompositionEngine->setHwComposer(getFactory().createHWComposer(mHwcServiceName));
    auto& composer = mCompositionEngine->getHwComposer();
    composer.setCallback(*this);

    // 3. 处理开机时已连接的显示设备
    // Process hotplug for displays connected at boot.
    LOG_ALWAYS_FATAL_IF(!configureLocked(),
                        "Initial display configuration failed: HWC did not hotplug");

    // 4. 提交主显示屏
    sp<const DisplayDevice> display;
    if (const auto indexOpt = mCurrentState.getDisplayIndex(getPrimaryDisplayIdLocked())) {
        // ...
        processDisplayAdded(token, state);
        mDrawingState.displays.add(token, state);
        display = getDefaultDisplayDeviceLocked();
    }
    LOG_ALWAYS_FATAL_IF(!display, "Failed to configure the primary display");

    // 5. 创建 Scheduler
    initScheduler(display);

    // 6. 提交其他显示屏，初始化绘制状态
    processDisplayChangesLocked();
    mDrawingState = mCurrentState;

    // 7. 在主线程上执行 initializeDisplays（点亮屏幕）
    static_cast<void>(mScheduler->schedule(
            [this]() FTL_FAKE_GUARD(kMainThreadContext) { initializeDisplays(); }));

    // 8. 预热 shader 缓存
    if (base::GetBoolProperty("service.sf.prime_shader_cache"s, true)) {
        mRenderEnginePrimeCacheFuture.callOnce([this] {
            // ...
            return getRenderEngine().primeCache(config);
        });
    }

    // 9. 异步设置启动属性，拉起开机动画
    mInitBootPropsFuture.callOnce([this] {
        return std::async(std::launch::async, &SurfaceFlinger::initBootProperties, this);
    });
}
```

逐步说明：

**1. RenderEngine**。这是 SurfaceFlinger 的 GPU 合成后端。当某些 Layer 无法交给硬件合成时（比如带圆角、模糊、或者 HWC 支持的图层数量不够），就由 RenderEngine 用 GPU 把这些 Layer 先画到一个 buffer 上。`chooseRenderEngineType` 负责选择具体实现：可以用 `debug.renderengine.backend` 属性手动指定 `skiagl`、`skiavk` 等；不指定时，由 feature flag 和设备能力决定 Skia 走 GL 还是 Vulkan。不管哪种，底层都是 Skia。

**2. HWComposer**。它封装了 HWC HAL，SurfaceFlinger 通过它和显示硬件交互。`composer.setCallback(*this)` 这一行很关键：`SurfaceFlinger` 继承了 `HWC2::ComposerCallback`，硬件的热插拔、Vsync、刷新请求等事件都会通过这个回调送回 SurfaceFlinger。

**3. configureLocked**。处理开机时已经连接的显示设备的热插拔事件。如果 HWC 一个显示设备都没上报，SurfaceFlinger 会直接 `LOG_ALWAYS_FATAL` 崩溃，因为没有屏幕就没有意义继续运行。

**4. processDisplayAdded**。为主显示屏创建 `DisplayDevice`，它是 SurfaceFlinger 里对一块屏幕的抽象，持有这块屏幕的分辨率、显示模式、合成输出等信息。

**5. initScheduler**。创建负责 Vsync 调度的 Scheduler，下一节单独看。

**7. initializeDisplays**。没有直接调用，而是通过 `mScheduler->schedule()` 投递到主线程执行。SurfaceFlinger 的很多状态只允许在主线程修改，这是它保证线程安全的主要方式，后面会反复见到这种写法。

**8. primeCache**。提前编译 RenderEngine 常用的 shader。如果不预热，第一次遇到某种合成场景时才去编译 shader，会造成明显卡顿。

**9. initBootProperties**。在另一个线程上设置属性，其中 `ctl.start bootanim` 会让 init 启动开机动画进程：

```cpp
void SurfaceFlinger::initBootProperties() {
    property_set("service.sf.present_timestamp", mHasReliablePresentFences ? "1" : "0");

    if (base::GetBoolProperty("debug.sf.boot_animation"s, true)) {
        // Reset and (if needed) start BootAnimation.
        property_set("service.bootanim.exit", "0");
        property_set("service.bootanim.progress", "0");
        property_set("ctl.start", "bootanim");
    }
}
```

源码注释解释了为什么要异步：`property_set` 依赖 init 里的 property service，而 init 在开机时可能正忙于 `mount_all --late` 这类慢操作，同步调用会阻塞 SurfaceFlinger 主线程。所以开机动画其实是 SurfaceFlinger 拉起的，这也解释了开机动画为什么能比 system_server 更早出现。

### initScheduler：创建 Vsync 调度器

```cpp
void SurfaceFlinger::initScheduler(const sp<const DisplayDevice>& display) {
    const auto activeMode = display->refreshRateSelector().getActiveMode();
    const Fps activeRefreshRate = activeMode.fps;

    FeatureFlags features;
    // ... 根据属性和硬件能力打开内容检测、present fence 等特性

    mScheduler = std::make_unique<Scheduler>(static_cast<ICompositor&>(*this),
                                             static_cast<ISchedulerCallback&>(*this), features,
                                             getFactory(), activeRefreshRate, *mTimeStats);

    // The pacesetter must be registered before EventThread creation below.
    mScheduler->registerDisplay(display->getPhysicalId(), display->holdRefreshRateSelector(),
                                mActiveDisplayId);

    const auto configs = mScheduler->getVsyncConfiguration().getCurrentConfigs();

    mScheduler->createEventThread(scheduler::Cycle::Render, mFrameTimeline->getTokenManager(),
                                  /* workDuration */ configs.late.appWorkDuration,
                                  /* readyDuration */ configs.late.sfWorkDuration);
    mScheduler->createEventThread(scheduler::Cycle::LastComposite,
                                  mFrameTimeline->getTokenManager(),
                                  /* workDuration */ activeRefreshRate.getPeriod(),
                                  /* readyDuration */ configs.late.sfWorkDuration);

    mScheduler->initVsync(*mFrameTimeline->getTokenManager(), configs.late.sfWorkDuration);

    // ...
    // Timer callbacks may fire, so do this last.
    mScheduler->startTimers();
}
```

这里有三个点：

- **Scheduler 持有 SurfaceFlinger 的 `ICompositor` 接口**。`SurfaceFlinger` 私有继承了 `ICompositor`，Scheduler 每一帧通过这个接口回调 SurfaceFlinger 的 `commit()` 和 `composite()`。也就是说，**Scheduler 决定什么时候做，SurfaceFlinger 负责做什么**。
- **`createEventThread(Cycle::Render, ...)`** 创建的是给 App 分发 Vsync 的 EventThread。App 里的 Choreographer 收到的 Vsync 就来自这里，`appWorkDuration` 和 `sfWorkDuration` 决定了 App 和 SurfaceFlinger 各自相对硬件 Vsync 提前多久被唤醒。另一路 `Cycle::LastComposite` 也在这里创建，第三篇讲 Vsync 时再细说。
- **`initVsync`** 为 SurfaceFlinger 自己注册 Vsync 回调，工作时长用的是 `sfWorkDuration`。

### SurfaceFlinger::run：进入主循环

`init()` 结束、服务注册完成后，main 函数调用 `run()`：

```cpp
void SurfaceFlinger::run() {
    mScheduler->run();
}
```

```cpp
// Scheduler/Scheduler.cpp
void Scheduler::run() {
    while (true) {
        waitMessage();
    }
}
```

`waitMessage()` 来自 Scheduler 的父类 `MessageQueue`，核心是一个 native `Looper`：

```cpp
// Scheduler/MessageQueue.cpp
void MessageQueue::waitMessage() {
    do {
        IPCThreadState::self()->flushCommands();
        int32_t ret = mLooper->pollOnce(-1);
        // ...
    } while (true);
}
```

`pollOnce(-1)` 会一直阻塞，直到有消息或 Vsync 回调到来。这和 App 主线程的 `Looper.loop()` 是同一套机制，底层都是 epoll，消息机制那一系列会细讲。

## 一帧是怎么被触发的

启动完成后，SurfaceFlinger 主线程大部分时间都阻塞在 `pollOnce` 里。一帧的触发过程如下：

**1. 有新内容时请求下一帧**。比如 App 提交了新的 buffer，SurfaceFlinger 会调用 `scheduleFrame()`，向 Vsync 调度器预约下一次唤醒：

```cpp
void MessageQueue::scheduleFrame() {
    std::lock_guard lock(mVsync.mutex);
    mVsync.scheduledFrameTimeOpt =
            mVsync.registration->schedule({.workDuration = mVsync.workDuration.get().count(),
                                           .readyDuration = 0,
                                           .lastVsync = mVsync.lastCallbackTime.ns()});
}
```

这一点很重要：**SurfaceFlinger 不是每个 Vsync 都会醒来**。屏幕内容不变时没人请求，它就一直睡着，这样可以省电。

**2. Vsync 到来，投递帧消息**。到达预约时间后，`vsyncCallback` 被调用。它会翻转 `VSYNC-sf` 这个 trace 计数器，然后把消息投递给主线程的 Looper：

```cpp
void MessageQueue::vsyncCallback(nsecs_t vsyncTime, nsecs_t targetWakeupTime, nsecs_t readyTime) {
    ATRACE_CALL();
    // Trace VSYNC-sf
    mVsync.value = (mVsync.value + 1) % 2;
    // ...
    mHandler->dispatchFrame(vsyncId, expectedVsyncTime);
}
```

在 Perfetto 里看到的 `VSYNC-sf` 那条 0/1 交替的轨道，就是这里的 `mVsync.value`。

**3. 主线程处理帧消息**。Looper 被唤醒，`Handler::handleMessage` 调用 `Scheduler::onFrameSignal`：

```cpp
void MessageQueue::Handler::handleMessage(const Message&) {
    mFramePending.store(false);
    mQueue.onFrameSignal(mQueue.mCompositor, mVsyncId, mExpectedVsyncTime);
}
```

**4. commit 然后 composite**。`onFrameSignal` 是每一帧的骨架：

```cpp
void Scheduler::onFrameSignal(ICompositor& compositor, VsyncId vsyncId,
                              TimePoint expectedVsyncTime) {
    // ... beginFrame：计算这一帧的预期显示时间
    {
        FrameTargets targets;
        // ...
        if (!compositor.commit(pacesetterPtr->displayId, targets)) {
            // ...
            mSchedulerCallback.onCommitNotComposited(pacesetterPtr->displayId);
            return;
        }
    }
    // ...
    const auto resultsPerDisplay = compositor.composite(pacesetterPtr->displayId, targeters);
    compositor.sample();

    for (const auto& [id, targeter] : targeters) {
        const auto resultOpt = resultsPerDisplay.get(id);
        targeter->endFrame(*resultOpt);
    }
}
```

- `commit()`：处理这段时间内收到的 Transaction，锁存（latch）各个 Layer 的新 buffer，更新 Layer 状态。如果它返回 `false`，说明这一帧不需要合成，直接返回。
- `composite()`：交给 CompositionEngine 做真正的合成，决定哪些 Layer 走 HWC、哪些走 GPU，最后把结果提交给显示硬件。

两个函数开头都有 `ATRACE_NAME`，所以在 Perfetto 里，SurfaceFlinger 主线程上能看到 `commit 12345`、`composite 12345` 这样的切片，后面的数字就是这一帧的 vsyncId。第四篇会逐行展开。

把这个过程画成一条线：

```text
App 提交 buffer ──▶ scheduleFrame() 预约唤醒
                         │
          （到达 Vsync-sf 时间）
                         ▼
             vsyncCallback()  翻转 VSYNC-sf
                         │ dispatchFrame
                         ▼
        Looper 唤醒 ──▶ handleMessage()
                         ▼
                 onFrameSignal()
                   ├─ commit()     处理 Transaction、latch buffer
                   └─ composite()  HWC / GPU 合成，送显
```

## 总结

- SurfaceFlinger 是一个由 init 启动的独立 native 进程，负责把各个 Layer 合成后送到屏幕。它启动得比 Zygote 早，崩溃时会连带重启 Zygote。
- `main()` 依次完成：配置实时优先级的 Binder 线程池、构造 `SurfaceFlinger`、`init()`、注册 `SurfaceFlinger` 和 `SurfaceFlingerAIDL` 两个服务、`run()` 进入主循环。
- `init()` 依次创建 RenderEngine（GPU 合成）和 HWComposer（硬件合成），处理开机时的显示设备，创建 Scheduler，预热 shader，最后异步拉起开机动画。
- 主线程是一个基于 Looper 的消息循环。只有在有新内容时，SurfaceFlinger 才会预约下一个 Vsync；Vsync 到来后由 `Scheduler::onFrameSignal` 依次调用 `commit()` 和 `composite()` 完成一帧。

下一篇看 App 侧：Surface、Layer 和 BufferQueue 是怎么建立起来的，一块 buffer 又是怎么从 App 送到 SurfaceFlinger 的。

## 参考

- [SurfaceFlinger 和 WindowManager](https://source.android.com/docs/core/graphics/surfaceflinger-windowmanager)
- [图形架构](https://source.android.com/docs/core/graphics/architecture)
- 源码：`frameworks/native/services/surfaceflinger/main_surfaceflinger.cpp`、`SurfaceFlinger.cpp`、`Scheduler/Scheduler.cpp`、`Scheduler/MessageQueue.cpp`
