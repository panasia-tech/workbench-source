package com.erp.rfid.net;

import android.content.Context;
import android.content.SharedPreferences;

/** 本地持久化：服务器地址、token、账号。 */
public class Prefs {
    private static final String FILE = "erp_rfid";
    private static final String K_HOST = "host";
    private static final String K_TOKEN = "token";
    private static final String K_USER = "username";
    private static final String K_NAME = "name";
    private static final String K_TOKEN_AT = "token_at"; // 取得 token 的时间戳(ms)
    private static final String K_POWER = "scan_power";  // 扫描功率(centi-dBm)

    // 默认指向生产 FastAPI。出厂可在登录页修改。
    public static final String DEFAULT_HOST = "http://127.0.0.1:8000";

    // 扫描功率档位（centi-dBm，即百分之 dBm）。盘点用，默认高功率。
    public static final int POWER_HIGH = 2700;     // 27 dBm
    public static final int POWER_MIDHIGH = 2000;  // 20 dBm
    public static final int POWER_MID = 1300;      // 13 dBm
    public static final int POWER_LOW = 500;       // 5 dBm

    private final SharedPreferences sp;

    public Prefs(Context ctx) {
        sp = ctx.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public String host() { return sp.getString(K_HOST, DEFAULT_HOST); }
    public void setHost(String v) { sp.edit().putString(K_HOST, v).apply(); }

    public String token() { return sp.getString(K_TOKEN, ""); }
    public long tokenAt() { return sp.getLong(K_TOKEN_AT, 0L); }

    public void setToken(String token) {
        sp.edit().putString(K_TOKEN, token).putLong(K_TOKEN_AT, System.currentTimeMillis()).apply();
    }

    public String username() { return sp.getString(K_USER, ""); }
    public void setUsername(String v) { sp.edit().putString(K_USER, v).apply(); }

    public String name() { return sp.getString(K_NAME, ""); }
    public void setName(String v) { sp.edit().putString(K_NAME, v).apply(); }

    /** 扫描功率(centi-dBm)，默认高档。 */
    public int scanPower() { return sp.getInt(K_POWER, POWER_HIGH); }
    public void setScanPower(int centiDbm) { sp.edit().putInt(K_POWER, centiDbm).apply(); }

    public boolean loggedIn() { return !token().isEmpty(); }

    public void clearToken() {
        sp.edit().remove(K_TOKEN).remove(K_TOKEN_AT).apply();
    }
}
