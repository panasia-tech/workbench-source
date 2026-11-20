package com.erp.groupcontrol.gc

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 日志落盘：GcBus 的内存环形缓冲(200 条)进程一死就丢，死因无从排查。
 * 这里把每条日志双写到 `files/logs/gc-yyyyMMdd.log`，按天滚动、保留 7 天。
 * 全程 fail-soft：写盘失败只丢日志，绝不影响主流程。
 */
object FileLogger {
    @Volatile private var logDir: File? = null
    private val tsFmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)
    private val dayFmt = SimpleDateFormat("yyyyMMdd", Locale.US)
    private val lock = Any()
    private const val KEEP_DAYS = 7

    /** 初始化日志目录并清理过期文件。幂等，服务/UI/看门狗启动时都调一次。 */
    fun init(context: Context) {
        if (logDir != null) return
        synchronized(lock) {
            if (logDir != null) return
            val dir = File(context.filesDir, "logs").apply { mkdirs() }
            logDir = dir
            prune(dir)
        }
    }

    /** 落盘一行(由 GcBus.appendLog 双写调用)。未初始化时直接丢弃。 */
    fun log(line: String) {
        val dir = logDir ?: return
        synchronized(lock) {
            runCatching {
                File(dir, "gc-${dayFmt.format(Date())}.log")
                    .appendText("${tsFmt.format(Date())}  $line\n")
            }
        }
    }

    /** 滚动清理：删除修改时间超过 [KEEP_DAYS] 天的 gc-*.log。 */
    private fun prune(dir: File) {
        runCatching {
            val cutoff = System.currentTimeMillis() - KEEP_DAYS * 24 * 3600 * 1000L
            dir.listFiles { f -> f.name.startsWith("gc-") && f.name.endsWith(".log") }
                ?.filter { it.lastModified() < cutoff }
                ?.forEach { it.delete() }
        }
    }
}
