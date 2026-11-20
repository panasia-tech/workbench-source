package com.erp.groupcontrol.inputmethod

import android.inputmethodservice.InputMethodService
import android.view.View
import android.view.inputmethod.EditorInfo

/**
 * 微型输入法(无键盘面板):向当前聚焦输入框提交任意文本。
 *
 * 为什么需要它:闲鱼聊天输入框是 Flutter 渲染——
 * ①无障碍 ACTION_SET_TEXT 没有可写节点(2026-07-26 实测);
 * ②dispatchGesture/语义长按都不触发 Flutter 的「粘贴」菜单(2026-07-28 小米12 实测三种姿势均无效)。
 * IME 的 InputConnection.commitText 与 `adb input text` / ADBKeyboard 同原理,Flutter 照单全收。
 *
 * 使用方式见 [com.erp.groupcontrol.gc.ImeInjector]:临时把本 IME 设为默认 →
 * [onStartInput] 拿到 InputConnection → commitText → 切回原 IME。
 * 本服务不带键盘界面,日常使用无感(只在被临时切换的几秒内生效)。
 */
class GcInputMethodService : InputMethodService() {

    /** 空视图:不渲染任何键盘面板,避免切换瞬间遮挡屏幕。 */
    override fun onCreateInputView(): View = View(this)

    override fun onEvaluateFullscreenMode(): Boolean = false

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        instance = this
    }

    override fun onFinishInput() {
        super.onFinishInput()
        if (instance === this) instance = null
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        @Volatile
        var instance: GcInputMethodService? = null
            private set

        /** 向当前聚焦输入框提交 text(无任何连接时返回 false,调用方重试)。 */
        fun commit(text: String): Boolean {
            val ic = instance?.currentInputConnection ?: return false
            return ic.commitText(text, 1)
        }

        /** 把 text 插入到聚焦输入框内容的**开头**(光标先归位 setSelection(0,0))。
         *  用途:发布流程在 AI 生成的标题/描述前注入 4 位上架编码(首行即闲鱼标题)。 */
        fun commitAtStart(text: String): Boolean {
            val ic = instance?.currentInputConnection ?: return false
            if (!ic.setSelection(0, 0)) return false
            return ic.commitText(text, 1)
        }
    }
}
