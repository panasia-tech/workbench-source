"""把指定 DB 里所有 staff 的密码统一重置为 RESET_PWD。

用法:
    DATABASE_URL="mysql+pypostgresql://demo:demo@localhost/erp_xcx?charset=utf8mb4" \\
        python3 -m scripts.reset_all_passwords
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import create_engine, text

from app.services.password import hash_password

RESET_PWD = "123456"


def main() -> None:
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("缺 DATABASE_URL")

    new_hash = hash_password(RESET_PWD)
    engine = create_engine(url, connect_args={"charset": "utf8mb4"})
    with engine.begin() as conn:
        # 先看下目标库共多少 staff
        n = conn.execute(text("SELECT COUNT(*) FROM staff")).scalar_one()
        print(f"目标 DB staff 总数: {n}")
        result = conn.execute(
            text("UPDATE staff SET password_hash = :h"),
            {"h": new_hash},
        )
        print(f"已重置 {result.rowcount} 条")
    print(f"全部账户密码已改为: {RESET_PWD}")


if __name__ == "__main__":
    main()
