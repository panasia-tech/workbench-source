from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

import logging

from app.config import settings

logger = logging.getLogger("gc.db")

# SQLite 需要 check_same_thread=False 以便桥线程池复用连接
connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    connect_args=connect_args,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# 新加到已存在表上的列(dev 用 create_all,它只建缺失的表、**不会** ALTER 老表)。
# gc.db 已在跑,故启动时对老库做一段幂等 ADD COLUMN,别让扩了模型的老库炸。
# SQLite/MySQL 均支持 `ALTER TABLE ... ADD COLUMN <可空列>`,类型给到能覆盖两者的最小集即可。
_LIGHT_MIGRATIONS: dict[str, dict[str, str]] = {
    "gc_device": {
        "kind": "VARCHAR(16)",
        "hw_id": "VARCHAR(64)",
        "last_ready": "BOOLEAN",
        "last_check_at": "DATETIME",
        "blocking": "VARCHAR(255)",
        "reported_nick": "VARCHAR(64)",
        "account_id": "VARCHAR(36)",
        "last_heartbeat_at": "DATETIME",
        "last_event": "VARCHAR(255)",
        "last_event_at": "DATETIME",
        "last_exit_reason": "VARCHAR(64)",
        "last_exit_at": "DATETIME",
        "serial": "VARCHAR(64)",
        "imei1": "VARCHAR(32)",
        "imei2": "VARCHAR(32)",
        "phone_number": "VARCHAR(32)",
        "xianyu_member_name": "VARCHAR(64)",
        "maintenance_since": "DATETIME",
        "maintenance_until": "DATETIME",
        "maintenance_reason": "VARCHAR(64)",
    },
    "gc_conversation": {
        "item_price": "VARCHAR(32)",
        "item_image": "VARCHAR(1024)",
        "listing_sku": "VARCHAR(64)",
        "item_id": "VARCHAR(64)",
    },
    "gc_chat_message": {
        "media": "JSON",
        "card": "JSON",
    },
    "gc_listing": {
        "refresh_skip": "VARCHAR(64)",
    },
}

# 老库补建唯一索引(新库由 create_all 按模型 unique=True 自带)。有重复值时跳过并告警,先人工清数据。
_LIGHT_UNIQUE_INDEXES: dict[str, tuple[str, str]] = {
    "gc_account": ("ux_gc_account_nick", "nick"),
}

# 补列后的老库回填(新增可空列但模型要求非默认值时,把 NULL 刷成默认,保持 ORM 非空约定)。
_LIGHT_BACKFILLS: dict[str, str] = {
    "gc_device": "UPDATE gc_device SET kind='android' WHERE kind IS NULL",
}


def run_light_migrations(bind=engine) -> None:
    """启动时对已存在的表补齐新列(幂等):对每张表,缺哪列补哪列;hw_id 补后建唯一索引。

    仅在列缺失时执行——新库(create_all 已带全列)整段跳过,故对全新库/内存测试库无副作用。
    """
    insp = inspect(bind)
    tables = set(insp.get_table_names())
    for table, cols in _LIGHT_MIGRATIONS.items():
        if table not in tables:
            continue  # 表不存在:create_all 会按最新模型整表建好,无需迁移
        existing = {c["name"] for c in insp.get_columns(table)}
        added_hw = False
        with bind.begin() as conn:
            for col, ddl in cols.items():
                if col not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"))
                    if table == "gc_device" and col == "hw_id":
                        added_hw = True
            # hw_id 唯一:仅在本次刚补上该列时建索引(避免与新库 create_all 的唯一约束重复)
            if added_hw:
                conn.execute(text(
                    "CREATE UNIQUE INDEX ux_gc_device_hw_id ON gc_device (hw_id)"
                ))
    # 唯一索引补建(幂等):索引已存在跳过;有重复值跳过并告警(需人工先清数据,否则索引建不上)
    for table, (index, col) in _LIGHT_UNIQUE_INDEXES.items():
        if table not in tables:
            continue
        if index in {ix["name"] for ix in insp.get_indexes(table)}:
            continue
        with bind.begin() as conn:
            dup = conn.execute(text(
                f"SELECT {col} FROM {table} GROUP BY {col} HAVING COUNT(*) > 1 LIMIT 1"
            )).first()
            if dup:
                logger.warning("%s.%s 存在重复值,%s 唯一索引跳过,请先人工去重", table, col, index)
                continue
            conn.execute(text(f"CREATE UNIQUE INDEX {index} ON {table} ({col})"))
    # NULL 回填(幂等):老库新增列后存量行为 NULL,刷成模型默认值
    for table, stmt in _LIGHT_BACKFILLS.items():
        if table not in tables:
            continue
        with bind.begin() as conn:
            conn.execute(text(stmt))
