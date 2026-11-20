package com.erp.groupcontrol.gc

import com.google.gson.JsonParser
import java.net.HttpURLConnection
import java.net.URL

/**
 * App 版本更新检查：读服务器上的版本清单(version.json),与本地 BuildConfig 比对。
 * 清单与 APK 同源托管(nginx 静态目录),无后端依赖,失败一律返回 null(fail-soft)。
 */
object UpdateCheck {

    const val VERSION_URL = "http://127.0.0.1:8000"

    data class Latest(
        val versionName: String,
        val versionCode: Int,
        val url: String,
        val md5: String?,
        val notes: String?,
    )

    /** 同步拉取(放 IO 线程调用);网络/解析任何失败返回 null。 */
    fun fetchLatest(): Latest? = runCatching {
        val conn = (URL(VERSION_URL).openConnection() as HttpURLConnection).apply {
            connectTimeout = 8_000
            readTimeout = 8_000
            useCaches = false
        }
        try {
            if (conn.responseCode != 200) return null
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val obj = JsonParser.parseString(body).asJsonObject
            Latest(
                versionName = obj.get("versionName")?.asString ?: return null,
                versionCode = obj.get("versionCode")?.asInt ?: return null,
                url = obj.get("url")?.asString ?: return null,
                md5 = obj.get("md5")?.takeIf { !it.isJsonNull }?.asString,
                notes = obj.get("notes")?.takeIf { !it.isJsonNull }?.asString,
            )
        } finally {
            conn.disconnect()
        }
    }.getOrNull()
}
