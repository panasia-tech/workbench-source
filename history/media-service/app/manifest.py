"""按清单批量导入资料：首批 25 集视频加配套说明，不用一条条 add / upload / publish / attach。

清单是 UTF-8 的 CSV（Excel 另存为「CSV UTF-8」就行），一行一份资料：

  id,title,audience,roles,video,master,attachments,description,series,sort
  wh-basic-01,第1课 所有物品登记与规范入库,roles,"WAREHOUSE,仓管",仓库基础课/第1课_720p.mp4,仓库基础课/第1课_母版.mp4,仓库基础课/第1课_说明.pdf,,仓库通用基础课,1

  - 文件路径相对清单所在目录；attachments 多个用分号隔开；video 空着就是只有教材的资料
  - series / sort 可以不写：工作台「培训视频」按 series（课程名）分组、按 sort（第几集）排
  - 重复跑不出重复：视频和已发布版本的 sha256 一样就跳过，传过但没发布的同一个文件直接发布那一版，
    内容变了才传新版本；配套文件同一份（sha256 一样）不再挂
  - 标题、说明、受众、角色以清单为准，改了就更新，受众和角色变了在报告里单独标出来（这两项决定谁能看）
  - 受众 public 的资料只导入不确认公开：发布人逐份 confirm-public 后访客才看得到
"""
import csv
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import library
from app.models import Attachment, MediaItem, MediaVersion
from app.storage import Storage, file_sha256

COLUMNS = ("id", "title", "audience", "roles", "video", "master", "attachments", "description", "series", "sort")


@dataclass
class ImportReport:
    lines: list[str] = field(default_factory=list)
    errors: int = 0
    on_line: Callable[[str], None] | None = None  # 命令行边做边打印，传 8 GB 要跑很久

    def add(self, item_id: str, text: str) -> None:
        line = f"{item_id}\t{text}"
        self.lines.append(line)
        if self.on_line:
            self.on_line(line)

    def fail(self, item_id: str, text: str) -> None:
        self.errors += 1
        self.add(item_id, f"没做成：{text}")


def read_manifest(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        missing = [c for c in ("id", "title") if c not in (reader.fieldnames or [])]
        if missing:
            raise library.LibraryError(f"清单缺列：{', '.join(missing)}（要有 {','.join(COLUMNS)}）")
        return [{k: (row.get(k) or "").strip() for k in COLUMNS} for row in reader if (row.get("id") or "").strip()]


def _resolve(base: Path, rel: str) -> Path:
    p = Path(rel).expanduser()
    return p if p.is_absolute() else base / p


def _check_files(base: Path, row: dict[str, str]) -> list[str]:
    paths = [row["video"], row["master"], *row["attachments"].split(";")]
    return [p.strip() for p in paths if p.strip() and not _resolve(base, p.strip()).is_file()]


def _sort(row: dict[str, str]) -> int:
    return int(row["sort"]) if row["sort"] else 0


def _validate(row: dict[str, str]) -> None:
    # 和 create_item 同样的规矩，预演时也先报出来
    if not library.ITEM_ID_RE.match(row["id"]):
        raise library.LibraryError("资料 ID 只能用小写字母、数字和横线，3~64 位，字母或数字开头")
    if (row["audience"] or "staff") not in library.AUDIENCES:
        raise library.LibraryError(f"受众只能是 {' / '.join(library.AUDIENCES)}")
    if row["audience"] == "roles" and not row["roles"]:
        raise library.LibraryError("岗位专属资料要写 roles（ERP 角色或平台分组，逗号分隔）")
    if row["sort"] and not row["sort"].lstrip("-").isdigit():
        raise library.LibraryError(f"sort 要写整数（第几集），现在是 {row['sort']}")


def _sync_item(db: Session, row: dict[str, str], dry_run: bool, report: ImportReport) -> MediaItem | None:
    _validate(row)
    item_id = row["id"]
    kind = "video" if row["video"] else "doc"
    audience = row["audience"] or "staff"
    item = db.get(MediaItem, item_id)
    if item is None:
        if dry_run:
            report.add(item_id, f"新建（{audience}{' ' + row['roles'] if row['roles'] else ''}）")
            return None
        item = library.create_item(db, item_id, row["title"], kind=kind, audience=audience, roles=row["roles"],
                                   description=row["description"], series=row["series"], sort=_sort(row))
        report.add(item_id, f"已新建（{audience}{' ' + row['roles'] if row['roles'] else ''}）")
        return item
    if (item.audience, item.roles) != (audience, row["roles"]):
        report.add(item_id, f"受众 {item.audience} {item.roles} → {audience} {row['roles']}".replace("  ", " "))
        if not dry_run:
            item.audience, item.roles = audience, row["roles"]
            if audience != "public":
                item.public_confirmed_by, item.public_confirmed_at = "", None
    if not dry_run:
        item.title, item.description, item.kind = row["title"], row["description"], kind
        item.series, item.sort = row["series"], _sort(row)
        db.commit()
    return item


def _sync_video(db: Session, storage: Storage, item: MediaItem | None, row: dict[str, str], base: Path,
                dry_run: bool, publish: bool, actor: str, report: ImportReport) -> None:
    item_id = row["id"]
    video = _resolve(base, row["video"])
    sha = file_sha256(video)
    pv = item.published_version if item is not None else None
    if pv is not None and pv.sha256 == sha:
        report.add(item_id, f"视频没变，仍是 v{pv.version_no}")
        return
    same = None
    if item is not None:
        same = db.scalar(select(MediaVersion).where(MediaVersion.item_id == item.id, MediaVersion.sha256 == sha,
                                                    MediaVersion.verified_at.is_not(None)))
    if dry_run:
        report.add(item_id, f"视频要{'改发已传的 v' + str(same.version_no) if same else '传新版本'}（{video.name}）")
        return
    if same is None:
        master = _resolve(base, row["master"]) if row["master"] else None
        same = library.add_version(db, storage, item_id, video, master=master, note="清单导入")
        report.add(item_id, f"已传 v{same.version_no} 并校验（{same.size} 字节）")
    if publish:
        library.publish(db, item_id, same.version_no, actor=actor)
        report.add(item_id, f"已发布 v{same.version_no}")
    else:
        report.add(item_id, f"v{same.version_no} 待发布：mediactl publish {item_id} {same.version_no}")


def _sync_attachments(db: Session, storage: Storage, item: MediaItem | None, row: dict[str, str], base: Path,
                      dry_run: bool, report: ImportReport) -> None:
    item_id = row["id"]
    have = set()
    if item is not None:
        have = set(db.scalars(select(Attachment.sha256).where(Attachment.item_id == item.id)))
    for rel in [p.strip() for p in row["attachments"].split(";") if p.strip()]:
        path = _resolve(base, rel)
        if file_sha256(path) in have:
            continue
        if dry_run:
            report.add(item_id, f"要挂配套文件 {path.name}")
            continue
        a = library.add_attachment(db, storage, item_id, path)
        have.add(a.sha256)
        report.add(item_id, f"已挂 {a.title}")


def import_manifest(db: Session, storage: Storage, manifest: Path, *, dry_run: bool = False, publish: bool = True,
                    actor: str = "", on_line: Callable[[str], None] | None = None) -> ImportReport:
    base = manifest.resolve().parent
    report = ImportReport(on_line=on_line)
    rows = read_manifest(manifest)
    seen: set[str] = set()
    for row in rows:
        item_id = row["id"]
        if item_id in seen:
            report.fail(item_id, "清单里出现了两次，只认第一行")
            continue
        seen.add(item_id)
        # 一份资料出错不挡别的；文件先查齐，缺一个就整份不动，免得传一半
        missing = _check_files(base, row)
        if missing:
            report.fail(item_id, f"找不到文件 {'、'.join(missing)}")
            continue
        try:
            item = _sync_item(db, row, dry_run, report)
            if row["video"]:
                _sync_video(db, storage, item, row, base, dry_run, publish, actor, report)
            _sync_attachments(db, storage, item, row, base, dry_run, report)
            if item is not None and item.audience == "public" and item.public_confirmed_at is None:
                report.add(item_id, f"公开资料还没确认：mediactl confirm-public {item_id} --by <发布人>")
        except library.LibraryError as exc:
            db.rollback()
            report.fail(item_id, str(exc))
        except Exception as exc:  # 网络断、OSS 超时：这一份记失败，接着做下一份；重跑时已传好的会跳过
            db.rollback()
            report.fail(item_id, f"上传出错（{type(exc).__name__}），重跑一次：{str(exc)[:200]}")
    return report
