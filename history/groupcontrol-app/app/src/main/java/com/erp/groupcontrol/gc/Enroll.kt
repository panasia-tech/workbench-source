package com.erp.groupcontrol.gc

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.erp.groupcontrol.BuildConfig
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * 设备引导注册（enroll）。
 *
 * MQTT 身份（device_id + token）由服务端签发，不在端上硬编。首次启动(未拿到身份)时：
 *   读 Android_ID 作 hw_id(仅作服务端 upsert 幂等键) →
 *   POST {BuildConfig.API_BASE}/enroll(API_BASE 已含 gc 前缀;带 BuildConfig.ENROLL_SECRET) →
 *   服务端按 hw_id 幂等 upsert，返回 device_id + token → 落 [Prefs]。
 *
 * 【时序】必须在启动 MQTT 之前完成：MQTT 用 device_id 作 clientId/username、token 作密码，
 * 缺一不可。故 [GcService] 的启动引导里：未配置 → 先 enroll(阻塞 HTTP，置于工作线程) → 再连 MQTT。
 *
 * 一切失败(读不到 ANDROID_ID / 密钥空 / 网络错 / 响应缺字段)一律返回 false 且不抛崩，由调用方决定重试。
 */
object Enroll {

    private const val TAG = "GcEnroll"

    /** enroll 路径：`POST {API_BASE}/enroll`。API_BASE **已含 gc 前缀**:
     *  dev 直连 = `http://<ip>:8100/api/gc`;prod 经 nginx = `http://127.0.0.1:8000`
     *  (nginx `^~ /gc/` 反代到后端 `/api/gc/`,见 deploy/nginx/admin.conf)。 */
    private const val ENROLL_PATH = "/enroll"

    /**
     * Android_ID：设备级唯一标识，仅作服务端 upsert 的幂等键(不作 MQTT 身份)。
     * 注：ANDROID_ID 与「应用签名 + 设备」绑定，恢复出厂会变——足够作 upsert 键。
     */
    @SuppressLint("HardwareIds")
    fun hardwareId(ctx: Context): String =
        Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID).orEmpty()

    /**
     * 确保设备已注册。
     * - 已有 device_id/token → 直接返回 true(幂等，不重复请求)。
     * - 未配置 → 同步 POST enroll；成功写 [Prefs] 返回 true，失败返回 false(不抛)。
     *
     * ⚠️ 阻塞网络调用，**必须在工作线程执行**。
     */
    fun ensureEnrolled(ctx: Context, prefs: Prefs, log: (String) -> Unit = {}): Boolean {
        if (prefs.deviceId.isNotBlank() && prefs.deviceToken.isNotBlank()) return true

        val hwId = hardwareId(ctx)
        if (hwId.isBlank()) {
            log("enroll 失败：读不到 ANDROID_ID")
            return false
        }
        if (BuildConfig.ENROLL_SECRET.isBlank()) {
            log("enroll 失败：ENROLL_SECRET 未配置(build.gradle 占位需填)")
            return false
        }

        val body = JsonObject().apply {
            addProperty("hw_id", hwId)                    // 必填：ANDROID_ID
            addProperty("brand", Build.BRAND)             // 可空
            addProperty("model", Build.MODEL)             // 可空
            addProperty("app_version", appVersion(ctx))   // 可空
            addProperty("enroll_secret", BuildConfig.ENROLL_SECRET) // 必填
        }.toString()

        val url = BuildConfig.API_BASE.trimEnd('/') + ENROLL_PATH
        return try {
            val resp = postJson(url, body, log)
                ?: run { log("enroll 失败：无响应/网络错误 url=$url"); return false }
            val obj = JsonParser.parseString(resp).asJsonObject
            val deviceId = obj.get("device_id")?.takeIf { !it.isJsonNull }?.asString
            val token = obj.get("token")?.takeIf { !it.isJsonNull }?.asString
            if (deviceId.isNullOrBlank() || token.isNullOrBlank()) {
                log("enroll 失败：响应缺 device_id/token → $resp")
                return false
            }
            prefs.deviceId = deviceId
            prefs.deviceToken = token
            log("enroll 成功：device_id=$deviceId")
            true
        } catch (e: Exception) {
            Log.w(TAG, "enroll failed", e)
            log("enroll 异常：${e.message}")
            false
        }
    }

    /** POST JSON；2xx 返回响应体，非 2xx / 异常返回 null(不抛)。 */
    private fun postJson(urlStr: String, body: String, log: (String) -> Unit): String? {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection)
        return try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.setRequestProperty("Accept", "application/json")
            conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.use { it.readBytes().toString(StandardCharsets.UTF_8) }.orEmpty()
            if (code in 200..299) {
                text
            } else {
                // 403 = 密钥空/不匹配(见服务端契约)
                log("enroll HTTP $code：$text")
                null
            }
        } catch (e: Exception) {
            Log.w(TAG, "postJson error", e)
            null
        } finally {
            runCatching { conn.disconnect() }
        }
    }

    private fun appVersion(ctx: Context): String =
        runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "?"
}
