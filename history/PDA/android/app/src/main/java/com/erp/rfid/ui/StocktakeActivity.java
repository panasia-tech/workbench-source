package com.erp.rfid.ui;

import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Bundle;
import android.view.KeyEvent;
import android.widget.Button;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import com.erp.rfid.R;
import com.erp.rfid.device.UhfReader;
import com.erp.rfid.net.Api;
import com.erp.rfid.net.Prefs;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 盘点页：点击「开始盘点」建会话并连续盘读，点击「结束盘点」上传并生成记录(带差异)。
 * 扳机键(138)可临时暂停/继续盘读。
 */
public class StocktakeActivity extends AppCompatActivity {

    private static final int KEY_TRIGGER = 138;

    private Api api;
    private Prefs prefs;
    private UhfReader uhf;
    private ToneGenerator tone;

    private TextView tvSession, tvCount, tvStatus, tvDiff;
    private Button btnStart, btnEnd;

    private String sessionId = null;
    private String sessionNo = null;
    private final Set<String> epcs = new LinkedHashSet<>();

    @Override protected void onCreate(Bundle s) {
        super.onCreate(s);
        setContentView(R.layout.activity_stocktake);
        api = new Api(this);
        prefs = new Prefs(this);
        uhf = new UhfReader();
        tone = new ToneGenerator(AudioManager.STREAM_MUSIC, 90);

        tvSession = findViewById(R.id.tv_session);
        tvCount = findViewById(R.id.tv_count);
        tvStatus = findViewById(R.id.tv_status);
        tvDiff = findViewById(R.id.tv_diff);
        btnStart = findViewById(R.id.btn_start);
        btnEnd = findViewById(R.id.btn_end);

        btnEnd.setEnabled(false);
        btnStart.setOnClickListener(v -> beginStocktake());
        btnEnd.setOnClickListener(v -> onEnd());
        tvStatus.setText("点击「开始盘点」");
    }

    @Override protected void onResume() {
        super.onResume();
        new Thread(() -> {
            boolean ok = uhf.connect(this);
            if (ok) uhf.setPower(prefs.scanPower());
            runOnUiThread(() -> {
                if (!ok) tvStatus.setText("RFID 模块连接失败");
                else if (sessionId == null) tvStatus.setText("就绪：点击「开始盘点」");
            });
        }).start();
    }

    @Override protected void onPause() {
        super.onPause();
        uhf.stopInventory();
        new Thread(() -> uhf.disconnect(this)).start();
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        if (tone != null) tone.release();
    }

    // ---------------- 开始 ----------------

    private void beginStocktake() {
        if (sessionId != null) return;
        btnStart.setEnabled(false);
        tvStatus.setText("创建盘点会话…");
        api.stocktakeStart(new Api.Cb() {
            @Override public void ok(String body) {
                try {
                    JsonObject o = Api.gson().fromJson(body, JsonObject.class);
                    sessionId = o.get("id").getAsString();
                    sessionNo = o.has("session_no") ? o.get("session_no").getAsString() : sessionId;
                } catch (Exception e) {
                    tvStatus.setText("会话解析失败"); btnStart.setEnabled(true); return;
                }
                epcs.clear();
                tvSession.setText("盘点单：" + sessionNo);
                tvDiff.setText("");
                btnEnd.setEnabled(true);
                startReading();
            }
            @Override public void fail(String msg) {
                tvStatus.setText("✘ " + msg);
                btnStart.setEnabled(true);
                beepFail();
            }
        });
    }

    private void startReading() {
        tvStatus.setText("盘点中…（扳机可暂停）");
        uhf.startInventory((epc, rssi) -> {
            boolean added;
            synchronized (epcs) { added = epcs.add(epc); }
            if (added) runOnUiThread(() -> { updateCount(); beepOk(); });
        });
    }

    private void updateCount() {
        synchronized (epcs) { tvCount.setText("已盘读：" + epcs.size() + " 张标签"); }
    }

    // 扳机：暂停/继续
    @Override public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KEY_TRIGGER && event.getRepeatCount() == 0) {
            if (sessionId == null) return true;
            if (uhf.isScanning()) {
                uhf.stopInventory();
                tvStatus.setText("已暂停（扳机继续）");
            } else {
                startReading();
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ---------------- 结束 ----------------

    private void onEnd() {
        if (sessionId == null) return;
        uhf.stopInventory();
        btnEnd.setEnabled(false);
        tvStatus.setText("上传盘点数据…");

        List<String> list;
        synchronized (epcs) { list = new ArrayList<>(epcs); }

        api.stocktakeScan(sessionId, list, new Api.Cb() {
            @Override public void ok(String scanBody) {
                int unresolved = 0;
                try {
                    JsonObject o = Api.gson().fromJson(scanBody, JsonObject.class);
                    if (o.has("unresolved")) unresolved = o.getAsJsonArray("unresolved").size();
                } catch (Exception ignore) {}
                final int unres = unresolved;
                tvStatus.setText("生成盘点记录…");
                api.stocktakeComplete(sessionId, new Api.Cb() {
                    @Override public void ok(String body) { showResult(body, unres); resetSession(); }
                    @Override public void fail(String msg) { tvStatus.setText("✘ 完成失败：" + msg); btnEnd.setEnabled(true); beepFail(); }
                });
            }
            @Override public void fail(String msg) {
                tvStatus.setText("✘ 上传失败：" + msg);
                btnEnd.setEnabled(true);
                beepFail();
            }
        });
    }

    private void showResult(String body, int unresolved) {
        try {
            JsonObject o = Api.gson().fromJson(body, JsonObject.class);
            JsonObject diff = o.getAsJsonObject("diff_result");
            int wh = diff.get("warehouse_count").getAsInt();
            int scanned = diff.get("scanned_count").getAsInt();
            int matched = diff.get("matched_count").getAsInt();
            int missing = sizeOf(diff, "missing");
            int surplus = sizeOf(diff, "surplus");
            StringBuilder sb = new StringBuilder();
            sb.append("盘点完成（单号 ").append(o.has("session_no") ? o.get("session_no").getAsString() : "").append("）\n");
            sb.append("应有(已绑标签)：").append(wh).append("\n");
            sb.append("实盘：").append(scanned).append("　匹配：").append(matched).append("\n");
            sb.append("缺失：").append(missing).append("　多出：").append(surplus).append("\n");
            if (unresolved > 0) sb.append("未识别标签：").append(unresolved).append("（未绑定/外来）");
            tvDiff.setText(sb.toString());
            tvStatus.setText("✔ 已生成盘点记录，可在小程序/后台查看");
            beepOk();
        } catch (Exception e) {
            tvStatus.setText("完成，但结果解析失败");
        }
    }

    private int sizeOf(JsonObject o, String key) {
        try { JsonArray a = o.getAsJsonArray(key); return a == null ? 0 : a.size(); }
        catch (Exception e) { return 0; }
    }

    private void resetSession() {
        sessionId = null; sessionNo = null;
        synchronized (epcs) { epcs.clear(); }
        btnStart.setEnabled(true);
        btnEnd.setEnabled(false);
        tvSession.setText("盘点单：—");
        tvCount.setText("已盘读：0 张标签");
    }

    private void beepOk() { try { tone.startTone(ToneGenerator.TONE_PROP_BEEP, 80); } catch (Exception ignore) {} }
    private void beepFail() { try { tone.startTone(ToneGenerator.TONE_CDMA_SOFT_ERROR_LITE, 250); } catch (Exception ignore) {} }
}
