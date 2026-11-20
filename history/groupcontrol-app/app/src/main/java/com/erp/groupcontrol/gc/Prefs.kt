package com.erp.groupcontrol.gc

import android.content.Context
import com.erp.groupcontrol.BuildConfig

/**
 * 执行端配置：EMQX 连接信息 + 本机身份。
 * device_id 同时作为 MQTT clientId / 用户名 / topic 里的设备段；device_token 作 MQTT 密码。
 * 二者不再手输——由服务端 enroll 自动下发(见 [Enroll])，写入这里后 MQTT 照旧用它们连。
 *
 * broker 连接默认值取自构建变体 [BuildConfig]（debug=本地 / release=线上），仍保留手动 override
 * (UI 保存 / 扫码)：一旦 setter 写过 SharedPreferences，后续就以存储值为准，不再回落 BuildConfig。
 */
class Prefs(context: Context) {

    private val sp = context.getSharedPreferences("groupcontrol", Context.MODE_PRIVATE)

    /** EMQX 主机（域名或 IP），默认取当前构建变体的 [BuildConfig.MQTT_HOST]。 */
    var brokerHost: String
        get() = sp.getString(KEY_HOST, BuildConfig.MQTT_HOST) ?: BuildConfig.MQTT_HOST
        set(v) = sp.edit().putString(KEY_HOST, v.trim()).apply()

    /** EMQX 端口：TLS 8883 / 明文 1883，默认取 [BuildConfig.MQTT_PORT]。 */
    var brokerPort: Int
        get() = sp.getInt(KEY_PORT, BuildConfig.MQTT_PORT)
        set(v) = sp.edit().putInt(KEY_PORT, v).apply()

    /** 是否走 TLS，默认取 [BuildConfig.MQTT_TLS]（release 变体为 true）。 */
    var tls: Boolean
        get() = sp.getBoolean(KEY_TLS, BuildConfig.MQTT_TLS)
        set(v) = sp.edit().putBoolean(KEY_TLS, v).apply()

    /** 设备唯一标识（后台建设备时返回，用作 clientId / 用户名 / topic 段）。 */
    var deviceId: String
        get() = sp.getString(KEY_DEVICE_ID, "") ?: ""
        set(v) = sp.edit().putString(KEY_DEVICE_ID, v.trim()).apply()

    /** 设备令牌（MQTT 密码，后台建设备时返回）。 */
    var deviceToken: String
        get() = sp.getString(KEY_TOKEN, "") ?: ""
        set(v) = sp.edit().putString(KEY_TOKEN, v.trim()).apply()

    /** 用户是否点了「启动」——决定重启后是否自动拉起前台服务。 */
    var enabled: Boolean
        get() = sp.getBoolean(KEY_ENABLED, false)
        set(v) = sp.edit().putBoolean(KEY_ENABLED, v).apply()

    /**
     * 已读到的当前登录闲鱼昵称(缓存)。identity 帧上报用；只有读到非空新值才覆盖。
     * 首次读到后即缓存，避免每次上报都主动跳「我的」页(会打断任务)。
     * TODO(真机)：检测到闲鱼账号切换时应清空本值以触发重新读取——切换信号需真机确认。
     */
    var xianyuNick: String
        get() = sp.getString(KEY_XIANYU_NICK, "") ?: ""
        set(v) = sp.edit().putString(KEY_XIANYU_NICK, v.trim()).apply()

    /** 已读到的闲鱼会员名(tb 开头,缓存)。语义同 [xianyuNick];读不到保持空,ERP 档案允许员工手填。 */
    var xianyuMemberName: String
        get() = sp.getString(KEY_XIANYU_MEMBER_NAME, "") ?: ""
        set(v) = sp.edit().putString(KEY_XIANYU_MEMBER_NAME, v.trim()).apply()

    fun isConfigured(): Boolean =
        brokerHost.isNotBlank() && deviceId.isNotBlank() && deviceToken.isNotBlank()

    companion object {
        private const val KEY_HOST = "broker_host"
        private const val KEY_PORT = "broker_port"
        private const val KEY_TLS = "broker_tls"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_XIANYU_NICK = "xianyu_nick"
        private const val KEY_XIANYU_MEMBER_NAME = "xianyu_member_name"
    }
}
