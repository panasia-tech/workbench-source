from __future__ import annotations

import json
from collections import Counter
from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    LongTable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "credential-status-report-2026-08-19.pdf"
FONT_PATH = "/System/Library/Fonts/STHeiti Medium.ttc"

NAVY = colors.HexColor("#17324D")
BLUE = colors.HexColor("#2B6EF3")
GREEN = colors.HexColor("#16834A")
AMBER = colors.HexColor("#A56800")
RED = colors.HexColor("#B63A3A")
INK = colors.HexColor("#26364A")
MUTED = colors.HexColor("#64748B")
LINE = colors.HexColor("#D9E1EA")
PALE_BLUE = colors.HexColor("#EEF4FF")
PALE_GREEN = colors.HexColor("#ECF8F0")
PALE_AMBER = colors.HexColor("#FFF7E6")
PALE_RED = colors.HexColor("#FFF0F0")


def load_manifest() -> dict:
    return json.loads((ROOT / "config" / "orchestration.json").read_text(encoding="utf-8"))


def load_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "title",
            parent=base["Title"],
            fontName="CJK",
            fontSize=25,
            leading=34,
            textColor=NAVY,
            spaceAfter=10,
        ),
        "subtitle": ParagraphStyle(
            "subtitle",
            parent=base["Normal"],
            fontName="CJK",
            fontSize=10.5,
            leading=17,
            textColor=MUTED,
            spaceAfter=16,
        ),
        "h1": ParagraphStyle(
            "h1",
            parent=base["Heading1"],
            fontName="CJK",
            fontSize=17,
            leading=23,
            textColor=NAVY,
            spaceBefore=5,
            spaceAfter=9,
        ),
        "h2": ParagraphStyle(
            "h2",
            parent=base["Heading2"],
            fontName="CJK",
            fontSize=11.5,
            leading=17,
            textColor=INK,
            spaceBefore=7,
            spaceAfter=5,
        ),
        "body": ParagraphStyle(
            "body",
            parent=base["BodyText"],
            fontName="CJK",
            fontSize=9.5,
            leading=16,
            textColor=INK,
            spaceAfter=6,
        ),
        "small": ParagraphStyle(
            "small",
            parent=base["BodyText"],
            fontName="CJK",
            fontSize=7.4,
            leading=10.5,
            textColor=MUTED,
        ),
        "table": ParagraphStyle(
            "table",
            parent=base["BodyText"],
            fontName="CJK",
            fontSize=7.5,
            leading=10.5,
            textColor=INK,
        ),
        "table_head": ParagraphStyle(
            "table_head",
            parent=base["BodyText"],
            fontName="CJK",
            fontSize=7.5,
            leading=10.5,
            textColor=colors.white,
        ),
        "card_value": ParagraphStyle(
            "card_value",
            parent=base["BodyText"],
            fontName="CJK",
            fontSize=18,
            leading=22,
            textColor=NAVY,
            alignment=1,
        ),
        "card_label": ParagraphStyle(
            "card_label",
            parent=base["BodyText"],
            fontName="CJK",
            fontSize=7.5,
            leading=10,
            textColor=MUTED,
            alignment=1,
        ),
    }


def para(text: object, style: ParagraphStyle) -> Paragraph:
    return Paragraph(str(text).replace("&", "&amp;").replace("\n", "<br/>"), style)


def table(data, widths, repeat_header=True):
    commands = [
        ("FONTNAME", (0, 0), (-1, -1), "CJK"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]
    if repeat_header:
        commands.extend(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("REPEATROWS", (0, 0), (-1, 0)),
            ]
        )
        start = 1
    else:
        start = 0
    for row in range(start, len(data)):
        if (row - start) % 2 == 0:
            commands.append(("BACKGROUND", (0, row), (-1, row), colors.HexColor("#F8FAFC")))
    result = LongTable(data, colWidths=widths, repeatRows=1 if repeat_header else 0)
    result.setStyle(TableStyle(commands))
    return result


def cards(items):
    cells = []
    for value, label in items:
        cells.append(
            Table(
                [[para(value, STYLES["card_value"])], [para(label, STYLES["card_label"])]],
                colWidths=[40 * mm],
                rowHeights=[13 * mm, 8 * mm],
                style=TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (-1, -1), PALE_BLUE),
                        ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ]
                ),
            )
        )
    return Table([cells], colWidths=[44 * mm] * len(cells))


def cell(text: object) -> Paragraph:
    return para(text, STYLES["table"])


PROVIDER_ROWS = [
    [
        "勇敢浏览图片",
        "图片搜索接口密钥",
        "BRAVE_SEARCH_API_KEY",
        "优先申请。让公开图片搜索更稳定。",
    ],
    [
        "谷歌图片搜索",
        "接口密钥 + 搜索引擎编号",
        "GOOGLE_API_KEY / GOOGLE_CX",
        "优先申请。作为勇敢浏览的备用来源。",
    ],
    [
        "红迪网 Reddit",
        "官方开发者账号：编号、密钥、软件名称",
        "REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET / REDDIT_USER_AGENT",
        "搜索公开帖子和图片。",
    ],
    [
        "抖音官方接口",
        "官方访问令牌 + 设备编号",
        "DOUYIN_ACCESS_TOKEN / DOUYIN_DEVICE_ID",
        "还要申请对应的搜索权限。",
    ],
    [
        "小红书接入器",
        "接入地址 + 合法登录状态",
        "XHS_ADAPTER_URL / XHS_COOKIE",
        "必须是自己控制的合法登录状态。",
    ],
    [
        "搜索聚合服务 SearXNG",
        "自己搭建或信任的服务地址",
        "SEARXNG_URL",
        "不是账号密码，是一个可用的搜索服务地址。",
    ],
]

PLATFORM_AUTH = {
    "douyin_shop": ["抖音电商", "抖音官方搜索工位", "官方访问令牌、设备编号和对应权限"],
    "taobao": ["淘宝", "淘宝登录状态检查工位", "合法登录状态或自己提供的登录凭据"],
    "tmall": ["天猫", "天猫登录状态检查工位", "合法登录状态或自己提供的登录凭据"],
    "ebay": ["eBay", "官方商品接口工位", "官方开发者账号和接口授权"],
    "aliexpress": ["速卖通 AliExpress", "官方评价接口工位", "开放平台开发者账号和接口授权"],
    "mercado_libre": ["Mercado Libre", "官方商品接口工位", "官方开发者账号或用户授权"],
    "etsy": ["Etsy", "官方评价接口工位", "官方开发者账号或用户授权"],
    "rakuten": ["乐天 Rakuten", "官方商品接口工位", "应用编号和接口访问密钥"],
}


def platform_rows(manifest):
    display_names = {
        "Amazon": "亚马逊 Amazon",
        "Walmart": "沃尔玛 Walmart",
        "Shopee": "虾皮 Shopee",
        "eBay": "易贝 eBay",
        "AliExpress": "速卖通 AliExpress",
        "SHEIN": "希音 SHEIN",
        "抖音电商/TikTok Shop": "抖音电商",
        "Facebook Marketplace": "Facebook 二手市场",
        "Depop/Poshmark": "二手平台 Depop/Poshmark",
    }
    rows = []
    for platform in manifest["platforms"]:
        counts = Counter(c.get("health", "unverified") for c in platform["components"])
        if counts["auth_required"]:
            action = "先申请授权"
        elif counts["unverified"] or counts["reference_only"]:
            action = "开发后测试"
        else:
            action = "可以使用"
        rows.append(
            [
                cell(display_names.get(platform["name"], platform["name"])),
                cell(str(len(platform["components"]))),
                cell(str(counts["ready"])),
                cell(str(counts["auth_required"])),
                cell(str(counts["unverified"])),
                cell(str(counts["reference_only"])),
                cell(action),
            ]
        )
    return rows


def project_lists(manifest):
    reference = []
    unverified = []
    ready = []
    for platform in manifest["platforms"]:
        for component in platform["components"]:
            name = f"{platform['name']}：{component['name']}"
            state = component.get("health", "unverified")
            if state == "reference_only":
                reference.append(name)
            elif state == "unverified":
                unverified.append(name)
            elif state == "ready":
                ready.append(name)
    return reference, unverified, ready


def page_footer(canvas, doc):
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(LINE)
    canvas.line(doc.leftMargin, height - 18 * mm, width - doc.rightMargin, height - 18 * mm)
    canvas.setFont("CJK", 7.2)
    canvas.setFillColor(MUTED)
    canvas.drawString(doc.leftMargin, 10 * mm, "图片检索服务 | 凭证清单（傻瓜版）")
    canvas.drawRightString(width - doc.rightMargin, 10 * mm, f"第 {doc.page} 页")
    canvas.restoreState()


def build_report() -> Path:
    global STYLES
    pdfmetrics.registerFont(TTFont("CJK", FONT_PATH, subfontIndex=0))
    STYLES = load_styles()
    manifest = load_manifest()
    platforms = manifest["platforms"]
    components = [component for platform in platforms for component in platform["components"]]
    reference, unverified, ready = project_lists(manifest)
    story = [Spacer(1, 17 * mm)]

    story += [
        para("图片检索服务", STYLES["title"]),
        para("凭证清单（傻瓜版）", STYLES["title"]),
        para(f"报告日期：{date.today().isoformat()}", STYLES["subtitle"]),
        para(
            "你今天只需要看懂这份报告，不需要研究技术。需要申请什么、申请之后怎么做，都已经按顺序写好。",
            STYLES["body"],
        ),
        Spacer(1, 4 * mm),
        cards(
            [
                ["6 项", "现在需要申请的服务"],
                ["8 个", "明确需要授权的网站"],
                ["26 个", "已经登记的网站"],
                ["73 个", "项目和处理工位"],
            ]
        ),
        Spacer(1, 9 * mm),
        para("先记住这三句话", STYLES["h1"]),
        para("1. 没有一个通用的“机器人密码”，每个网站需要的东西不同。", STYLES["body"]),
        para(
            "2. 你现在最值得先申请的是：勇敢浏览图片、谷歌图片搜索、红迪网、抖音官方接口。",
            STYLES["body"],
        ),
        para(
            "3. 员工以后只要照着这份报告申请、填入后台、点击健康检查，不需要理解每个开源项目的内部代码。",
            STYLES["body"],
        ),
        Spacer(1, 4 * mm),
        para(
            "目前能直接工作的基础来源：官方网页、必应公开图片。当前缺凭证不会让整个系统停止。",
            STYLES["body"],
        ),
        PageBreak(),
    ]

    story += [
        para("第一步：先申请这 6 项", STYLES["h1"]),
        para(
            "按下面顺序申请即可。括号里的英文是后台或环境里要填写的准确字段名，不能翻译。",
            STYLES["body"],
        ),
    ]
    provider_data = [
        [
            para("名称", STYLES["table_head"]),
            para("你要拿到什么", STYLES["table_head"]),
            para("填写字段", STYLES["table_head"]),
            para("拿到以后做什么", STYLES["table_head"]),
        ]
    ]
    provider_data.extend(
        [[cell(row[0]), cell(row[1]), cell(row[2]), cell(row[3])] for row in PROVIDER_ROWS]
    )
    story += [table(provider_data, [31 * mm, 46 * mm, 58 * mm, 40 * mm]), Spacer(1, 7 * mm)]
    story += [
        para("最省力的申请顺序", STYLES["h2"]),
        para("第一批：勇敢浏览图片 或 谷歌图片搜索。先让搜索数量稳定下来。", STYLES["body"]),
        para("第二批：红迪网和抖音官方接口。它们更接近公开社区和视频平台。", STYLES["body"]),
        para("第三批：小红书接入器和搜索聚合服务。没有业务需要时可以先不申请。", STYLES["body"]),
        para(
            "提醒：gallery-dl 是一个需要安装的软件，不是凭证；浏览器备用工位目前是关闭的，也不是凭证问题。",
            STYLES["body"],
        ),
        PageBreak(),
    ]

    story += [
        para("第二步：明确需要授权的 8 个网站", STYLES["h1"]),
        para(
            "这些网站的项目清单已经明确写了“需要授权”。没有授权时，员工不用反复点击，直接按表申请即可。",
            STYLES["body"],
        ),
    ]
    auth_data = [
        [
            para("网站", STYLES["table_head"]),
            para("缺口工位", STYLES["table_head"]),
            para("需要准备什么", STYLES["table_head"]),
        ]
    ]
    for website, component, credential in PLATFORM_AUTH.values():
        auth_data.append([cell(website), cell(component), cell(credential)])
    story += [table(auth_data, [38 * mm, 56 * mm, 81 * mm]), Spacer(1, 7 * mm)]
    story += [
        para("特别说明", STYLES["h2"]),
        para(
            "淘宝和天猫需要的是合法登录状态，不是所谓“机器人密码”。登录状态只能由你或公司自己提供。",
            STYLES["body"],
        ),
        para(
            "eBay、速卖通、Mercado Libre、Etsy、乐天需要官方开发者授权。报告已经列出方向，但具体申请字段要以各自开发者后台为准。拿到后，再由员工填入后台并做一次真实测试。",
            STYLES["body"],
        ),
        PageBreak(),
    ]

    story += [
        para("第三步：26 个网站现在是什么状态", STYLES["h1"]),
        para("看“下一步”一列就够了：先申请授权、开发后测试，或者可以使用。", STYLES["body"]),
    ]
    platform_data = [
        [
            para("网站", STYLES["table_head"]),
            para("工位数", STYLES["table_head"]),
            para("可以用", STYLES["table_head"]),
            para("要授权", STYLES["table_head"]),
            para("未测试", STYLES["table_head"]),
            para("仅参考", STYLES["table_head"]),
            para("下一步", STYLES["table_head"]),
        ]
    ]
    platform_data.extend(platform_rows(manifest))
    story += [
        table(platform_data, [35 * mm, 17 * mm, 17 * mm, 17 * mm, 17 * mm, 17 * mm, 38 * mm]),
        PageBreak(),
    ]

    story += [
        para("第四步：员工照着做", STYLES["h1"]),
        para("以后新增网站，也照这个顺序，不要直接运行网上下载的陌生脚本。", STYLES["body"]),
    ]
    steps = [
        ["1", "申请", "按本报告找到官方申请入口，拿到接口密钥、访问令牌或合法登录状态。"],
        ["2", "填写", "打开后台，把凭证填到对应的网站或服务栏目。敏感内容会加密并隐藏。"],
        ["3", "检查", "点击“健康检查”。如果显示需要申请，说明凭证还没填对或权限不够。"],
        ["4", "试搜", "用 AOC 24G2、Sonos Era 300 或 ROG XG259CMS 做一次真实搜索。"],
        ["5", "确认", "图片能打开、能解码、型号正确，才把这个项目标记为可以使用。"],
    ]
    step_data = [
        [
            para("顺序", STYLES["table_head"]),
            para("做什么", STYLES["table_head"]),
            para("最简单的做法", STYLES["table_head"]),
        ]
    ]
    step_data.extend([[cell(row[0]), cell(row[1]), cell(row[2])] for row in steps])
    story += [table(step_data, [17 * mm, 35 * mm, 112 * mm]), Spacer(1, 8 * mm)]
    story += [
        para("员工遇到这 4 种状态时怎么处理", STYLES["h2"]),
        para("需要申请：找老板申请对应网站的官方凭证。", STYLES["body"]),
        para("未测试：不要说已经能用，交给开发人员做一次真实测试。", STYLES["body"]),
        para("仅供参考：只是登记的开源项目，不能直接点击运行。", STYLES["body"]),
        para("可以使用：可以进入正常搜索，但仍然要看图片和型号是否正确。", STYLES["body"]),
        Spacer(1, 4 * mm),
        para(
            f"本报告的项目统计：已登记 {len(platforms)} 个网站、{len(components)} 个工位；其中 {len(ready)} 个本地工位已具备，8 个需要授权，{len(unverified)} 个还未测试，{len(reference)} 个只是参考项目。",
            STYLES["body"],
        ),
        para(
            "报告不包含任何真实密钥。资料来源：项目里的平台清单、凭证说明和当前服务状态。",
            STYLES["small"],
        ),
    ]

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        rightMargin=15 * mm,
        leftMargin=15 * mm,
        topMargin=25 * mm,
        bottomMargin=16 * mm,
        title="图片检索服务凭证清单（傻瓜版）",
        author="product-image-service",
    )
    doc.build(story, onFirstPage=page_footer, onLaterPages=page_footer)
    return OUTPUT


if __name__ == "__main__":
    print(build_report())
