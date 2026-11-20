"""上架短编码(4 位)分配/回收。

用途:同一类商品(同型号)多件实物同时/先后在架,给每个进入上架流程的 SKU 分配一个
全局当前唯一的 4 位码作为**内部标识**(后台可按码检索 SKU)。

策略(老板 2026-07-29 拍板):
- **上架时生成**(进入上架流程=首次保存上架信息时分配;建品/发布路径幂等兜底);
- **出库后回收复用**(SHIPPED 即清空 short_code 回池;1 万个号永远够用)。

2026-08-31 起不再把 `#NNNN ` 前缀嵌进闲鱼标题(发布/建品均不注入):
售出检测改为「会话宝贝标题 ↔ 账本标题」整标题前缀匹配(见 groupcontrol-server
jobs._detect_sold_listings);历史已发布商品的标题仍带码,老匹配路径保留兼容。
"""

from sqlalchemy.orm import Session

from app.models import Sku

_MIN, _MAX = 1, 9999


def _used_codes(db: Session) -> set[int]:
    rows = db.query(Sku.short_code).filter(Sku.short_code.isnot(None)).all()
    out = set()
    for (code,) in rows:
        try:
            out.add(int(code))
        except (TypeError, ValueError):
            continue
    return out


def ensure_short_code(db: Session, sku: Sku) -> str:
    """给 SKU 分配 4 位短编码(幂等:已有码直接返回)。取当前最小空闲号。"""
    if sku.short_code:
        return sku.short_code
    used = _used_codes(db)
    for n in range(_MIN, _MAX + 1):
        if n not in used:
            sku.short_code = f"{n:04d}"
            db.flush()  # 部分会话 autoflush=False;落盘后续分配才能看到占用
            return sku.short_code
    raise ValueError("4 位上架编码已用完(9999 个在架),请先出库释放")
