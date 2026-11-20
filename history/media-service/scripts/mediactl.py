"""资料维护命令行。在服务所在机器上跑（读同一份 .env 和库）。

  uv run python -m scripts.mediactl add wh-basic-01 "第1课 所有物品登记与规范入库" --audience roles --roles warehouse
  uv run python -m scripts.mediactl upload wh-basic-01 第1课_720p轻量版.mp4 --master 第1课_母版.mp4
  uv run python -m scripts.mediactl publish wh-basic-01 1
  uv run python -m scripts.mediactl rollback wh-basic-01
  uv run python -m scripts.mediactl attach wh-basic-01 第1课_说明.pdf --title "第1课 说明"
  uv run python -m scripts.mediactl confirm-public company-intro --by 老邹
  uv run python -m scripts.mediactl pass-create company-intro,wh-basic-01 --label "某某合作方" --days 7
  uv run python -m scripts.mediactl pass-revoke 3
  uv run python -m scripts.mediactl list
  uv run python -m scripts.mediactl usage --alert   # 本月播放、流量和费用估算；超过提醒线发钉钉（每天定时跑）
  uv run python -m scripts.mediactl import 首批资料/清单.csv --dry-run   # 先看要做什么，再去掉 --dry-run 真跑
"""
import argparse
import sys
from pathlib import Path

from sqlalchemy import select

from app import library, manifest, usage
from app.config import get_settings
from app.db import get_sessionmaker, init_db
from app.models import ExternalPass, MediaItem
from app.storage import build_storage


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="mediactl")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("add", help="建资料")
    p.add_argument("item_id")
    p.add_argument("title")
    p.add_argument("--kind", default="video", choices=["video", "doc"])
    p.add_argument("--audience", default="staff", choices=list(library.AUDIENCES))
    p.add_argument("--roles", default="")
    p.add_argument("--description", default="")
    p.add_argument("--series", default="", help="课程名，工作台按它分组")
    p.add_argument("--sort", type=int, default=0, help="第几集")

    p = sub.add_parser("upload", help="传一个新版本（不自动发布）")
    p.add_argument("item_id")
    p.add_argument("file", type=Path)
    p.add_argument("--master", type=Path)
    p.add_argument("--note", default="")

    p = sub.add_parser("publish", help="把某个版本设为已发布")
    p.add_argument("item_id")
    p.add_argument("version", type=int)
    p.add_argument("--by", default="")

    p = sub.add_parser("rollback", help="回到上一个已发布版本")
    p.add_argument("item_id")
    p.add_argument("--by", default="")

    p = sub.add_parser("attach", help="挂配套文件")
    p.add_argument("item_id")
    p.add_argument("file", type=Path)
    p.add_argument("--title", default="")

    p = sub.add_parser("confirm-public", help="确认公开（受众 public 的资料确认后访客才能看）")
    p.add_argument("item_id")
    p.add_argument("--by", required=True)

    p = sub.add_parser("pass-create", help="给外部人员开访问凭证")
    p.add_argument("item_ids", help="逗号分隔")
    p.add_argument("--label", required=True)
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--by", default="")

    p = sub.add_parser("pass-revoke", help="收回访问凭证")
    p.add_argument("pass_id", type=int)

    sub.add_parser("list", help="列出资料和凭证")

    p = sub.add_parser("usage", help="本月播放、外网流量和费用估算")
    p.add_argument("--month", default="", help="YYYY-MM，默认本月（北京时间）")
    p.add_argument("--alert", action="store_true", help="超过 MEDIA_ALERT_MONTHLY_YUAN 就发钉钉提醒（一个月一次）")
    p.add_argument("--no-storage", action="store_true", help="不读桶的存储用量")

    p = sub.add_parser("import", help="按清单批量导入（CSV，格式见 app/manifest.py）")
    p.add_argument("manifest", type=Path)
    p.add_argument("--dry-run", action="store_true", help="只算要做什么，不上传、不改库")
    p.add_argument("--no-publish", action="store_true", help="传完先不发布")
    p.add_argument("--by", default="")

    args = ap.parse_args(argv)
    s = get_settings()
    init_db()
    db = get_sessionmaker()()
    base = s.base_url.rstrip("/")
    try:
        if args.cmd == "add":
            item = library.create_item(db, args.item_id, args.title, kind=args.kind, audience=args.audience,
                                       roles=args.roles, description=args.description, series=args.series,
                                       sort=args.sort)
            print(f"已建 {item.id}，固定链接 {base}/m/{item.id}（发布版本后才能打开）")
        elif args.cmd == "upload":
            v = library.add_version(db, build_storage(s), args.item_id, args.file, master=args.master, note=args.note)
            print(f"{args.item_id} v{v.version_no} 已上传并校验：{v.object_key} {v.size} 字节 sha256={v.sha256}")
            print(f"确认无误后发布：mediactl publish {args.item_id} {v.version_no}")
        elif args.cmd == "publish":
            library.publish(db, args.item_id, args.version, actor=args.by)
            print(f"{args.item_id} 已发布 v{args.version}：{base}/m/{args.item_id}")
        elif args.cmd == "rollback":
            item = library.rollback(db, args.item_id, actor=args.by)
            print(f"{args.item_id} 已回到 v{item.published_version.version_no}")
        elif args.cmd == "attach":
            a = library.add_attachment(db, build_storage(s), args.item_id, args.file, args.title)
            print(f"已挂 {a.title}（文件 {a.id}，{a.size} 字节）")
        elif args.cmd == "confirm-public":
            library.confirm_public(db, args.item_id, args.by)
            print(f"{args.item_id} 已确认公开，访客打开 {base}/m/{args.item_id} 就能看")
        elif args.cmd == "pass-create":
            ids = [i.strip() for i in args.item_ids.split(",") if i.strip()]
            pss, token = library.create_pass(db, ids, label=args.label, days=args.days, created_by=args.by)
            print(f"凭证 {pss.id}（{pss.label}）到 {pss.expires_at:%Y-%m-%d %H:%M} UTC 失效，令牌只显示这一次：")
            for i in ids:
                print(f"  {base}/m/{i}?pass={token}")
        elif args.cmd == "pass-revoke":
            pss = library.revoke_pass(db, args.pass_id)
            print(f"凭证 {pss.id}（{pss.label}）已收回")
        elif args.cmd == "list":
            for item in db.scalars(select(MediaItem).order_by(MediaItem.id)):
                pv = item.published_version
                extra = f" roles={item.roles}" if item.roles else ""
                if item.audience == "public":
                    extra += " 已确认公开" if item.public_confirmed_at else " 未确认公开"
                print(f"{item.id}\t{item.audience}{extra}\t已发布 {'v' + str(pv.version_no) if pv else '-'}"
                      f"\t共 {len(item.versions)} 版 {len(item.attachments)} 个文件\t{item.title}")
            for pss in db.scalars(select(ExternalPass).order_by(ExternalPass.id)):
                state = "已收回" if pss.revoked_at else f"到 {pss.expires_at:%Y-%m-%d}"
                print(f"凭证 {pss.id}\t{pss.label}\t{state}\t{pss.item_ids}")
        elif args.cmd == "usage":
            month = args.month or usage.beijing_today().strftime("%Y-%m")
            u = usage.month_usage(db, None if args.no_storage else build_storage(s), month)
            print("\n".join(usage.report_lines(u, s)))
            if args.alert:
                print(usage.maybe_alert(db, u, s))
        elif args.cmd == "import":
            report = manifest.import_manifest(db, build_storage(s), args.manifest, dry_run=args.dry_run,
                                              publish=not args.no_publish, actor=args.by,
                                              on_line=lambda line: print(line, flush=True))
            if not report.lines:
                print("清单是空的")
            print(f"{'预演' if args.dry_run else '导入'}完：{len(report.lines)} 条，{report.errors} 份没做成")
            return 1 if report.errors else 0
    except library.LibraryError as exc:
        print(f"没做成：{exc}", file=sys.stderr)
        return 1
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
