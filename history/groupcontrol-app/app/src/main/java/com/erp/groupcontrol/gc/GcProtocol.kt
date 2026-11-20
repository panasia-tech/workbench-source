package com.erp.groupcontrol.gc

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * 群控执行端 <-> 调度中心 MQTT 协议：Topic 约定 + 指令/回传帧结构 + 任务类型/状态常量。
 *
 * 手机订阅 `gc/{device_id}/cmd` 领指令，向 `gc/{device_id}/report` 回状态，
 * 上线在 `gc/{device_id}/status`(retained)发 online、断线由 LWT 遗嘱发 offline。
 * 后端（Python + FastAPI + aiomqtt 桥）订 `gc/+/report`、`gc/+/status`，发 `gc/{id}/cmd`。
 */
object GcTopics {
    fun cmd(deviceId: String) = "gc/$deviceId/cmd"
    fun report(deviceId: String) = "gc/$deviceId/report"
    fun log(deviceId: String) = "gc/$deviceId/log"
    fun status(deviceId: String) = "gc/$deviceId/status"
    // V2 原语 RPC:服务端流程引擎驱动手机的「手」
    fun rpc(deviceId: String) = "gc/$deviceId/rpc"            // 后端→设备:{req_id, op, args}
    fun rpcResp(deviceId: String) = "gc/$deviceId/rpc_resp"   // 设备→后端:{req_id, ok, data, err}
    const val BROADCAST_CMD = "gc/broadcast/cmd"
}

object GcProtocol {

    // ---- 回传 status（后端据此映射任务状态）----
    const val S_RUN = "run"     // 端已开始执行 -> RUNNING
    const val S_WAIT = "wait"   // 端排队中     -> WAITING
    const val S_END = "end"     // 成功         -> SUCCESS
    const val S_ERROR = "error" // 失败         -> FAILED

    // ---- 任务类型（对齐后端 GcTaskType）----
    // 业务类（携带商品数据）
    const val TASK_GOODS_LIST_UP = "goods_list_up"     // 上架
    const val TASK_GOODS_LIST_DOWN = "goods_list_down" // 下架
    const val TASK_GOODS_PUBLISH = "goods_publish"     // 发布新品
    const val TASK_GOODS_REPRICE = "goods_reprice"     // 改价（智能调价下发）
    const val TASK_CHAT_REPLY = "chat_reply"           // 发送聊天消息（AI/话术/图片/视频）
    const val TASK_SHOP_DATA_SCRAPE = "shop_data_scrape" // 抓取小铺数据
    // 控制类（立即执行）
    const val TASK_CLEAR_TASK = "clear_task"           // 清空端队列
    const val TASK_REMOVE_TASK = "remove_task"         // 删单条
    const val TASK_RESTART_XY = "restart_xy"           // 重启闲鱼
    const val TASK_RESTART_AJ = "restart_aj"           // 重启助手（本 App）
    // 重启引擎：断开 MQTT、停心跳、重建原语线程池后重新 enroll/connect/订阅
    // （等价一尘 restart_aj 只重启引擎不重开 App；上面的 restart_aj 保留兼容旧后端，仅 ack）
    const val TASK_RESTART = "restart"                 // 重建执行环境（引擎重启）
    const val TASK_CLEAR_IMG = "clear_img"             // 清缓存
    const val TASK_SET_PHONE_INFO = "set_phone_info"   // 上报机型

    val CONTROL_TYPES = setOf(
        TASK_CLEAR_TASK, TASK_REMOVE_TASK, TASK_RESTART_XY,
        TASK_RESTART_AJ, TASK_RESTART, TASK_CLEAR_IMG, TASK_SET_PHONE_INFO,
    )

    private val gson = Gson()

    /** 解析后端下发到 cmd topic 的指令帧：`{task_id, task_type, payload:{...}}`。解析失败返回 null。 */
    fun parseCommand(raw: String): GcCommand? {
        return try {
            val obj = JsonParser.parseString(raw).asJsonObject
            val type = obj.get("task_type")?.asString ?: return null
            GcCommand(
                taskId = obj.get("task_id")?.takeIf { !it.isJsonNull }?.asString,
                taskType = type,
                payload = obj.getAsJsonObject("payload") ?: JsonObject(),
            )
        } catch (e: Exception) {
            null
        }
    }

    /** 构造回传 report topic 的状态帧。 */
    fun report(
        taskId: String?,
        status: String,
        progress: String? = null,
        mark: String? = null,
        error: String? = null,
        result: Map<String, Any?>? = null,
    ): String {
        val obj = JsonObject()
        obj.addProperty("task_id", taskId)
        obj.addProperty("status", status)
        progress?.let { obj.addProperty("progress", it) }
        mark?.let { obj.addProperty("mark", it) }
        error?.let { obj.addProperty("error", it) }
        result?.let { obj.add("result", gson.toJsonTree(it)) }
        obj.addProperty("ts", System.currentTimeMillis())
        return obj.toString()
    }

    /** 在线状态帧（retained 发到 status topic；LWT 遗嘱用 online=false）。 */
    fun statusFrame(online: Boolean, appVersion: String? = null): String {
        val obj = JsonObject()
        obj.addProperty("online", online)
        appVersion?.let { obj.addProperty("app_version", it) }
        obj.addProperty("ts", System.currentTimeMillis())
        return obj.toString()
    }

    /**
     * 身份/就绪帧(发到 report topic，kind=identity)。
     *
     * 用途：服务端按 [xianyuNick] 绑定闲鱼账号 + 据 [ready]/[blocking] 判设备可否派活。
     * 注意：**在线态仍只由 status 心跳决定，identity 帧不代表在线**(它可在离线队列里滞留后补达)。
     * [xianyuNick] 读不到时传 null(Gson 写成 JSON null)。
     * [ready]/[blocking] 复用 [Preflight.toJson] 语义：ready = 无 ok==false 的项；blocking = 逗号拼接失败项 key。
     */
    fun identityFrame(
        xianyuInstalled: Boolean,
        xianyuNick: String?,
        ready: Boolean,
        blocking: String,
        appVersion: String? = null,
        deviceInfo: DeviceInfo.Info? = null,
        memberName: String? = null,
    ): String {
        val obj = JsonObject()
        obj.addProperty("kind", "identity")
        obj.addProperty("xianyu_installed", xianyuInstalled)
        obj.addProperty("xianyu_nick", xianyuNick) // null → JSON null(Gson addProperty 对 null 安全)
        obj.addProperty("ready", ready)
        obj.addProperty("blocking", blocking)
        appVersion?.let { obj.addProperty("app_version", it) }
        // 设备硬件信息(账号初始化档案):读不到的字段不下发,服务端只认非空值
        deviceInfo?.let { di ->
            di.serial?.let { obj.addProperty("serial", it) }
            di.imei1?.let { obj.addProperty("imei1", it) }
            di.imei2?.let { obj.addProperty("imei2", it) }
            di.phoneNumber?.let { obj.addProperty("phone_number", it) }
        }
        memberName?.let { obj.addProperty("xianyu_member_name", it) }
        obj.addProperty("ts", System.currentTimeMillis())
        return obj.toString()
    }

    /** 纯文本日志帧。 */
    fun logFrame(msg: String, level: String = "info"): String {
        val obj = JsonObject()
        obj.addProperty("msg", msg)
        obj.addProperty("level", level)
        obj.addProperty("ts", System.currentTimeMillis())
        return obj.toString()
    }

    /** 通用事件帧(发到 report topic，kind=event)：无障碍断链等系统事件。 */
    fun eventFrame(event: String, detail: String? = null): String {
        val obj = JsonObject()
        obj.addProperty("kind", "event")
        obj.addProperty("event", event)
        detail?.let { obj.addProperty("detail", it) }
        obj.addProperty("ts", System.currentTimeMillis())
        return obj.toString()
    }

    /**
     * 上次进程退出原因帧(发到 report topic，kind=exit_info)。
     * 取自 ActivityManager.getHistoricalProcessExitReasons，用于灰度观察设备群死因。
     */
    fun exitInfoFrame(
        reason: Int,
        reasonName: String,
        importance: Int,
        description: String?,
        exitTs: Long,
    ): String {
        val obj = JsonObject()
        obj.addProperty("kind", "exit_info")
        obj.addProperty("reason", reason)
        obj.addProperty("reason_name", reasonName)
        obj.addProperty("importance", importance)
        description?.let { obj.addProperty("description", it.take(500)) }
        obj.addProperty("exit_ts", exitTs)
        obj.addProperty("ts", System.currentTimeMillis())
        return obj.toString()
    }

    /** 解析后端下发到 rpc topic 的原语帧:`{req_id, op, args:{...}}`。解析失败返回 null。 */
    fun parseRpc(raw: String): GcRpc? {
        return try {
            val obj = JsonParser.parseString(raw).asJsonObject
            val op = obj.get("op")?.asString ?: return null
            val reqId = obj.get("req_id")?.asString ?: return null
            GcRpc(reqId, op, obj.getAsJsonObject("args") ?: JsonObject())
        } catch (e: Exception) {
            null
        }
    }

    /** 构造原语回传帧 rpc_resp:`{req_id, ok, data, err}`。 */
    fun rpcResp(reqId: String, ok: Boolean, data: JsonObject? = null, err: String? = null): String {
        val obj = JsonObject()
        obj.addProperty("req_id", reqId)
        obj.addProperty("ok", ok)
        data?.let { obj.add("data", it) }
        err?.let { obj.addProperty("err", it) }
        obj.addProperty("ts", System.currentTimeMillis())
        return obj.toString()
    }
}

/** 服务端下发的一个原语请求。 */
data class GcRpc(
    val reqId: String,
    val op: String,
    val args: JsonObject,
) {
    fun int(key: String, def: Int = 0): Int =
        args.get(key)?.takeIf { !it.isJsonNull }?.asInt ?: def

    fun str(key: String): String? =
        args.get(key)?.takeIf { !it.isJsonNull }?.asString

    fun bool(key: String, def: Boolean = false): Boolean =
        args.get(key)?.takeIf { !it.isJsonNull }?.asBoolean ?: def
}

/** 服务端下发的一条指令。商品/参数数据在 [payload] 里（货号/标题/价/图/闲鱼itemId 等）。 */
data class GcCommand(
    val taskId: String?,
    val taskType: String,
    val payload: JsonObject,
) {
    val isControl: Boolean get() = taskType in GcProtocol.CONTROL_TYPES

    fun str(key: String): String? =
        payload.get(key)?.takeIf { !it.isJsonNull }?.asString
}
