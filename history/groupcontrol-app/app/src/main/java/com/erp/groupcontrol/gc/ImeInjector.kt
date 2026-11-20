package com.erp.groupcontrol.gc

import android.content.Context
import android.util.Log
import android.view.inputmethod.InputMethodManager
import com.erp.groupcontrol.inputmethod.GcInputMethodService

/**
 * IME 注入器:打开系统输入法选择器 + 等待 InputConnection 就绪后 commitText。
 *
 * 拆分原因:选择器是原生对话框、条目不带 content-desc(无法用语义点击),且 MIUI 对三方应用
 * 的 WRITE_SECURE_SETTINGS 授权不生效(2026-07-29 实测)——所以「切 IME / 切回」的点击由服务端
 * 流程引擎用 OCR 完成(原生对话框 OCR 稳),端上只提供两个原子原语:
 *   - "ime_picker":弹出系统输入法选择器(无需任何权限)
 *   - "ime_commit":等 InputConnection 就绪后向聚焦输入框 commitText
 *
 * 前置条件:本 IME 已在「已启用输入法」里(装机时 adb 写入 enabled_input_methods 一次)。
 * 全过程在工作线程执行(含轮询等待),勿在主线程调用。
 */
object ImeInjector {

    private const val TAG = "GcIme"
    private const val COMMIT_WAIT_MS = 3000L
    private const val POLL_STEP_MS = 120L

    fun showPicker(context: Context) {
        try {
            // 用无障碍服务作 context:后台应用进程调 showInputMethodPicker 会被静默忽略
            // (2026-07-29 实测,应用 context 调用无异常但不弹窗),服务由系统绑定不受限。
            val ctx: Context = com.erp.groupcontrol.auto.XianyuAccessibilityService.instance ?: context
            ctx.getSystemService(InputMethodManager::class.java).showInputMethodPicker()
        } catch (e: Exception) {
            Log.w(TAG, "ime_picker 打开失败: ${e.message}")
        }
    }

    /** 等 InputConnection 就绪后提交 text;超时/无连接返回 false(上层补聚焦重试)。 */
    fun commit(text: String): Boolean {
        val deadline = System.currentTimeMillis() + COMMIT_WAIT_MS
        while (System.currentTimeMillis() < deadline) {
            if (GcInputMethodService.instance?.currentInputConnection != null) {
                val ok = GcInputMethodService.commit(text)
                Log.i(TAG, "ime_commit ok=$ok len=${text.length}")
                return ok
            }
            Thread.sleep(POLL_STEP_MS)
        }
        Log.w(TAG, "ime_commit 等待 InputConnection 超时(未切到本 IME / 焦点丢失)")
        return false
    }

    /** 等 InputConnection 就绪后把 text 插到内容开头(setSelection(0,0)+commit)。 */
    fun commitAtStart(text: String): Boolean {
        val deadline = System.currentTimeMillis() + COMMIT_WAIT_MS
        while (System.currentTimeMillis() < deadline) {
            if (GcInputMethodService.instance?.currentInputConnection != null) {
                val ok = GcInputMethodService.commitAtStart(text)
                Log.i(TAG, "ime_prefix ok=$ok len=${text.length}")
                return ok
            }
            Thread.sleep(POLL_STEP_MS)
        }
        Log.w(TAG, "ime_prefix 等待 InputConnection 超时")
        return false
    }
}
