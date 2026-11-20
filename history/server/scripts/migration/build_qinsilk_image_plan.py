"""在**本地**跑：把秦丝导出的《商品列表导出(含图片).xlsx》与生产 sku 表对账，
产出「缺图回填计划」JSON + 人工复核用 CSV。

生产那台机器没有这份 Excel，所以匹配在本地做，只把 plan.json 传上去给
backfill_missing_images_from_qinsilk.py 执行。

sku 表用 mysql 导出的 TSV 喂进来（6 列，无表头）：
    SELECT sku_code, IFNULL(serial_number,''), product_name,
           IFNULL(cover_url,''), IFNULL(CAST(images AS CHAR),'[]'), status
    FROM sku
    WHERE (cover_url LIKE 'cloud://%' OR cover_url IS NULL OR cover_url='')
      AND (images IS NULL OR JSON_LENGTH(images)=0 OR CAST(images AS CHAR) NOT LIKE '%http%');

匹配档位见 backfill_missing_images_from_qinsilk.py 的说明。注意二手是一物一码，
同名 ≠ 同一台，所以名称多命中一律打 C 档，默认不回填。

用法：
    python3 -m scripts.migration.build_qinsilk_image_plan \
        --xlsx ~/Downloads/商品列表导出\\(含图片\\).xlsx --sku-tsv gap.tsv \
        --out plan.json --csv 缺图回填计划.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path


def norm(s: object) -> str:
    """归一化比对键：去空白与常见分隔/全半角括号，统一大写。"""
    return re.sub(r"[\s\-_（）()，,。.、/]", "", str(s or "")).upper()


def read_excel(path: Path) -> list[dict]:
    import warnings

    import openpyxl

    warnings.filterwarnings("ignore")
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = []
    for i, r in enumerate(ws.iter_rows(values_only=True), start=1):
        if i == 1:  # 表头：名称/货号/条码/图片链接/图片/...
            continue
        rows.append({"row": i, "name": r[0], "goods_no": r[1], "barcode": r[2], "img_url": r[3]})
    return rows


def read_sku_tsv(path: Path) -> list[dict]:
    cols = ["sku_code", "serial", "name", "cover", "images", "status"]
    out = []
    for line in path.read_text(encoding="utf8").splitlines():
        parts = line.split("\t")
        if len(parts) >= 6:
            out.append(dict(zip(cols, parts)))
    return out


def build_plan(rows: list[dict], gap: list[dict]) -> list[dict]:
    by_code: dict[str, list[dict]] = {}
    by_serial: dict[str, list[dict]] = {}
    by_name: dict[str, list[dict]] = {}
    for d in rows:
        if not d["img_url"]:
            continue
        by_code.setdefault(norm(d["goods_no"]), []).append(d)
        if d["barcode"]:
            by_serial.setdefault(norm(d["barcode"]), []).append(d)
        by_name.setdefault(norm(d["name"]), []).append(d)

    plan = []
    for s in gap:
        code, serial, name = norm(s["sku_code"]), norm(s["serial"]), norm(s["name"])
        if code in by_code and len(by_code[code]) == 1:
            tier, how, hit = "A", "货号唯一", by_code[code][0]
        elif serial and serial in by_serial and len(by_serial[serial]) == 1:
            tier, how, hit = "A", "条码=序列号唯一", by_serial[serial][0]
        elif code in by_code:
            tier, how, hit = "B", "货号多命中", by_code[code][0]
        elif serial and serial in by_serial:
            tier, how, hit = "B", "条码多命中", by_serial[serial][0]
        elif name in by_name and len(by_name[name]) == 1:
            tier, how, hit = "B", "名称唯一", by_name[name][0]
        elif name in by_name:
            tier, how, hit = "C", f"名称多命中({len(by_name[name])})", by_name[name][0]
        else:
            tier, how, hit = "D", "无匹配", None
        plan.append({
            **s,
            "tier": tier,
            "how": how,
            "src_url": hit["img_url"] if hit else None,
            "src_goods_no": hit["goods_no"] if hit else None,
            "excel_row": hit["row"] if hit else None,
        })
    return plan


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", required=True, type=Path)
    ap.add_argument("--sku-tsv", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--csv", type=Path)
    args = ap.parse_args()

    rows = read_excel(args.xlsx)
    gap = read_sku_tsv(args.sku_tsv)
    plan = build_plan(rows, gap)
    args.out.write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf8")

    from collections import Counter

    c = Counter(p["tier"] for p in plan)
    print(f"Excel {len(rows)} 行，缺图 sku {len(gap)} 条 -> {args.out}")
    for t in "ABCD":
        print(f"  Tier {t}: {c.get(t, 0)}")

    if args.csv:
        with args.csv.open("w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["可信度", "sku_code", "商品名称", "序列号", "状态",
                        "原cover", "匹配方式", "秦丝货号", "Excel行", "源图URL"])
            for p in sorted(plan, key=lambda x: (x["tier"], x["sku_code"])):
                cover = ("cloud://死链" if p["cover"].startswith("cloud://")
                         else (p["cover"] or "空"))
                w.writerow([p["tier"], p["sku_code"], p["name"], p["serial"], p["status"],
                            cover, p["how"], p["src_goods_no"] or "",
                            p["excel_row"] or "", p["src_url"] or ""])
        print(f"复核 CSV -> {args.csv}")


if __name__ == "__main__":
    main()
