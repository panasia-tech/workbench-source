package com.erp.groupcontrol.gc

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.erp.groupcontrol.auto.XianyuAccessibilityService
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.util.Locale

/**
 * 执行机环境自检。
 *
 * 【为什么需要】2026-07-21 真机验证踩到的坑全是「表面正常、实则失能」，光看设备 ONLINE 完全看不出来：
 * - 无障碍：`settings put` 改了开关值、`dumpsys` 也显示 bound，但服务实例是 null，
 *   所有依赖它的原语静默全废(截图返回 0 字节)。**权限位对 ≠ 能力可用**，所以必须实测。
 * - MIUI 省电策略未设「无限制」：App 退到后台再被要求拉起闲鱼就会被冻结，
 *   之后连不依赖无障碍的 screen_size 都超时，且**冻死后无法自愈**(端上看门线程一起被冻)。
 * - MQTT 重连丢凭据(已修)：断一次就永久 NOT_AUTHORIZED。
 *
 * 【分三类】
 * 1. 权限位——能用标准 API 读；
 * 2. 能力实测——真跑一次(截屏/读节点)，这是唯一能戳穿「权限对但功能废」的手段；
 * 3. 读不到的——MIUI 自启动/省电策略没有公开 API(powerkeeper provider 需系统权限)，
 *    只能靠「意外断连次数」间接暴露，并提供跳转让人工确认。
 */
object Preflight {

    /** ok=null 表示「测不了，需人工确认」，不是失败。 */
    data class Item(
        val key: String,
        val label: String,
        val ok: Boolean?,
        val detail: String,
        val fix: String? = null,
        val action: Action? = null,
    )

    enum class Action { ACCESSIBILITY, BATTERY_OPT, OVERLAY, NOTIFICATION, AUTOSTART, APP_DETAIL }

    /**
     * @param probe 是否做能力实测(截屏/读节点)。实测约耗时 1~2s 且受截屏最小间隔限制，
     *              UI 手动点自检时开，高频调用时可关。
     */
    fun run(ctx: Context, probe: Boolean = true): List<Item> {
        val items = mutableListOf<Item>()

        // ---- 1. 无障碍：先看开关，再看实例，最后实测能力 ----
        val enabledInSettings = isAccessibilityEnabledInSettings(ctx)
        val svc = XianyuAccessibilityService.instance
        items += Item(
            key = "accessibility",
            label = "无障碍服务",
            ok = svc != null,
            detail = when {
                svc != null -> "已绑定，可执行原语"
                enabledInSettings -> "开关已开但服务未绑定——需在无障碍设置里【先关再开】"
                else -> "未开启"
            },
            fix = if (svc == null) "设置→无障碍→群控闲鱼执行器；已开着也要先关再开才会真正绑定" else null,
            action = if (svc == null) Action.ACCESSIBILITY else null,
        )

        // ---- 2. 能力实测：权限位骗得了人，这个骗不了 ----
        if (probe) {
            items += probeScreenshot(svc)
            items += probeNodes(svc)
            items += probeBackgroundStart(svc)
        }

        // ---- 2b. 闲鱼是否安装：没装闲鱼这台设备什么也干不了(identity 帧/派发前置)----
        val xyInstalled = isXianyuInstalled(ctx)
        items += Item(
            key = "xianyu_installed",
            label = "闲鱼已安装",
            ok = xyInstalled,
            detail = if (xyInstalled) "已安装 ${TaskExecutor.XIANYU_PKG}"
            else "未检测到闲鱼(${TaskExecutor.XIANYU_PKG})",
            fix = if (!xyInstalled) "在本机安装闲鱼并登录目标账号" else null,
        )

        // ---- 3. 电池优化白名单 ----
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        val ignoringBatt = pm.isIgnoringBatteryOptimizations(ctx.packageName)
        items += Item(
            key = "battery_opt",
            label = "电池优化白名单",
            ok = ignoringBatt,
            detail = if (ignoringBatt) "已忽略电池优化" else "未加入白名单，后台可能被限制",
            fix = if (!ignoringBatt) "允许「后台无限制运行」" else null,
            action = if (!ignoringBatt) Action.BATTERY_OPT else null,
        )

        // ---- 4. 悬浮窗：原语悬浮提示用。⚠️ 它**不代表**「后台弹出界面」——
        //    MIUI 把后台拉起 Activity 做成独立开关(权限管理→其他权限→后台弹出界面),
        //    悬浮窗已授权照样被拦(2026-08-01 实测:此 ok=true 但 launch_app 静默失败),
        //    后台拉起能力以 probe_bg_start 实测项为准 ----
        val overlay = Settings.canDrawOverlays(ctx)
        items += Item(
            key = "overlay",
            label = "悬浮窗权限",
            ok = overlay,
            detail = if (overlay) "已授权" else "未授权",
            fix = if (!overlay) "允许「显示在其他应用上层」" else null,
            action = if (!overlay) Action.OVERLAY else null,
        )

        // ---- 5. 通知权限：前台服务通知被禁会削弱保活 ----
        val notif = NotificationManagerCompat.from(ctx).areNotificationsEnabled()
        items += Item(
            key = "notification",
            label = "通知权限",
            ok = notif,
            detail = if (notif) "已允许(前台服务通知可见)" else "被禁用，前台服务保活会变弱",
            fix = if (!notif) "允许通知" else null,
            action = if (!notif) Action.NOTIFICATION else null,
        )

        // ---- 6. MQTT 连接 ----
        val connected = GcBus.state.value == GcConnState.CONNECTED
        items += Item(
            key = "mqtt",
            label = "MQTT 连接",
            ok = connected,
            detail = if (connected) "已连接调度中心" else "未连接：${GcBus.detail.value ?: "未启动"}",
        )

        // ---- 7. 后台保活：MIUI 自启动/省电策略读不到，用意外断连数间接暴露 ----
        val drops = GcHealth.unexpectedDisconnects
        items += Item(
            key = "keepalive",
            label = "后台保活(自启动/省电策略)",
            // 没有公开 API 可读 → 永远 null，靠断连数给线索，最终仍需人工确认
            ok = null,
            detail = if (drops == 0)
                "暂无意外断连记录（正常）；自启动/省电策略系统读不到，请人工确认"
            else
                "累计意外断连 $drops 次${GcHealth.lastDropReason?.let { "，最近：$it" } ?: ""}——频繁断连多半是省电策略没设「无限制」",
            fix = "点此项尝试直达本机自启动设置页【允许】；再进应用详情把省电策略设【无限制】；最近任务里【锁定】卡片并关闭省电模式",
            action = Action.AUTOSTART,
        )

        return items
    }

    /** 真截一张图。权限位全对但拿到 0 字节，正是无障碍未真正绑定的典型症状。 */
    private fun probeScreenshot(svc: XianyuAccessibilityService?): Item {
        if (svc == null) {
            return Item("probe_shot", "截屏能力（实测）", false, "无障碍未绑定，跳过实测")
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return Item("probe_shot", "截屏能力（实测）", null, "系统低于 Android 11，不支持无障碍截屏")
        }
        val t0 = System.currentTimeMillis()
        val bytes = runCatching { svc.screenshotJpeg(quality = 40) }.getOrNull()
        val ms = System.currentTimeMillis() - t0
        val n = bytes?.size ?: 0
        return Item(
            key = "probe_shot",
            label = "截屏能力（实测）",
            ok = n > 0,
            detail = if (n > 0) "成功 ${n / 1024}KB / ${ms}ms" else "失败（${ms}ms）——截图返回空，原语会全线超时",
            fix = if (n <= 0) "无障碍设置里先关再开；确认省电策略为「无限制」" else null,
            action = if (n <= 0) Action.ACCESSIBILITY else null,
        )
    }

    private fun probeNodes(svc: XianyuAccessibilityService?): Item {
        if (svc == null) {
            return Item("probe_nodes", "控件树读取（实测）", false, "无障碍未绑定，跳过实测")
        }
        val n = runCatching { svc.dumpNodes().size }.getOrDefault(0)
        return Item(
            key = "probe_nodes",
            label = "控件树读取（实测）",
            ok = n > 0,
            detail = if (n > 0) "读到 $n 个节点" else "读到 0 个节点（当前页可能无可读控件，或无障碍未真正生效）",
        )
    }

    /**
     * 实测「后台弹出界面」：经无障碍服务实例 context(与 XianyuIdentity.launchApp 同款绕法)
     * 拉起透明探针 Activity,2s 内没到前台 = MIUI 拦截后台启动——launch_app 拉起闲鱼会静默失败
     * (任务报「闲鱼首页不可见」)。这个 MIUI 开关无任何权限位可读(canDrawOverlays 覆盖不到),只能实测。
     * 会短暂把透明探针页切到前台(立即 finish),只随自检跑,勿在任务执行中调用。
     */
    private fun probeBackgroundStart(svc: XianyuAccessibilityService?): Item {
        if (svc == null) {
            return Item("probe_bg_start", "后台弹出界面（实测）", false, "无障碍未绑定，跳过实测")
        }
        BackgroundStartProbeActivity.lastForegroundAt = 0
        val t0 = System.currentTimeMillis()
        runCatching {
            val i = Intent(svc, BackgroundStartProbeActivity::class.java)
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            svc.startActivity(i)
        }
        var ok = false
        while (System.currentTimeMillis() - t0 < 2000) {
            if (BackgroundStartProbeActivity.lastForegroundAt >= t0) { ok = true; break }
            Thread.sleep(150)
        }
        return Item(
            key = "probe_bg_start",
            label = "后台弹出界面（实测）",
            ok = ok,
            detail = if (ok) "可从后台拉起 Activity"
            else "被 MIUI 拦截——后台拉起闲鱼会静默失败（任务报「闲鱼首页不可见」）",
            fix = if (!ok) "设置→应用管理→本应用→权限管理→其他权限→后台弹出界面【始终允许】" else null,
            action = if (!ok) Action.APP_DETAIL else null,
        )
    }

    /**
     * 闲鱼是否安装。包名取 [TaskExecutor.XIANYU_PKG] 单一真源(com.taobao.idlefish)，
     * 与 AndroidManifest 的 <queries> 一致(否则 Android 11+ 因包不可见误判未装)。
     * 供自检项与 identity 帧复用。
     */
    fun isXianyuInstalled(ctx: Context): Boolean =
        runCatching {
            ctx.packageManager.getPackageInfo(TaskExecutor.XIANYU_PKG, 0); true
        }.getOrDefault(false)

    private fun isAccessibilityEnabledInSettings(ctx: Context): Boolean {
        val s = Settings.Secure.getString(
            ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return s.contains(ctx.packageName)
    }

    /** 供 self_check 原语回传给服务端：调度器据此判断设备是否真的可派发。 */
    fun toJson(items: List<Item>): JsonObject {
        val arr = JsonArray()
        items.forEach {
            arr.add(JsonObject().apply {
                addProperty("key", it.key)
                addProperty("label", it.label)
                if (it.ok == null) add("ok", null) else addProperty("ok", it.ok)
                addProperty("detail", it.detail)
            })
        }
        val obj = JsonObject()
        obj.add("items", arr)
        // ready：所有「能判定」的项都通过。ok=null(读不到的)不参与判定，否则永远 not ready。
        obj.addProperty("ready", items.none { it.ok == false })
        obj.addProperty("blocking", items.filter { it.ok == false }.joinToString(",") { it.key })
        obj.addProperty("unexpected_disconnects", GcHealth.unexpectedDisconnects)
        // 顶层便捷字段：服务端派发前直接读，与 identity 帧同名同义。
        obj.addProperty("xianyu_installed", items.firstOrNull { it.key == "xianyu_installed" }?.ok ?: false)
        return obj
    }

    /**
     * 打开各检查项对应的修复页：按优先级逐候选尝试，全失败返回 false(调用方记日志)。
     * BATTERY_OPT 直达系统授权框(免在列表里找应用)；AUTOSTART 按厂商跳已知自启动设置页，
     * 均不可用时统一落到应用详情页。
     */
    fun openFix(ctx: Context, action: Action): Boolean {
        for (intent in candidatesFor(ctx, action)) {
            try {
                ctx.startActivity(intent)
                return true
            } catch (_: Exception) {
            }
        }
        return false
    }

    /** 各检查项的修复页候选(按优先级排序)。 */
    private fun candidatesFor(ctx: Context, action: Action): List<Intent> = when (action) {
        Action.ACCESSIBILITY -> listOf(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        // 直接弹系统授权框(需 manifest 声明 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)；
        // 老 ROM/厂商阉割该页时回退白名单列表页 → 应用详情页
        Action.BATTERY_OPT -> listOf(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")),
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            appDetailIntent(ctx),
        )
        Action.OVERLAY -> listOf(
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}"))
        )
        Action.NOTIFICATION -> listOf(
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
        )
        // 厂商自启动设置页逐个尝试，全失败落应用详情页
        Action.AUTOSTART -> autostartIntents() + appDetailIntent(ctx)
        Action.APP_DETAIL -> listOf(appDetailIntent(ctx))
    }

    private fun appDetailIntent(ctx: Context) = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")
    )

    /**
     * 按 Build.MANUFACTURER 返回已知自启动设置页 intent(小米/红米、华为、荣耀、OPPO 系、vivo 系、三星)。
     * 这些页面没有公开 API/标准 action，全是厂商私有组件，只能靠已知清单逐个 try；
     * 不认识的厂商返回空，由调用方落应用详情页兜底。
     */
    private fun autostartIntents(): List<Intent> {
        val m = Build.MANUFACTURER.lowercase(Locale.ROOT)
        fun cmp(pkgName: String, cls: String) = Intent().setComponent(ComponentName(pkgName, cls))
        return when {
            m.contains("xiaomi") || m.contains("redmi") -> listOf(
                cmp("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            )
            m.contains("huawei") -> listOf(
                cmp("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                cmp("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
            )
            m.contains("honor") -> listOf(
                cmp("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                cmp("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
            )
            m.contains("oppo") || m.contains("oneplus") || m.contains("realme") -> listOf(
                cmp("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                cmp("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
            )
            m.contains("vivo") || m.contains("iqoo") -> listOf(
                cmp("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
                cmp("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
            )
            m.contains("samsung") -> listOf(
                cmp("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
            )
            else -> emptyList()
        }
    }
}

/**
 * 运行期健康统计。MIUI 的自启动/省电策略读不到，只能靠这些迹象反推。
 * 关键计数持久化到 `files/gc_health.json`，进程重启不清零(死因可追溯)；
 * 未 init 时退化为纯内存(fail-soft)。
 */
object GcHealth {
    @Volatile
    var unexpectedDisconnects: Int = 0
        private set

    @Volatile
    var lastDropReason: String? = null
        private set

    /** 无障碍断链标记：onServiceConnected/恢复时清除，onDestroy/onInterrupt/看门狗置位。 */
    @Volatile
    var a11yLost: Boolean = false
        private set

    @Volatile
    var a11yLostReason: String? = null
        private set

    /** 上次已上报过的进程退出时间戳，避免同一死因每次启动重复上报。 */
    @Volatile
    var lastExitReportTs: Long = 0
        private set

    private var file: File? = null
    private val lock = Any()

    /** 注入上下文并读回持久化值。幂等，服务/UI/看门狗/无障碍启动时都调一次。 */
    fun init(context: Context) {
        if (file != null) return
        synchronized(lock) {
            if (file != null) return
            val f = File(context.filesDir, "gc_health.json")
            file = f
            runCatching {
                if (!f.exists()) return@runCatching
                val obj = JsonParser.parseString(f.readText()).asJsonObject
                unexpectedDisconnects = obj.get("unexpected_disconnects")?.asInt ?: 0
                lastDropReason = obj.get("last_drop_reason")?.takeIf { !it.isJsonNull }?.asString
                a11yLost = obj.get("a11y_lost")?.asBoolean ?: false
                a11yLostReason = obj.get("a11y_lost_reason")?.takeIf { !it.isJsonNull }?.asString
                lastExitReportTs = obj.get("last_exit_report_ts")?.asLong ?: 0
            }
        }
    }

    fun onUnexpectedDisconnect(reason: String?) {
        unexpectedDisconnects++
        lastDropReason = reason
        persist()
    }

    /** @return true = 新发生的断链(此前为正常状态)，调用方据此决定是否发通知/上报，防 onInterrupt 反复轰炸。 */
    fun onAccessibilityLost(reason: String?): Boolean {
        val fresh = !a11yLost
        a11yLost = true
        a11yLostReason = reason
        persist()
        return fresh
    }

    fun onAccessibilityRestored() {
        if (!a11yLost && a11yLostReason == null) return
        a11yLost = false
        a11yLostReason = null
        persist()
    }

    fun markExitReported(ts: Long) {
        lastExitReportTs = ts
        persist()
    }

    fun reset() {
        unexpectedDisconnects = 0
        lastDropReason = null
        a11yLost = false
        a11yLostReason = null
        persist()
    }

    private fun persist() {
        val f = file ?: return
        synchronized(lock) {
            runCatching {
                val obj = JsonObject().apply {
                    addProperty("unexpected_disconnects", unexpectedDisconnects)
                    addProperty("last_drop_reason", lastDropReason)
                    addProperty("a11y_lost", a11yLost)
                    addProperty("a11y_lost_reason", a11yLostReason)
                    addProperty("last_exit_report_ts", lastExitReportTs)
                }
                f.writeText(obj.toString())
            }
        }
    }
}
