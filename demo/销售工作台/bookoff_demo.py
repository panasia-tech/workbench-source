"""第一次启动时，在本地创建小型、全合成的搜索样本。"""
from pathlib import Path
import sqlite3


def seed_bookoff(db_path):
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as db:
        db.execute("""CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY, item_id TEXT UNIQUE, title TEXT, author TEXT,
            category TEXT, genre TEXT, price_yen INTEGER, stock TEXT,
            image_url TEXT, detail_url TEXT, release_date TEXT, offer TEXT
        )""")
        db.executemany("""INSERT OR IGNORE INTO products
            (item_id,title,author,category,genre,price_yen,stock,image_url,detail_url,release_date,offer)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)""", [
            ("DEMO-BK-01","架空の技術入門","サンプル編集部","本","技術書",800,"in_stock","/img/sources/demo-source.svg","","2026-09-01","used"),
            ("DEMO-BK-02","架空の写真手帖","サンプル編集部","本","技術書",1050,"in_stock","/img/sources/demo-source.svg","","2026-09-02","used"),
            ("DEMO-BK-03","架空の画面設計","サンプル編集部","本","技術書",1250,"out_of_stock","/img/sources/demo-source.svg","","2026-09-03","used"),
            ("DEMO-BK-04","休日工作のデモ","サンプル編集部","雑誌","趣味",550,"in_stock","/img/sources/demo-source.svg","","2026-09-04","new"),
        ])
