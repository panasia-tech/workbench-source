package com.erp.groupcontrol.gc

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.erp.groupcontrol.auto.XianyuIdentity
import com.erp.groupcontrol.ui.MainActivity
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * 常驻前台服务：持有 MQTT 长连接与执行器，是执行端的“心脏”。
 * 用户点启动即拉起并 START_STICKY 常驻，收指令交 [TaskExecutor]。
 */
class GcService : Service(), GcClientListener {

    private lateinit var prefs: Prefs
    private lateinit var executor: TaskExecutor
    private lateinit var primitives: PrimitiveExecutor
    // 原语串行执行:一机一时刻只跑一个原语,且不占用 MQTT 回调线程。
    // 卡死时会被 rpcGate 换掉，故为 var。
    private var rpcPool: ExecutorService = Executors.newSingleThreadExecutor()
    // 提交+限时等待原语结果的守门线程(自身不执行原语，故不会被原语卡住)
    private val rpcGate: ExecutorService = Executors.newCachedThreadPool()
    // 心跳定时器:每 5s POST HTTP 心跳,让服务端秒级判离线(比 MQTT LWT 快、且能识破进程冻结假在线)
    private var heartbeatPool: ScheduledExecutorService? = null
    // MQTT 假活检测:60s 周期看最后收帧时间，超阈值主动断开重连(绕开自动重连被 Doze/厂商冻结拖延)
    private var staleWatchdogPool: ScheduledExecutorService? = null
    private var client: GcMqttClient? = null
    private var wakeLock: PowerManager.WakeLock? = null
    // 正在执行的原语数：>0 时禁止「跳页读昵称」的破坏性导航，避免打断正在跑的任务。
    private val rpcInFlight = AtomicInteger(0)
    // 昵称补读的延迟重试(首启无障碍未绑定/闲鱼冷启动慢时 identity 会读空,靠它补)。
    private val nickRetryHandler = Handler(Looper.getMainLooper())
    // 启动引导线程：未注册(无 device_id/token)时先 enroll 再连 MQTT；停服时中断。
    @Volatile private var bootstrapThread: Thread? = null
    // 上次进程退出原因每次服务生命周期只上报一次
    private val exitInfoReported = AtomicBoolean(false)

    override fun onCreate() {
        super.onCreate()
        instance = this
        FileLogger.init(this)
        GcHealth.init(this)
        prefs = Prefs(this)
        executor = TaskExecutor(
            context = applicationContext,
            reporter = { json -> client?.report(json) },
            logger = { line -> onLog(line) },
            engineRestarter = { restartEngine() },
        )
        primitives = PrimitiveExecutor(applicationContext)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            prefs.enabled = false
            // 用户主动停止:取消看门狗 alarm、停假活检测,之后绝不自动拉起
            WatchdogReceiver.cancel(applicationContext)
            stopStaleWatchdog()
            stopClientAndSelf()
            return START_NOT_STICKY
        }
        prefs.enabled = true
        startForeground(NOTIF_ID, buildNotification("正在连接…"))
        acquireWakeLock()
        ensureEnrolledThenConnect()
        startHeartbeat()
        startStaleWatchdog()
        // 系统级看门狗:20 分钟节拍,进程被杀后由 AlarmManager 唤醒拉起(与 START_STICKY 互补)
        WatchdogReceiver.schedule(applicationContext)
        return START_STICKY
    }

    /**
     * 用户从最近任务划卡。厂商 ROM(尤其 MIUI)划卡=强杀进程,START_STICKY 常常不生效,
     * 这里自救:立即尝试 startForegroundService 自拉起;被后台启动限制拦住时,
     * 排 1 分钟后的看门狗 alarm 兜底拉起。
     * 安全边界:用户主动停过(prefs.enabled=false)绝不拉起。
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        if (!prefs.enabled) return
        onLog("检测到划卡清理，尝试自拉起…")
        runCatching { start(applicationContext) }
            .onFailure {
                onLog("即时自拉起失败(${it.message})，1 分钟后由看门狗兜底拉起")
                WatchdogReceiver.schedule(applicationContext, TASK_REMOVED_RETRY_MS)
            }
    }

    /**
     * 启动引导：MQTT 用 device_id/token 连，二者由服务端 enroll 下发。
     * - 已有身份 → 直接连(免一次网络往返)。
     * - 未注册 → 后台线程 enroll(阻塞 HTTP，不能占 onStartCommand 主线程) → 成功再连；
     *   失败退避重试(多为服务端未起/网络不通)，直到停服或拿到身份。全程 fail-soft，不崩。
     */
    private fun ensureEnrolledThenConnect() {
        if (client != null) return
        if (prefs.deviceId.isNotBlank() && prefs.deviceToken.isNotBlank()) {
            startClient()
            return
        }
        if (bootstrapThread?.isAlive == true) return
        bootstrapThread = Thread {
            var attempt = 0
            while (!Thread.currentThread().isInterrupted && client == null && prefs.enabled) {
                attempt++
                onLog("未注册，向服务端 enroll 换取设备身份(第 $attempt 次)…")
                val ok = runCatching { Enroll.ensureEnrolled(applicationContext, prefs) { onLog(it) } }
                    .getOrElse { onLog("enroll 调度异常：${it.message}"); false }
                if (ok) {
                    startClient()
                    return@Thread
                }
                val backoff = (ENROLL_RETRY_BASE_MS * attempt).coerceAtMost(ENROLL_RETRY_MAX_MS)
                try { Thread.sleep(backoff) } catch (_: InterruptedException) { return@Thread }
            }
        }.apply { isDaemon = true; name = "gc-bootstrap"; start() }
    }

    @Synchronized
    private fun startClient() {
        if (client != null) return
        client = GcMqttClient(prefs, appVersion(), this).also { it.start() }
    }

    override fun onDestroy() {
        bootstrapThread?.interrupt()
        bootstrapThread = null
        nickRetryHandler.removeCallbacksAndMessages(null)
        stopHeartbeat()
        stopStaleWatchdog()
        client?.stop()
        client = null
        releaseWakeLock()
        rpcPool.shutdownNow()
        // 注意:不取消看门狗 alarm——非 ACTION_STOP 的 onDestroy(系统回收/强杀)仍要靠它拉起;
        // ACTION_STOP 路径已在 onStartCommand 里显式取消过。
        instance = null
        super.onDestroy()
    }

    /**
     * 执行期间 App 必然在后台(闲鱼在前台)。没有 WakeLock 时 MQTT 的 keepalive 心跳会被
     * 系统的定时器合并/延迟，偶尔超过 broker 的 1.5×keepalive 容忍线 → 被 "Server sent DISCONNECT"
     * 踢掉；随后重连也因后台受限而拖延，窗口期内所有原语一律超时。
     * PARTIAL_WAKE_LOCK 只保证 CPU 不休眠(不点亮屏幕)，代价可接受——执行机本就常驻供电。
     */
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gc:mqtt").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        wakeLock = null
    }

    // ---- 心跳:每 5s HTTP 上报,服务端 15s 无心跳即判离线 ----
    private fun startHeartbeat() {
        if (heartbeatPool != null) return
        heartbeatPool = Executors.newSingleThreadScheduledExecutor().also { pool ->
            // fixedDelay 而非 fixedRate:心跳 POST 偶尔慢时不堆积,始终隔 5s 再发下一次
            pool.scheduleWithFixedDelay({
                runCatching {
                    Heartbeat.send(
                        applicationContext, prefs,
                        mqttConnected = client?.state == GcConnState.CONNECTED,
                        busy = rpcInFlight.get() > 0,
                        appVersion = appVersion(),
                    )
                }
            }, 0, Heartbeat.INTERVAL_MS, TimeUnit.MILLISECONDS)
        }
    }

    private fun stopHeartbeat() {
        heartbeatPool?.shutdownNow()
        heartbeatPool = null
    }

    // ---- MQTT 假活检测:60s 周期,最后收帧超 180s(>keepAlive 120s)判假活,主动断开重连 ----
    // HiveMQ 自动重连被 Doze/厂商冻结时可能无限拖延,心跳线程也救不了 TCP 半开,只能应用层兜底。
    private fun startStaleWatchdog() {
        if (staleWatchdogPool != null) return
        staleWatchdogPool = Executors.newSingleThreadScheduledExecutor().also { pool ->
            pool.scheduleWithFixedDelay({
                runCatching {
                    val c = client
                    if (c == null || c.state != GcConnState.CONNECTED) return@runCatching
                    val idleMs = System.currentTimeMillis() - GcMqttClient.lastFrameAtMs
                    if (idleMs > STALE_THRESHOLD_MS) {
                        onLog("MQTT 已 ${idleMs / 1000}s 无任何收帧(>keepAlive 120s)，判定假活，强制重连")
                        c.forceReconnect()
                    }
                }
            }, STALE_CHECK_INTERVAL_MS, STALE_CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS)
        }
    }

    private fun stopStaleWatchdog() {
        staleWatchdogPool?.shutdownNow()
        staleWatchdogPool = null
    }

    /** 看门狗发现 MQTT 假活时调用(同进程)。 */
    fun pokeMqttReconnect() {
        client?.forceReconnect()
    }

    /**
     * 远程 restart 指令:完整重建执行环境(等价引擎重启,不重开 App)。
     * 断 MQTT → 停心跳 → 重建原语线程池 → 重新 enroll/connect/订阅。
     * 注意不停 stale 检测/看门狗 alarm(它们是服务级,不属于「引擎」)。
     */
    private fun restartEngine() {
        onLog("收到 restart 指令，重建执行环境(MQTT/执行池/心跳)…")
        client?.stop()
        client = null
        recreateRpcPool()
        stopHeartbeat()
        startHeartbeat()
        ensureEnrolledThenConnect()
    }

    /** 系统事件上报(report 通道 kind=event)，供无障碍断链等场景调用；未连接时只落日志。 */
    fun reportEvent(event: String, detail: String? = null) {
        onLog("事件上报:$event${detail?.let { "($it)" } ?: ""}")
        client?.report(GcProtocol.eventFrame(event, detail))
    }

    /**
     * 上次进程退出原因:读 getHistoricalProcessExitReasons 落日志 + MQTT 上报一次(kind=exit_info)。
     * 死因可追溯是灰度观察保活效果的前提;同一退出时间戳只报一次(持久化在 GcHealth)。
     */
    private fun reportLastExitInfo() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        rpcGate.execute {
            runCatching {
                val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                val info = am.getHistoricalProcessExitReasons(packageName, 0, 1).firstOrNull() ?: return@runCatching
                if (info.timestamp == GcHealth.lastExitReportTs) return@runCatching // 已报过
                val reasonName = exitReasonName(info.reason)
                val desc = info.description?.takeIf { it.isNotBlank() }
                onLog("上次进程退出:$reasonName(reason=${info.reason}${desc?.let { ", $it" } ?: ""})")
                client?.report(
                    GcProtocol.exitInfoFrame(
                        reason = info.reason,
                        reasonName = reasonName,
                        importance = info.importance,
                        description = desc,
                        exitTs = info.timestamp,
                    )
                )
                GcHealth.markExitReported(info.timestamp)
            }.onFailure { onLog("读取上次退出原因失败:${it.message}") }
        }
    }

    private fun exitReasonName(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_ANR -> "ANR"
        ApplicationExitInfo.REASON_CRASH -> "CRASH"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "CRASH_NATIVE"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE_USAGE"
        ApplicationExitInfo.REASON_EXIT_SELF -> "EXIT_SELF"
        ApplicationExitInfo.REASON_FREEZER -> "FREEZER"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "INITIALIZATION_FAILURE"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
        ApplicationExitInfo.REASON_OTHER -> "OTHER"
        ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE -> "PACKAGE_STATE_CHANGE"
        ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "PACKAGE_UPDATED"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "PERMISSION_CHANGE"
        ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
        ApplicationExitInfo.REASON_UNKNOWN -> "UNKNOWN"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "USER_REQUESTED"
        ApplicationExitInfo.REASON_USER_STOPPED -> "USER_STOPPED"
        else -> "REASON_$reason"
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---- GcClientListener ----
    override fun onState(state: GcConnState, detail: String?) {
        GcBus.setState(state, detail)
        val text = when (state) {
            GcConnState.CONNECTED -> "已连接 · ${prefs.deviceId}"
            GcConnState.CONNECTING -> "连接中… ${detail ?: ""}"
            GcConnState.DISCONNECTED -> "已停止"
        }
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIF_ID, buildNotification(text))

        // 连上即补一帧 identity(昵称 + 就绪态)。刚(重)连上大概率还没在派活，
        // 若此刻无原语在跑则允许「跳页读昵称」的破坏性导航获取昵称。
        if (state == GcConnState.CONNECTED) {
            publishIdentity(allowNavigate = true)
            // 每次服务生命周期上报一次上次进程死因(灰度观察保活效果靠它)
            if (exitInfoReported.compareAndSet(false, true)) reportLastExitInfo()
        }
    }

    override fun onLog(line: String) {
        GcBus.appendLog(line)
    }

    override fun onCommand(cmd: GcCommand) {
        executor.execute(cmd)
    }

    override fun onRpc(rpc: GcRpc) {
        // 原语仍串行执行(一机一时刻只跑一个)，但必须带硬超时：
        // 单线程池里只要有一个原语卡死(如后台时截屏回调不返回)，后面所有 RPC 会永久排队，
        // 整台设备彻底失能且服务端只看到「超时」，只能人工重启 App。
        // 故由 rpcGate 提交并限时等待，超时就弃掉这条、重建执行线程，让设备自己恢复。
        rpcGate.execute {
            rpcInFlight.incrementAndGet()
            val resp = try {
                val task = rpcPool.submit<String> { primitives.handle(rpc) }
                try {
                    task.get(RPC_HARD_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                } catch (e: TimeoutException) {
                    task.cancel(true)
                    recreateRpcPool()
                    onLog("原语 ${rpc.op} 执行超时，已重置执行线程")
                    GcProtocol.rpcResp(rpc.reqId, ok = false, err = "原语执行超时(${RPC_HARD_TIMEOUT_MS}ms)，已重置执行线程")
                } catch (e: Exception) {
                    GcProtocol.rpcResp(rpc.reqId, ok = false, err = "原语调度异常:${e.message}")
                }
            } finally {
                rpcInFlight.decrementAndGet()
            }
            client?.rpcResp(resp)
            // 自检后补发 identity：服务端据此拿最新就绪态/昵称。此刻刚跑完自检、原语已归零，可安全读昵称。
            if (rpc.op == "self_check") publishIdentity(allowNavigate = true)
        }
    }

    /** 丢弃可能卡死的执行线程，换一个干净的，避免整机永久失能。 */
    @Synchronized
    private fun recreateRpcPool() {
        runCatching { rpcPool.shutdownNow() }
        rpcPool = Executors.newSingleThreadExecutor()
    }

    // ---- identity 帧（昵称 + 就绪态）----

    /**
     * 组装并上报 identity 帧到 report topic(复用 [GcMqttClient.report] 通道 / 同 QoS)。
     * 放工作线程：读昵称可能切页 + 读节点，勿在 MQTT 回调线程直接跑。fail-soft：任何异常只记日志。
     *
     * @param allowNavigate 是否允许「跳「我的」页读昵称」的破坏性路径(仅当已缓存过昵称则不再跳)。
     */
    private fun publishIdentity(allowNavigate: Boolean, nickRetryAttempt: Int = 0) {
        val c = client ?: return
        rpcGate.execute {
            val (frame, nickMissing) = runCatching { buildIdentityFrame(allowNavigate) }
                .getOrElse { onLog("组装 identity 失败：${it.message}"); return@execute }
            c.report(frame)
            // 昵称读空(首启无障碍还没绑定/闲鱼冷启动慢都会空)→ 退避重试直到读到。
            // 不重试的话读空一次就永久缺昵称:群控侧无法自动注册账号,ERP 发布会报「未在群控注册」。
            if (nickMissing && nickRetryAttempt < NICK_RETRY_MAX) {
                val delay = NICK_RETRY_BASE_MS * (nickRetryAttempt + 1)
                onLog("昵称未读到,${delay / 1000}s 后重试读昵称(第 ${nickRetryAttempt + 1} 次)")
                nickRetryHandler.postDelayed({
                    // 连接已断/换实例则放弃;重连后 onState(CONNECTED) 会从头再试
                    if (client === c) publishIdentity(allowNavigate = true, nickRetryAttempt = nickRetryAttempt + 1)
                }, delay)
            }
        }
    }

    /** @return identity 帧 to (已装闲鱼但昵称为空)。 */
    private fun buildIdentityFrame(allowNavigate: Boolean): Pair<String, Boolean> {
        val installed = Preflight.isXianyuInstalled(applicationContext)
        val cached = prefs.xianyuNick.takeIf { it.isNotBlank() }
        val nick = if (!installed) null else {
            // 只有「从未读到过昵称」且「当前无原语在跑」时，才允许破坏性跳页读取，避免打断任务；
            // 已缓存过就只做非破坏性的当前屏读取(读到才刷新)。
            val navigate = allowNavigate && cached == null && rpcInFlight.get() == 0
            val fresh = readNick(navigate)
            if (!fresh.isNullOrBlank()) {
                if (fresh != cached) prefs.xianyuNick = fresh
                fresh
            } else cached
        }
        // 会员名(tb 开头):缓存优先,没有则尽力读一次(读不到 null,ERP 档案允许员工手填)
        val cachedMember = prefs.xianyuMemberName.takeIf { it.isNotBlank() }
        val memberName = if (!installed) null else {
            val fresh = if (cachedMember == null && rpcInFlight.get() == 0) readMemberName() else null
            if (!fresh.isNullOrBlank()) {
                if (fresh != cachedMember) prefs.xianyuMemberName = fresh
                fresh
            } else cachedMember
        }
        // 设备硬件信息(SN/双IMEI/手机号):App 尽力读,读不到 null(服务端只认非空,adb 兜底补)
        val devInfo = DeviceInfo.collect(applicationContext)
        // 落地身份文件:桌面守护经 adb 直接读该机昵称(cat 外部私有目录),免服务端映射。失败不影响 identity 上报。
        runCatching {
            val idFile = java.io.File(applicationContext.getExternalFilesDir(null), "gc_identity.json")
            val idObj = com.google.gson.JsonObject().apply {
                addProperty("device_id", prefs.deviceId)      // 桌面 adb 兜底上报时按它直调 /device-info
                addProperty("nick", nick)                 // 可能为 null → JSON null
                addProperty("member_name", memberName)
                addProperty("serial", devInfo.serial)
                addProperty("imei1", devInfo.imei1)
                addProperty("imei2", devInfo.imei2)
                addProperty("phone_number", devInfo.phoneNumber)
                addProperty("model", android.os.Build.MODEL)
                addProperty("updatedAt", System.currentTimeMillis())
            }
            idFile.writeText(idObj.toString())
        }
        val pf = Preflight.toJson(Preflight.run(applicationContext, probe = false))
        val frame = GcProtocol.identityFrame(
            xianyuInstalled = installed,
            xianyuNick = nick,
            ready = pf.get("ready").asBoolean,
            blocking = pf.get("blocking").asString,
            appVersion = appVersion(),
            deviceInfo = devInfo,
            memberName = memberName,
        )
        return frame to (installed && nick == null)
    }

    /**
     * 读昵称。navigate=true 时把读取串行到 [rpcPool]，确保与原语互斥(不会同时驱动无障碍)，并限时兜底；
     * navigate=false 则直接非破坏性读当前屏。任何失败返回 null。
     */
    private fun readNick(navigate: Boolean): String? = runCatching {
        if (navigate) {
            rpcPool.submit<String?> { XianyuIdentity.readNick(applicationContext, allowNavigate = true) }
                .get(NICK_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        } else {
            XianyuIdentity.readNick(applicationContext, allowNavigate = false)
        }
    }.getOrNull()

    /** 读会员名(tb 开头):串行到 rpcPool 与原语互斥,非破坏性导航(进资料页读完返回)。失败 null。 */
    private fun readMemberName(): String? = runCatching {
        rpcPool.submit<String?> { XianyuIdentity.readMemberName(applicationContext) }
            .get(NICK_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }.getOrNull()

    // ---- 前台通知 ----
    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "群控执行端", NotificationManager.IMPORTANCE_LOW)
            ch.description = "保持与调度中心的长连接"
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val pi = android.app.PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("群控执行端")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }

    private fun stopClientAndSelf() {
        bootstrapThread?.interrupt()
        bootstrapThread = null
        nickRetryHandler.removeCallbacksAndMessages(null)
        stopHeartbeat()
        client?.stop()
        client = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun appVersion(): String =
        runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "?"

    companion object {
        const val ACTION_STOP = "com.erp.groupcontrol.STOP"

        /** 进程内服务实例(同进程的看门狗/无障碍服务经它触发强制重连与事件上报)。 */
        @Volatile
        var instance: GcService? = null
            private set

        private const val CHANNEL_ID = "gc_service"
        private const val NOTIF_ID = 1001
        // 略大于服务端 RPC 超时(15s)：让服务端先判超时，端上再兜底回收线程，
        // 避免两边同时判超时导致重复重置。
        private const val RPC_HARD_TIMEOUT_MS = 20_000L
        // enroll 退避重试：base×attempt，封顶 60s(多为服务端未起/网络不通，别高频打)。
        private const val ENROLL_RETRY_BASE_MS = 10_000L
        private const val ENROLL_RETRY_MAX_MS = 60_000L
        // 跳页读昵称的硬超时(串行在 rpcPool 上，防导航卡住拖垮 identity 上报)。
        // 须覆盖「冷启动轮询 + 点「我的」页轮询」的最坏路径(9s+6s,见 XianyuIdentity)。
        private const val NICK_READ_TIMEOUT_MS = 20_000L
        // 昵称读空时的退避重试:base×次数,最多 MAX 次(约覆盖连上后的前 14 分钟)。
        private const val NICK_RETRY_BASE_MS = 15_000L
        private const val NICK_RETRY_MAX = 10
        // MQTT 假活:60s 周期检测,最后收帧超 180s(>keepAlive 120s)判假活强制重连。
        private const val STALE_CHECK_INTERVAL_MS = 60_000L
        private const val STALE_THRESHOLD_MS = 180_000L
        // 划卡后即时自拉起失败时的兜底拉起延迟(经看门狗 alarm)。
        private const val TASK_REMOVED_RETRY_MS = 60_000L

        fun start(context: Context) {
            val i = Intent(context, GcService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(i)
            } else {
                context.startService(i)
            }
        }

        fun stop(context: Context) {
            context.startService(Intent(context, GcService::class.java).setAction(ACTION_STOP))
        }
    }
}
