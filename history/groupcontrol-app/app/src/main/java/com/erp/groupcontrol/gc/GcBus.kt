package com.erp.groupcontrol.gc

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Service ↔ UI 的轻量状态总线（进程内单例）。 */
object GcBus {
    private val _state = MutableStateFlow(GcConnState.DISCONNECTED)
    val state: StateFlow<GcConnState> = _state

    private val _detail = MutableStateFlow<String?>(null)
    val detail: StateFlow<String?> = _detail

    private val _logs = MutableStateFlow<List<String>>(emptyList())
    val logs: StateFlow<List<String>> = _logs

    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.CHINA)
    private const val MAX_LOG = 200

    fun setState(s: GcConnState, d: String?) {
        _state.value = s
        _detail.value = d
    }

    fun appendLog(line: String) {
        val stamped = "${fmt.format(Date())}  $line"
        _logs.value = (_logs.value + stamped).takeLast(MAX_LOG)
        // 双写落盘：进程死后内存环形缓冲即丢，死因排查靠文件
        FileLogger.log(line)
    }
}
