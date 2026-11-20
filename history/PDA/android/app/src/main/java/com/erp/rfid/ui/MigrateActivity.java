package com.erp.rfid.ui;

import android.content.Intent;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import com.erp.rfid.R;
import com.erp.rfid.net.Api;
import com.google.gson.JsonObject;

/**
 * 条码迁移页：扫旧条码查商品 → 显示详情 → 「修改条形码」扫新条码覆盖货号。
 * 也可单纯扫码查看商品详情（详情可返回，不会卡住）。
 */
public class MigrateActivity extends AppCompatActivity {

    // 扫码用途
    private static final int PURPOSE_QUERY = 1;   // 扫码查询商品
    private static final int PURPOSE_RECODE = 2;  // 扫新码改码
    private static final int PURPOSE_NONE = 0;    // 详情展示中，忽略误扫

    // iData 软触发扫码广播
    private static final String ACTION_START_SCAN = "android.intent.action.BARCODESTARTSCAN";

    private Api api;
    private ToneGenerator tone;

    private EditText etBarcode;
    private Button btnScan, btnRecode, btnBack;
    private View detailPanel;
    private TextView tvDetail, tvStatus;

    private int purpose = PURPOSE_QUERY;
    private String currentOldCode = null;   // 当前查到的商品货号(改码时作旧码)

    @Override protected void onCreate(Bundle s) {
        super.onCreate(s);
        setContentView(R.layout.activity_migrate);
        api = new Api(this);
        tone = new ToneGenerator(AudioManager.STREAM_MUSIC, 90);

        etBarcode = findViewById(R.id.et_barcode);
        btnScan = findViewById(R.id.btn_scan);
        detailPanel = findViewById(R.id.detail_panel);
        tvDetail = findViewById(R.id.tv_detail);
        tvStatus = findViewById(R.id.tv_status);
        btnRecode = findViewById(R.id.btn_recode);
        btnBack = findViewById(R.id.btn_back);

        etBarcode.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence c, int a, int b, int d) {}
            @Override public void onTextChanged(CharSequence c, int a, int b, int d) {}
            @Override public void afterTextChanged(Editable e) {
                String t = e.toString();
                if (t.contains("\n") || t.contains("\r")) {
                    String code = t.replaceAll("[\\r\\n]", "").trim();
                    etBarcode.setText("");
                    if (!code.isEmpty()) onScan(code);
                }
            }
        });
        etBarcode.setOnEditorActionListener((v, id, ev) -> {
            String code = etBarcode.getText().toString().trim();
            etBarcode.setText("");
            if (!code.isEmpty()) onScan(code);
            return true;
        });

        btnScan.setOnClickListener(v -> { toIdle(); triggerScan(); });
        btnRecode.setOnClickListener(v -> startRecode());
        btnBack.setOnClickListener(v -> toIdle());

        toIdle();
    }

    @Override protected void onResume() {
        super.onResume();
        etBarcode.requestFocus();
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        if (tone != null) tone.release();
    }

    /** 软触发扫码（部分机型支持；不支持也可按实体扫描键，结果同样以键盘方式回填）。 */
    private void triggerScan() {
        etBarcode.requestFocus();
        try { sendBroadcast(new Intent(ACTION_START_SCAN)); } catch (Exception ignore) {}
    }

    private void onScan(String code) {
        if (purpose == PURPOSE_RECODE) {
            doRecode(currentOldCode, code.toUpperCase());
        } else if (purpose == PURPOSE_QUERY) {
            doQuery(code.trim());
        }
        // PURPOSE_NONE：详情展示中误扫，忽略
    }

    // ---------------- 查询 ----------------

    private void doQuery(String code) {
        tvStatus.setText("查询中… " + code);
        api.skuDetail(code, new Api.Cb() {
            @Override public void ok(String body) {
                try {
                    JsonObject o = Api.gson().fromJson(body, JsonObject.class);
                    currentOldCode = str(o, "sku_code");
                    showDetail(o);
                    beepOk();
                } catch (Exception e) {
                    tvStatus.setText("返回解析失败");
                    beepFail();
                }
            }
            @Override public void fail(String msg) {
                // 未查到商品 → 警告并返回扫码态
                toIdle();
                tvStatus.setText("✘ 未查到商品：" + msg);
                Toast.makeText(MigrateActivity.this, "未查到商品", Toast.LENGTH_SHORT).show();
                beepFail();
            }
        });
    }

    private void showDetail(JsonObject o) {
        purpose = PURPOSE_NONE;           // 展示中，忽略误扫
        StringBuilder sb = new StringBuilder();
        sb.append("货号：").append(str(o, "sku_code")).append("\n");
        sb.append("品名：").append(str(o, "product_name")).append("\n");
        String brand = str(o, "brand");
        if (!brand.isEmpty()) sb.append("品牌：").append(brand).append("\n");
        String spec = str(o, "spec");
        if (!spec.isEmpty()) sb.append("规格：").append(spec).append("\n");
        sb.append("库位：").append(orDash(str(o, "location_code"))).append("\n");
        sb.append("状态：").append(str(o, "status")).append("\n");
        String epc = str(o, "rfid_epc");
        sb.append("RFID：").append(epc.isEmpty() ? "未绑定" : epc);
        tvDetail.setText(sb.toString());

        detailPanel.setVisibility(View.VISIBLE);
        btnScan.setVisibility(View.GONE);
        tvStatus.setText("已查到商品。可「修改条形码」或返回。");
    }

    // ---------------- 改码 ----------------

    private void startRecode() {
        purpose = PURPOSE_RECODE;
        tvStatus.setText("请扫描【新条码】以覆盖货号 " + currentOldCode);
        triggerScan();
    }

    private void doRecode(String oldCode, String newCode) {
        if (oldCode == null) { toIdle(); return; }
        if (newCode.equalsIgnoreCase(oldCode)) {
            tvStatus.setText("新条码与原条码相同，未改动");
            purpose = PURPOSE_NONE;
            beepFail();
            return;
        }
        tvStatus.setText("改码中… " + oldCode + " → " + newCode);
        api.recode(oldCode, newCode, new Api.Cb() {
            @Override public void ok(String body) {
                Toast.makeText(MigrateActivity.this, "改码成功", Toast.LENGTH_SHORT).show();
                beepOk();
                toIdle();
                tvStatus.setText("✔ 改码成功：" + oldCode + " → " + newCode);
            }
            @Override public void fail(String msg) {
                Toast.makeText(MigrateActivity.this, "改码失败：" + msg, Toast.LENGTH_LONG).show();
                tvStatus.setText("✘ 改码失败：" + msg);
                purpose = PURPOSE_NONE;   // 留在详情，可重试
                beepFail();
            }
        });
    }

    // ---------------- 状态 ----------------

    private void toIdle() {
        purpose = PURPOSE_QUERY;
        currentOldCode = null;
        detailPanel.setVisibility(View.GONE);
        btnScan.setVisibility(View.VISIBLE);
        tvDetail.setText("");
        tvStatus.setText("点「扫码查询商品」或直接扫码");
        etBarcode.requestFocus();
    }

    @Override public void onBackPressed() {
        // 详情展示中 → 返回扫码态（不退出，保证可返回）
        if (detailPanel.getVisibility() == View.VISIBLE) {
            toIdle();
        } else {
            super.onBackPressed();
        }
    }

    private static String str(JsonObject o, String k) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : "";
    }
    private static String orDash(String s) { return s.isEmpty() ? "—" : s; }

    private void beepOk() { try { tone.startTone(ToneGenerator.TONE_PROP_BEEP, 120); } catch (Exception ignore) {} }
    private void beepFail() { try { tone.startTone(ToneGenerator.TONE_CDMA_SOFT_ERROR_LITE, 250); } catch (Exception ignore) {} }
}
