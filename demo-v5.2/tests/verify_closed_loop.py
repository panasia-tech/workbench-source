#!/usr/bin/env python3
"""
采购工作台 v4.0（围绕「二次议价利润锚点」全盘重构：买前6步判空间给仓管打标 + 到货9步细颗粒度二次议价陪跑）全量自动化回归测试。
直接启动内置临时端口 HTTP 服务并使用临时 SQLite 测试库，不污染演示库。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "后端演示接口"))

TMP_DB = os.path.join(tempfile.gettempdir(), f"pw_test_{os.getpid()}.db")
os.environ["PROCUREMENT_DB_PATH"] = TMP_DB

import procurement_server as srv  # noqa: E402


def req(base: str, method: str, path: str, body=None) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    r = urllib.request.Request(f"{base}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def main() -> None:
    srv.init_db(force_reset=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), srv.ProcurementRequestHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"
    passed = 0

    def check(name: str, cond: bool, detail: str = "") -> None:
        nonlocal passed
        if not cond:
            raise AssertionError(f"[FAIL] {name}: {detail}")
        passed += 1
        print(f"  [PASS] {name}")

    try:
        # 1. 健康检查 + 12 笔采购订单按「今天采购的(4) / 二次议价·问题订单(6) / 已经完结的(2)」清晰归类
        st, d = req(base, "GET", "/api/health")
        check("健康检查", st == 200 and d["ok"])
        st, dash = req(base, "GET", "/api/dashboard")
        cases = dash["data"]["cases"]
        lvls = [c["lvl"] for c in cases]
        rank = [{"red": 0, "amb": 1, "grn": 2}[x] for x in lvls]
        buckets = {"today": 0, "issue": 0, "completed": 0}
        for c in cases:
            buckets[c["order_bucket"]] = buckets.get(c["order_bucket"], 0) + 1
        check(
            "12笔订单完整归入三大类（今天采购4 + 二次议价问题订单6 + 已经完结2）且默认紧急优先排序",
            st == 200
            and len(cases) == 12
            and buckets == {"today": 4, "issue": 6, "completed": 2}
            and rank == sorted(rank),
            str(buckets),
        )

        # 2. 步入式进度条（买前6步 / 二次议价9步）与二次议价全套陪跑包校验
        st_c3, c3 = req(base, "GET", "/api/cases/CASE-003")
        st_c2, c2 = req(base, "GET", "/api/cases/CASE-002")
        st_c6, c6 = req(base, "GET", "/api/cases/CASE-006")
        st_404, _ = req(base, "GET", "/api/cases/NOT-EXIST-999")
        sp_buy = c3["case"]["step_progress"]
        sp_issue = c6["case"]["step_progress"]
        bp = c6["case"]["bargain_plan"]
        check(
            "买前采购6步进度（CASE-003停在第2步判二次议价）+ 二次议价9步进度 + 不存在单号返回404",
            st_c3 == 200
            and sp_buy["mode"] == "buying"
            and sp_buy["total"] == 6
            and sp_buy["cur"] == 2
            and c2["case"]["prebuy_eval"]["defects_fully_disclosed"] is True
            and c2["case"]["prebuy_eval"]["can_secondary_bargain"] is False
            and st_c6 == 200
            and sp_issue["mode"] == "issue"
            and sp_issue["total"] == 9
            and st_404 == 404,
            f"sp_buy={sp_buy}, sp_issue={sp_issue}",
        )
        check(
            "二次议价9步陪跑数据齐全（开口A/目标B/底线C + MESO三方案 + 阶梯让步 + 二次回拨救单稿 + 电话6步 + 5类顶嘴拆招）",
            bp["anchor_a_cents"] > bp["target_b_cents"] >= bp["floor_c_cents"] > 0
            and len(bp["phone_6step"]) == 6
            and len(bp["objection_routes"]) == 5
            and len(bp["seller_signals"]) == 3
            and len(bp["meso_options"]) == 3
            and len(bp["ladder_steps"]) == 4
            and bool(bp.get("callback_script"))
            and bp["estimated_comm_cents"] > 0,
        )

        # 2b. 收货前进阶核心：CASE-003「几乎全新+图糊」不追问并给赵仓管打『质疑成色·重点深检』标记 -> CASE-004 仓管按标抓差转9步二次议价
        st_ab, ab_res = req(
            base,
            "POST",
            "/api/cases/CASE-003/step/assess-bargain",
            {
                "actor_id": "liming",
                "seller_wrote_like_new": True,
                "photos_blurry_incomplete": True,
                "defects_fully_disclosed": False,
                "suspect_condition_tag": True,
                "warehouse_focus_points": ["查底壳与四角边框磕碰掉漆", "强光查屏幕划痕/亮斑坏点"],
                "buyer_note_to_warehouse": "卖家写几乎全新且底壳照片模糊未追问，到货请重点查底壳划痕与原装头！",
            },
        )
        _, c3_after = req(base, "GET", "/api/cases/CASE-003")
        check(
            "买前第2步判二次议价空间并给仓管打『质疑成色』重点验机标 -> 自动推进到第3步谈价",
            st_ab == 200
            and ab_res["prebuy_eval"]["suspect_condition_tag"] is True
            and c3_after["case"]["step_progress"]["cur"] == 3,
        )

        # 3. 二次议价逐轮纪律校验：保密词拦截(422) + 买方跳破底线C拦截(409) + 卖家松口新报价自动重算净赚与提成
        before_rounds = len(c6["case"]["bargain_plan"]["logs"])
        st_br_leak, _ = req(
            base,
            "POST",
            "/api/aftersales/TK-2402/bargain-round",
            {"actor_id": "liming", "role_side": "buyer", "round_no": 2, "ask_refund_cents": 30000, "text": "我们公司底价不能高于这个数"},
        )
        floor_c_6 = c6["case"]["bargain_plan"]["floor_c_cents"]
        st_br_floor, floor_res = req(
            base,
            "POST",
            "/api/aftersales/TK-2402/bargain-round",
            {"actor_id": "liming", "role_side": "buyer", "round_no": 2, "ask_refund_cents": max(1000, floor_c_6 - 5000), "text": "那算了退一点点就行"},
        )
        st_br, br_res = req(
            base,
            "POST",
            "/api/aftersales/TK-2402/bargain-round",
            {
                "actor_id": "liming",
                "role_side": "seller",
                "round_no": 2,
                "ask_refund_cents": 28000,
                "text": "按电话沟通我再让一步，最多退你 280 块马上确认收货",
            },
        )
        _, c6_round = req(base, "GET", "/api/cases/CASE-006")
        after_rounds = len(c6_round["case"]["bargain_plan"]["logs"])
        check(
            "二次议价第5-6步：保密词拦截(422) + 买方跌破底线C硬拦截(409) + 卖家新报价重算净赚与20%提成",
            st_br_leak == 422
            and st_br_floor == 409
            and floor_res.get("code") == "BELOW_FLOOR_C"
            and st_br == 200
            and br_res["ok"]
            and after_rounds == before_rounds + 1
            and c6_round["case"]["bargain_plan"]["seller_offer_cents"] == 28000,
        )

        # 3b. 双10分钟极速闭环 + 首刀50%半价大砍 + 欲擒故纵/勉强收下心理武器库 + 95338双向物流锁校验
        # (i) CASE-005 (TK-2401): 未确认面单已显示拒签 -> 400 WAYBILL_REFUSE_UNVERIFIED 拦截；确认拒签+10m内加微信 -> 200 通过
        st_ref_bad, ref_bad = req(
            base,
            "POST",
            "/api/aftersales/TK-2401/submit-return",
            {
                "actor_id": "liming",
                "platform_return_no": "RET-2401-TEST",
                "return_mode": "station_refuse",
                "waybill_refused_verified": False,
                "seller_wechat_added": True,
                "seller_wechat_id": "wx_seller_01",
            },
        )
        check(
            "拒签黄金10分钟：未勾选确认面单显示『已拒签』服务端400硬拦截(WAYBILL_REFUSE_UNVERIFIED)",
            st_ref_bad == 400 and ref_bad.get("code") == "WAYBILL_REFUSE_UNVERIFIED",
        )

        # (ii) CASE-011 (TK-2404, 实付¥1,400): 首刀直接50%半价大砍(¥700) + 12大增量心理学(P1-P6)×博弈学(G1-G6)矩阵 + 红白脸脱敏单 + 策略留痕
        _, c11_check = req(base, "GET", "/api/cases/CASE-011")
        bp11 = c11_check["case"]["bargain_plan"]
        arsenal11 = bp11.get("psychology_arsenal", {})
        p_codes = [x["code"] for x in bp11.get("psych_anchors", [])]
        g_codes = [x["code"] for x in bp11.get("game_anchors", [])]
        rf_card = bp11.get("red_face_voucher", {}).get("desensitized_copy_card", "")
        check(
            "实战录像laze同款(CASE-011)：首刀50%半价(¥700) + 10%到货提成(¥70) + 新增心理学6锚点(P1-P6) + 新增博弈学6锚点(G1-G6) + 红白脸脱敏凭证零泄密",
            bp11["anchor_a_cents"] == 70000
            and bp11["half_price_slash_cents"] == 70000
            and bp11["half_price_comm_cents"] == 7000
            and bp11["comm_rate_pct"] == 10
            and p_codes == ["P1", "P2", "P3", "P4", "P5", "P6"]
            and g_codes == ["G1", "G2", "G3", "G4", "G5", "G6"]
            and bp11["rubinstein_model"]["buyer_delta"] > bp11["rubinstein_model"]["seller_delta"]
            and "ERP 系统锁死最高收购红线" in rf_card
            and all(kw not in rf_card for kw in ("毛利", "提成", "参考价", "目标价"))
            and {"safe_add_wechat", "half_price_first_cut", "indifferent_pushback", "reluctant_accept_tough", "wechat_4elem_lock"}.issubset(set(arsenal11.keys()))
            and "不用啦，谢谢" in arsenal11["indifferent_pushback"]["step1_brush_off"]
            and "勉为其难" in arsenal11["reluctant_accept_tough"]["script"],
            f"p_codes={p_codes}, g_codes={g_codes}",
        )

        # 验证博弈锚点 G3 (阿克洛夫柠檬市场推演) 与 P3 (零整拆项精确锚) 调用留痕闭环（零触发保密词拦截！）
        g3_obj = next(x for x in bp11["game_anchors"] if x["code"] == "G3")
        p3_obj = next(x for x in bp11["psych_anchors"] if x["code"] == "P3")
        st_tac_g3, _ = req(
            base,
            "POST",
            "/api/aftersales/TK-2404/bargain-round",
            {"actor_id": "liming", "round_no": 1, "role_side": "buyer", "ask_refund_cents": 70000, "text": g3_obj["script"], "tactic_code": "G3"},
        )
        st_tac_p3, _ = req(
            base,
            "POST",
            "/api/aftersales/TK-2404/bargain-round",
            {"actor_id": "liming", "round_no": 2, "role_side": "buyer", "ask_refund_cents": 45000, "text": p3_obj["script"], "tactic_code": "P3"},
        )
        _, c11_after_tac = req(base, "GET", "/api/cases/CASE-011")
        used_tacs = c11_after_tac["case"]["bargain_plan"]["flow_state"].get("tactics_used", [])
        check(
            "启用增量心理/博弈锚点(G3柠檬市场+P3拆项精确锚)自动通过防泄密校验并写入本单策略归因留痕(tactics_used)",
            st_tac_g3 == 200 and st_tac_p3 == 200 and ["G3", "P3"] == used_tacs,
            f"used_tacs={used_tacs}",
        )

        # (iii) 第3步观察卖家信号 & 顺丰95338状态 + 第7步「嫌弃式勉强收下保底吃肉 vs 二次回拨救单」双杀闭环
        st_sig, _ = req(
            base,
            "POST",
            "/api/aftersales/TK-2404/observe-signal",
            {
                "actor_id": "liming",
                "signal": "green_proactive",
                "sf_95338_status": "station_hold",
                "seller_words": "卖家急问退200行不行不要退回来了",
            },
        )
        _, c9_init = req(base, "GET", "/api/cases/CASE-009")
        bp9 = c9_init["case"]["bargain_plan"]
        floor_c_9 = bp9["floor_c_cents"]
        check(
            "CASE-009(强硬卖家打95338喊退)：自动识别捡漏保底净赚¥530(is_salvage_profitable=True)",
            bp9["is_salvage_profitable"] is True and bp9["salvage_zero_refund_net_cents"] == 53000,
        )
        st_cb_low, _ = req(
            base,
            "POST",
            "/api/aftersales/TK-2403/cooldown-callback",
            {"actor_id": "liming", "outcome": "rescued_keep", "cooldown_mins": 35, "agreed_refund_cents": max(1000, floor_c_9 - 5000)},
        )
        # 走老板钦定「算了吧太急了，虽然这么烂我也勉强收下」保底吃肉分支（顺手抹50元清洁费）
        st_reluct_ok, _ = req(
            base,
            "POST",
            "/api/aftersales/TK-2403/cooldown-callback",
            {"actor_id": "liming", "outcome": "reluctant_salvage_keep", "cooldown_mins": 10, "agreed_refund_cents": 5000},
        )
        _, c9_after = req(base, "GET", "/api/cases/CASE-009")
        check(
            "第3步观察卖家信号 + 第7步『嫌弃式勉强收下』保底留肉与二次回拨底线保护双闭环解锁第8步",
            st_sig == 200
            and st_cb_low == 409
            and st_reluct_ok == 200
            and c9_after["case"]["step_progress"]["cur"] == 8
            and c9_after["case"]["bargain_plan"]["flow_state"]["cooldown_outcome"] == "reluctant_salvage_keep",
        )

        # 4. 新员工练习未通关服务端硬拦截 (403)
        st_gate, gate_r = req(base, "POST", "/api/quota/reserve", {"actor_id": "newbie", "order_ref": "PO-NB", "amount_cents": 100000})
        check("新员工未完成3关练习服务端硬拦截 403", st_gate == 403 and gate_r.get("code") == "PRACTICE_GATE_LOCKED")

        # 5. 诚实数据校验（禁填0占位；暂时拿不到可后续补齐）
        st_zero, zero_r = req(
            base,
            "POST",
            "/api/cases/CASE-003/step/init",
            {"actor_id": "liming", "model_code": "MBP14-M3-16-512", "condition_grade": "0", "seller_declaration": "0", "seller_price_cents": 745000},
        )
        check("缺数据禁填 0 占位校验 400", st_zero == 400 and zero_r.get("code") == "HONEST_DATA_REQUIRED")

        st_unk, unk_r = req(base, "POST", "/api/cases/CASE-004/step/supplement", {"actor_id": "liming", "channel": "serial_report", "unavailable": True})
        st_resup, resup_r = req(
            base,
            "POST",
            "/api/cases/CASE-004/step/supplement",
            {"actor_id": "liming", "channel": "serial_report", "content": "卖家已补拍背面铭牌序列号 AS-VG27AQML1A", "unavailable": False},
        )
        check("货况截图标记暂缺后仍支持随时补录", st_unk == 200 and unk_r["capture"]["serial_report"]["state"] == "unknown" and st_resup == 200 and resup_r["capture"]["serial_report"]["state"] == "ok")

        # 5b. 赵仓管按采购预埋『质疑成色』红靶标一镜到底抓差 -> 自动开启 9 步二次议价
        st_wh_catch, wh_res = req(
            base,
            "POST",
            "/api/cases/CASE-004/step/warehouse-inspect",
            {"actor_id": "zhaocg", "result": "defect", "note": "一镜到底核验：无原厂泡沫内衬+缺DP线+纯白亮屏划痕3cm（已拍3角度特写进ERP）"},
        )
        _, c4_after = req(base, "GET", "/api/cases/CASE-004")
        check(
            "买前第5步赵仓管按『质疑成色』标抓出未披露瑕疵 -> 自动转入『二次议价·问题订单』9步陪跑",
            st_wh_catch == 200
            and wh_res.get("ticket_id") is not None
            and c4_after["case"]["order_bucket"] == "issue"
            and c4_after["case"]["step_progress"]["total"] == 9
            and c4_after["case"]["bargain_plan"]["flow_state"]["hit_prebuy_tag"] is True,
        )

        # 6. 额度池幂等预占、超额拦截与释放
        st, r1 = req(base, "POST", "/api/quota/reserve", {"actor_id": "liming", "order_ref": "PO-T1", "amount_cents": 300000, "idempotency_key": "k-q-1"})
        st2, r2 = req(base, "POST", "/api/quota/reserve", {"actor_id": "liming", "order_ref": "PO-T1", "amount_cents": 300000, "idempotency_key": "k-q-1"})
        check("采购额度幂等预占返回同一预占单", st == 200 and st2 == 200 and r2.get("idempotent_replay") is True)
        st_ov, _ = req(base, "POST", "/api/quota/reserve", {"actor_id": "wangzg", "order_ref": "PO-OV", "amount_cents": 99000000})
        check("超额预占自动拦截 409", st_ov == 409)
        st_rel, _ = req(base, "POST", "/api/quota/release", {"actor_id": "liming", "res_id": r1["reservation"]["res_id"]})
        check("预占额度释放回池", st_rel == 200)

        # 7. 聊天暂停锁 + 防泄密词拦截 + 卖家改条件作废旧草稿
        st_ps, _ = req(base, "POST", "/api/conversations/CONV-001/pause", {"actor_id": "liming", "simulate_inflight": True})
        st_blk, _ = req(base, "POST", "/api/conversations/CONV-001/send", {"actor_id": "liming", "text": "试试竞态锁", "expected_context_version": 2})
        check("暂停接管在途消息拦截 409", st_ps == 200 and st_blk == 409)
        st_res, _ = req(base, "POST", "/api/conversations/CONV-001/pause-resolve", {"actor_id": "liming", "resolution": "abort_inflight"})
        st_ai, _ = req(base, "POST", "/api/conversations/CONV-001/send", {"actor_id": "liming", "sender": "buyer_ai", "text": "AI偷发", "expected_context_version": 2})
        check("人工接管期间禁止自动发消息 409", st_res == 200 and st_ai == 409)
        req(base, "POST", "/api/conversations/CONV-001/resume", {"actor_id": "liming"})
        st_leak, _ = req(base, "POST", "/api/conversations/CONV-001/send", {"actor_id": "liming", "text": "我们公司参考价4900", "expected_context_version": 2})
        check("聊天内部保密词自动拦截 422", st_leak == 422)
        req(base, "POST", "/api/conversations/CONV-001/quotes", {"actor_id": "liming", "simulate_context_change": True})
        st_stale, _ = req(base, "POST", "/api/conversations/CONV-001/send", {"actor_id": "liming", "text": "旧版草稿", "expected_context_version": 2})
        check("卖家条件变化后旧报价草稿自动作废 409", st_stale == 409)

        # 8. 价格表主管审批权限保护
        st_forb, _ = req(base, "POST", "/api/pricebook/PB-004/publish", {"actor_id": "liming"})
        st_pub, pub_r = req(base, "POST", "/api/pricebook/PB-004/publish", {"actor_id": "wangzg"})
        check("采购专员禁改价格表(403) + 王主管发布不影响旧单快照", st_forb == 403 and st_pub == 200 and pub_r["g11_impact_checklist"]["historical_snapshots_untouched"] is True)

        # 9. 买前付款防呆：未核对闲鱼改价禁止直接登记实付
        st_cr, cr = req(base, "POST", "/api/orders/create", {"actor_id": "liming", "conv_id": "CONV-001", "agreed_cents": 460000, "idempotency_key": "k-po-1"})
        po_id = cr["po_id"]
        st_skip, _ = req(base, "POST", f"/api/orders/{po_id}/advance", {"actor_id": "liming", "target_stage": "manual_paid", "paid_cents": 460000, "payment_receipt_no": "R-1"})
        st_chk, _ = req(base, "POST", f"/api/orders/{po_id}/advance", {"actor_id": "liming", "target_stage": "price_checked", "platform_listed_cents": 460000})
        st_paid, _ = req(base, "POST", f"/api/orders/{po_id}/advance", {"actor_id": "liming", "target_stage": "manual_paid", "paid_cents": 460000, "payment_receipt_no": "ALI-888"})
        check("未核对改价禁点实付(409) -> 核对改价 -> 登记实付锁快照闭环", st_cr == 200 and st_skip == 409 and st_chk == 200 and st_paid == 200)

        # 10. 二次议价防呆：必须先点退货锁住48小时防判到手刀 -> 算净赚对比 -> 完整披露确认留货 + 快递未拦回禁入库
        st_rf, _ = req(base, "POST", "/api/aftersales/TK-2401/plan-b-calc", {"actor_id": "liming", "s_market_cents": 390000, "k_keep_cost_cents": 350000, "r_replace_cost_cents": 375000})
        check("未先提交闲鱼退货申请禁止跳步算退差价 409", st_rf == 409)
        req(base, "POST", "/api/aftersales/TK-2402/plan-b-calc", {"actor_id": "liming", "s_market_cents": 760000, "k_keep_cost_cents": 703000, "r_replace_cost_cents": 735000, "partial_refund_cents": 25000})
        st_hs, _ = req(base, "POST", "/api/aftersales/TK-2402/confirm-keep", {"actor_id": "liming", "s_market_cents": 760000, "k_keep_cost_cents": 710000, "r_replace_cost_cents": 735000})
        st_keep_ok, _ = req(base, "POST", "/api/aftersales/TK-2402/confirm-keep", {"actor_id": "liming", "s_market_cents": 760000, "k_keep_cost_cents": 703000, "r_replace_cost_cents": 735000, "partial_refund_cents": 25000, "disclosure_complete": True})
        check("金额改动自动要求重算(409) + 完整披露同口径确认退差留货成功", st_hs == 409 and st_keep_ok == 200)

        st_int, _ = req(base, "POST", "/api/aftersales/TK-2403/warehouse-dispose", {"actor_id": "zhaocg", "stock_disposition": "restocked_good"})
        check("顺丰在途退货未拦回前禁止恢复上架库存 409", st_int == 409)

        # 11. 核心风控锚点：2000谈成800不走部分退款 -> 整单全退关单 + 支付宝对公支付订单登记 + 次日10:00(T+1)财务审批闭环
        _, c12_init = req(base, "GET", "/api/cases/CASE-012")
        check(
            "CASE-012（原单¥2000议价至¥800成交）初始停在第8步『整单退·对公登记』",
            c12_init["case"]["step_progress"]["cur"] == 8 and c12_init["case"]["ticket"]["paid_cents"] == 200000,
        )
        # 漏填卖家收款支付宝账号或填0占位 -> 400 拦截
        st_reg_bad, reg_bad = req(
            base,
            "POST",
            "/api/aftersales/TK-2412/confirm-keep",
            {
                "actor_id": "liming",
                "s_market_cents": 165000,
                "k_keep_cost_cents": 80000,
                "r_replace_cost_cents": 152000,
                "partial_refund_cents": 120000,
                "settle_mode": "corp_alipay_close",
                "agreed_payout_cents": 80000,
                "platform_close_no": "GF-CLOSE-20261116-12",
                "seller_alipay_account": "0",
                "seller_alipay_name": "",
            },
        )
        st_reg_ok, _ = req(
            base,
            "POST",
            "/api/aftersales/TK-2412/confirm-keep",
            {
                "actor_id": "liming",
                "s_market_cents": 165000,
                "k_keep_cost_cents": 80000,
                "r_replace_cost_cents": 152000,
                "partial_refund_cents": 120000,
                "settle_mode": "corp_alipay_close",
                "agreed_payout_cents": 80000,
                "platform_close_no": "GF-CLOSE-20261116-12",
                "seller_alipay_account": "00044706541",
                "seller_alipay_name": "周明远",
                "register_note": "原单2000谈成800整单全退关单，申请次日10:00 T+1支付宝对公支付800元",
                "disclosure_complete": True,
            },
        )
        _, c12_reg = req(base, "GET", "/api/cases/CASE-012")
        reg_obj = c12_reg["case"]["corp_alipay_reg"]
        check(
            "2000砍到800：漏填对公账号400拦截 -> 完整登记后自动生成『次日10:00 T+1财务审批』登记单与双腿流水并推进第9步",
            st_reg_bad == 400
            and reg_bad.get("code") == "HONEST_DATA_REQUIRED"
            and st_reg_ok == 200
            and reg_obj is not None
            and reg_obj["agreed_payout_cents"] == 80000
            and reg_obj["bargain_saved_cents"] == 120000
            and reg_obj["approval_status"] == "pending_t1_10am"
            and "次日 10:00" in reg_obj["expected_approve_at"]
            and c12_reg["case"]["step_progress"]["cur"] == 9,
            f"reg_obj={reg_obj}",
        )

        # 11b. 27寸一体机整单全退 + 支付宝对公支付 ¥850 次日10:00(T+1)双确认闭环（陈会计审批 + 赵仓管入库 -> 自动转入「已经完结的」）
        st_cl1, _ = req(base, "POST", "/api/aftersales/TK-SAMPLE/close-ticket", {"actor_id": "liming"})
        st_fin_forb, _ = req(base, "POST", "/api/finance/verify-receipt", {"actor_id": "liming", "entry_id": "FIN-1002", "receipt_id": "ALI-CORP-850"})
        check("钱货未双确认禁完结(409) + 采购员禁替会计做T+1对公审批(403)", st_cl1 == 409 and st_fin_forb == 403)
        req(base, "POST", "/api/finance/verify-receipt", {"actor_id": "chenkj", "entry_id": "FIN-1002", "receipt_id": "ALI-CORP-20261117-1000"})
        st_cl2, _ = req(base, "POST", "/api/aftersales/TK-SAMPLE/close-ticket", {"actor_id": "chenkj"})
        check("缺赵仓管实物入库确认仍禁完结 409", st_cl2 == 409)
        req(base, "POST", "/api/aftersales/TK-SAMPLE/warehouse-dispose", {"actor_id": "zhaocg", "stock_disposition": "restocked_good"})
        st_cl3, _ = req(base, "POST", "/api/aftersales/TK-SAMPLE/close-ticket", {"actor_id": "wangzg"})
        _, c7_done = req(base, "GET", "/api/cases/CASE-007")
        check(
            "陈会计完成次日10:00 T+1对公审批 + 赵仓管入库双确认后完结成功，登记单变approved_paid且订单归入「已经完结的」",
            st_cl3 == 200
            and c7_done["case"]["order_bucket"] == "completed"
            and c7_done["case"]["lvl"] == "grn"
            and c7_done["case"]["corp_alipay_reg"]["approval_status"] == "approved_paid"
            and c7_done["case"]["corp_alipay_reg"]["alipay_corp_receipt_no"] == "ALI-CORP-20261117-1000",
        )

        # 12. 新员工 3 关防踩坑练习解锁与重置 + 问主管闭环
        st_pu, pu = req(base, "POST", "/api/onboarding/practice", {"actor_id": "newbie", "unlock_all": True})
        st_nb_ok, _ = req(base, "POST", "/api/quota/reserve", {"actor_id": "newbie", "order_ref": "PO-NB-OK", "amount_cents": 100000})
        st_pr, _ = req(base, "POST", "/api/onboarding/practice", {"actor_id": "newbie", "reset": True})
        check("新员工3关通关解锁与重置闭环", st_pu == 200 and pu["onboarding"]["return_planb"] == 3 and st_nb_ok == 200 and st_pr == 200)

        st_ho, ho = req(base, "POST", "/api/help-requests", {"actor_id": "liming", "page_key": "#/cases", "category": "价格超限", "note": "卖家咬死 4750 问主管能不能批"})
        hid = ho.get("help_id", "")
        st_hr, _ = req(base, "POST", f"/api/help-requests/{hid}/resolve", {"actor_id": "wangzg"})
        check("员工一键问主管 + 王主管批复闭环", st_ho == 200 and st_hr == 200)

        # 13. v5.0 两段各10%独立核算 + 个人每日目标进度 + 三栏独立展示校验
        _, dash_v5 = req(base, "GET", "/api/dashboard")
        earn = dash_v5["data"]["daily_earnings"]
        st_tgt, tgt_res = req(base, "POST", "/api/earnings/target", {"actor_id": "liming", "target_cents": 120000})
        check(
            "两段各10%独立核算（买前expected + 到货expected = today_expected）+ 预计/已确认/已发放三栏独立 + 修改单日目标闭环",
            earn["pre_buy_expected_cents"] + earn["post_arrival_expected_cents"] == earn["today_expected_cents"]
            and earn["confirmed_cents"] >= 0
            and earn["paid_cents"] > 0
            and st_tgt == 200
            and tgt_res["daily_target_cents"] == 120000,
            str(earn),
        )

        # 14. v5.0 收藏卖家（个人私藏↔采购组共享 + 标签备注）& 慢慢压价分池解耦校验
        st_fav, fav_res = req(
            base,
            "POST",
            "/api/sellers/favorite",
            {
                "actor_id": "liming",
                "seller_id": "SELLER-GF-999",
                "seller_name": "深圳老张摄影",
                "scope": "personal",
                "tags": ["沟通顺畅", "长期供货"],
                "note": "先个人私藏观察两单",
            },
        )
        st_fav_team, fav_team = req(
            base,
            "POST",
            "/api/sellers/favorite",
            {"actor_id": "liming", "seller_id": "SELLER-GF-999", "seller_name": "深圳老张摄影", "scope": "team"},
        )
        st_slow, slow_res = req(base, "POST", "/api/conversations/CONV-002/group", {"actor_id": "liming", "slow_group": True})
        check(
            "收藏卖家（个人私藏->一键共享采购组）与会话移入慢慢压价长线池双池独立闭环",
            st_fav == 200
            and fav_res["scope"] == "personal"
            and st_fav_team == 200
            and fav_team["scope"] == "team"
            and st_slow == 200
            and slow_res["slow_group"] == 1,
        )

        # 15. v5.0 规格冲突待核(CONV-007) -> 人工修正型号匹配解锁 + 商品多图快照版本递增
        st_fix, fix_res = req(
            base,
            "POST",
            "/api/conversations/CONV-007/correct-match",
            {"actor_id": "liming", "model_code": "SONY-A7M4-BODY", "resume_auto": True},
        )
        st_snap1, snap1 = req(
            base,
            "POST",
            "/api/snapshots/save",
            {
                "actor_id": "newbie",
                "product_id": "GF-SNAP-88",
                "title_raw": "iPhone 15 Pro 几乎全新",
                "images": ["./evidence/IMG_5878.PNG", "./evidence/IMG_5881.PNG"],
            },
        )
        st_snap2, snap2 = req(
            base,
            "POST",
            "/api/snapshots/save",
            {
                "actor_id": "newbie",
                "product_id": "GF-SNAP-88",
                "title_raw": "iPhone 15 Pro 卖家改了标题",
                "images": ["./evidence/IMG_5878.PNG"],
            },
        )
        check(
            "规格冲突待核人工修正解锁(CONV-007) + 商品页多图快照自动存档按版本号递增(v1->v2)",
            st_fix == 200
            and fix_res["matched_status"] == "matched"
            and st_snap1 == 200
            and snap1["version_no"] == 1
            and st_snap2 == 200
            and snap2["version_no"] == 2,
        )

        # 16. v5.0 独立监听端商品链接投递幂等去重 + 1前台3后台执行队列拉取与回执 + 双轨切换
        st_ing1, ing1 = req(
            base,
            "POST",
            "/api/leads/ingest",
            {"actor_id": "liming", "platform": "goofish", "product_id": "GF-ING-777", "account_id": "ACC-GF-01", "title": "M3 MacBook 几乎全新"},
        )
        st_ing2, ing2 = req(
            base,
            "POST",
            "/api/leads/ingest",
            {"actor_id": "liming", "platform": "goofish", "product_id": "GF-ING-777", "account_id": "ACC-GF-01", "title": "重复投递"},
        )
        st_jobs, jobs_res = req(base, "GET", "/api/executor/jobs?status=queued")
        st_ack, ack_res = req(base, "POST", "/api/executor/jobs/ack", {"actor_id": "liming", "job_id": ing1["job_id"], "status": "completed"})
        st_trk, trk_res = req(
            base,
            "POST",
            "/api/aftersales/TK-2404/step1-triage",
            {"actor_id": "liming", "route_choice": "bargain_keep", "arrival_track": "signed_platform_return"},
        )
        check(
            "监听端链接投递幂等去重 + 执行器队列(GET/ACK) + 二次议价双轨切换(sf_express_refuse <-> signed_platform_return)闭环",
            st_ing1 == 200
            and ing1["deduplicated"] is False
            and st_ing2 == 200
            and ing2["deduplicated"] is True
            and st_jobs == 200
            and jobs_res["count"] >= 1
            and st_ack == 200
            and ack_res["status"] == "completed"
            and st_trk == 200
            and trk_res["flow_state"]["arrival_track"] == "signed_platform_return",
        )

        # 17. AdsPower 闲鱼内嵌 Copilot v5.0 ZIP 扩展包完整性校验
        st_ads, ads_res = req(base, "GET", "/api/adspower/status")
        ads = ads_res.get("adspower", {})
        zip_path = os.path.join(ROOT, "采购Copilot-AdsPower插件.zip")
        with zipfile.ZipFile(zip_path, "r") as zf:
            names = set(zf.namelist())
            mf = json.loads(zf.read("manifest.json").decode("utf-8"))
        check(
            "AdsPower 闲鱼内嵌 Copilot v5.0 扩展包完整就绪（含多图快照抓取+灯箱UI+四Dock侧边栏）",
            st_ads == 200
            and ads.get("ext_ready") is True
            and mf.get("manifest_version") == 3
            and mf.get("version") == "5.0.0"
            and {
                "manifest.json",
                "background.js",
                "product-snapshot.js",
                "snapshot-ui.js",
                "content.js",
                "integration.css",
                "sidebar.html",
                "sidebar.css",
                "sidebar.js",
                "popup.html",
            }.issubset(names),
            f"manifest={mf}",
        )

        # 18. 次日10:00前昨日财务对账单 × 采购订单抓全核对闭环（漏单检出 -> 未清零禁签字409 -> CSV幂等导入 -> 一键补抓 -> 差额核平 -> 100%抓全打卡）
        _, d_stmt0 = req(base, "GET", "/api/dashboard")
        rec0 = d_stmt0["data"]["statement_reconciliation"]["summary"]
        cases_cnt0 = len(d_stmt0["data"]["cases"])
        st_sign_early, sign_early = req(base, "POST", "/api/reconcile/signoff", {"actor_id": "liming"})
        check(
            "次日10:00昨日对账单初始检出 2 笔漏抓单 + 1 笔实付差额，未清零前禁止提前签字(409 UNRESOLVED_STATEMENT_DIFFS)",
            rec0["missing_count"] == 2
            and rec0["amount_diff_count"] == 1
            and rec0["all_clear"] is False
            and st_sign_early == 409
            and sign_early.get("code") == "UNRESOLVED_STATEMENT_DIFFS",
            str(rec0),
        )

        csv_line = "PAY-ALI-TEST99, GF-ORD-TEST99, 杭州卖家老陈, MacBook Air M2 16+512 几乎全新, 4200, 昨日 20:15, 闲鱼3号"
        st_imp1, imp1 = req(base, "POST", "/api/reconcile/import", {"actor_id": "chenkj", "raw_text": csv_line})
        st_imp2, imp2 = req(base, "POST", "/api/reconcile/import", {"actor_id": "chenkj", "raw_text": csv_line})
        st_bf, bf_res = req(base, "POST", "/api/reconcile/backfill", {"actor_id": "liming", "backfill_all": True})
        st_fix_diff, _ = req(
            base,
            "POST",
            "/api/reconcile/resolve-diff",
            {"actor_id": "liming", "stmt_item_id": "ST-08", "action": "sync_to_statement"},
        )
        st_sign_ok, sign_ok = req(base, "POST", "/api/reconcile/signoff", {"actor_id": "liming"})
        _, d_stmt1 = req(base, "GET", "/api/dashboard")
        rec1 = d_stmt1["data"]["statement_reconciliation"]["summary"]
        check(
            "昨日对账单CSV幂等导入 -> 一键补抓全部3笔漏单进采购订单库 -> 核平顺丰保价差额 -> 次日10:00 100%抓全打卡成功",
            st_imp1 == 200
            and imp1["imported_count"] == 1
            and st_imp2 == 200
            and imp2["deduplicated_count"] == 1
            and st_bf == 200
            and bf_res["backfilled_count"] == 3
            and len(d_stmt1["data"]["cases"]) == cases_cnt0 + 3
            and st_fix_diff == 200
            and st_sign_ok == 200
            and sign_ok["status"] == "all_reconciled"
            and rec1["missing_count"] == 0
            and rec1["amount_diff_count"] == 0
            and rec1["signed_off"] is True,
            str(rec1),
        )

        # 19. 账号退款率 ≤5% & 纠纷率 ≤5% 防红标监控盾 + 非必要禁扯皮/禁擅点小二介入全链路硬锁校验
        shield0 = d_stmt1["data"]["account_risk_shield"]
        acct2 = next(a for a in shield0["accounts"] if a["account_id"] == "闲鱼副号2")
        check(
            "闲鱼账号5%防红标监控盾实时追踪近30天退款率/纠纷率，精准预警副号2(4.71%再退1单破5.88%红标)并推荐闲鱼3号(1.67%)",
            shield0["redline_pct"] == 5.0
            and acct2["refund_rate_pct"] == 4.71
            and acct2["will_breach_on_next_refund"] is True
            and shield0["summary"]["recommended_safe_account"] == "闲鱼3号",
            str(shield0["summary"]),
        )

        # 闲鱼聊天反扯皮/威胁小二介入词 422 拦截 + 员工擅点小二介入 409 拦截 + 买前一键换安全号 + 零退款率保号留货闭环
        req(base, "POST", "/api/conversations/CONV-002/resume", {"actor_id": "liming"})
        _, d_conv2 = req(base, "GET", "/api/dashboard")
        c2_ver = next(x["context_version"] for x in d_conv2["data"]["conversations"] if x["conv_id"] == "CONV-002")
        st_bicker, bicker_r = req(
            base,
            "POST",
            "/api/conversations/CONV-002/send",
            {"actor_id": "liming", "text": "你不退我现在就点小二介入闲鱼小法庭见", "expected_context_version": c2_ver},
        )
        st_int_forb, int_forb = req(
            base,
            "POST",
            "/api/aftersales/TK-2401/request-intervention",
            {"actor_id": "liming", "severe_fraud_confirmed": False, "reason": "卖家不肯便宜50块"},
        )
        st_sw, sw_res = req(
            base,
            "POST",
            "/api/cases/CASE-003/switch-safe-account",
            {"actor_id": "liming", "target_account_id": "闲鱼3号"},
        )
        st_zr, zr_res = req(
            base,
            "POST",
            "/api/aftersales/TK-2401/zero-refund-keep",
            {"actor_id": "liming", "private_comp_cents": 15000, "note": "零退款率保号留货不占5%红标额度"},
        )
        check(
            "5%防红标四大强控：闲鱼扯皮词拦截(422) + 员工擅点小二介入硬锁(409) + 买前切换低退款率安全号 + 零退款率保号留货闭环",
            st_bicker == 422
            and bicker_r.get("code") == "ANTI_BICKERING_BLOCKED"
            and st_int_forb == 409
            and int_forb.get("code") == "DISPUTE_INTERVENTION_FORBIDDEN"
            and st_sw == 200
            and sw_res["new_account_id"] == "闲鱼3号"
            and st_zr == 200
            and zr_res["zero_refund_rate_protected"] is True,
            f"bicker={bicker_r}, int_forb={int_forb}",
        )

        print(f"\n全部通过：{passed} 项采购工作台 v5.2（次日10:00昨日对账单抓全核对 + 5%退款/纠纷防红标反扯皮硬锁 + 两段10%零重算 + 双轨12奇兵）断言验证成功！")
    finally:
        server.shutdown()
        if os.path.exists(TMP_DB):
            os.remove(TMP_DB)


if __name__ == "__main__":
    main()
