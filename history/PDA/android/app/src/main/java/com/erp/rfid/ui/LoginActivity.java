package com.erp.rfid.ui;

import android.content.Intent;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import com.erp.rfid.R;
import com.erp.rfid.net.Api;
import com.erp.rfid.net.Prefs;
import com.google.gson.JsonObject;

/** 登录页：设备账号 device-login，本地存 token，启动时自动续期。 */
public class LoginActivity extends AppCompatActivity {

    private Api api;
    private Prefs prefs;
    private EditText etHost, etUser, etPwd;
    private Button btnLogin;
    private TextView tvMsg;

    @Override protected void onCreate(Bundle s) {
        super.onCreate(s);
        setContentView(R.layout.activity_login);
        api = new Api(this);
        prefs = api.prefs();

        etHost = findViewById(R.id.et_host);
        etUser = findViewById(R.id.et_user);
        etPwd = findViewById(R.id.et_pwd);
        btnLogin = findViewById(R.id.btn_login);
        tvMsg = findViewById(R.id.tv_msg);

        etHost.setText(prefs.host());
        etUser.setText(prefs.username());

        btnLogin.setOnClickListener(v -> doLogin());

        // 已有 token → 先尝试续期，成功直接进主页
        if (prefs.loggedIn()) {
            tvMsg.setText("正在自动登录…");
            api.refresh(new Api.Cb() {
                @Override public void ok(String body) {
                    saveTokenFrom(body);
                    goHome();
                }
                @Override public void fail(String msg) {
                    tvMsg.setText("登录已过期，请重新登录");
                    prefs.clearToken();
                }
            });
        }
    }

    private void doLogin() {
        String host = etHost.getText().toString().trim();
        String user = etUser.getText().toString().trim();
        String pwd = etPwd.getText().toString();
        if (TextUtils.isEmpty(host) || TextUtils.isEmpty(user) || TextUtils.isEmpty(pwd)) {
            toast("请填写服务器、账号、密码");
            return;
        }
        prefs.setHost(host);
        btnLogin.setEnabled(false);
        tvMsg.setText("登录中…");
        api.deviceLogin(user, pwd, new Api.Cb() {
            @Override public void ok(String body) {
                prefs.setUsername(user);
                saveTokenFrom(body);
                btnLogin.setEnabled(true);
                goHome();
            }
            @Override public void fail(String msg) {
                btnLogin.setEnabled(true);
                tvMsg.setText(msg);
                toast(msg);
            }
        });
    }

    private void saveTokenFrom(String body) {
        try {
            JsonObject o = Api.gson().fromJson(body, JsonObject.class);
            if (o.has("token") && !o.get("token").isJsonNull()) {
                prefs.setToken(o.get("token").getAsString());
            }
            if (o.has("staff") && o.get("staff").isJsonObject()) {
                JsonObject st = o.getAsJsonObject("staff");
                if (st.has("name")) prefs.setName(st.get("name").getAsString());
            }
        } catch (Exception ignore) {}
    }

    private void goHome() {
        startActivity(new Intent(this, HomeActivity.class));
        finish();
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show(); }
}
