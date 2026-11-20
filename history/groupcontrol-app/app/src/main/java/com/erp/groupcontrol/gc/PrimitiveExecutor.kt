package com.erp.groupcontrol.gc

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.MediaStore
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import com.erp.groupcontrol.auto.XianyuAccessibilityService
import com.google.gson.Gson
import com.google.gson.JsonObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * 原语执行器(V2「手」):把服务端流程引擎经 RPC 下发的原语落到设备动作,回 rpc_resp。
 *
 * 设计原则:**只做手,不做脑**。这里每个 op 都是稳定的物理动作(截屏/点/滑/输入/dump/拉起),
 * 不含任何闲鱼业务流程逻辑——流程判断全在服务端 app/flow/。闲鱼改版不影响本文件。
 *
 * 需要读屏/点击的原语依赖 [XianyuAccessibilityService];未开启无障碍则回 ok=false。
 * 由 [GcService] 在单线程执行器上串行调用(一机一时刻一个原语),勿在 MQTT 回调线程直接跑。
 */
class PrimitiveExecutor(private val context: Context) {

    private val gson = Gson()

    /** 执行一个原语,返回可直接 publish 的 rpc_resp JSON 字符串。 */
    fun handle(rpc: GcRpc): String {
        return try {
            val data = dispatch(rpc)
            GcProtocol.rpcResp(rpc.reqId, ok = true, data = data)
        } catch (e: PrimitiveError) {
            GcProtocol.rpcResp(rpc.reqId, ok = false, err = e.message)
        } catch (e: Exception) {
            GcProtocol.rpcResp(rpc.reqId, ok = false, err = "原语异常:${e.message}")
        }
    }

    private class PrimitiveError(msg: String) : Exception(msg)

    private fun svc(): XianyuAccessibilityService =
        XianyuAccessibilityService.instance ?: throw PrimitiveError("无障碍服务未开启")

    private fun dispatch(rpc: GcRpc): JsonObject {
        val data = JsonObject()
        when (rpc.op) {
            "screencap" -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R)
                    throw PrimitiveError("截屏需 Android 11+(takeScreenshot)")
                val jpeg = svc().screenshotJpeg(quality = rpc.int("quality", 60))
                    ?: throw PrimitiveError("截屏失败")
                data.addProperty("image_b64", Base64.encodeToString(jpeg, Base64.NO_WRAP))
                data.addProperty("bytes", jpeg.size)
            }

            "tap" -> if (!svc().tap(rpc.int("x"), rpc.int("y"), rpc.int("ms", 60).toLong()))
                throw PrimitiveError("点击派发失败")

            "long_press" -> if (!svc().longPress(rpc.int("x"), rpc.int("y"), rpc.int("ms", 900).toLong()))
                throw PrimitiveError("长按派发失败")

            "swipe" -> if (!svc().swipe(rpc.int("x1"), rpc.int("y1"), rpc.int("x2"), rpc.int("y2"), rpc.int("ms", 300)))
                throw PrimitiveError("滑动派发失败")

            "key" -> when (rpc.str("code")?.uppercase()) {
                "BACK" -> svc().globalBack()
                "HOME" -> svc().globalHome()
                "WAKEUP" -> wakeScreen()
                else -> throw PrimitiveError("不支持的按键 ${rpc.str("code")}")
            }

            "set_text" -> {
                val text = rpc.str("text") ?: ""
                if (!svc().setFocusedText(text)) throw PrimitiveError("未找到聚焦输入框")
            }

            "set_clipboard" -> {
                val text = rpc.str("text") ?: ""
                if (!svc().setClipboard(text)) throw PrimitiveError("剪贴板写入失败")
            }

            "ime_picker" -> {
                // 弹系统输入法选择器(切换/切回的条目点击由服务端 OCR 完成,见 ImeInjector)
                ImeInjector.showPicker(context)
            }

            "ime_commit" -> {
                // 等 InputConnection 就绪后 commitText(需已通过选择器切到内置 IME)
                val text = rpc.str("text") ?: ""
                if (!ImeInjector.commit(text)) throw PrimitiveError("IME 提交失败(未切换/焦点丢失)")
            }

            "ime_prefix" -> {
                // 把 text 插到聚焦输入框内容开头(发布标题注入 4 位编码用,见 ImeInjector)
                val text = rpc.str("text") ?: ""
                if (!ImeInjector.commitAtStart(text)) throw PrimitiveError("IME 前缀注入失败(焦点丢失)")
            }

            "dump_nodes" -> {
                data.add("nodes", gson.toJsonTree(svc().dumpNodes()))
            }

            "node_click" -> {
                val desc = rpc.str("desc") ?: throw PrimitiveError("缺 desc")
                if (!svc().clickNodeByDesc(desc, rpc.int("index", 0)))
                    throw PrimitiveError("未找到可点节点 desc=$desc")
            }

            "node_long_click" -> {
                // 语义长按(Flutter 输入框弹「粘贴」菜单用;手势长按在 Flutter 不生效,见服务内注释)
                val desc = rpc.str("desc") ?: throw PrimitiveError("缺 desc")
                if (!svc().longClickNodeByDesc(desc, rpc.int("index", 0)))
                    throw PrimitiveError("未找到可长按节点 desc=$desc")
            }

            "launch_app" -> launchApp(rpc.str("pkg") ?: throw PrimitiveError("缺 pkg"))

            "force_stop" -> {
                // 非 root 无法真正 force-stop 他应用:降级为回主页(清出前台),流程靠「放弃草稿」兜底
                svc().globalHome()
                data.addProperty("degraded", true)
            }

            "screen_size" -> {
                val (w, h) = screenSize()
                data.addProperty("w", w); data.addProperty("h", h)
            }

            "push_media" -> {
                val uri = pushMedia(rpc.str("url") ?: throw PrimitiveError("缺 url"))
                data.addProperty("uri", uri)   // 供流程记账，发布完精确删除
            }

            "clear_media" -> {
                val arr = rpc.args.getAsJsonArray("uris")
                val uris = arr?.mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString }
                data.addProperty("deleted", clearMedia(uris))
            }

            // 环境自检：让调度端在派发前就能识破「设备 ONLINE 但实际失能」——
            // 无障碍未真正绑定、截屏拿不到字节这类问题，只看在线状态永远看不出来。
            "self_check" -> {
                val items = Preflight.run(context, probe = rpc.bool("probe", true))
                Preflight.toJson(items).entrySet().forEach { (k, v) -> data.add(k, v) }
            }

            else -> throw PrimitiveError("未知原语 ${rpc.op}")
        }
        return data
    }

    // ---- 具体实现 ----
    private fun wakeScreen() {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        @Suppress("DEPRECATION")
        val wl = pm.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "gc:wake",
        )
        wl.acquire(3000)
        try { Thread.sleep(300) } catch (_: InterruptedException) {}
        if (wl.isHeld) wl.release()
    }

    /**
     * 拉起目标应用。
     *
     * 【2026-07-21 真机实测】用 applicationContext.startActivity 会让本进程被 MIUI 额外降级：
     * oom_score_adj 50 → 200，随后整个 App 被冻结，之后所有原语(连不依赖无障碍的 screen_size)
     * 一律超时，设备表面在线实则失能。对照：同样退到后台，若闲鱼是被 adb 拉起的则维持 50、原语正常。
     * 差别只在「是否由本进程主动 startActivity」。改用无障碍服务实例作 context——它由系统绑定，
     * 发起的 Activity 启动不算「后台应用主动拉起界面」。
     */
    private fun launchApp(pkg: String) {
        val intent = context.packageManager.getLaunchIntentForPackage(pkg)
            ?: throw PrimitiveError("未安装 $pkg")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val ctx: Context = XianyuAccessibilityService.instance ?: context
        ctx.startActivity(intent)
    }

    private fun screenSize(): Pair<Int, Int> {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val b = wm.currentWindowMetrics.bounds
            b.width() to b.height()
        } else {
            val m = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(m)
            m.widthPixels to m.heightPixels
        }
    }

    /**
     * 下载 url 图片入相册 + 媒体扫描(发布选图用)。
     * 服务端只会传 sku/product/ 前缀的 OSS 签名 URL;禁传 asset 订单截图(_order_)与 sku/location/(隐私/库位)。
     */
    /** 下载商品图入相册，返回 MediaStore uri（调用方须记下来，发布完用 clear_media 删掉）。 */
    private fun pushMedia(url: String): String {
        val bytes = URL(url).let {
            val conn = it.openConnection() as HttpURLConnection
            conn.connectTimeout = 15000; conn.readTimeout = 30000
            conn.inputStream.use { s -> s.readBytes() }
        }
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, mediaName(bytes))
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Images.Media.RELATIVE_PATH, GC_MEDIA_DIR)
            }
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: throw PrimitiveError("MediaStore 写入失败")
        resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw PrimitiveError("写图失败")
        return uri.toString()
    }

    /**
     * 删除本端写入相册的商品图。
     *
     * 【为什么必须有】push_media 只写不删，图会一直堆在 DCIM/gc/：
     * ①占存储(单机 300 件 × 数张，几百 MB 且永不回收)；
     * ②更危险的是 step_images 靠「点最新的 N 张」选图——残留一多，时序稍有偏差
     *   就会把上一个商品的图发到这个商品上（发错图）。
     * 传 uris 则精确删；不传则清掉本 App 写进 DCIM/gc 的全部图片。
     * 作用域存储下本 App 只能删自己写入的媒体，不会碰用户相册里的其他照片。
     */
    private fun clearMedia(uris: List<String>?): Int {
        val resolver = context.contentResolver
        if (!uris.isNullOrEmpty()) {
            var n = 0
            uris.forEach { u -> runCatching { n += resolver.delete(Uri.parse(u), null, null) } }
            return n
        }
        return runCatching {
            resolver.delete(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                "${MediaStore.Images.Media.RELATIVE_PATH} LIKE ?",
                arrayOf("%$GC_MEDIA_DIR%"),
            )
        }.getOrDefault(0)
    }

    /**
     * 入相册文件名：毫秒时间戳转 36 进制 + 内容 MD5 前 8 位（与服务端 OSS 命名一致，
     * 见 py-api app/services/oss.py upload_filename）。原来只按毫秒起名，同工位几个执行端
     * 同一毫秒下载不同货的图会撞名互串（2026-10-15 显示器 4 图撞名事件的服务端侧同款隐患）。
     */
    private fun mediaName(bytes: ByteArray): String {
        val ms36 = System.currentTimeMillis().toString(36)
        val md5 = MessageDigest.getInstance("MD5")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
            .substring(0, 8)
        return "gc_${ms36}_$md5.jpg"
    }

    companion object {
        /** 商品图落地目录（相对 external）。push_media 写这里，clear_media 只清这里。 */
        private const val GC_MEDIA_DIR = "DCIM/gc"
    }
}
