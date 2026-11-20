package com.erp.groupcontrol.gc

import android.util.Log
import com.hivemq.client.mqtt.MqttClient
import com.hivemq.client.mqtt.datatypes.MqttQos
import com.hivemq.client.mqtt.mqtt5.Mqtt5AsyncClient
import com.hivemq.client.mqtt.mqtt5.lifecycle.Mqtt5ClientDisconnectedContext
import com.hivemq.client.mqtt.mqtt5.message.auth.Mqtt5SimpleAuth
import com.hivemq.client.mqtt.mqtt5.message.connect.Mqtt5Connect
import com.hivemq.client.mqtt.mqtt5.message.publish.Mqtt5Publish
import com.hivemq.client.mqtt.mqtt5.message.publish.Mqtt5WillPublish
import java.nio.charset.StandardCharsets

enum class GcConnState { DISCONNECTED, CONNECTING, CONNECTED }

/** 通信层向上（Service/UI/执行器）回调。 */
interface GcClientListener {
    fun onState(state: GcConnState, detail: String?)
    fun onLog(line: String)
    fun onCommand(cmd: GcCommand)
    fun onRpc(rpc: GcRpc)
}

/**
 * 群控执行端 MQTT 客户端（HiveMQ, MQTT 5）。
 *
 * 生命周期：start() 连 EMQX → 连上后订 `gc/{id}/cmd`、retained 发 online →
 * 收指令回调 [GcClientListener.onCommand] → report()/log() 回传 →
 * stop() 主动发 offline 后断开。断线由 HiveMQ 自动重连 + LWT 遗嘱兜底。
 */
class GcMqttClient(
    private val prefs: Prefs,
    private val appVersion: String,
    private val listener: GcClientListener,
) {
    private var client: Mqtt5AsyncClient? = null
    // 首次 connect 的完整凭据帧：自动重连与假活强制重连都要重挂它（否则 EMQX 判 NOT_AUTHORIZED）
    private var connectFrame: Mqtt5Connect? = null
    @Volatile var state: GcConnState = GcConnState.DISCONNECTED
        private set

    fun start() {
        if (client != null) return
        if (!prefs.isConfigured()) {
            listener.onLog("未配置完整（主机/设备ID/令牌），无法连接")
            return
        }
        setState(GcConnState.CONNECTING, "连接 ${prefs.brokerHost}:${prefs.brokerPort}")

        val connect = Mqtt5Connect.builder()
            .keepAlive(KEEP_ALIVE_SEC)
            .cleanStart(true)
            .sessionExpiryInterval(SESSION_EXPIRY_SEC)
            .simpleAuth(
                Mqtt5SimpleAuth.builder()
                    .username(prefs.deviceId)
                    .password(prefs.deviceToken.toByteArray(StandardCharsets.UTF_8))
                    .build()
            )
            .willPublish(
                Mqtt5WillPublish.builder()
                    .topic(GcTopics.status(prefs.deviceId))
                    .qos(MqttQos.AT_LEAST_ONCE)
                    .retain(true)
                    .payload(GcProtocol.statusFrame(false).toByteArray(StandardCharsets.UTF_8))
                    .build()
            )
            .build()
        connectFrame = connect

        var b = MqttClient.builder()
            .useMqttVersion5()
            .identifier(prefs.deviceId)
            .serverHost(prefs.brokerHost)
            .serverPort(prefs.brokerPort)
            .automaticReconnectWithDefaultConfig()
            .addConnectedListener { onConnected() }
            .addDisconnectedListener { ctx ->
                // 关键：自动重连默认发的是「空的」CONNECT——不会重放首次 connect 里的 simpleAuth 和遗嘱。
                // 后果：EMQX 收到 username=''/password 空 → 判 NOT_AUTHORIZED，设备断一次就永久失联，
                // 只能人工重启 App 或重新点「保存配置」。所以每次重连前必须把同一个 connect 重新挂上。
                (ctx as? Mqtt5ClientDisconnectedContext)?.reconnector?.connect(connect)
                onDisconnected(ctx.cause.message)
            }
        if (prefs.tls) b = b.sslWithDefaultConfig()
        val c = b.buildAsync()
        client = c

        c.connect(connect).whenComplete { _, ex ->
            if (ex != null) {
                // 自动重连会接管，这里只记日志
                listener.onLog("连接失败：${ex.message}（自动重连中）")
                setState(GcConnState.CONNECTING, ex.message)
            }
        }
    }

    fun stop() {
        val c = client ?: return
        client = null
        connectFrame = null
        try {
            // 主动发 offline retained（覆盖遗嘱），再优雅断开
            c.publishWith()
                .topic(GcTopics.status(prefs.deviceId))
                .qos(MqttQos.AT_LEAST_ONCE)
                .retain(true)
                .payload(GcProtocol.statusFrame(false).toByteArray(StandardCharsets.UTF_8))
                .send()
                .whenComplete { _, _ -> c.disconnect() }
        } catch (e: Exception) {
            try { c.disconnect() } catch (_: Exception) {}
        }
        setState(GcConnState.DISCONNECTED, "已停止")
    }

    /** 回传任务状态到 report topic。 */
    fun report(json: String) = publish(GcTopics.report(prefs.deviceId), json, MqttQos.AT_LEAST_ONCE)

    /** 回传原语结果到 rpc_resp topic。 */
    fun rpcResp(json: String) = publish(GcTopics.rpcResp(prefs.deviceId), json, MqttQos.AT_LEAST_ONCE)

    /** 回传日志到 log topic（best-effort）。 */
    fun log(json: String) = publish(GcTopics.log(prefs.deviceId), json, MqttQos.AT_MOST_ONCE)

    /**
     * 假活兜底：主动断开后立即用同一凭据重连。
     * 用于绕开 HiveMQ 自动重连被 Doze/厂商冻结无限拖延、或 TCP 半开导致的「状态已连接但收不到帧」。
     * 触发方：GcService 的 60s stale 检测 / 看门狗的 20 分钟巡检。
     */
    fun forceReconnect() {
        val c = client ?: return
        val conn = connectFrame ?: return
        // 先重置收帧计时，避免重连进行中被看门狗连环触发
        lastFrameAtMs = System.currentTimeMillis()
        try {
            c.disconnect().whenComplete { _, _ ->
                // 期间若已被 stop()/重建则放弃，避免旧实例复活
                if (client === c) runCatching { c.connect(conn) }
            }
        } catch (e: Exception) {
            Log.w(TAG, "forceReconnect 失败: ${e.message}")
        }
    }

    private fun publish(topic: String, payload: String, qos: MqttQos) {
        val c = client ?: return
        try {
            c.publishWith().topic(topic).qos(qos)
                .payload(payload.toByteArray(StandardCharsets.UTF_8)).send()
        } catch (e: Exception) {
            Log.w(TAG, "publish failed: ${e.message}")
        }
    }

    // ---- HiveMQ 回调（连上/断开每次都触发，含自动重连）----
    private fun onConnected() {
        lastFrameAtMs = System.currentTimeMillis()
        setState(GcConnState.CONNECTED, "已连接")
        val c = client ?: return
        // 订阅本机指令 + 全体广播
        c.subscribeWith()
            .topicFilter(GcTopics.cmd(prefs.deviceId))
            .qos(MqttQos.AT_LEAST_ONCE)
            .callback { pub -> handleCmd(pub) }
            .send()
        c.subscribeWith()
            .topicFilter(GcTopics.BROADCAST_CMD)
            .qos(MqttQos.AT_LEAST_ONCE)
            .callback { pub -> handleCmd(pub) }
            .send()
        // 订阅原语 RPC(V2 大脑在服务端,手机执行原语)
        c.subscribeWith()
            .topicFilter(GcTopics.rpc(prefs.deviceId))
            .qos(MqttQos.AT_LEAST_ONCE)
            .callback { pub -> handleRpc(pub) }
            .send()
        // retained 上报 online
        publish(GcTopics.status(prefs.deviceId), GcProtocol.statusFrame(true, appVersion), MqttQos.AT_LEAST_ONCE)
        listener.onLog("已连接 EMQX，订阅指令完成")
    }

    private fun onDisconnected(reason: String?) {
        if (client == null) return // 主动 stop 的断开，不当异常
        // 计数供自检用：MIUI 自启动/省电策略没有公开 API 可读，
        // 「频繁意外断连」是唯一能反推保活没配好的信号。
        GcHealth.onUnexpectedDisconnect(reason)
        setState(GcConnState.CONNECTING, reason ?: "连接断开")
        listener.onLog("连接断开：${reason ?: "未知"}（自动重连中）")
    }

    private fun handleCmd(pub: Mqtt5Publish) {
        lastFrameAtMs = System.currentTimeMillis()
        val raw = String(pub.payloadAsBytes, StandardCharsets.UTF_8)
        val cmd = GcProtocol.parseCommand(raw)
        if (cmd == null) {
            listener.onLog("收到无法解析的指令：$raw")
            return
        }
        listener.onLog("收到指令 ${cmd.taskType} task=${cmd.taskId}")
        listener.onCommand(cmd)
    }

    private fun handleRpc(pub: Mqtt5Publish) {
        lastFrameAtMs = System.currentTimeMillis()
        val raw = String(pub.payloadAsBytes, StandardCharsets.UTF_8)
        val rpc = GcProtocol.parseRpc(raw)
        if (rpc == null) {
            listener.onLog("收到无法解析的原语:$raw")
            return
        }
        listener.onRpc(rpc)
    }

    private fun setState(s: GcConnState, detail: String?) {
        state = s
        listener.onState(s, detail)
    }

    companion object {
        private const val TAG = "GcMqttClient"
        // 30s 对后台 App 太苛刻:心跳被系统延迟就会超过 broker 的 1.5×keepalive 容忍线(45s)被踢。
        // 放宽到 120s(容忍线 3 分钟),代价是掉线检测最慢 3 分钟才由 LWT 通知服务端——
        // 对「一台设备同时只跑一个任务」的调度模型可接受，Watchdog 的任务超时会兜住。
        private const val KEEP_ALIVE_SEC = 120
        private const val SESSION_EXPIRY_SEC = 300L

        /**
         * 最后一次收到任何 MQTT 帧(cmd/rpc)或连接成功的时间戳。
         * 供 GcService 的 stale 检测与 WatchdogReceiver 判「假活」用；进程内共享，故放 companion。
         */
        @Volatile
        var lastFrameAtMs: Long = 0L
    }
}
