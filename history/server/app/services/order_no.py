from sqlalchemy.orm import Session

from app.services.finance import china_today


def _next_serial(db: Session, column, base: str, suffix_prefix: str = "") -> int:
    """扫描所有 `<base><suffix_prefix><NNN>` 的现有编号，返回下一个序号。

    - 先 db.flush() 让同一事务内尚未 commit 的 add 行被纳入查询，避免批量插入撞唯一键。
    - 用 MAX 序号 + 1（而非 COUNT），对历史删除/补单也健壮。
    """
    db.flush()
    rows = db.query(column).filter(column.like(f"{base}{suffix_prefix}%")).all()
    cut = len(base) + len(suffix_prefix)
    max_seq = 0
    for (val,) in rows:
        if not val:
            continue
        suffix = str(val)[cut:]
        if suffix.isdigit():
            try:
                max_seq = max(max_seq, int(suffix))
            except ValueError:
                pass
    return max_seq + 1


def generate_order_no(db: Session, prefix: str, table, column: str) -> str:
    today = china_today().strftime("%Y%m%d")
    base = f"{prefix}{today}"
    col = getattr(table, column)
    seq = _next_serial(db, col, base)
    return f"{base}{seq:03d}"


def generate_sku_code(db: Session) -> str:
    from app.models import Sku

    today = china_today().strftime("%Y%m%d")
    base = f"M{today}"
    seq = _next_serial(db, Sku.sku_code, base, suffix_prefix="-")
    return f"{base}-{seq:03d}"


def generate_asset_no(db: Session) -> str:
    from app.models import AssetDevice

    today = china_today().strftime("%Y%m%d")
    base = f"AST{today}"
    seq = _next_serial(db, AssetDevice.asset_no, base)
    return f"{base}{seq:03d}"


def generate_staff_no(db: Session) -> str:
    from app.models import Staff

    rows = db.query(Staff.staff_no).all()
    max_num = 0
    for (no,) in rows:
        if no.startswith("E") and no[1:].isdigit():
            max_num = max(max_num, int(no[1:]))
    return f"E{max_num + 1:03d}"


def calc_suggest_price(cost_price: float, condition_grade: str | None) -> float:
    # 业务上不存在"建议售价"：入库价格即实际采购成本，议价环节人工修正
    return round(float(cost_price), 2)
