package com.erp.groupcontrol.gc

import android.app.Activity
import android.os.Bundle

/**
 * 自检探针:实测「后台弹出界面」是否被 MIUI 放行(见 Preflight.probeBackgroundStart)。
 * 被成功拉起即置标志位并立即自杀;透明主题,无感。被 MIUI 拦截时根本不会到 onResume。
 */
class BackgroundStartProbeActivity : Activity() {

    override fun onResume() {
        super.onResume()
        lastForegroundAt = System.currentTimeMillis()
        finish()
    }

    companion object {
        /** 探针页最后一次到前台的时间戳(System.currentTimeMillis)。 */
        @Volatile
        var lastForegroundAt: Long = 0
    }
}
