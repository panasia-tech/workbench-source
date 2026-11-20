package com.erp.groupcontrol.ui

import android.Manifest
import android.app.ActivityManager
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.Window
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.VideoView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.erp.groupcontrol.BuildConfig
import com.erp.groupcontrol.R
import com.erp.groupcontrol.databinding.ActivityMainBinding
import com.erp.groupcontrol.gc.FileLogger
import com.erp.groupcontrol.gc.GcBus
import com.erp.groupcontrol.gc.GcConnState
import com.erp.groupcontrol.gc.GcHealth
import com.erp.groupcontrol.gc.GcService
import com.erp.groupcontrol.gc.Preflight
import com.erp.groupcontrol.gc.Prefs
import com.erp.groupcontrol.gc.TaskExecutor
import com.erp.groupcontrol.gc.UpdateCheck
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/**
 * 执行端唯一界面(设计稿「鱼鱼小助手」还原):状态 hero + 账号卡 + 主按钮 + 自检/日志折叠卡。
 * 成员零填写;broker/身份配置全部来自 BuildConfig + enroll,高级调试区连点标题 5 次展开。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs
    private var checkedOnce = false
    private var titleTapCount = 0
    private var lastTitleTapAt = 0L

    // 当前自检结果(主按钮启用判定用):key → ok(true/false/null)
    private var checkItems: Map<String, Boolean?> = emptyMap()
    private var selfCheckRunning = false
    private var connState: GcConnState = GcConnState.DISCONNECTED

    // 通知权限请求结果的挂起点:启动引导链在此挂起等用户当场授权/拒绝
    private var notifContinuation: CancellableContinuation<Unit>? = null
    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            notifContinuation?.resumeWith(Result.success(Unit))
            notifContinuation = null
        }
    // 读取设备信息权限(SN/IMEI/手机号采集)的请求挂起点
    private var phoneContinuation: CancellableContinuation<Unit>? = null
    private val phonePermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            phoneContinuation?.resumeWith(Result.success(Unit))
            phoneContinuation = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = Prefs(this)
        FileLogger.init(this)
        GcHealth.init(this)

        binding.tvVerTag.text = "v${BuildConfig.VERSION_NAME}"
        renderHeroMeta()
        renderAccount()
        refreshMainButton()

        binding.btnToggle.setOnClickListener { toggleService() }
        binding.btnAcct.setOnClickListener { onAccountButton() }
        binding.llCheckHead.setOnClickListener { toggleFold(binding.llCheckBody, binding.ivCheckChev) }
        binding.llLogHead.setOnClickListener { toggleFold(binding.tvLog, binding.ivLogChev) }
        binding.btnRecheck.setOnClickListener { runSelfCheck(probe = true) }
        binding.btnAccessibility.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        binding.btnSave.setOnClickListener { saveForm() }
        binding.tvTitle.setOnClickListener { onTitleTap() }

        observeBus()
        maybeAutoStart()
        // 启动引导链:权限检查 → 自检 → 进入等待接单状态(见 startAutoFlow)
        startAutoFlow()
        // 版本更新检查(独立于引导链,不阻塞启动)
        checkAppUpdate()
        // 开屏页淡出
        binding.llBoot.animate().alpha(0f).setStartDelay(900).setDuration(400).withEndAction {
            binding.llBoot.visibility = View.GONE
        }.start()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent) // 更新 intent,供 maybeAutoStart 读最新 extra
        maybeAutoStart()
    }

    // ---- 启动引导链:权限检查 → 自检 → 等待接单 ----

    private var autoFlowStarted = false

    /**
     * App 启动后的自动引导,严格按序串行,任何一步失败只记日志不崩:
     * 1) 权限检查:通知权限+读取设备信息权限当场弹框授权(挂起等结果);无障碍/悬浮窗/电池等无法
     *    代码授权的项,交给下一步自检逐项展示并提供修复跳转;
     * 2) 自检:含能力实测(probe=true),启动这一次必须真测,别带着「权限位对但能力废」的环境上线;
     * 3) 无阻塞项(全绿或仅黄项)且服务未在跑 → 自动启动 GcService,连上调度中心后即为等待接单状态;
     *    有红项则不启动,等成员按提示修好(onResume 会自动复检)。
     */
    private fun startAutoFlow() {
        if (autoFlowStarted) return
        autoFlowStarted = true
        lifecycleScope.launch {
            GcBus.appendLog("启动引导:1/3 权限检查…")
            awaitNotifPermission()
            awaitPhoneStatePermission()

            GcBus.appendLog("启动引导:2/3 自检…")
            val items = doSelfCheck(probe = true)
            if (items.isEmpty()) {
                GcBus.appendLog("自检未拿到结果,跳过自动启动;请点「重新自检」")
                return@launch
            }

            // mqtt 项不算阻塞:此时服务多半还没起,「未连接」正是下一步自动启动要解决的,不能拿它拦启动
            val blocking = items.filter { it.ok == false && it.key != "mqtt" }
            if (blocking.isNotEmpty()) {
                GcBus.appendLog("自检未通过(${blocking.joinToString(",") { it.label }}),未自动启动;修好红项后点「重新自检」或手动启动")
                return@launch
            }
            if (!isGcServiceRunning()) {
                if (prefs.brokerHost.isBlank()) {
                    GcBus.appendLog("自检通过但 broker 主机为空(检查构建变体),未自动启动")
                    return@launch
                }
                GcBus.appendLog("启动引导:3/3 自检通过,自动启动服务,进入等待接单状态")
                GcService.start(this@MainActivity)
            } else {
                GcBus.appendLog("启动引导:3/3 自检通过,服务已在运行(等待接单)")
            }
        }
    }

    /** 挂起等通知权限的当场授权结果;已授权或系统无需该权限时立即返回。 */
    private suspend fun awaitNotifPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED
        ) return
        GcBus.appendLog("请求通知权限(前台服务保活需要)…")
        suspendCancellableCoroutine { cont ->
            notifContinuation = cont
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    /** 挂起等「读取设备信息」权限结果(账号档案采集 SN/IMEI/手机号);已授权立即返回,拒绝不阻塞引导。 */
    private suspend fun awaitPhoneStatePermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE)
            == PackageManager.PERMISSION_GRANTED
        ) return
        GcBus.appendLog("请求读取设备信息权限(采集序列号/IMEI/手机号)…")
        suspendCancellableCoroutine { cont ->
            phoneContinuation = cont
            phonePermission.launch(Manifest.permission.READ_PHONE_STATE)
        }
    }

    /**
     * ADB 拉活入口:am start ... --ez autostart true 时自动启动 GcService(不干扰用户手动启停)。
     * 判定用「服务是否真在跑」,不能信 GcBus.state——服务被 MIUI 杀掉而进程存活时,
     * state 会卡在 CONNECTED/CONNECTING 旧值,导致拉活被静默跳过(线上真实事故)。
     */
    private fun maybeAutoStart() {
        if (intent?.getBooleanExtra("autostart", false) != true) return
        if (isGcServiceRunning()) return
        if (prefs.brokerHost.isBlank()) {
            GcBus.appendLog("拉活跳过:broker 主机为空(检查构建变体)")
            return
        }
        GcBus.appendLog("收到拉活指令:GcService 未运行,自动启动")
        GcService.start(this)
    }

    /** 系统级服务表里查本应用 GcService 是否真在跑(只看自己进程,API26+ 依然可靠)。 */
    private fun isGcServiceRunning(): Boolean {
        val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        @Suppress("DEPRECATION")
        return am.getRunningServices(Int.MAX_VALUE)
            .any { it.service.className == GcService::class.java.name }
    }

    override fun onResume() {
        super.onResume()
        // 从设置页改完开关回来自动复检,省得人工再点一次。
        if (checkedOnce) runSelfCheck(probe = false)
        renderAccount()
        renderHeroMeta()
    }

    // ---- 折叠卡 ----

    private fun toggleFold(body: View, chev: ImageView) {
        val open = body.visibility != View.VISIBLE
        body.visibility = if (open) View.VISIBLE else View.GONE
        chev.animate().rotation(if (open) 180f else 0f).setDuration(250).start()
    }

    // ---- hero(状态卡) ----

    private fun renderHeroMeta() {
        binding.tvHeroModel.text = Build.MODEL
        binding.tvHeroDevId.text =
            prefs.deviceId.takeIf { it.isNotBlank() }?.let { "设备 ${it.takeLast(4).uppercase()}" } ?: "未注册"
        binding.tvHeroNet.text = networkText()
    }

    private fun networkText(): String = runCatching {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        @Suppress("DEPRECATION")
        when {
            cm.activeNetworkInfo == null -> "无网络"
            cm.activeNetworkInfo?.type == ConnectivityManager.TYPE_WIFI -> "Wi-Fi"
            else -> "蜂窝网络"
        }
    }.getOrDefault("")

    private fun renderState(s: GcConnState) {
        connState = s
        when (s) {
            GcConnState.CONNECTED -> {
                binding.viewPulse.setBackgroundResource(R.drawable.yy_pulse_on)
                binding.tvConn.text = "已连接 · 等待接单"
                binding.tvConnSub.text = "服务运行中，可接收任务指令"
                binding.tvConnChip.apply {
                    text = "在线"
                    setBackgroundResource(R.drawable.yy_chip_on)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.yy_green))
                }
            }
            GcConnState.CONNECTING -> {
                binding.viewPulse.setBackgroundResource(R.drawable.yy_pulse_mid)
                binding.tvConn.text = "连接中"
                binding.tvConnSub.text = "正在建立安全连接…"
                binding.tvConnChip.apply {
                    text = "连接中"
                    setBackgroundResource(R.drawable.yy_chip_mid)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.yy_orange))
                }
            }
            GcConnState.DISCONNECTED -> {
                binding.viewPulse.setBackgroundResource(R.drawable.yy_pulse_off)
                binding.tvConn.text = "未启动"
                binding.tvConnSub.text = "服务尚未运行"
                binding.tvConnChip.apply {
                    text = "离线"
                    setBackgroundResource(R.drawable.yy_chip_off)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.yy_ink3))
                }
            }
        }
        refreshMainButton()
    }

    /** 主按钮状态(对齐设计稿):运行中=黑色「停止服务」;未跑=黄色「启动服务」,条件不满足时禁用+提示。 */
    private fun refreshMainButton() {
        val running = connState != GcConnState.DISCONNECTED
        val btn = binding.btnToggle
        val hint = binding.tvBtnHint
        if (connState == GcConnState.CONNECTING) {
            btn.text = "启动中…"
            btn.setBackgroundResource(R.drawable.yy_btn_disabled)
            btn.setTextColor(ContextCompat.getColor(this, R.color.yy_ink3))
            btn.isEnabled = false
            hint.text = ""
            return
        }
        if (running) {
            btn.text = "停止服务"
            btn.setBackgroundResource(R.drawable.yy_btn_stop)
            btn.setTextColor(Color.WHITE)
            btn.isEnabled = true
            hint.text = ""
            return
        }
        btn.text = "启动服务"
        val accountBound = prefs.xianyuNick.isNotBlank()
        val checkDone = checkItems.isNotEmpty()
        val hasErr = checkItems.any { it.value == false && it.key != "mqtt" }
        when {
            !accountBound -> {
                btn.isEnabled = false
                hint.text = "请先绑定闲鱼账号"
            }
            !checkDone -> {
                btn.isEnabled = false
                hint.text = "正在等待环境自检完成"
            }
            hasErr -> {
                btn.isEnabled = false
                hint.text = "存在异常项，修复后才能启动服务"
            }
            else -> {
                btn.isEnabled = true
                hint.text = ""
            }
        }
        if (btn.isEnabled) {
            btn.setBackgroundResource(R.drawable.yy_btn_start)
            btn.setTextColor(ContextCompat.getColor(this, R.color.yy_ink))
        } else {
            btn.setBackgroundResource(R.drawable.yy_btn_disabled)
            btn.setTextColor(ContextCompat.getColor(this, R.color.yy_ink3))
        }
    }

    // ---- 账号卡 ----

    private fun renderAccount() {
        val nick = prefs.xianyuNick.takeIf { it.isNotBlank() }
        if (nick != null) {
            binding.tvAvatar.apply {
                setBackgroundResource(R.drawable.yy_avatar_bound)
                text = nick.first().toString()
            }
            binding.ivAvatarIcon.visibility = View.GONE
            binding.tvAcctName.text = nick
            val member = prefs.xianyuMemberName.takeIf { it.isNotBlank() }
            binding.tvAcctDesc.text = member?.let { "会员名 $it" } ?: "任务将执行到该账号"
            binding.btnAcct.apply {
                text = "管理"
                setBackgroundResource(0)
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.yy_ink2))
            }
            binding.llAcctWarn.visibility = View.GONE
        } else {
            binding.tvAvatar.apply {
                setBackgroundResource(R.drawable.yy_avatar_empty)
                text = ""
            }
            binding.ivAvatarIcon.visibility = View.VISIBLE
            binding.tvAcctName.text = "未绑定闲鱼账号"
            binding.tvAcctDesc.text = "绑定后任务将执行到该账号"
            binding.btnAcct.apply {
                text = "去绑定"
                setBackgroundResource(R.drawable.yy_btn_stop)
                setTextColor(Color.WHITE)
            }
            binding.llAcctWarn.visibility = View.VISIBLE
        }
        refreshMainButton()
    }

    private fun onAccountButton() {
        if (prefs.xianyuNick.isNotBlank()) {
            showUnbindDialog()
        } else {
            // 绑定是自动的(昵称读到即绑):拉起闲鱼让成员确认登录,服务自检链会自动完成绑定
            val launch = packageManager.getLaunchIntentForPackage(TaskExecutor.XIANYU_PKG)
            if (launch != null) {
                GcBus.appendLog("拉起闲鱼:请确认已登录目标账号,返回后自动完成绑定")
                startActivity(launch)
            } else {
                GcBus.appendLog("未检测到闲鱼 App,请先安装")
            }
        }
    }

    private fun showUnbindDialog() {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_unbind, null)
        dialog.setContentView(view)
        dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        view.findViewById<TextView>(R.id.btnUnbindCancel).setOnClickListener { dialog.dismiss() }
        view.findViewById<TextView>(R.id.btnUnbindOk).setOnClickListener {
            dialog.dismiss()
            val old = prefs.xianyuNick
            prefs.xianyuNick = ""
            prefs.xianyuMemberName = ""
            GcBus.appendLog("已解绑闲鱼账号:$old(服务端记录保留,下次读到昵称会自动重绑)")
            renderAccount()
        }
        dialog.show()
    }

    // ---- 环境自检 ----

    private fun runSelfCheck(probe: Boolean = true) {
        lifecycleScope.launch { doSelfCheck(probe) }
    }

    /** 自检本体(挂起版):IO 线程跑 Preflight、主线程渲染,返回检查项供启动引导链判定。 */
    private suspend fun doSelfCheck(probe: Boolean): List<Preflight.Item> {
        checkedOnce = true
        if (selfCheckRunning) return emptyList()
        selfCheckRunning = true
        binding.btnRecheck.isEnabled = false
        setCheckPill("检测中…", PillKind.RUN)
        binding.llConclusion.visibility = View.GONE
        val t0 = System.currentTimeMillis()
        val items = withContext(Dispatchers.IO) {
            runCatching { Preflight.run(applicationContext, probe = probe) }
                .getOrElse {
                    GcBus.appendLog("自检异常:${it.message}")
                    emptyList()
                }
        }
        renderSelfCheck(items)
        binding.tvElapsed.text = "耗时 ${"%.1f".format((System.currentTimeMillis() - t0) / 1000f)}s"
        binding.btnRecheck.isEnabled = true
        selfCheckRunning = false
        return items
    }

    private enum class PillKind { RUN, OK, BAD }

    private fun setCheckPill(text: String, kind: PillKind) {
        binding.tvCheckPill.apply {
            this.text = text
            when (kind) {
                PillKind.RUN -> {
                    setBackgroundResource(R.drawable.yy_chip_run)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.yy_blue_run))
                }
                PillKind.OK -> {
                    setBackgroundResource(R.drawable.yy_chip_on)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.yy_green))
                }
                PillKind.BAD -> {
                    setBackgroundResource(R.drawable.yy_chip_bad)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.yy_red))
                }
            }
        }
    }

    private fun renderSelfCheck(items: List<Preflight.Item>) {
        val box = binding.llCheck
        box.removeAllViews()
        checkItems = items.associate { it.key to it.ok }

        if (items.isEmpty()) {
            setCheckPill("自检异常", PillKind.BAD)
            box.addView(TextView(this).apply {
                text = "🟡 自检异常，请稍后点「重新自检」再试"
                textSize = 12f
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.yy_orange))
                setPadding(12, 8, 12, 8)
            })
            refreshMainButton()
            return
        }

        val inflater = LayoutInflater.from(this)
        for (item in items) {
            box.addView(buildCheckRow(inflater, item))
            when (item.ok) {
                false -> GcBus.appendLog("自检[${item.label}] 异常:${item.detail}")
                null -> GcBus.appendLog("自检[${item.label}] 未知:${item.detail}")
                else -> {}
            }
        }

        val errs = items.filter { it.ok == false }
        val unks = items.filter { it.ok == null }
        if (errs.isEmpty() && unks.isEmpty()) {
            setCheckPill("全部正常", PillKind.OK)
            binding.llConclusion.apply {
                setBackgroundResource(R.drawable.yy_conclusion_ok)
                visibility = View.VISIBLE
            }
            binding.ivConclusionIcon.setImageResource(R.drawable.yy_ic_ok)
            binding.tvConclusion.apply {
                text = "全部正常 · ${items.size}/${items.size} 项通过"
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.yy_green_text))
            }
        } else {
            setCheckPill("${errs.size + unks.size} 项待处理", PillKind.BAD)
            binding.llConclusion.apply {
                setBackgroundResource(R.drawable.yy_conclusion_bad)
                visibility = View.VISIBLE
            }
            binding.ivConclusionIcon.setImageResource(R.drawable.yy_ic_err)
            binding.tvConclusion.apply {
                text = buildString {
                    if (errs.isNotEmpty()) append("${errs.size} 项异常（必须修复）")
                    if (unks.isNotEmpty()) {
                        if (isNotEmpty()) append("，")
                        append("${unks.size} 项未知（需人工确认）")
                    }
                    append("\n点击异常项可跳转对应设置页")
                }
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.yy_red_text))
            }
            // 有异常自动展开,让成员看到
            binding.llCheckBody.visibility = View.VISIBLE
            binding.ivCheckChev.rotation = 180f
        }

        // 无障碍未绑定才显示红色大按钮——成员最常要点的修复入口
        val a11yBad = items.any { it.key == "accessibility" && it.ok == false }
        binding.btnAccessibility.visibility = if (a11yBad) View.VISIBLE else View.GONE

        refreshMainButton()
    }

    /** 单行检查项(设计稿):图标 + 名称 + 状态 + 引导视频/去修复 chip(异常或未知时)。 */
    private fun buildCheckRow(inflater: LayoutInflater, item: Preflight.Item): View {
        val row = inflater.inflate(R.layout.item_check, binding.llCheck, false)
        val icon = row.findViewById<ImageView>(R.id.ivChkIcon)
        val name = row.findViewById<TextView>(R.id.tvChkName)
        val video = row.findViewById<TextView>(R.id.tvChkVideo)
        val status = row.findViewById<TextView>(R.id.tvChkStatus)
        val fix = row.findViewById<TextView>(R.id.tvChkFix)
        name.text = item.label
        when (item.ok) {
            true -> {
                icon.setImageResource(R.drawable.yy_ic_ok)
                status.text = "正常"
                status.setTextColor(ContextCompat.getColor(this, R.color.yy_green))
            }
            false -> {
                icon.setImageResource(R.drawable.yy_ic_err)
                status.text = "异常"
                status.setTextColor(ContextCompat.getColor(this, R.color.yy_red))
                fix.text = "去修复"
                fix.setBackgroundResource(R.drawable.yy_chip_bad)
                fix.setTextColor(ContextCompat.getColor(this, R.color.yy_red))
                fix.visibility = View.VISIBLE
                video.visibility = View.VISIBLE
            }
            null -> {
                icon.setImageResource(R.drawable.yy_ic_unk)
                status.text = "未知"
                status.setTextColor(ContextCompat.getColor(this, R.color.yy_orange))
                fix.text = "需确认"
                fix.setBackgroundResource(R.drawable.yy_chip_mid)
                fix.setTextColor(ContextCompat.getColor(this, R.color.yy_orange))
                fix.visibility = View.VISIBLE
                video.visibility = View.VISIBLE
            }
        }
        val openFix = View.OnClickListener {
            item.action?.let { act ->
                if (!Preflight.openFix(this, act)) GcBus.appendLog("打不开设置页:${item.key}")
            }
        }
        fix.setOnClickListener(openFix)
        if (item.ok != true) row.setOnClickListener(openFix)
        video.setOnClickListener { showGuideVideo(item) }
        return row
    }

    // ---- 引导视频 ----

    /** 检查项 → 引导视频(内置 res/raw;线上可换 OSS 地址,结构已留接口)。 */
    private fun guideVideoFor(key: String): String = when (key) {
        "accessibility", "probe_nodes" -> "guide_a11y"
        "battery_opt", "keepalive" -> "guide_battery"
        "overlay", "probe_bg_start" -> "guide_float"
        else -> "guide_common"
    }

    private fun showGuideVideo(item: Preflight.Item) {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_guide_video, null)
        dialog.setContentView(view)
        dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        view.findViewById<TextView>(R.id.tvGuideTitle).text = "${item.label} · 操作引导"
        val player = view.findViewById<VideoView>(R.id.videoGuide)
        val loading = view.findViewById<LinearLayout>(R.id.llGuideLoading)
        player.setVideoPath("android.resource://$packageName/raw/${guideVideoFor(item.key)}")
        player.setOnPreparedListener {
            loading.visibility = View.GONE
            it.isLooping = true
            player.start()
        }
        player.setOnErrorListener { _, _, _ ->
            loading.visibility = View.VISIBLE
            true
        }
        view.findViewById<TextView>(R.id.btnGuideClose).setOnClickListener { dialog.dismiss() }
        view.findViewById<TextView>(R.id.btnGuideReplay).setOnClickListener {
            player.seekTo(0)
            player.start()
        }
        view.findViewById<TextView>(R.id.btnGuideFix).setOnClickListener {
            dialog.dismiss()
            item.action?.let { act ->
                if (!Preflight.openFix(this, act)) GcBus.appendLog("打不开设置页:${item.key}")
            }
        }
        dialog.setOnDismissListener { player.stopPlayback() }
        dialog.show()
        GcBus.appendLog("播放引导视频:${guideVideoFor(item.key)}.mp4(${item.label})")
    }

    // ---- 版本更新检查 ----

    private var updatePrompted = false

    /** 拉服务器版本清单比对;有新版弹一次设计稿样式对话框(去下载=浏览器打开 APK 直链)。 */
    private fun checkAppUpdate() {
        lifecycleScope.launch {
            val latest = withContext(Dispatchers.IO) { UpdateCheck.fetchLatest() } ?: return@launch
            val currentCode = BuildConfig.VERSION_CODE
            if (latest.versionCode <= currentCode) return@launch
            GcBus.appendLog("发现新版本 ${latest.versionName}(${latest.versionCode}),当前 ${BuildConfig.VERSION_NAME}($currentCode)")
            if (updatePrompted) return@launch
            updatePrompted = true
            showUpdateDialog(latest)
        }
    }

    private fun showUpdateDialog(latest: UpdateCheck.Latest) {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_update, null)
        dialog.setContentView(view)
        dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        view.findViewById<TextView>(R.id.tvUpdTitle).text = "发现新版本 v${latest.versionName}"
        view.findViewById<TextView>(R.id.tvUpdSub).text =
            "当前版本 v${BuildConfig.VERSION_NAME}，建议尽快更新。"
        val notes = view.findViewById<TextView>(R.id.tvUpdNotes)
        notes.text = latest.notes ?: "群控执行端有新版本,建议更新。"
        notes.visibility = if (latest.notes.isNullOrBlank()) View.GONE else View.VISIBLE
        view.findViewById<TextView>(R.id.btnUpdIgnore).setOnClickListener { dialog.dismiss() }
        view.findViewById<TextView>(R.id.btnUpdGo).setOnClickListener {
            dialog.dismiss()
            runCatching {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(latest.url)))
            }.onFailure { GcBus.appendLog("打不开下载链接:${it.message}") }
        }
        dialog.show()
    }

    // ---- 高级(调试)区 ----

    private fun onTitleTap() {
        val now = System.currentTimeMillis()
        titleTapCount = if (now - lastTitleTapAt < 2000) titleTapCount + 1 else 1
        lastTitleTapAt = now
        if (titleTapCount >= 5) {
            titleTapCount = 0
            val show = binding.cardAdvanced.visibility != View.VISIBLE
            binding.cardAdvanced.visibility = if (show) View.VISIBLE else View.GONE
            if (show) loadIntoForm()
        }
    }

    private fun loadIntoForm() {
        binding.etHost.setText(prefs.brokerHost)
        binding.etPort.setText(prefs.brokerPort.toString())
        binding.swTls.isChecked = prefs.tls
        binding.etDeviceId.setText(prefs.deviceId)
        binding.etToken.setText(prefs.deviceToken)
    }

    private fun saveForm() {
        prefs.brokerHost = binding.etHost.text.toString()
        prefs.brokerPort = binding.etPort.text.toString().toIntOrNull() ?: prefs.brokerPort
        prefs.tls = binding.swTls.isChecked
        // device_id/token 由服务端 enroll 自动写入;
        // 只有手输了非空值才覆盖(手输仅作调试/手动配号 override),否则会把 enroll 拿到的身份清空。
        binding.etDeviceId.text.toString().trim().let { if (it.isNotBlank()) prefs.deviceId = it }
        binding.etToken.text.toString().trim().let { if (it.isNotBlank()) prefs.deviceToken = it }
        GcBus.appendLog("配置已保存")
    }

    // ---- 启停 ----

    private fun toggleService() {
        // 同样以「服务是否真在跑」为准:state 卡住时旧逻辑会把「启动」误判成「停止」。
        if (!isGcServiceRunning()) {
            // 设备身份(device_id/token)由服务端 enroll 自动下发;
            // broker 永远有 BuildConfig 兜底,服务内部未注册会先 enroll 再连。
            if (prefs.brokerHost.isBlank()) {
                GcBus.appendLog("broker 主机为空:检查构建变体")
                return
            }
            GcService.start(this)
        } else {
            GcService.stop(this)
        }
    }

    private fun observeBus() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    combine(GcBus.state, GcBus.detail) { s, d -> s to d }.collect { (s, _) ->
                        renderState(s)
                        if (s == GcConnState.CONNECTED) {
                            renderAccount()
                            renderHeroMeta()
                        }
                    }
                }
                launch {
                    GcBus.logs.collect { lines ->
                        binding.tvLog.text = lines.takeLast(80).joinToString("\n")
                        binding.tvLogCount.text = "${lines.size} 条"
                    }
                }
            }
        }
    }
}
