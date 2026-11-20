package com.erp.groupcontrol.gc

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat

/**
 * 设备硬件信息采集(账号初始化档案用):序列号 / 双 IMEI / SIM 本机号码。
 *
 * 全程 best-effort:Android 10+ 普通应用读不到 IMEI/序列号(SecurityException 或返回 null),
 * 读不到的字段返回 null,由 PC 守护端 adb 兜底(POST /device-info 只填空字段)。
 * 任何异常都不抛出——采集失败绝不能影响 identity 上报主流程。
 */
object DeviceInfo {

    data class Info(
        val serial: String?,
        val imei1: String?,
        val imei2: String?,
        val phoneNumber: String?,
    )

    fun collect(context: Context): Info {
        val granted = ContextCompat.checkSelfPermission(context, android.Manifest.permission.READ_PHONE_STATE) ==
            PackageManager.PERMISSION_GRANTED
        return Info(
            serial = readSerial(granted),
            imei1 = readImei(context, granted, 0),
            imei2 = readImei(context, granted, 1),
            phoneNumber = readLine1Number(context, granted),
        )
    }

    @SuppressLint("HardwareIds")
    private fun readSerial(granted: Boolean): String? = runCatching {
        when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> null // 10+ 普通应用不可读
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && granted ->
                Build.getSerial().takeIf { it.isNotBlank() && it != Build.UNKNOWN }
            Build.VERSION.SDK_INT < Build.VERSION_CODES.O ->
                Build.SERIAL.takeIf { it.isNotBlank() && it != Build.UNKNOWN }
            else -> null
        }
    }.getOrNull()

    @SuppressLint("HardwareIds")
    private fun readImei(context: Context, granted: Boolean, slot: Int): String? = runCatching {
        if (!granted || Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return@runCatching null
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            tm.getImei(slot)?.takeIf { it.isNotBlank() }
        } else if (slot == 0) {
            @Suppress("DEPRECATION") tm.deviceId?.takeIf { it.isNotBlank() }
        } else null
    }.getOrNull()

    @SuppressLint("HardwareIds")
    private fun readLine1Number(context: Context, granted: Boolean): String? = runCatching {
        if (!granted) return@runCatching null
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        @Suppress("DEPRECATION")
        tm.line1Number?.takeIf { it.isNotBlank() }
    }.getOrNull()
}
