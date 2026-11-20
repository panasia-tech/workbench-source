package com.erp.groupcontrol.gc

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat

/**
 * 系统级看门狗(对标一尘 TaskSchedulerImpl + RunTaskReceiver，20 分钟节拍)。
 *
 * GcService 用 [AlarmManager.setExactAndAllowWhileIdle] 排单次 alarm 链触发；
 * 与 START_STICKY 互补：厂商划卡清理/冻结把服务连同进程杀掉时，alarm 仍能唤醒进程拉起服务。
 *
 * 每次触发：
 * 1. 用户开着(enabled)但服务没在跑 → startForegroundService 拉起；
 * 2. 服务在跑但 MQTT 超过 3 分钟无任何收帧(假活) → 通知服务做应用层强制重连；
 * 3. 系统设置里无障碍已被关掉 → 记健康档案 + 高优先通知引导用户去重开；
 * 4. 排下一次 alarm。
 *
 * 安全边界：用户主动停止(prefs.enabled=false)后绝不自动拉起，也不再排下一次。
 */
class WatchdogReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        FileLogger.init(context)
        GcHealth.init(context)
        val prefs = Prefs(context)
        if (!prefs.enabled) return

        val svc = GcService.instance
        if (svc == null) {
            GcBus.appendLog("看门狗：服务未运行，拉起 GcService")
            runCatching { GcService.start(context) }
                .onFailure { GcBus.appendLog("看门狗拉起服务失败:${it.message}") }
        } else {
            // 假活判定：连接状态自报 CONNECTED 但长期无任何收帧(正常链路 keepAlive 120s 内必有帧)
            val idleMs = System.currentTimeMillis() - GcMqttClient.lastFrameAtMs
            if (GcBus.state.value == GcConnState.CONNECTED && idleMs > STALE_MS) {
                GcBus.appendLog("看门狗：MQTT ${idleMs / 1000}s 无收帧，触发强制重连")
                svc.pokeMqttReconnect()
            }
        }

        // 无障碍无法代码自 rebind(系统限制，一尘同样只能检测+引导)，
        // 这里检查系统设置位；断链细节已由 identity 帧的 blocking 带到服务端。
        if (!isA11yEnabled(context) && GcHealth.onAccessibilityLost("系统设置中未启用")) {
            GcNotifier.notifyA11yLost(context, "无障碍服务已被系统关闭，点击去重新开启")
        }

        schedule(context)
    }

    private fun isA11yEnabled(context: Context): Boolean {
        val s = Settings.Secure.getString(
            context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return s.contains(context.packageName)
    }

    companion object {
        /** 看门狗节拍：20 分钟(对标一尘 TaskSchedulerImpl)。 */
        const val INTERVAL_MS = 20 * 60 * 1000L
        /** MQTT 假活阈值：> keepAlive(120s)，与服务内 60s 周期 stale 检测同值。 */
        private const val STALE_MS = 180 * 1000L

        /**
         * 排 [delayMs] 后触发一次(默认下一节拍)。
         * Android 12+ 精确 alarm 需 SCHEDULE_EXACT_ALARM 且未被用户收回，不可用时退化为非精确 alarm。
         */
        fun schedule(context: Context, delayMs: Long = INTERVAL_MS) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val at = System.currentTimeMillis() + delayMs
            val pi = pendingIntent(context)
            runCatching {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
                } else {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
                }
            }.onFailure {
                runCatching { am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi) }
            }
        }

        fun cancel(context: Context) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            runCatching { am.cancel(pendingIntent(context)) }
        }

        private fun pendingIntent(context: Context): PendingIntent =
            PendingIntent.getBroadcast(
                context, 0, Intent(context, WatchdogReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
    }
}

/** 保活告警通知(无障碍断链等)，无障碍服务与看门狗共用。 */
internal object GcNotifier {
    private const val ALERT_CHANNEL_ID = "gc_alerts"
    private const val NOTIF_A11Y_ID = 1002

    fun notifyA11yLost(context: Context, text: String) {
        runCatching {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(
                    NotificationChannel(ALERT_CHANNEL_ID, "保活告警", NotificationManager.IMPORTANCE_HIGH)
                )
            }
            val pi = PendingIntent.getActivity(
                context, 0, Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            nm.notify(
                NOTIF_A11Y_ID,
                NotificationCompat.Builder(context, ALERT_CHANNEL_ID)
                    .setContentTitle("群控执行端")
                    .setContentText(text)
                    .setSmallIcon(android.R.drawable.stat_notify_sync)
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .build()
            )
        }
    }
}
