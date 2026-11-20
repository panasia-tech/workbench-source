package com.erp.rfid.device;

import android.content.Context;
import android.content.Intent;

import com.pow.api.cls.RfidPower;
import com.uhf.api.cls.Reader;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * iData PDA 的 UHF 读头封装。复用自逆向的 EI App（RfidUtil + com.uhf.api SDK）。
 * - 上电：emsh 广播开服务 + UHF 供电 + 打开 UHF 串口
 * - 初始化：InitReader_Notype("/dev/ttyMT2", 1) + RfidPower(IDATA)
 * - 盘读：TagInventory_Raw 一轮 → GetNextTag 逐张取 EPC
 * 功率单位为「百分之 dBm」(centi-dBm)，如 2700=27dBm，500=5dBm。
 */
public class UhfReader {

    // ---- emsh 常量（取自 EmshConstant）----
    private static final String EMSH_REQ = "android.intent.extra.EMSH_REQUEST";
    private static final String CMD_ENABLE_SVC = "emsh.REQUEST_ENABLE_EMSH_SERVICE";
    private static final String CMD_SET_POWER_MODE = "emsh.REQUEST_SET_POWER_MODE";
    private static final String CMD_ENABLE_UHF_COMM = "emsh.REQUEST_ENABLE_UHF_COMM";
    private static final String EX_CMD = "cmd";
    private static final String EX_ARG1 = "arg1";

    private static final String SERIAL = "/dev/ttyMT2";

    public interface TagListener {
        /** 盘到一张标签（已去重前的原始回调）。 */
        void onTag(String epc, int rssi);
    }

    private Reader reader;
    private RfidPower power;
    private final int[] ants = {1};
    private int readtime = 50;       // 单轮盘存时间(ms)
    private volatile boolean scanning = false;
    private Thread worker;
    private final Object lock = new Object();

    // ---------------- 上电 / 初始化 ----------------

    private void emsh(Context ctx, String cmd, int arg1) {
        Intent it = new Intent(EMSH_REQ);
        it.putExtra(EX_CMD, cmd);
        it.putExtra(EX_ARG1, arg1);
        ctx.sendBroadcast(it);
    }

    /** 连接读头。返回 true 表示初始化成功。需在子线程调用。 */
    public boolean connect(Context ctx) {
        emsh(ctx, CMD_ENABLE_SVC, 1);
        emsh(ctx, CMD_SET_POWER_MODE, 2);   // 2 = EMSH_PWR_MODE_DSG_UHF
        sleep(500);
        emsh(ctx, CMD_ENABLE_UHF_COMM, 1);
        sleep(200);
        synchronized (lock) {
            reader = new Reader();
            power = new RfidPower(RfidPower.PDATYPE.IDATA);
            Reader.READER_ERR er = reader.InitReader_Notype(SERIAL, 1);
            return er == Reader.READER_ERR.MT_OK_ERR;
        }
    }

    public void disconnect(Context ctx) {
        stopInventory();
        synchronized (lock) {
            try { if (reader != null) reader.CloseReader(); } catch (Exception ignore) {}
            reader = null;
        }
        emsh(ctx, CMD_SET_POWER_MODE, 0);
        emsh(ctx, CMD_ENABLE_SVC, 0);
    }

    public boolean isConnected() { return reader != null; }

    /** 设置读写功率（centi-dBm）。 */
    public boolean setPower(int centiDbm) {
        synchronized (lock) {
            if (reader == null) return false;
            try {
                Reader.AntPowerConf conf = reader.new AntPowerConf();
                conf.antcnt = 1;
                Reader.AntPower ap = reader.new AntPower();
                ap.antid = 1;
                ap.readPower = (short) centiDbm;
                ap.writePower = (short) centiDbm;
                conf.Powers[0] = ap;
                return reader.ParamSet(Reader.Mtr_Param.MTR_PARAM_RF_ANTPOWER, conf)
                        == Reader.READER_ERR.MT_OK_ERR;
            } catch (Exception e) {
                return false;
            }
        }
    }

    // ---------------- 连续盘点 ----------------

    /** 开始后台连续盘读。l 在子线程被回调。 */
    public void startInventory(final TagListener l) {
        if (scanning) return;
        scanning = true;
        worker = new Thread(() -> {
            while (scanning) {
                oneRound(l);
                sleep(10);
            }
        }, "uhf-inv");
        worker.start();
    }

    public void stopInventory() {
        scanning = false;
        if (worker != null) {
            try { worker.join(800); } catch (InterruptedException ignore) {}
            worker = null;
        }
    }

    public boolean isScanning() { return scanning; }

    private void oneRound(TagListener l) {
        synchronized (lock) {
            if (reader == null) return;
            int[] cnt = {0};
            Reader.READER_ERR er = reader.TagInventory_Raw(ants, ants.length, (short) readtime, cnt);
            if (er != Reader.READER_ERR.MT_OK_ERR || cnt[0] <= 0) return;
            for (int i = 0; i < cnt[0]; i++) {
                Reader.TAGINFO t = reader.new TAGINFO();
                if (reader.GetNextTag(t) != Reader.READER_ERR.MT_OK_ERR) break;
                String epc = toEpc(t);
                if (epc != null && !epc.isEmpty() && l != null) l.onTag(epc, t.RSSI);
            }
        }
    }

    // ---------------- 单张读取（绑定用，防串读）----------------

    public static class Single {
        public final String epc;
        public final int rssi;
        public final int distinctCount;   // 本次读到的不同标签数（>1 表示串读）
        public Single(String epc, int rssi, int distinctCount) {
            this.epc = epc; this.rssi = rssi; this.distinctCount = distinctCount;
        }
    }

    /**
     * 绑定时使用：多盘几轮，返回信号最强(最近)的一张，并报告读到的不同标签数。
     * 上层应先 setPower 到低功率（如 5dBm），再调用本方法，配合“多张则拒绝”。
     */
    public Single readNearest(int rounds) {
        Map<String, Integer> best = new HashMap<>(); // epc -> 最大RSSI
        for (int r = 0; r < rounds; r++) {
            oneRound((epc, rssi) -> {
                Integer cur = best.get(epc);
                if (cur == null || rssi > cur) best.put(epc, rssi);
            });
            sleep(20);
        }
        if (best.isEmpty()) return new Single(null, 0, 0);
        String top = null; int topRssi = Integer.MIN_VALUE;
        for (Map.Entry<String, Integer> e : best.entrySet()) {
            if (e.getValue() > topRssi) { topRssi = e.getValue(); top = e.getKey(); }
        }
        return new Single(top, topRssi, best.size());
    }

    // ---------------- 工具 ----------------

    /** TAGINFO → 干净的大写 HEX EPC（按 Epclen 截取有效字节）。 */
    private static String toEpc(Reader.TAGINFO t) {
        byte[] id = t.EpcId;
        if (id == null) return null;
        int len = t.Epclen > 0 ? t.Epclen : id.length;
        len = Math.min(len, id.length);
        StringBuilder sb = new StringBuilder(len * 2);
        for (int i = 0; i < len; i++) sb.append(String.format("%02X", id[i] & 0xFF));
        String s = sb.toString();
        // 去掉可能的全零尾部（长度异常时兜底）
        return s.isEmpty() ? null : s;
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignore) {}
    }
}
