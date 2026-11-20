package com.erp.groupcontrol.auto

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import com.erp.groupcontrol.gc.TaskExecutor

/**
 * 读取本机当前登录的闲鱼昵称（best-effort，真机最脆的一环）。
 *
 * 【为什么】服务端按 nick(昵称)绑定闲鱼账号，需要端上把「当前登录昵称」报上去(见 identity 帧)。
 * 昵称在闲鱼「我的」页顶部。
 *
 * ✅ 核心已真机校准(2026-07-23,小米 popsicle,昵称「嘻喵喵酱」):昵称 resource-id 与「我的」Tab 均已核实,
 *    昵称是原生可读 TextView(**无需 OCR**)。仅「未命中时的坐标兜底」仍为 best-effort。
 * 约束(务必保持)：
 *  · fail-soft：任何失败(无障碍未开 / 找不到节点 / 跳转异常 / 权限不足)一律返回 null，**绝不抛崩**。
 *  · 不改动 [XianyuAccessibilityService] 既有原语行为；不在此触发任何业务流程。
 *  · 破坏性导航(切到「我的」页)默认关闭，只有调用方显式 allowNavigate=true 且确认设备空闲时才走。
 */
object XianyuIdentity {

    private const val TAG = "XianyuIdentity"

    /**
     * 读取当前登录昵称。
     *
     * @param allowNavigate true=允许主动跳到「我的」页再读(**会切换闲鱼当前界面，可能打断正在执行的任务**，
     *        故调用方须确保此刻设备空闲)；false=只读**当前屏**(恰在个人页才读得到，否则 null)，非破坏性。
     * @return 昵称字符串；读不到返回 null。
     */
    fun readNick(context: Context, allowNavigate: Boolean = false): String? {
        val svc = XianyuAccessibilityService.instance ?: return null

        // 1) 先非破坏性地读当前屏(若恰在「我的」页能直接命中)。
        readNickFromCurrentScreen(svc)?.let { return it }

        // 2) 允许导航才走破坏性路径。
        if (!allowNavigate) return null
        return runCatching { navigateAndReadNick(context, svc) }
            .onFailure { Log.w(TAG, "navigateAndReadNick failed", it) }
            .getOrNull()
    }

    /**
     * 从当前屏节点树里找昵称。
     *
     * TODO(真机校准)：以下匹配全是**假设**，需用 `uiautomator dump` 抓闲鱼「我的」页后逐一核对替换：
     *  1) 昵称文本节点的 resource-id(闲鱼常见形如 "com.taobao.idlefish:id/xxx") → 填入 [NICK_RES_IDS]；
     *  2) 若无稳定 id，则用「我的」页锚点(如「编辑资料」「个人主页」)的相对位置定位昵称(见 [nearbyNick])；
     *  3) 「我的」页部分区块是 Flutter(节点读不到)——若昵称本身读不到，需回退 OCR(本文件不做)。
     */
    private fun readNickFromCurrentScreen(svc: XianyuAccessibilityService): String? {
        val root = svc.rootInActiveWindow ?: return null

        // 2a) 优先按 resource-id 精确取(最稳)。✅真机已核:个人页昵称 id 见 NICK_RES_IDS。
        for (rid in NICK_RES_IDS) {
            val text = root.findAccessibilityNodeInfosByViewId(rid)?.firstOrNull()
                ?.text?.toString()?.trim()
            // 占位文案(账号未设昵称时闲鱼显示「昵称未填写」)不算昵称:上报它会让多台
            // 未命名设备在服务端挤进同一个 Account(nick 唯一)互相顶设备,不如读空重试。
            if (!text.isNullOrEmpty() && text !in NICK_PLACEHOLDERS) {
                Log.i(TAG, "nick by res-id $rid")
                return text
            }
        }

        // 2b) 退化启发：找锚点，取其附近「像昵称」的文本。TODO(真机校准)：极可能取错，需按真实结构替换。
        for (anchor in NICK_ANCHORS) {
            val hits = root.findAccessibilityNodeInfosByText(anchor) ?: continue
            for (a in hits) nearbyNick(a)?.let { return it }
        }
        return null
    }

    /** 占位：取锚点父级下第一个「像昵称」的文本。TODO(真机校准)：替换为按真实节点关系定位。 */
    private fun nearbyNick(anchor: AccessibilityNodeInfo): String? {
        val parent = anchor.parent ?: return null
        for (i in 0 until parent.childCount) {
            val t = parent.getChild(i)?.text?.toString()?.trim()
            if (looksLikeNick(t)) return t
        }
        return null
    }

    private fun looksLikeNick(t: String?): Boolean {
        if (t.isNullOrEmpty() || t.length > 30) return false
        if (t.all { it.isDigit() }) return false      // 粉丝/关注等数字
        return t !in NICK_STOPWORDS && t !in NICK_PLACEHOLDERS
    }

    /**
     * 跳到「我的」页再读。**破坏性**：会把闲鱼切到个人页。
     *
     * TODO(真机校准)，按 `uiautomator dump` 逐一确认并替换：
     *  1) 拉起闲鱼：用无障碍服务实例作 context 发 startActivity，规避「后台应用主动拉起界面」被系统 abort；
     *  2) 点底部「我的」Tab —— 下面按 text/desc「我的」假设，真机需确认；失败应按坐标兜底(需按分辨率算，此处未做)；
     *  3) 等页面稳定后再读(闲鱼「我的」页含 Flutter，昵称未必是可读节点 → 读不到需回退 OCR，本文件不做)。
     */
    private fun navigateAndReadNick(context: Context, svc: XianyuAccessibilityService): String? {
        // 1) 拉起闲鱼(context 优先用无障碍服务实例，见 PrimitiveExecutor.launchApp 的同款理由)
        val launch = context.packageManager.getLaunchIntentForPackage(TaskExecutor.XIANYU_PKG)
            ?: return null
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        (XianyuAccessibilityService.instance ?: context).startActivity(launch)

        // 2) 冷启动+开屏广告要数秒,固定 sleep 太短会读空 → 轮询等昵称节点(上次可能就停在「我的」页)。
        pollNick(svc, NAV_WAIT_LAUNCH_MS)?.let { return it }

        // 3) 点底部「我的」Tab 再轮询等。✅真机已核(2026-07-23):tab 标题 text="我的"(resource-id .../tab_title,
        //    本身不可点),可点祖先 content-desc="我的，未选中状态";svc.click 会就近 climb 到可点祖先。
        //    用精确 text=="我的" 命中 tab 标题(避免 findByText 的 CONTAINS 误命中信息流里的「我的xxx」)。
        val root = svc.rootInActiveWindow
        val tab = root?.findAccessibilityNodeInfosByText(TAB_MINE)?.firstOrNull { it.text?.toString() == TAB_MINE }
            ?: svc.findByText(TAB_MINE)
        if (tab != null) {
            svc.click(tab)
        }
        // else:未命中时留待按分辨率坐标兜底(当前设备 click-climb 已验证可达,暂不需要)。
        return pollNick(svc, NAV_WAIT_PAGE_MS)
    }

    /**
     * 读闲鱼会员名(tb 开头)。best-effort,不保证成功(页面结构随版本变;读不到返回 null,员工手填兜底)。
     *
     * 路径:「我的」页顶部昵称区 → 个人资料页 → 找匹配 `^tb[0-9a-zA-Z_]{3,}$` 的节点文本/desc;
     * 读完按一次返回键回上一页。全程 fail-soft,绝不抛崩、不做业务操作。
     */
    fun readMemberName(context: Context): String? {
        val svc = XianyuAccessibilityService.instance ?: return null
        // 1) 当前屏直接命中(恰在资料页)
        findMemberNameOnScreen(svc)?.let { return it }
        // 2) 点「我的」页顶部昵称区进资料页(此刻闲鱼须已在「我的」页,昵称读取刚走过这条路径)
        val nickNode = runCatching {
            val root = svc.rootInActiveWindow ?: return@runCatching null
            NICK_RES_IDS.firstNotNullOfOrNull { rid ->
                root.findAccessibilityNodeInfosByViewId(rid)?.firstOrNull()
            }
        }.getOrNull()
        if (nickNode != null) {
            runCatching { svc.click(nickNode) }
            val deadline = SystemClock.elapsedRealtime() + MEMBER_WAIT_PAGE_MS
            while (SystemClock.elapsedRealtime() < deadline) {
                findMemberNameOnScreen(svc)?.let {
                    runCatching { svc.globalBack() }
                    return it
                }
                sleep(POLL_INTERVAL_MS)
            }
            runCatching { svc.globalBack() }  // 没找到也退回,别把人留在资料页
        }
        return null
    }

    /** 在当前屏节点树里找会员名:文本或 desc 匹配 tb 开头 ID。 */
    private fun findMemberNameOnScreen(svc: XianyuAccessibilityService): String? {
        val root = runCatching { svc.rootInActiveWindow }.getOrNull() ?: return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            val candidates = listOfNotNull(
                n.text?.toString()?.trim(),
                n.contentDescription?.toString()?.trim(),
            )
            for (c in candidates) {
                if (MEMBER_NAME_REGEX.matches(c)) return c
            }
            for (i in 0 until n.childCount) {
                n.getChild(i)?.let(queue::add)
            }
        }
        return null
    }

    /** 轮询读昵称节点直到出现或超时(替代固定 sleep:冷启动快慢差异大,读到即返回)。 */
    private fun pollNick(svc: XianyuAccessibilityService, timeoutMs: Long): String? {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (SystemClock.elapsedRealtime() < deadline) {
            readNickFromCurrentScreen(svc)?.let { return it }
            sleep(POLL_INTERVAL_MS)
        }
        return null
    }

    private fun sleep(ms: Long) {
        try { Thread.sleep(ms) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
    }

    // ==== 以下常量全部为占位假设，TODO(真机校准)务必用真机 dump 校验后替换 ====

    /** 昵称文本节点的 resource-id。✅真机已核(2026-07-23,小米 popsicle):
     *  「我的」页顶部昵称 = com.taobao.idlefish:id/personal_user_info_nick_name
     *  (原生 TextView,可直读,**无需 OCR**)。 */
    private val NICK_RES_IDS = listOf("com.taobao.idlefish:id/personal_user_info_nick_name")

    /** 「我的」页用于定位昵称的锚点文案。TODO(真机校准)：确认真实存在且稳定。 */
    private val NICK_ANCHORS = listOf("编辑资料", "个人主页")

    /** 定位时需排除的固定文案，避免把它们误当昵称。 */
    private val NICK_STOPWORDS = setOf("我的", "编辑资料", "个人主页", "粉丝", "关注", "获赞", "浏览", "收藏", "足迹")

    /** 底部「我的」Tab 文案。✅真机已核(2026-07-23)。 */
    private const val TAB_MINE = "我的"

    /** 账号未设昵称时闲鱼昵称位的占位文案;读到一律视为「未读到」。 */
    private val NICK_PLACEHOLDERS = setOf("昵称未填写")

    // 以下两个常量是「轮询截止时长」而非固定 sleep:冷启动快慢差异大,读到昵称即提前返回。
    private const val NAV_WAIT_LAUNCH_MS = 9_000L
    private const val NAV_WAIT_PAGE_MS = 6_000L
    private const val POLL_INTERVAL_MS = 500L

    /** 会员名(tb 开头)匹配:tb + 至少 3 位数字/字母/下划线(如 tb052254232)。 */
    private val MEMBER_NAME_REGEX = Regex("^tb[0-9a-zA-Z_]{3,}$")
    private const val MEMBER_WAIT_PAGE_MS = 5_000L
}
