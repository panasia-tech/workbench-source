package com.erp.rfid.net;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * 后端接口封装（对接 47.96.9.61 FastAPI）。
 * 所有业务接口带 Bearer token；回调统一切回主线程。
 */
public class Api {
    public static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");
    private static final Gson GSON = new Gson();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private final OkHttpClient client;
    private final Prefs prefs;

    public Api(Context ctx) {
        this.prefs = new Prefs(ctx);
        this.client = new OkHttpClient.Builder()
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                .build();
    }

    public Prefs prefs() { return prefs; }

    public interface Cb {
        void ok(String body);
        void fail(String msg);
    }

    private String url(String path) {
        String h = prefs.host();
        if (h.endsWith("/")) h = h.substring(0, h.length() - 1);
        return h + path;
    }

    private void post(String path, Object bodyObj, boolean auth, Cb cb) {
        RequestBody rb = RequestBody.create(GSON.toJson(bodyObj), JSON);
        Request.Builder b = new Request.Builder().url(url(path)).post(rb);
        if (auth) b.header("Authorization", "Bearer " + prefs.token());
        enqueue(b.build(), cb);
    }

    private void get(String path, Cb cb) {
        Request req = new Request.Builder()
                .url(url(path))
                .header("Authorization", "Bearer " + prefs.token())
                .get()
                .build();
        enqueue(req, cb);
    }

    private void enqueue(Request req, final Cb cb) {
        client.newCall(req).enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException e) {
                postFail(cb, "网络错误：" + e.getMessage());
            }
            @Override public void onResponse(Call call, Response resp) throws IOException {
                String body = resp.body() != null ? resp.body().string() : "";
                if (resp.isSuccessful()) {
                    postOk(cb, body);
                } else {
                    postFail(cb, parseErr(resp.code(), body));
                }
            }
        });
    }

    /** FastAPI 错误体通常是 {"detail": "..."} 或 {"detail": {"msg": "..."}}。 */
    private String parseErr(int code, String body) {
        try {
            JsonObject o = GSON.fromJson(body, JsonObject.class);
            if (o != null && o.has("detail")) {
                if (o.get("detail").isJsonObject()) {
                    JsonObject d = o.getAsJsonObject("detail");
                    if (d.has("msg")) return d.get("msg").getAsString();
                    return d.toString();
                }
                return o.get("detail").getAsString();
            }
        } catch (Exception ignore) {}
        if (code == 401) return "登录已过期，请重新登录";
        return "请求失败(" + code + ")";
    }

    private void postOk(final Cb cb, final String body) { MAIN.post(() -> cb.ok(body)); }
    private void postFail(final Cb cb, final String msg) { MAIN.post(() -> cb.fail(msg)); }

    // ---------------- 认证 ----------------

    static class LoginReq { String username; String password; LoginReq(String u, String p){username=u;password=p;} }

    public void deviceLogin(String username, String password, Cb cb) {
        post("/api/auth/device-login", new LoginReq(username, password), false, cb);
    }

    /** 用现有 token 续期（启动时调用）。 */
    public void refresh(Cb cb) {
        Request req = new Request.Builder()
                .url(url("/api/auth/refresh"))
                .post(RequestBody.create("", null))
                .header("Authorization", "Bearer " + prefs.token())
                .build();
        enqueue(req, cb);
    }

    // ---------------- 绑定 ----------------

    static class BindReq { String sku_code; String epc; boolean force; BindReq(String s,String e,boolean f){sku_code=s;epc=e;force=f;} }
    static class UnbindReq { String sku_code; String epc; }

    public void bind(String skuCode, String epc, boolean force, Cb cb) {
        post("/api/inventory/rfid/bind", new BindReq(skuCode, epc, force), true, cb);
    }

    static class ResolveReq { List<String> epcs; ResolveReq(List<String> e){epcs=e;} }

    public void resolve(List<String> epcs, Cb cb) {
        post("/api/inventory/rfid/resolve", new ResolveReq(epcs), true, cb);
    }

    // ---------------- 盘点 ----------------

    public void stocktakeStart(Cb cb) {
        post("/api/inventory/stocktake/start", new Object(), true, cb);
    }

    static class ScanReq { List<String> epcs; ScanReq(List<String> e){epcs=e;} }

    public void stocktakeScan(String sessionId, List<String> epcs, Cb cb) {
        post("/api/inventory/stocktake/" + sessionId + "/scan-rfid", new ScanReq(epcs), true, cb);
    }

    public void stocktakeComplete(String sessionId, Cb cb) {
        post("/api/inventory/stocktake/" + sessionId + "/complete", new Object(), true, cb);
    }

    // ---------------- 条码迁移 ----------------

    /** 按货号(条形码)查商品详情。404 表示未查到。 */
    public void skuDetail(String skuCode, Cb cb) {
        get("/api/inventory/skus/" + skuCode, cb);
    }

    static class RecodeReq { String old_sku_code; String new_sku_code; RecodeReq(String o,String n){old_sku_code=o;new_sku_code=n;} }

    /** 把商品旧货号改成新货号(覆盖条形码)。 */
    public void recode(String oldCode, String newCode, Cb cb) {
        post("/api/inventory/skus/recode", new RecodeReq(oldCode, newCode), true, cb);
    }

    public static Gson gson() { return GSON; }
}
