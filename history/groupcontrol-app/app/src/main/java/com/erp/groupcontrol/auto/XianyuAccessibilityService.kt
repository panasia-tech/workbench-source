package com.erp.groupcontrol.auto

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityService.ScreenshotResult
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import com.erp.groupcontrol.gc.GcBus
import com.erp.groupcontrol.gc.GcHealth
import com.erp.groupcontrol.gc.GcNotifier
import com.erp.groupcontrol.gc.GcService
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 闲鱼无障碍执行器（骨架）。
 *
 * 后续上下架 / 发布 / 改价 / 发消息 / 抓小铺数据的真实自动化流程都长在这里：
 * 靠遍历闲鱼界面的 [AccessibilityNodeInfo] 找控件、[dispatchGesture] 或 performAction 模拟操作。
 *
 * 【重要发现，2026-07-07 真机验证】闲鱼**并非全 Flutter 读不到控件**：
 * - 主浏览页(首页/搜索/行情)是 Flutter → 节点读不到 → 只能截图 OCR(见 automation/ocr_tap.py)。
 * - **发布流程页面(发布编辑页、选图器)是原生的、节点可读**。uiautomator dump 拿到干净节点树,
 *   选图器每张缩略图配一个 `content-desc="选择"` 的选择框(见 [selectFirstPhotos])。
 * 所以 App 侧发布流程应**优先用节点**(比 OCR 稳),浏览页才回退 OCR。
 * 原型阶段在 automation/(ADB+uiautomator dump)已跑通,此处是移植进 App 的对应实现。
 */
class XianyuAccessibilityService : AccessibilityService() {

    /**
     * 截屏回调的派发线程。**不能用 mainExecutor**：执行期间闲鱼在前台、本 App 在后台，
     * 主线程不被调度 → TakeScreenshotCallback 迟迟不执行 → latch 空等到超时 → 重试 4 次
     * 累计 20s+ 超过服务端 RPC 的 15s 预算，表现为「screencap 超时」且拖垮整条流程。
     * 用独立线程派发回调，与主线程调度解耦。
     */
    private val shotExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        // 绑定成功 = 断链恢复:清掉「无障碍异常」标记(持久化的,见 GcHealth)
        GcHealth.init(applicationContext)
        GcHealth.onAccessibilityRestored()
        GcBus.appendLog("无障碍服务已绑定")
        Log.i(TAG, "无障碍服务已连接")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // TODO: 按 event.packageName 判断是否在闲鱼，驱动当前正在执行的任务状态机
    }

    override fun onInterrupt() {
        Log.w(TAG, "无障碍服务被中断")
        handleLinkLost("onInterrupt")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        handleLinkLost("onDestroy")
        shotExecutor.shutdownNow()
        super.onDestroy()
    }

    /**
     * 无障碍断链(被系统关闭/异常解绑)。系统限制无法代码自 rebind(一尘同样只能检测+引导),
     * 这里对齐「可观测 + 可引导恢复」:记健康档案(持久化) → 经 GcService 上报服务端一次 →
     * 发高优先通知引导用户去重开。重复断链只报第一次(fresh 去重),防 onInterrupt 轰炸。
     */
    private fun handleLinkLost(source: String) {
        GcHealth.init(applicationContext)
        val fresh = GcHealth.onAccessibilityLost(source)
        GcBus.appendLog("无障碍服务断链($source)")
        Log.w(TAG, "无障碍断链: $source")
        if (!fresh) return
        // 走现有 report 通道(kind=event);服务不在时由下次 identity 帧的 blocking 兜底带出
        GcService.instance?.reportEvent("accessibility_lost", source)
        GcNotifier.notifyA11yLost(applicationContext, "无障碍服务已断开，点击去重新开启")
    }

    // ---- 供任务流程复用的基础工具 ----

    /** 按文本在当前界面查找第一个匹配节点。 */
    fun findByText(text: String): AccessibilityNodeInfo? =
        rootInActiveWindow?.findAccessibilityNodeInfosByText(text)?.firstOrNull()

    /** 按 viewId 查找。 */
    fun findById(viewId: String): AccessibilityNodeInfo? =
        rootInActiveWindow?.findAccessibilityNodeInfosByViewId(viewId)?.firstOrNull()

    /** 点击节点（就近找可点击祖先）。 */
    fun click(node: AccessibilityNodeInfo?): Boolean {
        var n = node
        while (n != null) {
            if (n.isClickable) return n.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            n = n.parent
        }
        return false
    }

    /** 按 content-desc 收集节点（选图器缩略图无文字，只能靠 desc，如「选择」/「查看大图」）。 */
    fun findByDesc(desc: String): List<AccessibilityNodeInfo> {
        val out = ArrayList<AccessibilityNodeInfo>()
        fun walk(n: AccessibilityNodeInfo?) {
            if (n == null) return
            if (n.contentDescription?.toString() == desc) out.add(n)
            for (i in 0 until n.childCount) walk(n.getChild(i))
        }
        walk(rootInActiveWindow)
        return out
    }

    /**
     * 选图器里选最新的 [count] 张:每次点第一个 `content-desc="选择"` 的选择框
     * (已选的会从「选择」变成其它 desc,故第一个始终是当前最新未选)。
     * 对应 automation 里 tap_node_by_desc("选择", index=0) 循环。加图后闲鱼会自动生成描述。
     */
    fun selectFirstPhotos(count: Int): Int {
        var picked = 0
        repeat(count) {
            val boxes = findByDesc("选择").sortedWith(
                compareBy({ it.boundsCenterY() }, { it.boundsCenterX() })
            )
            val first = boxes.firstOrNull() ?: return picked
            if (click(first)) picked++
        }
        return picked
    }

    private fun AccessibilityNodeInfo.boundsCenterY(): Int {
        val r = Rect(); getBoundsInScreen(r); return r.centerY()
    }
    private fun AccessibilityNodeInfo.boundsCenterX(): Int {
        val r = Rect(); getBoundsInScreen(r); return r.centerX()
    }

    // ==================== V2 原语(供服务端流程引擎经 RPC 驱动)====================

    /**
     * 截屏 → JPEG 字节。用无障碍 [takeScreenshot](API 30+),免 root、免 MediaProjection 授权弹窗。
     * 同步返回(内部用 latch 等回调);调用方须在工作线程,勿在主线程调。
     * < API 30 返回 null(需 MediaProjection 兜底,TODO)。
     *
     * ⚠️ takeScreenshot 系统级频率限制(约 1 次/秒,过频返回 ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT)。
     * 故:①与上次截屏强制最小间隔 [SHOT_MIN_INTERVAL_MS];②失败退避重试 [SHOT_MAX_RETRY] 次。
     * 这是正式包(无 adb)与开发(adb screencap 无限流)最大的行为差异,必须在端上兜住。
     */
    @RequiresApi(Build.VERSION_CODES.R)
    fun screenshotJpeg(quality: Int = 60, timeoutMs: Long = 4000): ByteArray? {
        repeat(SHOT_MAX_RETRY) {
            val since = System.currentTimeMillis() - lastShotAtMs
            if (since < SHOT_MIN_INTERVAL_MS) {
                sleepQuiet(SHOT_MIN_INTERVAL_MS - since)
            }
            val bytes = takeOneShot(quality, timeoutMs)
            lastShotAtMs = System.currentTimeMillis()
            if (bytes != null) return bytes
            sleepQuiet(SHOT_RETRY_BACKOFF_MS)  // 可能撞限流,退避后再试
        }
        Log.w(TAG, "截屏连续 $SHOT_MAX_RETRY 次失败")
        return null
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun takeOneShot(quality: Int, timeoutMs: Long): ByteArray? {
        var out: ByteArray? = null
        val latch = CountDownLatch(1)
        takeScreenshot(android.view.Display.DEFAULT_DISPLAY, shotExecutor,
            object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    try {
                        val hb = result.hardwareBuffer
                        val bmp = Bitmap.wrapHardwareBuffer(hb, result.colorSpace)
                            ?.copy(Bitmap.Config.ARGB_8888, false)
                        hb.close()
                        if (bmp != null) {
                            val bos = ByteArrayOutputStream()
                            bmp.compress(Bitmap.CompressFormat.JPEG, quality, bos)
                            out = bos.toByteArray()
                            bmp.recycle()
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "截屏转码失败: ${e.message}")
                    } finally {
                        latch.countDown()
                    }
                }

                override fun onFailure(errorCode: Int) {
                    Log.w(TAG, "takeScreenshot 失败 code=$errorCode(可能频率限制)")
                    latch.countDown()
                }
            })
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        return out
    }

    private fun sleepQuiet(ms: Long) {
        if (ms <= 0) return
        try { Thread.sleep(ms) } catch (_: InterruptedException) {}
    }

    /** 点坐标(dispatchGesture 模拟真实触摸)。 */
    fun tap(x: Int, y: Int, durationMs: Long = 60): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val g = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.coerceIn(1, 3000)))
            .build()
        return dispatchGesture(g, null, null)
    }

    /**
     * 长按坐标(两笔手势:down 保持 → 持续按住后抬起)。
     * Flutter 的长按识别(聊天输入框弹「粘贴」菜单)对单笔定点长滑/长触不响应(2026-07-28 实测),
     * willContinue 拆笔是 dispatchGesture 表达「按住不动」的标准姿势。
     */
    fun longPress(x: Int, y: Int, durationMs: Long = 900): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val down = GestureDescription.StrokeDescription(path, 0, 50, /* willContinue */ true)
        val g1 = GestureDescription.Builder().addStroke(down).build()
        if (!dispatchGesture(g1, null, null)) return false
        val hold = down.continueStroke(path, 50, durationMs.coerceIn(100, 3000), false)
        val g2 = GestureDescription.Builder().addStroke(hold).build()
        return dispatchGesture(g2, null, null)
    }

    /** 滑动。 */
    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, ms: Int): Boolean {
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat()); lineTo(x2.toFloat(), y2.toFloat())
        }
        val g = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, ms.toLong().coerceIn(50, 5000)))
            .build()
        return dispatchGesture(g, null, null)
    }

    /** 把 text 写入当前聚焦的可编辑节点(中文/空格安全,取代 ADBKeyboard)。
     * 2026-07-25 修复:旧实现兜底只查 rootInActiveWindow——定价/发货方式等弹层是**独立窗口**,
     * 其中的可编辑节点够不到(表现为 set_text 返回 true 却写进空气)。现与 dumpNodes/clickNodeByDesc
     * 一致遍历所有窗口:先各窗口内找 FOCUS_INPUT,再退到任意可编辑节点(优先有可见面积的)。 */
    fun setFocusedText(text: String): Boolean {
        findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.let { return applyText(it, text) }
        val roots = LinkedHashSet<AccessibilityNodeInfo>()
        rootInActiveWindow?.let { roots.add(it) }
        for (w in windows) w.root?.let { roots.add(it) }
        // 先找各窗口内的输入焦点,再退任意可编辑节点
        for (r in roots) r.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.let {
            if (it.isEditable) return applyText(it, text)
        }
        for (r in roots) findEditable(r)?.let { return applyText(it, text) }
        return false
    }

    private fun applyText(node: AccessibilityNodeInfo, text: String): Boolean {
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun findEditable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (root.isEditable) return root
        for (i in 0 until root.childCount) {
            val r = root.getChild(i)?.let { findEditable(it) }
            if (r != null) return r
        }
        return null
    }

    /** 写系统剪贴板(Flutter 文本框的兜底输入路径:长按→粘贴。
     * 描述框是 Flutter 渲染、ACTION_SET_TEXT 不可写(2026-07-26 实测),剪贴板+粘贴是唯一可靠输入法。 */
    fun setClipboard(text: String): Boolean {
        return try {
            val cm = getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            cm.setPrimaryClip(android.content.ClipData.newPlainText("gc", text))
            true
        } catch (e: Exception) {
            false
        }
    }

    /** 全局返回 / 主页。 */
    fun globalBack(): Boolean = performGlobalAction(GLOBAL_ACTION_BACK)
    fun globalHome(): Boolean = performGlobalAction(GLOBAL_ACTION_HOME)

    /** 控件树 dump:与服务端 Transport.dump_nodes 同结构 [{desc,cls,clickable,cx,cy,w,h}]。 */
    fun dumpNodes(): List<Map<String, Any>> {
        val out = ArrayList<Map<String, Any>>()
        fun walk(n: AccessibilityNodeInfo?) {
            if (n == null) return
            val r = Rect(); n.getBoundsInScreen(r)
            if (r.width() > 0 && r.height() > 0) {
                out.add(
                    mapOf(
                        "desc" to (n.contentDescription?.toString() ?: ""),
                        "cls" to (n.className?.toString() ?: ""),
                        "clickable" to n.isClickable,
                        "cx" to r.centerX(), "cy" to r.centerY(),
                        "w" to r.width(), "h" to r.height(),
                    )
                )
            }
            for (i in 0 until n.childCount) walk(n.getChild(i))
        }
        // 遍历所有窗口:定价键盘在同窗,但发货方式弹层的键盘/数字键在独立窗口,rootInActiveWindow 取不到
        val roots = LinkedHashSet<AccessibilityNodeInfo>()
        rootInActiveWindow?.let { roots.add(it) }
        for (w in windows) w.root?.let { roots.add(it) }
        for (r in roots) walk(r)
        return out
    }

    /**
     * 对 content-desc 匹配的可点击节点执行 ACTION_CLICK(语义点击,非合成触摸)。
     * 闲鱼定价/邮费自定义数字键盘会**过滤无障碍合成触摸**(dispatchGesture 点不动数字键),
     * 但键位是 clickable 的 Button 节点,performAction(CLICK) 走 performClick() 可绕过该过滤。
     * index 用于同 desc 多节点时选第几个(按屏幕上→下、左→右排序)。返回是否点成功。
     */
    fun clickNodeByDesc(desc: String, index: Int = 0): Boolean {
        // 按 content-desc 匹配(**不限 clickable**:发货方式邮费键盘的数字键 desc 命中但节点本身不标 clickable,
        // 可点的是其祖先),命中后自身或向上找可点祖先做 ACTION_CLICK;都不行则对命中节点强点一次。
        val matches = ArrayList<AccessibilityNodeInfo>()
        fun walk(n: AccessibilityNodeInfo?) {
            if (n == null) return
            if (n.contentDescription?.toString() == desc) matches.add(n)
            for (i in 0 until n.childCount) walk(n.getChild(i))
        }
        // 遍历所有窗口:定价键盘在同窗、但发货方式弹层的键盘是独立窗口,rootInActiveWindow 取不到
        val roots = LinkedHashSet<AccessibilityNodeInfo>()
        rootInActiveWindow?.let { roots.add(it) }
        for (w in windows) w.root?.let { roots.add(it) }
        for (r in roots) walk(r)
        if (matches.size <= index) return false
        matches.sortWith(compareBy({ Rect().also { it2 -> it.getBoundsInScreen(it2) }.centerY() },
            { Rect().also { it2 -> it.getBoundsInScreen(it2) }.centerX() }))
        val node = matches[index]
        var cur: AccessibilityNodeInfo? = node
        var up = 0
        while (cur != null && up <= 3) {
            if (cur.isClickable && cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            cur = cur.parent
            up++
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    }

    /**
     * 对 content-desc==desc 的节点做 ACTION_LONG_CLICK(语义长按)。
     * 用途:Flutter 聊天输入框的「粘贴」菜单——dispatchGesture 的长按(定点长滑/长触)在 Flutter
     * 手势识别里不触发 onLongPress(2026-07-28 小米12 实测两种手势均无效),语义 LONG_CLICK 可以。
     */
    fun longClickNodeByDesc(desc: String, index: Int = 0): Boolean {
        val matches = ArrayList<AccessibilityNodeInfo>()
        fun walk(n: AccessibilityNodeInfo?) {
            if (n == null) return
            if (n.contentDescription?.toString() == desc) matches.add(n)
            for (i in 0 until n.childCount) walk(n.getChild(i))
        }
        val roots = LinkedHashSet<AccessibilityNodeInfo>()
        rootInActiveWindow?.let { roots.add(it) }
        for (w in windows) w.root?.let { roots.add(it) }
        for (r in roots) walk(r)
        if (matches.size <= index) return false
        matches.sortWith(compareBy({ Rect().also { it2 -> it.getBoundsInScreen(it2) }.centerY() },
            { Rect().also { it2 -> it.getBoundsInScreen(it2) }.centerX() }))
        val node = matches[index]
        var cur: AccessibilityNodeInfo? = node
        var up = 0
        while (cur != null && up <= 3) {
            if (cur.isLongClickable && cur.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)) return true
            cur = cur.parent
            up++
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)
    }

    /** 上次截屏时刻(ms),用于满足 takeScreenshot 频率限制。 */
    @Volatile
    private var lastShotAtMs = 0L

    companion object {
        private const val TAG = "XianyuA11y"

        // takeScreenshot 频率限制约 1/s,取 1.1s 留余量;失败退避 400ms、最多重试 4 次
        private const val SHOT_MIN_INTERVAL_MS = 1100L
        private const val SHOT_RETRY_BACKOFF_MS = 400L
        private const val SHOT_MAX_RETRY = 4

        /** 无障碍服务运行时的单例，供执行器调用；未启用时为 null。 */
        @Volatile
        var instance: XianyuAccessibilityService? = null
            private set

        fun isRunning(): Boolean = instance != null
    }
}
