"""本地 Demo 使用临时文件 SQLite，互不读取其他工作台。"""
from pathlib import Path
import os

from sqlalchemy import URL, create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

runtime_db = Path(os.environ["SALES_RUNTIME_DIR"]) / "sales-demo.sqlite"
if runtime_db.is_file():
    runtime_db.unlink()
engine = create_engine(URL.create("sqlite", database=str(runtime_db)), connect_args={"timeout": 30})
Base = declarative_base()
SessionDemo = sessionmaker(bind=engine, autoflush=False)


@event.listens_for(engine, "connect")
def use_wal(conn, _record):
    conn.execute("PRAGMA journal_mode=WAL")


def get_db():
    with SessionDemo() as db:
        yield db
