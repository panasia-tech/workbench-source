package com.erp.groupcontrol.gc

import android.content.Context
import android.util.Log
import com.erp.groupcontrol.BuildConfig
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * 设备心跳:每 5s POST `{API_BASE}/devices/{id}/heartbeat`,让服务端秒级掌握设备死活。
 *
 * 为什么单独要它(而非只靠 MQTT LWT 遗嘱):
 * - MQTT LWT 要等 1.5×keepalive(本端 keepalive=120s → 最慢 ~3min)才判离线,太慢;
 * - 更致命:进程被 MIUI 冻结(greeze)时 TCP 靠内核维持、MQTT 连接不断,LWT **根本不触发** → 假在线,
 *   服务端把任务派给一台其实已失能的机器,原语全超时(真机实测过)。
 * 应用层心跳:进程活着且有网才发得出;发不出=真失能,服务端超时(15s)即判 OFFLINE。
 *
 * 与 enroll 同走 [BuildConfig.API_BASE](已含 gc 前缀):dev=`http://<ip>:8100/api/gc`、
 * prod=`http://127.0.0.1:8000`(经 nginx 反代到 /api/gc)。
 * fail-soft:任何失败只 [Log.w],不抛、不刷 UI 日志(离线时 POST 本就会失败,那正是要上报的信号,
 * 刷屏无意义)。
 */
object Heartbeat {
    private const val TAG = "GcHeartbeat"

    /** 心跳周期(与服务端 heartbeat_timeout_sec=15 配套:3 次没到即判离线)。 */
    const val INTERVAL_MS = 5_000L

    /**
     * 发一次心跳。[mqttConnected]/[busy] 由调用方(GcService)传入实时态;端上就绪态(无障碍/闲鱼)
     * 用 [Preflight] 现读,顺带同步给服务端治 identity 陈旧。返回是否 2xx(仅调试用),失败不抛。
     */
    fun send(
        context: Context,
        prefs: Prefs,
        mqttConnected: Boolean,
        busy: Boolean,
        appVersion: String,
    ): Boolean {
        val id = prefs.deviceId
        val token = prefs.deviceToken
        if (id.isBlank() || token.isBlank()) return false  // 还没 enroll,无身份可上报
        val pf = Preflight.toJson(Preflight.run(context, probe = false))  // probe=false:不截图,轻量
        val body = JSONObject().apply {
            put("token", token)
            put("mqtt_connected", mqttConnected)
            put("a11y_ready", pf.get("ready").asBoolean)
            put("blocking", pf.get("blocking").asString)
            put("busy", busy)
            put("app_version", appVersion)
        }.toString()
        val url = "${BuildConfig.API_BASE.trimEnd('/')}/devices/$id/heartbeat"
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 4000
                readTimeout = 4000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
            conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            conn.responseCode in 200..299
        } catch (e: Exception) {
            Log.w(TAG, "heartbeat failed: ${e.message}")
            false
        } finally {
            conn?.disconnect()
        }
    }
}
