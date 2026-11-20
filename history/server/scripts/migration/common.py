"""迁移共享工具:字段转换、ID 映射、JSONL 读取。"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterable

from sqlalchemy.orm import Session

REPO_ROOT = Path(__file__).resolve().parents[3]
CLOUD_DUMP_DIR = REPO_ROOT / "server" / "data" / "cloud_dump"

logger = logging.getLogger("migration")


# ------------------------ 字段转换 ------------------------


def parse_dt(value: Any) -> datetime | None:
    """解析云端日期。

    兼容多种格式:
      - {"$date": 1772213912350}                 (MCP 简化格式)
      - {"$date": {"$numberLong": "1772213..."}} (tcb CLI Extended JSON)
      - {"$date": "2026-04-27T17:07:31.725Z"}    (ISO 字符串包装)
      - 1772213912350                            (毫秒整数)
      - "2026-04-27T17:07:31.725Z"               (ISO 字符串)
    """
    if value is None or value == "":
        return None
    if isinstance(value, dict) and "$date" in value:
        inner = value["$date"]
        if isinstance(inner, dict) and "$numberLong" in inner:
            try:
                ms = int(inner["$numberLong"])
            except (TypeError, ValueError):
                return None
            return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).replace(tzinfo=None)
        if isinstance(inner, (int, float)):
            return datetime.fromtimestamp(inner / 1000, tz=timezone.utc).replace(tzinfo=None)
        return parse_dt(inner)
    if isinstance(value, dict) and "$numberLong" in value:
        try:
            ms = int(value["$numberLong"])
        except (TypeError, ValueError):
            return None
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).replace(tzinfo=None)
    if isinstance(value, (int, float)):
        # 默认认为是毫秒
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc).replace(tzinfo=None)
    if isinstance(value, str):
        s = value.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(s).astimezone(timezone.utc).replace(tzinfo=None)
        except ValueError:
            return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    return None


def parse_date(value: Any) -> date | None:
    dt = parse_dt(value)
    if dt:
        return dt.date()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None
    return None


# 本地 Numeric(12, 2) 的上限:10^10 - 0.01。云端少量脏数据是科学记数法溢出
# (e.g. 3.3e20 分),会让结果远超列容量。超界视为 0,记一条 warning。
_AMOUNT_MAX = Decimal("9999999999.99")


def fen_to_yuan(fen: Any) -> Decimal:
    """金额单位:分 → 元,保留 2 位小数。None / 非数字 → 0;超 Numeric(12,2) 容量 → 0(带 warning)。"""
    if fen is None or fen == "":
        return Decimal("0.00")
    try:
        yuan = (Decimal(str(fen)) / Decimal(100)).quantize(Decimal("0.01"))
    except Exception:
        return Decimal("0.00")
    if abs(yuan) > _AMOUNT_MAX:
        logger.warning("金额超出 Numeric(12,2) 容量,落 0:原值=%s 转换=%s", fen, yuan)
        return Decimal("0.00")
    return yuan


def fen_to_yuan_opt(fen: Any) -> Decimal | None:
    if fen is None or fen == "":
        return None
    try:
        yuan = (Decimal(str(fen)) / Decimal(100)).quantize(Decimal("0.01"))
    except Exception:
        return None
    if abs(yuan) > _AMOUNT_MAX:
        logger.warning("金额超出 Numeric(12,2) 容量,落 NULL:原值=%s 转换=%s", fen, yuan)
        return None
    return yuan


def safe_str(value: Any, max_len: int | None = None) -> str | None:
    if value is None:
        return None
    s = str(value)
    if max_len and len(s) > max_len:
        s = s[:max_len]
    return s


def safe_list(value: Any) -> list:
    if isinstance(value, list):
        return value
    if value is None:
        return []
    return [value]


def safe_dict(value: Any) -> dict | None:
    if isinstance(value, dict):
        return value
    return None


def is_soft_deleted(doc: dict) -> bool:
    """识别软删除文档。云端用 isDeleted / deleted 双字段。"""
    if doc.get("isDeleted") is True or doc.get("deleted") is True:
        return True
    data = doc.get("data") or {}
    return data.get("isDeleted") is True or data.get("deleted") is True


def new_local_uuid() -> str:
    return str(uuid.uuid4())


# ------------------------ JSONL 读取 ------------------------


def _unwrap_extended_json(value: Any) -> Any:
    """递归拍平 MongoDB Extended JSON 的数字包装。

    - ``{"$numberInt": "48"}``    → ``48``
    - ``{"$numberLong": "1772"}`` → ``1772``
    - ``{"$numberDouble": "1.5"}``→ ``1.5``
    - ``{"$oid": "..."}``         → 字符串(便于直接当 id 使用)

    ``$date`` 保留原样,由 :func:`parse_dt` 自己处理。其余结构原样递归。
    """
    if isinstance(value, dict):
        if len(value) == 1:
            k, v = next(iter(value.items()))
            if k == "$numberInt" or k == "$numberLong":
                try:
                    return int(v)
                except (TypeError, ValueError):
                    return None
            if k == "$numberDouble":
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return None
            if k == "$oid":
                return v if isinstance(v, str) else value
        # $date 等其他单键 / 多键 dict:递归子字段
        return {k: _unwrap_extended_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_unwrap_extended_json(v) for v in value]
    return value


def iter_jsonl(collection: str) -> Iterable[dict]:
    path = CLOUD_DUMP_DIR / f"{collection}.jsonl"
    if not path.exists():
        logger.warning("dump 文件不存在: %s,跳过该集合", path)
        return
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            doc = _unwrap_extended_json(json.loads(line))
            yield doc


# ------------------------ ID 映射 ------------------------


class UniqueGuard:
    """跨记录的唯一值去重器。

    用法:
        guard = UniqueGuard()
        order_no = guard.ensure("sale_order.order_no", raw_no, max_len=32)

    撞键时追加 ``#2``、``#3``、…… 单调递增的后缀,保证最终结果唯一;
    若指定 ``max_len``,会截断主体以腾出后缀位置。
    适用于:云端 dump 在某些字段(outTradeNo、sn 等)上有重复,
    但本地表对应列是 UNIQUE 的场景。
    """

    def __init__(self) -> None:
        self._seen: dict[str, set[str]] = {}

    def ensure(self, scope: str, value: str, max_len: int | None = None) -> str:
        seen = self._seen.setdefault(scope, set())
        candidate = value if max_len is None else value[:max_len]
        if candidate not in seen:
            seen.add(candidate)
            return candidate
        i = 2
        while True:
            suffix = f"#{i}"
            base = value if max_len is None else value[: max(0, max_len - len(suffix))]
            cand = base + suffix
            if cand not in seen:
                seen.add(cand)
                return cand
            i += 1


class IdMapper:
    """内存中的 cloud_id → local_id 映射,按 collection 隔离。

    迁移单次执行内有效;持久化可选(写入 data/cloud_dump/id_map.json)。
    """

    def __init__(self) -> None:
        self._maps: dict[str, dict[str, str]] = {}

    def put(self, collection: str, cloud_id: str, local_id: str) -> None:
        self._maps.setdefault(collection, {})[cloud_id] = local_id

    def get(self, collection: str, cloud_id: str | None) -> str | None:
        if not cloud_id:
            return None
        return self._maps.get(collection, {}).get(cloud_id)

    def get_or_new(self, collection: str, cloud_id: str) -> str:
        local_id = self.get(collection, cloud_id)
        if local_id:
            return local_id
        local_id = new_local_uuid()
        self.put(collection, cloud_id, local_id)
        return local_id

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(self._maps, ensure_ascii=False, indent=2))

    def load(self, path: Path) -> None:
        if not path.exists():
            return
        self._maps = json.loads(path.read_text(encoding="utf-8"))


# ------------------------ ETL 注册表 ------------------------


class EtlStep:
    def __init__(
        self,
        name: str,
        collection: str,
        runner: Callable[[Session, "IdMapper"], int],
        depends_on: list[str] | None = None,
    ) -> None:
        self.name = name
        self.collection = collection
        self.runner = runner
        self.depends_on = depends_on or []

    def run(self, db: Session, mapper: IdMapper) -> int:
        logger.info("[%s] 开始迁移 collection=%s", self.name, self.collection)
        n = self.runner(db, mapper)
        db.commit()
        logger.info("[%s] 完成,导入 %d 条", self.name, n)
        return n
