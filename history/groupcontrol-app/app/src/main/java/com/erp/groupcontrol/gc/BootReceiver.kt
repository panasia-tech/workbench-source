package com.erp.groupcontrol.gc

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机 / 应用更新后，如果用户此前点了启动，则自动拉起前台服务，保证执行端常驻。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            val prefs = Prefs(context)
            // V2：身份由服务端 enroll 自动下发，不再要求开机时已配好 device_id/token——
            // 只要用户此前点过「启动」(enabled)，就拉起服务，未注册会在服务内先 enroll 再连。
            if (prefs.enabled) {
                GcService.start(context)
            }
        }
    }
}
