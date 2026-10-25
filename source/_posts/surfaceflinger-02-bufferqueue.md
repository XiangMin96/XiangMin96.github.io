---
title: SurfaceFlinger（二）：Surface、Layer 与 BufferQueue
categories: 渲染与显示
tags:
  - SurfaceFlinger
  - BufferQueue
  - 图形系统
date: 2026-10-25 09:44:52
---


> 本文基于 AOSP android-15.0.0_r1 源码，涉及 `frameworks/native/libs/gui/`、`frameworks/native/services/surfaceflinger/` 和 `frameworks/base/` 中 ViewRootImpl、WMS 相关代码，可在 [cs.android.com](https://cs.android.com) 对照查看。文中代码均为节选，省略部分用 `// ...` 标出。

App 画好的一帧，是怎么从 App 进程交到 SurfaceFlinger 手上的？这篇沿着一块 buffer 的生命周期走一遍：窗口的 Layer 怎么创建，BufferQueue 里的 buffer 怎么在 dequeue、queue、acquire、release 之间流转，以及 BLASTBufferQueue 怎么把 buffer 装进 Transaction 提交给 SurfaceFlinger。

<!-- more -->

## 背景

[上一篇](/2026/10/24/surfaceflinger-01-architecture/)讲到，SurfaceFlinger 主线程在 Vsync 到来时依次调用 `commit()` 和 `composite()`。那 `commit()` 处理的 buffer 是从哪来的？

先认识这篇会反复出现的几个概念：

| 概念 | 所在进程 | 是什么 |
| --- | --- | --- |
| Layer | SurfaceFlinger | 一个图层，保存 buffer、位置、裁剪、透明度等状态 |
| SurfaceControl | App / system_server | 指向某个 Layer 的句柄，用来通过 Transaction 修改 Layer 的属性 |
| Surface | App | 生产者一侧的窗口，实现了 `ANativeWindow`，HWUI、EGL、Vulkan 都往它上面画 |
| BufferQueue | App（BLAST 模式下） | 管理一组 buffer 槽位，连接生产者和消费者 |
| BLASTBufferQueue | App | BufferQueue 的消费者，负责把 buffer 装进 Transaction 发给 SurfaceFlinger |
| Transaction | 跨进程 | 一批对 Layer 的修改，包括新的 buffer，一次性提交给 SurfaceFlinger |

一句话串起来：**App 往 Surface 上画，画完的 buffer 进入 BufferQueue，BLASTBufferQueue 把它取出来，放进 Transaction 交给 SurfaceFlinger 里对应的 Layer。**

### 为什么叫 BLAST

早期版本里，BufferQueue 的消费者在 SurfaceFlinger 进程里，App 是跨进程的生产者。这样有一个问题：buffer 走 BufferQueue，窗口的位置、大小这些属性走 Transaction，两条路各走各的，很难保证"新尺寸的 buffer"和"新尺寸的窗口"在同一帧生效，窗口缩放时就容易出现拉伸、闪烁。

BLAST（Buffer As LayerState）的思路是把 buffer 也当成 Layer 的一项状态。BufferQueue 搬到 App 进程里，消费者变成 App 自己的 BLASTBufferQueue，buffer 和其他属性一起放进同一个 Transaction，原子地提交。在 android-15 的源码里，WMS 创建窗口 Layer 时直接调用 `setBLASTLayer()`，App 窗口只走这一条路。

## 整体流程

一块 buffer 的完整路径：

```text
[WMS] ① 创建 SurfaceControl（setBLASTLayer）
        └─ Binder ─▶ [SF] createLayer()，创建 Layer
      relayout 把 SurfaceControl 交给 App

[App] ② ViewRootImpl 创建 BLASTBufferQueue 和 Surface

[App] ③ RenderThread
        dequeueBuffer()     FREE → DEQUEUED
        绘制
        queueBuffer()       DEQUEUED → QUEUED
        └─ 回调 onFrameAvailable

[App] ④ BLASTBufferQueue
        acquireBuffer()     QUEUED → ACQUIRED
        t.setBuffer(...).apply()
        └─ Binder ─▶ [SF] setTransactionState()，入队并预约下一帧

[SF]  ⑤ commit() 取出 Transaction，Layer 拿到新 buffer

[SF]  ⑥ 旧 buffer 不再需要
        └─ Binder ─▶ [App] onReleaseBuffer

[App] ⑦ releaseBufferCallback
        releaseBuffer()     ACQUIRED → FREE
```

下面逐段看源码。

## 源码分析

### 一、WMS 创建 SurfaceControl

App 窗口的 Layer 不是 App 自己创建的，而是由 WMS 在 relayout 时创建。代码在 `WindowSurfaceController` 的构造函数里：

```java
// frameworks/base/services/core/java/com/android/server/wm/WindowSurfaceController.java
WindowSurfaceController(String name, int format, int flags, WindowStateAnimator animator,
        int windowType) {
    // ...
    Trace.traceBegin(TRACE_TAG_WINDOW_MANAGER, "new SurfaceControl");
    mSurfaceControl = win.makeSurface()
            .setParent(win.getSurfaceControl())
            .setName(name)
            .setFormat(format)
            .setFlags(flags)
            .setMetadata(METADATA_WINDOW_TYPE, windowType)
            .setMetadata(METADATA_OWNER_UID, mWindowSession.mUid)
            .setMetadata(METADATA_OWNER_PID, mWindowSession.mPid)
            .setCallsite("WindowSurfaceController")
            .setBLASTLayer().build();

    Trace.traceEnd(TRACE_TAG_WINDOW_MANAGER);
}
```

注意两点：

- `setParent(win.getSurfaceControl())`：这个 Layer 挂在窗口 `WindowState` 自己的 Layer 下面。WMS 维护的窗口层级，在 SurfaceFlinger 里就是一棵 Layer 树。
- `setBLASTLayer()`：声明这是一个 BLAST 类型的 Layer，buffer 会通过 Transaction 提交。

`build()` 最终通过 Binder 调到 SurfaceFlinger 的 `createLayer()`：

```cpp
// services/surfaceflinger/SurfaceFlinger.cpp
status_t SurfaceFlinger::createLayer(LayerCreationArgs& args, gui::CreateSurfaceResult& outResult) {
    status_t result = NO_ERROR;
    sp<Layer> layer;

    switch (args.flags & ISurfaceComposerClient::eFXSurfaceMask) {
        case ISurfaceComposerClient::eFXSurfaceBufferQueue:
        case ISurfaceComposerClient::eFXSurfaceContainer:
        case ISurfaceComposerClient::eFXSurfaceBufferState:
            args.flags |= ISurfaceComposerClient::eNoColorFill;
            [[fallthrough]];
        case ISurfaceComposerClient::eFXSurfaceEffect: {
            result = createBufferStateLayer(args, &outResult.handle, &layer);
            // ...
        } break;
        default:
            result = BAD_VALUE;
            break;
    }
    // ...
    result = addClientLayer(args, outResult.handle, layer, parent, &outTransformHint);
    // ...
    outResult.layerId = layer->sequence;
    outResult.layerName = String16(layer->getDebugName());
    return result;
}
```

可以看到，不管是 BufferQueue、BufferState、容器还是纯色效果类型，现在都统一创建成 `BufferStateLayer`，只是用 flag 区分行为。返回给调用方的 `handle` 是一个 Binder 对象，SurfaceControl 内部持有它，之后修改这个 Layer 时就用它来指明目标。

WMS 拿到 SurfaceControl 后，通过 relayout 的返回值把它交给 App。

### 二、ViewRootImpl 创建 BLASTBufferQueue

App 侧的 `ViewRootImpl.relayoutWindow()` 调完 `mWindowSession.relayout(...)`，拿到 `mSurfaceControl` 后，调用 `updateBlastSurfaceIfNeeded()`：

```java
// frameworks/base/core/java/android/view/ViewRootImpl.java
void updateBlastSurfaceIfNeeded() {
    if (!mSurfaceControl.isValid()) {
        return;
    }

    if (mBlastBufferQueue != null && mBlastBufferQueue.isSameSurfaceControl(mSurfaceControl)) {
        mBlastBufferQueue.update(mSurfaceControl,
            mSurfaceSize.x, mSurfaceSize.y,
            mWindowAttributes.format);
        return;
    }

    // If the SurfaceControl has been updated, destroy and recreate the BBQ to reset the BQ and
    // BBQ states.
    if (mBlastBufferQueue != null) {
        mBlastBufferQueue.destroy();
    }
    mBlastBufferQueue = new BLASTBufferQueue(mTag, mSurfaceControl,
            mSurfaceSize.x, mSurfaceSize.y, mWindowAttributes.format);
    mBlastBufferQueue.setTransactionHangCallback(sTransactionHangCallback);
    Surface blastSurface;
    if (addSchandleToVriSurface()) {
        blastSurface = mBlastBufferQueue.createSurfaceWithHandle();
    } else {
        blastSurface = mBlastBufferQueue.createSurface();
    }
    // Only call transferFrom if the surface has changed to prevent inc the generation ID and
    // causing EGL resources to be recreated.
    mSurface.transferFrom(blastSurface);
}
```

逻辑很直接：

- 同一个 SurfaceControl 只是尺寸或格式变了，调用 `update()` 更新即可。
- SurfaceControl 换了，就销毁旧的 BLASTBufferQueue，重新创建。
- `createSurface()` 生成一个 Surface，再用 `transferFrom` 转移到 ViewRootImpl 一直持有的 `mSurface` 对象上。这样 `mSurface` 这个 Java 对象不变，但它背后连接的已经是新的 BufferQueue。后面 HWUI 就往这个 Surface 上画。

`createSurface()` 在 native 层创建的是 `BBQSurface`，它持有的 producer 就是 BLASTBufferQueue 内部 BufferQueue 的生产者端：

```cpp
// libs/gui/BLASTBufferQueue.cpp
sp<Surface> BLASTBufferQueue::getSurface(bool includeSurfaceControlHandle) {
    std::lock_guard _lock{mMutex};
    sp<IBinder> scHandle = nullptr;
    if (includeSurfaceControlHandle && mSurfaceControl) {
        scHandle = mSurfaceControl->getHandle();
    }
    return new BBQSurface(mProducer, true, scHandle, this);
}
```

### 三、BLASTBufferQueue 内部的 BufferQueue

看 BLASTBufferQueue 的构造函数：

```cpp
// libs/gui/BLASTBufferQueue.cpp
BLASTBufferQueue::BLASTBufferQueue(const std::string& name, bool updateDestinationFrame)
      : mSurfaceControl(nullptr),
        mSize(1, 1),
        // ...
        mUpdateDestinationFrame(updateDestinationFrame) {
    createBufferQueue(&mProducer, &mConsumer);
    // since the adapter is in the client process, set dequeue timeout
    // explicitly so that dequeueBuffer will block
    mProducer->setDequeueTimeout(std::numeric_limits<int64_t>::max());

    // safe default, most producers are expected to override this
    mProducer->setMaxDequeuedBufferCount(2);
    mBufferItemConsumer = new BLASTBufferItemConsumer(mConsumer,
                                                      GraphicBuffer::USAGE_HW_COMPOSER |
                                                              GraphicBuffer::USAGE_HW_TEXTURE,
                                                      1, false, this);
    // ...
    mBufferItemConsumer->setFrameAvailableListener(this);

    ComposerServiceAIDL::getComposerService()->getMaxAcquiredBufferCount(&mMaxAcquiredBuffers);
    mBufferItemConsumer->setMaxAcquiredBufferCount(mMaxAcquiredBuffers);
    // ...
}

void BLASTBufferQueue::createBufferQueue(sp<IGraphicBufferProducer>* outProducer,
                                         sp<IGraphicBufferConsumer>* outConsumer) {
    sp<BufferQueueCore> core(new BufferQueueCore());
    sp<IGraphicBufferProducer> producer(new BBQBufferQueueProducer(core, this));
    sp<BufferQueueConsumer> consumer(new BufferQueueConsumer(core));
    consumer->setAllowExtraAcquire(true);

    *outProducer = producer;
    *outConsumer = consumer;
}
```

几个关键点：

- **一个 Core，两个端**。`BufferQueueCore` 保存所有状态，`BBQBufferQueueProducer` 是生产者端，`BufferQueueConsumer` 是消费者端。三者都在 App 进程里，所以生产和消费之间没有 Binder 调用。
- **`setDequeueTimeout(max)`**：注释写得明白，因为在客户端进程里，要让 `dequeueBuffer` 在没有空闲 buffer 时一直阻塞等待。
- **`setMaxDequeuedBufferCount(2)`**：生产者同时最多持有 2 块 buffer。注释说这只是安全默认值，具体的生产者（比如 HWUI）通常会自己再设置。
- **usage 标志**：`USAGE_HW_COMPOSER | USAGE_HW_TEXTURE`，表示这些 buffer 要能被 HWC 直接合成，也要能被 GPU 当纹理采样，分别对应上一篇说的硬件合成和 GPU 合成两条路。
- **`setFrameAvailableListener(this)`**：生产者一提交 buffer，BLASTBufferQueue 自己就会收到 `onFrameAvailable` 回调。
- **`getMaxAcquiredBufferCount`**：向 SurfaceFlinger 询问消费者最多能同时持有几块 buffer。SurfaceFlinger 会根据最高刷新率，以及 `appWorkDuration + sfWorkDuration` 算出的显示延迟来计算：

```cpp
// services/surfaceflinger/SurfaceFlinger.cpp
int SurfaceFlinger::getMaxAcquiredBufferCountForRefreshRate(Fps refreshRate) const {
    const auto vsyncConfig =
            mScheduler->getVsyncConfiguration().getConfigsForRefreshRate(refreshRate).late;
    const auto presentLatency = vsyncConfig.appWorkDuration + vsyncConfig.sfWorkDuration;
    return calculateMaxAcquiredBufferCount(refreshRate, presentLatency);
}
```

刷新率越高、流水线越长，同时在路上的 buffer 就要越多，这也是高刷屏会多占一些图形内存的原因之一。

### 四、BufferSlot 的状态机

BufferQueue 里的每块 buffer 都放在一个槽位（slot）里，每个槽位有一个状态。`BufferSlot.h` 的注释把状态机列成了一张表：

```cpp
// libs/gui/include/gui/BufferSlot.h
//         | mShared | mDequeueCount | mQueueCount | mAcquireCount |
// --------|---------|---------------|-------------|---------------|
// FREE    |  false  |       0       |      0      |       0       |
// DEQUEUED|  false  |       1       |      0      |       0       |
// QUEUED  |  false  |       0       |      1      |       0       |
// ACQUIRED|  false  |       0       |      0      |       1       |
// SHARED  |  true   |      any      |     any     |      any      |
```

正常情况下，一块 buffer 按这个顺序循环：

```text
FREE     ── dequeueBuffer ──▶ DEQUEUED   生产者取走，开始绘制
DEQUEUED ── queueBuffer   ──▶ QUEUED     生产者画完提交
QUEUED   ── acquireBuffer ──▶ ACQUIRED   消费者取走
ACQUIRED ── releaseBuffer ──▶ FREE       消费者用完归还，进入下一轮
```

- **FREE**：空闲，归 BufferQueue 所有，等着被生产者取走。
- **DEQUEUED**：生产者正在往里画，归生产者所有。
- **QUEUED**：生产者画完了，等消费者来取。
- **ACQUIRED**：消费者持有，正在使用。
- **SHARED**：共享 buffer 模式，生产者和消费者同时使用同一块 buffer，用在低延迟场景，这里不展开。

### 五、生产者：dequeueBuffer 与 queueBuffer

HWUI 的 RenderThread 每画一帧，都会通过 `Surface` 先 dequeue 一块 buffer，画完再 queue 回去。`Surface::dequeueBuffer` 调用的是生产者端的 `dequeueBuffer`：

```cpp
// libs/gui/BufferQueueProducer.cpp
status_t BufferQueueProducer::dequeueBuffer(int* outSlot, sp<android::Fence>* outFence,
                                            uint32_t width, uint32_t height, PixelFormat format,
                                            uint64_t usage, uint64_t* outBufferAge,
                                            FrameEventHistoryDelta* outTimestamps) {
    ATRACE_CALL();
    { // Autolock scope
        std::lock_guard<std::mutex> lock(mCore->mMutex);
        // ...
        int found = BufferItem::INVALID_BUFFER_SLOT;
        while (found == BufferItem::INVALID_BUFFER_SLOT) {
            status_t status = waitForFreeSlotThenRelock(FreeSlotCaller::Dequeue, lock, &found);
            if (status != NO_ERROR) {
                return status;
            }
            // ...
        }
        // ...
        *outSlot = found;
        ATRACE_BUFFER_INDEX(found);
        // ...
        mSlots[found].mBufferState.dequeue();

        if (needsReallocation) {
            // ...
            returnFlags |= BUFFER_NEEDS_REALLOCATION;
        }
        // ...
    } // Autolock scope

    if (returnFlags & BUFFER_NEEDS_REALLOCATION) {
        // ...
        sp<GraphicBuffer> graphicBuffer = new GraphicBuffer(allocRequest);
        // ...
    }
    // ...
}
```

流程分三步：

1. **`waitForFreeSlotThenRelock`** 找一个 FREE 的槽位。如果没有空闲槽位，生产者会在这里等。前面设置了无限超时，所以会一直等到有 buffer 被归还为止。在 Perfetto 里看到 RenderThread 卡在 `dequeueBuffer` 上，通常就是这个原因：消费者那边的 buffer 还没还回来。
2. **`mBufferState.dequeue()`**：槽位状态变成 DEQUEUED。
3. **按需分配**。如果槽位里还没有 buffer，或者已有 buffer 的尺寸、格式、usage 不符合要求，就 `new GraphicBuffer` 重新分配，并在返回值里带上 `BUFFER_NEEDS_REALLOCATION`。`Surface` 看到这个标志后会再调用 `requestBuffer` 拿到新 buffer 的引用。正常运行时 buffer 会被反复复用，只有刚开始或者窗口尺寸变化时才需要分配。

画完之后，RenderThread 调用 `queueBuffer`：

```cpp
// libs/gui/BufferQueueProducer.cpp
status_t BufferQueueProducer::queueBuffer(int slot,
        const QueueBufferInput &input, QueueBufferOutput *output) {
    ATRACE_CALL();
    ATRACE_BUFFER_INDEX(slot);
    // ...
        mSlots[slot].mFence = acquireFence;
        mSlots[slot].mBufferState.queue();

        // Increment the frame counter and store a local version of it
        // for use outside the lock on mCore->mMutex.
        ++mCore->mFrameCounter;
        currentFrameNumber = mCore->mFrameCounter;
        mSlots[slot].mFrameNumber = currentFrameNumber;
    // ...
    // Call back without the main BufferQueue lock held, but with the callback
    // lock held so we can ensure that callbacks occur in order
    {
        // ...
        if (frameAvailableListener != nullptr) {
            frameAvailableListener->onFrameAvailable(item);
        } else if (frameReplacedListener != nullptr) {
            frameReplacedListener->onFrameReplaced(item);
        }
        // ...
    }
    // ...
}
```

- 槽位状态变成 QUEUED，帧号 `mFrameCounter` 加一。
- **`acquireFence`**：GPU 绘制是异步的。`queueBuffer` 返回时 GPU 可能还没画完，所以 buffer 会附带一个 fence，等 GPU 真正画完时 fence 才会 signal。消费者在读取 buffer 内容之前必须等这个 fence。
- 最后在不持有 BufferQueue 主锁的情况下回调 `onFrameAvailable`，这里的 listener 就是 BLASTBufferQueue。

### 六、消费者：BLASTBufferQueue 把 buffer 装进 Transaction

`onFrameAvailable` 去掉同步（sync）相关的分支后，主干很简单：

```cpp
// libs/gui/BLASTBufferQueue.cpp
void BLASTBufferQueue::onFrameAvailable(const BufferItem& item) {
    // ...
    {
        UNIQUE_LOCK_WITH_ASSERTION(mMutex);
        BBQ_TRACE();
        bool waitForTransactionCallback = !mSyncedFrameNumbers.empty();
        // ... sync transaction 相关处理

        // add to shadow queue
        mNumFrameAvailable++;
        // ...
        ATRACE_INT(mQueuedBufferTrace.c_str(),
                   mNumFrameAvailable + mNumAcquired - mPendingRelease.size());

        if (syncTransactionSet) {
            // ...
        } else if (!waitForTransactionCallback) {
            acquireNextBufferLocked(std::nullopt);
        }
    }
    // ...
}
```

`mQueuedBufferTrace` 的名字是 `"QueuedBuffer - " + mName + "BLAST#" + id`。在 Perfetto 里，App 进程下能看到一条 `QueuedBuffer - ...` 计数器轨道，值是 `mNumFrameAvailable + mNumAcquired - mPendingRelease.size()`，也就是"生产者已经 queue、但 SurfaceFlinger 还没释放"的 buffer 数量。看卡顿时，这条轨道能直接看出 buffer 是不是堆积了。

真正干活的是 `acquireNextBufferLocked`：

```cpp
// libs/gui/BLASTBufferQueue.cpp
status_t BLASTBufferQueue::acquireNextBufferLocked(
        const std::optional<SurfaceComposerClient::Transaction*> transaction) {
    if (mNumFrameAvailable == 0) {
        return BufferQueue::NO_BUFFER_AVAILABLE;
    }

    if (mNumAcquired >= (mMaxAcquiredBuffers + 2)) {
        return BufferQueue::NO_BUFFER_AVAILABLE;
    }
    // ...
    SurfaceComposerClient::Transaction localTransaction;
    bool applyTransaction = true;
    SurfaceComposerClient::Transaction* t = &localTransaction;
    // ...
    BufferItem bufferItem;
    status_t status =
            mBufferItemConsumer->acquireBuffer(&bufferItem, 0 /* expectedPresent */, false);
    // ...
    auto buffer = bufferItem.mGraphicBuffer;
    mNumFrameAvailable--;
    // ...
    mNumAcquired++;
    mLastAcquiredFrameNumber = bufferItem.mFrameNumber;
    ReleaseCallbackId releaseCallbackId(buffer->getId(), mLastAcquiredFrameNumber);
    mSubmitted[releaseCallbackId] = bufferItem;
    // ...
    auto releaseBufferCallback =
            std::bind(releaseBufferCallbackThunk, wp<BLASTBufferQueue>(this) /* callbackContext */,
                      std::placeholders::_1, std::placeholders::_2, std::placeholders::_3);
    sp<Fence> fence = bufferItem.mFence ? new Fence(bufferItem.mFence->dup()) : Fence::NO_FENCE;
    // ...
    t->setBuffer(mSurfaceControl, buffer, fence, bufferItem.mFrameNumber, mProducerId,
                 releaseBufferCallback, dequeueTime);
    t->setDataspace(mSurfaceControl, static_cast<ui::Dataspace>(bufferItem.mDataSpace));
    t->setHdrMetadata(mSurfaceControl, bufferItem.mHdrMetadata);
    t->setSurfaceDamageRegion(mSurfaceControl, bufferItem.mSurfaceDamage);
    t->addTransactionCompletedCallback(transactionCallbackThunk, static_cast<void*>(this));
    // ...
    t->setBufferCrop(mSurfaceControl, crop);
    t->setTransform(mSurfaceControl, bufferItem.mTransform);
    // ...
    if (!mPendingFrameTimelines.empty() &&
        mPendingFrameTimelines.front().first == bufferItem.mFrameNumber) {
        t->setFrameTimelineInfo(mPendingFrameTimelines.front().second);
        mPendingFrameTimelines.pop();
    }

    mergePendingTransactions(t, bufferItem.mFrameNumber);
    if (applyTransaction) {
        // All transactions on our apply token are one-way. See comment on mAppliedLastTransaction
        t->setApplyToken(mApplyToken).apply(false, true);
        // ...
    }
    // ...
    return OK;
}
```

按顺序看：

1. **两个前置检查**。没有待取的帧就返回；已经持有的 buffer 数达到 `mMaxAcquiredBuffers + 2` 也返回，防止 App 一股脑把 buffer 全塞给 SurfaceFlinger。
2. **`acquireBuffer`**：从 BufferQueue 取出最早 queue 进来的那块 buffer，槽位状态变成 ACQUIRED。
3. **记账**。`mSubmitted` 用 buffer id 加帧号作为 key，记住这块 buffer。等 SurfaceFlinger 归还时，用同样的 key 找回它。
4. **装进 Transaction**。`setBuffer` 把 buffer、acquireFence、帧号和 **releaseBufferCallback** 一起放进去。同时带上 dataspace、HDR 元数据、脏区、裁剪、旋转等属性。这正是 BLAST 的意义：buffer 和它的属性在同一个 Transaction 里。
5. **`setFrameTimelineInfo`**：把这一帧对应的 vsyncId 等信息带给 SurfaceFlinger。SurfaceFlinger 的 FrameTimeline 靠它把 App 的帧和 SurfaceFlinger 的合成对应起来，Perfetto 里的 Expected Timeline 和 Actual Timeline 就是这么来的。
6. **`apply(false, true)`**：两个参数分别是 `synchronous` 和 `oneWay`。这里是异步加 one-way，App 发出 Transaction 后不用等 SurfaceFlinger 处理完就能返回。

### 七、SurfaceFlinger 接收 Transaction

`apply()` 通过 Binder 调到 SurfaceFlinger 的 `setTransactionState`：

```cpp
// services/surfaceflinger/SurfaceFlinger.cpp
status_t SurfaceFlinger::setTransactionState(
        const FrameTimelineInfo& frameTimelineInfo, Vector<ComposerState>& states,
        const Vector<DisplayState>& displays, uint32_t flags, const sp<IBinder>& applyToken,
        /* ... */) {
    ATRACE_CALL();

    IPCThreadState* ipc = IPCThreadState::self();
    const int originPid = ipc->getCallingPid();
    const int originUid = ipc->getCallingUid();
    uint32_t permissions = LayerStatePermissions::getTransactionPermissions(originPid, originUid);
    for (auto& composerState : states) {
        composerState.state.sanitize(permissions);
    }
    // ...
    {
        // Transactions are added via a lockless queue and does not need to be added from the main
        // thread.
        ftl::FakeGuard guard(kMainThreadContext);
        mTransactionHandler.queueTransaction(std::move(state));
    }
    // ...
    setTransactionFlags(eTransactionFlushNeeded, schedule, applyToken, frameHint);
    return NO_ERROR;
}
```

这个函数跑在 SurfaceFlinger 的 Binder 线程上，只做三件事：

1. **权限过滤**。根据调用方的 pid、uid 计算权限，`sanitize` 会清掉调用方无权设置的字段，比如只允许系统进程设置的特权属性。
2. **入队**。Transaction 放进一个无锁队列，不需要等主线程。
3. **预约下一帧**。`setTransactionFlags` 会调用 `scheduleCommit`，最终调到上一篇讲过的 `scheduleFrame()`：

```cpp
void SurfaceFlinger::scheduleCommit(FrameHint hint) {
    if (hint == FrameHint::kActive) {
        mScheduler->resetIdleTimer();
    }
    mPowerAdvisor->notifyDisplayUpdateImminentAndCpuReset();
    mScheduler->scheduleFrame();
}
```

这就和第一篇接上了：**App 提交 Transaction，SurfaceFlinger 预约下一个 Vsync-sf；Vsync 到来后，在 `commit()` 里统一处理这段时间攒下的所有 Transaction**。处理的位置在 `updateLayerSnapshots()`：

```cpp
// services/surfaceflinger/SurfaceFlinger.cpp
    if (flushTransactions) {
        ATRACE_NAME("TransactionHandler:flushTransactions");
        // ...
        mTransactionHandler.collectTransactions();
        {
            std::scoped_lock<std::mutex> lock(mCreatedLayersLock);
            // ... 取出新创建的 Layer
        }

        mLayerLifecycleManager.addLayers(std::move(update.newLayers));
        update.transactions = mTransactionHandler.flushTransactions();
        // ...
        mLayerLifecycleManager.applyTransactions(update.transactions);
        // ...
    }
```

注释里提到了一个顺序要求：必须先加入新创建的 Layer，再应用 Transaction，因为 Transaction 修改的可能正是一个刚创建的 Layer。`flushTransactions()` 还会检查每个 Transaction 是否就绪，比如期望的显示时间到了没有、buffer 的 acquireFence 是否已经 signal，没就绪的会留到后面的帧。这部分放到第六篇 Transaction 机制里细讲。

### 八、buffer 的归还

SurfaceFlinger 用完一块 buffer 后，要通知 App 把它放回 FREE 状态，否则生产者很快就会在 `dequeueBuffer` 里等不到空闲 buffer。

通知是通过 `setBuffer` 时传进去的 releaseBufferCallback 完成的。SurfaceFlinger 侧调用的是 `Layer::callReleaseBufferCallback`：

```cpp
// services/surfaceflinger/Layer.cpp
void Layer::callReleaseBufferCallback(const sp<ITransactionCompletedListener>& listener,
                                      const sp<GraphicBuffer>& buffer, uint64_t framenumber,
                                      const sp<Fence>& releaseFence) {
    if (!listener) {
        return;
    }
    ATRACE_FORMAT_INSTANT("callReleaseBufferCallback %s - %" PRIu64, getDebugName(), framenumber);
    uint32_t currentMaxAcquiredBufferCount =
            mFlinger->getMaxAcquiredBufferCountForCurrentRefreshRate(mOwnerUid);
    listener->onReleaseBuffer({buffer->getId(), framenumber},
                              releaseFence ? releaseFence : Fence::NO_FENCE,
                              currentMaxAcquiredBufferCount);
}
```

它带回三样东西：buffer id 加帧号（对应 App 侧 `mSubmitted` 的 key）、**releaseFence**，以及当前刷新率下的最大可持有 buffer 数。

releaseFence 和前面的 acquireFence 方向相反：SurfaceFlinger 发出释放通知时，显示硬件可能还在读这块 buffer，releaseFence 要等硬件真正读完才会 signal。生产者下次 dequeue 到这块 buffer 后，必须等这个 fence 才能往里写。

什么时候会触发释放？一个典型场景在 `Layer::releasePreviousBuffer` 里：上一块 buffer 还没被合成显示，新的 buffer 就来了，旧的那块会被直接丢弃并释放：

```cpp
// services/surfaceflinger/Layer.cpp
void Layer::releasePreviousBuffer() {
    mReleasePreviousBuffer = true;
    if (!mBufferInfo.mBuffer ||
        (!mDrawingState.buffer->hasSameBuffer(*mBufferInfo.mBuffer) ||
         mDrawingState.frameNumber != mBufferInfo.mFrameNumber)) {
        // If mDrawingState has a buffer, and we are about to update again
        // before swapping to drawing state, then the first buffer will be
        // dropped and we should decrement the pending buffer count and
        // call any release buffer callbacks if set.
        callReleaseBufferCallback(mDrawingState.releaseBufferListener,
                                  mDrawingState.buffer->getBuffer(), mDrawingState.frameNumber,
                                  mDrawingState.acquireFence);
        decrementPendingBufferCount();
        // ... 把这一帧记为被丢弃
    }
    // ...
}
```

正常显示过的 buffer，则是在它被下一块 buffer 取代、显示硬件不再需要它之后释放。不管哪种情况，最后走的都是同一个回调。

App 侧收到回调后进入 `releaseBufferCallbackLocked`：

```cpp
// libs/gui/BLASTBufferQueue.cpp
void BLASTBufferQueue::releaseBufferCallbackLocked(
        const ReleaseCallbackId& id, const sp<Fence>& releaseFence,
        std::optional<uint32_t> currentMaxAcquiredBufferCount, bool fakeRelease) {
    ATRACE_CALL();
    // Calculate how many buffers we need to hold before we release them back
    // to the buffer queue. This will prevent higher latency when we are running
    // on a lower refresh rate than the max supported. We only do that for EGL
    // clients as others don't care about latency
    const auto it = mSubmitted.find(id);
    const bool isEGL = it != mSubmitted.end() && it->second.mApi == NATIVE_WINDOW_API_EGL;

    if (currentMaxAcquiredBufferCount) {
        mCurrentMaxAcquiredBufferCount = *currentMaxAcquiredBufferCount;
    }

    const uint32_t numPendingBuffersToHold =
            isEGL ? std::max(0, mMaxAcquiredBuffers - (int32_t)mCurrentMaxAcquiredBufferCount) : 0;

    auto rb = ReleasedBuffer{id, releaseFence};
    if (std::find(mPendingRelease.begin(), mPendingRelease.end(), rb) == mPendingRelease.end()) {
        mPendingRelease.emplace_back(rb);
        // ...
    }

    // Release all buffers that are beyond the ones that we need to hold
    while (mPendingRelease.size() > numPendingBuffersToHold) {
        const auto releasedBuffer = mPendingRelease.front();
        mPendingRelease.pop_front();
        releaseBuffer(releasedBuffer.callbackId, releasedBuffer.releaseFence);
        // ...
        if (mSyncedFrameNumbers.empty()) {
            acquireNextBufferLocked(std::nullopt);
        }
    }

    ATRACE_INT("PendingRelease", mPendingRelease.size());
    // ...
    mCallbackCV.notify_all();
}

void BLASTBufferQueue::releaseBuffer(const ReleaseCallbackId& callbackId,
                                     const sp<Fence>& releaseFence) {
    auto it = mSubmitted.find(callbackId);
    // ...
    mNumAcquired--;
    mBufferItemConsumer->releaseBuffer(it->second, releaseFence);
    mSubmitted.erase(it);
    // ...
}
```

这里有一个不太直观的细节：**收到释放通知后，buffer 不一定马上还给 BufferQueue**。

`mMaxAcquiredBuffers` 是 BLASTBufferQueue 创建时按设备**最高**刷新率算出来的。如果当前跑在较低的刷新率上，SurfaceFlinger 回传的 `currentMaxAcquiredBufferCount` 会更小，两者的差值就是 `numPendingBuffersToHold`。对于 EGL 生产者，BLASTBufferQueue 会先扣下这么多块 buffer 不还。源码注释说明了目的：防止在低刷新率下 buffer 太多、流水线变长，导致延迟变高。

真正归还时，`releaseBuffer` 调用消费者端的 `releaseBuffer`，槽位状态回到 FREE，阻塞在 `dequeueBuffer` 里的生产者就能继续了。归还后还会顺手调用 `acquireNextBufferLocked`，如果有之前因为数量限制没能提交的帧，就趁这个机会提交。

## 总结

- App 窗口的 Layer 由 WMS 通过 `setBLASTLayer()` 创建，SurfaceFlinger 里统一是 `BufferStateLayer`；SurfaceControl 通过 relayout 交给 App。
- ViewRootImpl 拿到 SurfaceControl 后创建 BLASTBufferQueue，生成 Surface 给 HWUI 绘制。BufferQueue 的生产者和消费者都在 App 进程里。
- 一块 buffer 在槽位里按 FREE → DEQUEUED → QUEUED → ACQUIRED → FREE 循环。生产者在 `dequeueBuffer` 阻塞，往往说明 buffer 还没被 SurfaceFlinger 归还。
- BLASTBufferQueue 收到 `onFrameAvailable` 后 acquire buffer，把 buffer、acquireFence、属性和 releaseBufferCallback 一起放进 Transaction，one-way 提交给 SurfaceFlinger。
- SurfaceFlinger 在 Binder 线程上过滤权限、入队、预约下一帧，在 `commit()` 里统一应用；用完的 buffer 通过 releaseBufferCallback 带着 releaseFence 归还给 App。
- 两个 fence 方向相反：acquireFence 表示"生产者画完了"，releaseFence 表示"显示硬件读完了"。

下一篇看 Vsync：硬件 Vsync 怎么变成软件模型，又怎么分成 Vsync-app 和 Vsync-sf 两路，分别去唤醒 App 和 SurfaceFlinger。

## 参考

- [BufferQueue 和 Gralloc](https://source.android.com/docs/core/graphics/arch-bq-gralloc)
- [SurfaceFlinger 和 WindowManager](https://source.android.com/docs/core/graphics/surfaceflinger-windowmanager)
- 源码：`libs/gui/BLASTBufferQueue.cpp`、`libs/gui/BufferQueueProducer.cpp`、`libs/gui/include/gui/BufferSlot.h`、`services/surfaceflinger/SurfaceFlinger.cpp`、`services/surfaceflinger/Layer.cpp`、`core/java/android/view/ViewRootImpl.java`、`services/core/java/com/android/server/wm/WindowSurfaceController.java`
