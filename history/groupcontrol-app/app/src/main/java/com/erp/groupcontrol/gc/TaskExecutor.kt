package com.erp.groupcontrol.gc

import android.content.Context
import android.os.Build
import java.io.File

/**
 * 指令分发执行器：把 [GcCommand] 落到具体动作，并把执行结果回传。
 *
 * 职责（V2）:只处理**控制类**任务(上报机型 / 清缓存 / 重启 / 拉起闲鱼)。
 *
 * 业务类(上下架 / 发布 / 改价 / 聊天 / 抓小铺数据)在 V2 里**不再作为 cmd 任务下发给设备**——
 * 它们的流程逻辑全在服务端 app/flow/,由服务端拆成一串原语经 RPC 驱动设备的「手」
 * ([PrimitiveExecutor] + [com.erp.groupcontrol.auto.XianyuAccessibilityService])。
 * 若仍收到业务类 cmd(旧后端/误发),这里直接回错,提示走原语 RPC。
 */
class TaskExecutor(
    private val context: Context,
    private val reporter: (String) -> Unit,
    private val logger: (String) -> Unit,
    // restart 指令的引擎重建回调(由 GcService 注入：重建 MQTT/rpcPool/心跳)
    private val engineRestarter: (() -> Unit)? = null,
) {

    fun execute(cmd: GcCommand) {
        // 先回 run，让后端知道端已接手
        reporter(GcProtocol.report(cmd.taskId, GcProtocol.S_RUN))
        try {
            when (cmd.taskType) {
                GcProtocol.TASK_SET_PHONE_INFO -> reportPhoneInfo(cmd)
                GcProtocol.TASK_CLEAR_IMG -> clearCache(cmd)
                GcProtocol.TASK_RESTART_XY -> restartXianyu(cmd)
                GcProtocol.TASK_RESTART_AJ -> ack(cmd, "已收到重启助手指令")
                GcProtocol.TASK_RESTART -> restartEngine(cmd)
                GcProtocol.TASK_CLEAR_TASK, GcProtocol.TASK_REMOVE_TASK ->
                    ack(cmd, "端侧无独立队列，任务真相以后端为准，已 ack")

                GcProtocol.TASK_GOODS_LIST_UP,
                GcProtocol.TASK_GOODS_LIST_DOWN,
                GcProtocol.TASK_GOODS_PUBLISH,
                GcProtocol.TASK_GOODS_REPRICE,
                GcProtocol.TASK_CHAT_REPLY,
                GcProtocol.TASK_SHOP_DATA_SCRAPE -> delegateToXianyu(cmd)

                else -> fail(cmd, "未知任务类型：${cmd.taskType}")
            }
        } catch (e: Exception) {
            fail(cmd, "执行异常：${e.message}")
        }
    }

    // ---- 控制类：真实现 ----
    private fun reportPhoneInfo(cmd: GcCommand) {
        val info = mapOf(
            "brand" to Build.BRAND,
            "model" to Build.MODEL,
            "android" to Build.VERSION.RELEASE,
            "sdk" to Build.VERSION.SDK_INT,
        )
        reporter(GcProtocol.report(cmd.taskId, GcProtocol.S_END, result = info))
        logger("已上报机型 ${Build.BRAND} ${Build.MODEL}")
    }

    private fun clearCache(cmd: GcCommand) {
        val ok = runCatching { context.cacheDir.deleteRecursivelyQuiet() }.getOrDefault(false)
        if (ok) done(cmd, "缓存已清理") else fail(cmd, "清理缓存失败")
    }

    private fun restartXianyu(cmd: GcCommand) {
        val intent = context.packageManager.getLaunchIntentForPackage(XIANYU_PKG)
        if (intent == null) {
            fail(cmd, "未安装闲鱼($XIANYU_PKG)")
            return
        }
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        done(cmd, "已拉起闲鱼")
    }

    /** restart：先 ack(走旧连接回传)，再交 GcService 重建 MQTT/执行池/心跳。 */
    private fun restartEngine(cmd: GcCommand) {
        ack(cmd, "已收到 restart 指令，开始重建执行环境")
        if (engineRestarter == null) {
            logger("restart：当前构建未挂引擎重启回调")
            return
        }
        engineRestarter.invoke()
    }

    // ---- 业务类：V2 已改为服务端原语 RPC 驱动，设备不再处理业务 cmd ----
    private fun delegateToXianyu(cmd: GcCommand) {
        fail(cmd, "业务流程已上移服务端(app/flow),经原语 RPC 驱动;设备不再直接执行 ${cmd.taskType}")
    }

    // ---- 回传辅助 ----
    private fun ack(cmd: GcCommand, msg: String) = done(cmd, msg)

    private fun done(cmd: GcCommand, mark: String) {
        reporter(GcProtocol.report(cmd.taskId, GcProtocol.S_END, mark = mark))
        logger(mark)
    }

    private fun fail(cmd: GcCommand, error: String) {
        reporter(GcProtocol.report(cmd.taskId, GcProtocol.S_ERROR, error = error, mark = error))
        logger("失败：$error")
    }

    private fun File.deleteRecursivelyQuiet(): Boolean = this.deleteRecursively()

    companion object {
        // 闲鱼包名
        const val XIANYU_PKG = "com.taobao.idlefish"
    }
}
