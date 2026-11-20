#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""泛亚外包客服工作台 · 桌面版 H5 闭环门禁与单文件完整性自动化校验"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import cs_server  # noqa: E402


def run_tests():
    # 1. 验证外包角色物理剥离采购进价 costPrice 与上游卖家 supplierNick
    sample_state = {
        "version": "test-v1",
        "skus": [
            {
                "skuCode": "990001540233-A",
                "price": 1020,
                "costPrice": 760,
                "supplierNick": "闲鱼卖家_杭州自用出",
            }
        ],
    }
    outsource_view = cs_server.desensitize_for_actor(sample_state, "outsource_lu")
    assert "costPrice" not in outsource_view["skus"][0], "外包视图严禁泄露 costPrice！"
    assert "supplierNick" not in outsource_view["skus"][0], "外包视图严禁泄露 supplierNick！"

    supervisor_view = cs_server.desensitize_for_actor(sample_state, "supervisor")
    assert supervisor_view["skus"][0]["costPrice"] == 760, "主管内部视图应保留 costPrice！"

    # 2. 验证外包提交状态同步时，后端自动保护底表机密不被清空
    merged = cs_server.preserve_internal_secrets(outsource_view, sample_state)
    assert merged["skus"][0]["costPrice"] == 760, "外包写回不得抹除底表 costPrice！"

    # 3. 验证服务端二次外发守卫（拦截手机号、微信号、单字刷尾响；放行合规婉拒话术）
    ok, _ = cs_server.validate_outbound_text("1")
    assert not ok, "单字符 '1' 刷尾响必须被拦截"

    ok, _ = cs_server.validate_outbound_text("加我微信 " + "199" + "0" * 8 + " 私下转")
    assert not ok, "微信号与手机号必须被拦截"

    ok, _ = cs_server.validate_outbound_text("亲，平台规定不能留个人微信哈，实拍视频我直接在这里发您！")
    assert ok, "包含‘不能留微信’的合规婉拒话术必须放行"

    # 4. 验证 dist 与单文件直开版 HTML 均已生成且包含富阳法院管辖卡与退款理由UI图
    single_html = os.path.join(ROOT, "客服工作台-桌面版H5-单文件直开版.html")
    assert os.path.isfile(single_html), "单文件直开版 HTML 未生成"
    size_kb = os.path.getsize(single_html) / 1024
    assert size_kb > 100, f"单文件 HTML 体积异常偏小: {size_kb:.1f} KB"
    html_text = open(single_html, "r", encoding="utf-8").read()
    assert "杭州市富阳区人民法院" in html_text or "%E6%9D%AD%E5%B7%9E%E5%B8%82%E5%AF%8C%E9%98%B3%E5%8C%BA%E4%BA%BA%E6%B0%91%E6%B3%95%E9%99%A2" in html_text, "缺少富阳法院管辖保修卡"
    assert "不想要了" in html_text, "缺少不想要了退款引导逻辑"
    assert "协商一致" in html_text, "缺少协商一致退款引导逻辑"

    print(f"[PASS] 全部后端脱敏门禁、外发守卫与单文件直开包 ({size_kb:.1f} KB) 验收通过！")


if __name__ == "__main__":
    run_tests()
