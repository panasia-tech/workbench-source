#!/usr/bin/env python3
"""初始化基础「商品种类类型」及其 AI 重绘/生图提示词（幂等：按名跳过已存在）。

用法: venv/bin/python scripts/seed_product_types.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal
from app.models import ProductType

# 提示词面向 gpt-image-2「重绘」（图生图）：把仓库实拍图整理成纯白底电商主图，
# 保留真实商品/成色，不美化不修复；也可用于文生图时的风格基准。
_BASE = (
    "纯白背景，商品居中，完整保留商品本身的型号、颜色、外观与成色细节"
    "（磨损/划痕如实保留，不美化不修复不换新），去除桌面杂物与杂乱背景，"
    "柔和均匀布光、无强反光，方形构图，高清，画面不添加任何文字、水印或 logo。"
)

SEEDS = [
    ("手机", 10, "将这张二手手机的实拍图处理为专业电商主图：手机正面平放，" + _BASE),
    ("平板电脑", 20, "将这张二手平板电脑的实拍图处理为专业电商主图：平板正面平放，" + _BASE),
    ("笔记本电脑", 30, "将这张二手笔记本电脑的实拍图处理为专业电商主图：机身约 45 度半开展示，" + _BASE),
    ("台式主机", 40, "将这张二手台式机/主机的实拍图处理为专业电商主图：机箱正面 45 度展示，" + _BASE),
    ("显示器", 50, "将这张二手显示器的实拍图处理为专业电商主图：显示器正面略带角度展示，" + _BASE),
    ("数码配件", 60, "将这张二手数码配件（充电器/耳机/数据线等）的实拍图处理为专业电商主图：配件居中平铺，" + _BASE),
    ("智能穿戴", 70, "将这张二手智能手表/手环的实拍图处理为专业电商主图：表盘正面展示，" + _BASE),
]


def main():
    db = SessionLocal()
    try:
        created = 0
        for name, sort_order, prompt in SEEDS:
            if db.query(ProductType).filter(ProductType.name == name).first():
                print(f"skip existing: {name}")
                continue
            db.add(
                ProductType(
                    name=name,
                    enabled=True,
                    sort_order=sort_order,
                    prompt=prompt,
                    ai_size="1:1",
                    ai_resolution="2k",
                )
            )
            created += 1
            print(f"create: {name}")
        db.commit()
        print(f"done. created {created} product types.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
