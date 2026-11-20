#!/usr/bin/env python3
"""Visible-UI seller homepage collector for Xianyu rank pages.

This module is intentionally separate from the product exporter.  It only
opens seller cards from a rank list, captures the seller page, copies the
seller homepage share link, and writes an append-only local queue.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from xml.etree import ElementTree as ET

import adbutils
import uiautomator2 as u2

from task_manifest import BOARDS as MANIFEST_BOARDS
from task_manifest import build_manifest, coverage_report, load_manifest, shard_manifest, write_manifest

try:
    import cv2
    import numpy as np
except Exception:  # pragma: no cover - the bundled runtime currently has both
    cv2 = None
    np = None


DEFAULT_BOARD_URL = "https://m.tb.cn/h.871bemS?tk=7hubTZxZ2Ih"
DEFAULT_SERIAL = "30219605"
DEFAULT_BOARDS = MANIFEST_BOARDS
DEFAULT_CATEGORY = "工业"
DEFAULT_CITY = "全国"
IDLEFISH_INIT_ACTIVITY = "com.taobao.idlefish/com.taobao.fleamarket.home.activity.InitActivity"
IDLEFISH_PACKAGE = "com.taobao.idlefish"
FOLLOW_LABELS = {"关注TA", "已关注"}
INVISIBLE = "\u200b\u200c\u200d\ufeff"
MAX_RANK_SEEK_STEPS = 80
CATEGORY_TAG_RE = re.compile(r"第\s*\d+\s*个标签，共\s*\d+\s*个")


class RpaError(RuntimeError):
    pass


class SafetyStop(RpaError):
    pass


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def clean_text(value: str) -> str:
    value = (value or "").replace("\r", "")
    for ch in INVISIBLE:
        value = value.replace(ch, "")
    return re.sub(r"[ \t]+", " ", value).strip()


def compact_seller_name(value: str) -> str:
    """Remove OCR punctuation while retaining Chinese, Latin, and digits."""

    return re.sub(r"[^0-9A-Za-z\u3400-\u9fff]+", "", clean_text(value)).lower()


def seller_name_ocr_compatible(expected: str, observed: str) -> bool:
    """Allow one documented trailing-count artifact, never fuzzy matching."""

    left = compact_seller_name(expected)
    right = compact_seller_name(observed)
    if not left or not right:
        return False
    if left == right:
        return True
    if len(left) == len(right) + 1 and left.startswith(right) and left[-1].isdigit():
        return True
    if len(right) == len(left) + 1 and right.startswith(left) and right[-1].isdigit():
        return True
    return False


def split_lines(value: str) -> List[str]:
    return [clean_text(x) for x in (value or "").splitlines() if clean_text(x)]


def parse_bounds(value: str) -> Optional[Tuple[int, int, int, int]]:
    nums = re.findall(r"\d+", value or "")
    if len(nums) != 4:
        return None
    return tuple(map(int, nums))  # type: ignore[return-value]


def center_of(bounds: str) -> Optional[Tuple[int, int]]:
    parsed = parse_bounds(bounds)
    if not parsed:
        return None
    x1, y1, x2, y2 = parsed
    return ((x1 + x2) // 2, (y1 + y2) // 2)


def xml_nodes(xml: str) -> Iterable[dict]:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    return [node.attrib for node in root.iter("node")]


def node_label(node: dict) -> str:
    return clean_text((node.get("text") or "") + " " + (node.get("content-desc") or ""))


def longest_rank_list_desc(xml: str) -> str:
    candidates = []
    for node in xml_nodes(xml):
        desc = node.get("content-desc", "")
        bounds = parse_bounds(node.get("bounds", ""))
        # A seller profile/share panel can contain the copied phrase
        # “快来关注TA吧”.  A real rank list is the large scrolling node whose
        # bounds start below the rank header and whose cards expose prices.
        is_large_list = bool(bounds and bounds[0] == 0 and bounds[2] >= 1000 and 400 <= bounds[1] <= 1000 and bounds[3] >= 2200)
        if is_large_list and ("关注TA" in desc or "已关注" in desc) and desc.count("¥") >= 4:
            candidates.append(desc)
    return max(candidates, key=len, default="")


def profile_page_ready(xml: str) -> bool:
    """Recognize the two observed profile credit-header variants."""

    return (
        "粉丝" in (xml or "")
        and "宝贝" in (xml or "")
        and ("卖家信用" in (xml or "") or "信用档案" in (xml or ""))
    )


def parse_visible_sellers(desc: str) -> List[dict]:
    """Parse the flattened rank-card accessibility description.

    Each card currently exposes: seller name, main business, follow label,
    review text, prices, and review counts.  We deliberately only use the
    three stable fields before the follow label and never inspect product
    thumbnails or click product nodes.
    """

    lines = split_lines(desc)
    records: List[dict] = []
    for index, line in enumerate(lines):
        if line not in FOLLOW_LABELS or index < 2:
            continue
        name = clean_text(lines[index - 2])
        business = clean_text(lines[index - 1])
        if not name or not business:
            continue
        if name in {"TOP1", "TOP2", "TOP3", "TOP4", "TOP5"}:
            continue
        if name in {r["sellerName"] for r in records}:
            continue
        records.append({"sellerName": name, "mainBusiness": business, "visibleIndex": len(records)})
    return records


def extract_share_url(text: str) -> str:
    match = re.search(r"https?://m\.tb\.cn/[^\s\u3000\u3011\u300d]+", text or "")
    return match.group(0).rstrip("，。；;】〉") if match else ""


def extract_share_seller_name(text: str) -> str:
    match = re.search(r"「([^」]+?)的闲鱼号", text or "")
    return clean_text(match.group(1)) if match else ""


def ocr_top_rank(text: str) -> Optional[int]:
    """Parse TOP labels with a few conservative OCR digit substitutions."""

    match = re.search(r"T[O0]P\s*([0-9SILO|]+)", (text or "").upper())
    if not match:
        return None
    token = match.group(1).translate(str.maketrans({"S": "5", "I": "1", "L": "1", "O": "0", "|": "1"}))
    if not token.isdigit():
        return None
    rank = int(token)
    return rank if 1 <= rank <= 1000 else None


def extract_seller_id_from_text(text: str) -> str:
    patterns = (
        r"[?&]userId=(\d+)",
        r"userId(?:%22|\"|')?\s*(?:%3A|:|=)\s*(?:%22|\"|')?(\d+)",
        r"userid(?:%22|\"|')?\s*(?:%3A|:|=)\s*(?:%22|\"|')?(\d+)",
    )
    for pattern in patterns:
        match = re.search(pattern, text or "", re.IGNORECASE)
        if match:
            return match.group(1)
    return ""


def resolve_seller_id(homepage_url: str) -> str:
    """Best-effort local resolution; the copied URL remains the evidence."""

    if not homepage_url:
        return ""
    direct = extract_seller_id_from_text(homepage_url)
    if direct:
        return direct
    try:
        request = urllib.request.Request(
            homepage_url,
            headers={"User-Agent": "Mozilla/5.0 (Android 15) AppleWebKit/537.36"},
        )
        with urllib.request.urlopen(request, timeout=6) as response:
            body = response.read(1024 * 1024).decode("utf-8", errors="ignore")
        return extract_seller_id_from_text(body)
    except Exception:
        return ""


def canonical_key(event: dict) -> str:
    seller_id = clean_text(event.get("sellerId", ""))
    if seller_id:
        return "seller:" + seller_id
    return "url:" + clean_text(event.get("homepageUrl", "")).split("#", 1)[0]


def percentile(values: List[float], fraction: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * fraction)))
    return ordered[index]


def timing_summary(events: Iterable[dict]) -> Dict[str, dict]:
    names = (
        "contextCheckMs",
        "rankLocateMs",
        "profileOpenMs",
        "screenshotMs",
        "shareMenuMs",
        "copyLinkMs",
        "returnMs",
        "sellerIdResolveMs",
        "totalMs",
    )
    output: Dict[str, dict] = {}
    for name in names:
        values = []
        for event in events:
            value = event.get("timings", {}).get(name)
            if value is not None:
                values.append(float(value))
        output[name] = {
            "samples": len(values),
            "p50Ms": round(percentile(values, 0.50), 1) if values else None,
            "p95Ms": round(percentile(values, 0.95), 1) if values else None,
        }
    return output


class LocalQueue:
    def __init__(self, root: Path, args: argparse.Namespace):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "screenshots").mkdir(exist_ok=True)
        self.events_path = self.root / "events.ndjson"
        self.sellers_path = self.root / "sellers.json"
        self.run_path = self.root / "run.json"
        self.summary_path = self.root / "summary.json"
        self.summary_md_path = self.root / "summary.md"
        self.progress_path = self.root / "progress.json"
        self.manifest_path = self.root / "manifest.json"
        self.coverage_path = self.root / "coverage.json"
        self.overlap_path = self.root / "overlap.csv"
        self.failures_path = self.root / "failures.csv"
        self.seller_id_queue_path = self.root / "seller-id-queue.ndjson"
        self.seller_id_updates_path = self.root / "seller-id-updates.ndjson"
        self.timing_updates_path = self.root / "timing-updates.ndjson"
        self.last_summary_at = 0.0
        self.events: List[dict] = []
        if self.events_path.exists():
            for line in self.events_path.read_text(encoding="utf-8").splitlines():
                try:
                    self.events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        timing_updates = {}
        if self.timing_updates_path.exists():
            for line in self.timing_updates_path.read_text(encoding="utf-8").splitlines():
                try:
                    update = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if update.get("eventId"):
                    timing_updates[update["eventId"]] = update.get("timings", {})
        for event in self.events:
            if event.get("eventId") in timing_updates:
                event.setdefault("timings", {}).update(timing_updates[event["eventId"]])
        seller_id_updates = {}
        if self.seller_id_updates_path.exists():
            for line in self.seller_id_updates_path.read_text(encoding="utf-8").splitlines():
                try:
                    update = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if update.get("eventId") and update.get("sellerId"):
                    seller_id_updates[update["eventId"]] = str(update["sellerId"])
        for event in self.events:
            if event.get("eventId") in seller_id_updates:
                event["sellerId"] = seller_id_updates[event["eventId"]]
                event["sellerIdStatus"] = "resolved"
        self.sellers: Dict[str, dict] = {}
        for event in self.events:
            if event.get("status") not in {"success", "duplicate", "needs_review", "queued"}:
                continue
            key = canonical_key(event)
            if key == "url:":
                continue
            seller = self.sellers.setdefault(
                key,
                {
                    "sellerId": event.get("sellerId", ""),
                    "sellerName": event.get("sellerName", ""),
                    "mainBusiness": event.get("mainBusiness", ""),
                    "homepageUrl": event.get("homepageUrl", ""),
                    "screenshotPath": event.get("screenshotPath", ""),
                    "status": "queued",
                    "rankContexts": [],
                    "firstCapturedAt": event.get("capturedAt", ""),
                },
            )
            context = {
                "category": event.get("category"),
                "city": event.get("city"),
                "board": event.get("board"),
                "rank": event.get("rank"),
                "capturedAt": event.get("capturedAt"),
            }
            if context not in seller["rankContexts"]:
                seller["rankContexts"].append(context)
            if event.get("status") == "success":
                seller.update(
                    {
                        "sellerName": event.get("sellerName", seller["sellerName"]),
                        "mainBusiness": event.get("mainBusiness", seller["mainBusiness"]),
                        "homepageUrl": event.get("homepageUrl", seller["homepageUrl"]),
                        "screenshotPath": event.get("screenshotPath", seller["screenshotPath"]),
                        "status": "queued",
                    }
                )
        for event in self.events:
            seller_id = seller_id_updates.get(event.get("eventId"))
            if not seller_id:
                continue
            for seller in self.sellers.values():
                if seller.get("homepageUrl") == event.get("homepageUrl"):
                    seller["sellerId"] = seller_id
        self.manifest = self._load_or_create_manifest(args)
        self.run = self._load_or_create_run(args)

    def _load_or_create_manifest(self, args: argparse.Namespace) -> dict:
        if self.manifest_path.exists():
            try:
                return load_manifest(self.manifest_path)
            except (OSError, ValueError, json.JSONDecodeError):
                pass
        if getattr(args, "manifest", ""):
            source = Path(args.manifest)
            if not source.exists():
                raise RpaError(f"manifest not found: {source}")
            manifest = load_manifest(source)
        else:
            manifest = build_manifest(
                {
                    "categories": [
                        {
                            "name": getattr(args, "category", DEFAULT_CATEGORY),
                            "cities": [getattr(args, "city", DEFAULT_CITY)],
                            "sourceUrl": getattr(args, "board_url", DEFAULT_BOARD_URL),
                        }
                    ],
                    "boards": list(getattr(args, "boards", DEFAULT_BOARDS)),
                    "rankLimit": getattr(args, "board_limit", 100),
                },
                dt.date.today().isoformat(),
                getattr(args, "device_id", "") or getattr(args, "serial", DEFAULT_SERIAL),
            )
        shard_count = int(getattr(args, "shard_count", 1))
        shard_index = int(getattr(args, "shard_index", 0))
        existing_shard = manifest.get("shard", {})
        if shard_count > 1 and not (
            existing_shard.get("count") == shard_count and existing_shard.get("index") == shard_index
        ):
            manifest = shard_manifest(
                manifest,
                shard_index,
                shard_count,
                getattr(args, "device_id", "") or getattr(args, "serial", DEFAULT_SERIAL),
            )
        write_manifest(self.manifest_path, manifest)
        return manifest

    def _load_or_create_run(self, args: argparse.Namespace) -> dict:
        if self.run_path.exists():
            try:
                return json.loads(self.run_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass
        run = {
            "runId": self.root.name,
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "category": getattr(args, "category", DEFAULT_CATEGORY),
            "city": getattr(args, "city", DEFAULT_CITY),
            "targetUniqueSellers": args.target,
            "boardOrder": list(self.manifest.get("boards", args.boards)),
            "deviceSerial": args.serial,
            "deviceId": getattr(args, "device_id", "") or args.serial,
            "status": "running",
            "checkpoint": {
                "taskId": self.manifest.get("contexts", [{}])[0].get("taskId", ""),
                "category": getattr(args, "category", DEFAULT_CATEGORY),
                "city": getattr(args, "city", DEFAULT_CITY),
                "board": self.manifest.get("boards", args.boards)[0],
                "nextRank": 1,
            },
            "productCrawlLimit": 1000,
            "serverUpload": False,
        }
        self._write_json(self.run_path, run)
        return run

    def _write_json(self, path: Path, data: object) -> None:
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)

    def append(self, event: dict) -> None:
        self.events.append(event)
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        key = canonical_key(event)
        if key != "url:" and event.get("status") in {"success", "duplicate", "needs_review", "queued"}:
            seller = self.sellers.setdefault(
                key,
                {
                    "sellerId": event.get("sellerId", ""),
                    "sellerName": event.get("sellerName", ""),
                    "mainBusiness": event.get("mainBusiness", ""),
                    "homepageUrl": event.get("homepageUrl", ""),
                    "screenshotPath": event.get("screenshotPath", ""),
                    "status": "queued",
                    "rankContexts": [],
                    "firstCapturedAt": event.get("capturedAt", ""),
                },
            )
            context = {
                "category": event.get("category"),
                "city": event.get("city"),
                "board": event.get("board"),
                "rank": event.get("rank"),
                "capturedAt": event.get("capturedAt"),
            }
            if context not in seller["rankContexts"]:
                seller["rankContexts"].append(context)
            if event.get("status") == "success":
                seller.update(
                    {
                        "sellerId": event.get("sellerId", seller["sellerId"]),
                        "sellerName": event.get("sellerName", seller["sellerName"]),
                        "mainBusiness": event.get("mainBusiness", seller["mainBusiness"]),
                        "homepageUrl": event.get("homepageUrl", seller["homepageUrl"]),
                        "screenshotPath": event.get("screenshotPath", seller["screenshotPath"]),
                        "status": "queued",
                    }
                )
            self._write_json(self.sellers_path, list(self.sellers.values()))
        if event.get("homepageUrl") and event.get("sellerIdStatus") == "queued":
            self.enqueue_seller_id(event)
        self.write_progress(event)
        if len(self.events) % 25 == 0 or time.monotonic() - self.last_summary_at >= 20:
            self.write_summary()

    def enqueue_seller_id(self, event: dict) -> None:
        """Queue seller-id enrichment after the UI-critical path has finished."""

        item = {
            "eventId": event.get("eventId", ""),
            "homepageUrl": event.get("homepageUrl", ""),
            "queuedAt": now_iso(),
            "status": "pending",
        }
        with self.seller_id_queue_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def update_event_timing(self, event_id: str, timings: dict) -> None:
        for event in reversed(self.events):
            if event.get("eventId") == event_id:
                event.setdefault("timings", {}).update(timings)
                break
        update = {"eventId": event_id, "timings": timings, "updatedAt": now_iso()}
        with self.timing_updates_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(update, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def write_progress(self, last_event: Optional[dict] = None) -> None:
        attempted_slots = {
            (event.get("taskId"), event.get("rank"))
            for event in self.events
            if event.get("rank") is not None
        }
        status_counts = {
            status: sum(1 for event in self.events if event.get("status") == status)
            for status in ("success", "duplicate", "failed", "blocked", "needs_review")
        }
        checkpoint = self.run.get("checkpoint", {})
        progress = {
            "schemaVersion": 2,
            "updatedAt": now_iso(),
            "runId": self.run.get("runId"),
            "deviceId": self.run.get("deviceId"),
            "deviceSerial": self.run.get("deviceSerial"),
            "status": self.run.get("status"),
            "expectedSourceSlots": self.manifest.get("sourceSlotCount", 0),
            "attemptedSourceSlots": len(attempted_slots),
            "remainingSourceSlots": max(0, int(self.manifest.get("sourceSlotCount", 0)) - len(attempted_slots)),
            "uniqueSellerCount": self.unique_count(),
            "statusCounts": status_counts,
            "categoryCount": self.manifest.get("categoryCount", 0),
            "contextCount": self.manifest.get("contextCount", 0),
            "boardCount": len(self.manifest.get("boards", [])),
            "rankLimit": self.manifest.get("rankLimit", 100),
            "shard": self.manifest.get("shard"),
            "checkpoint": {
                "category": checkpoint.get("category", ""),
                "city": checkpoint.get("city", ""),
                "board": checkpoint.get("board", ""),
                "nextRank": checkpoint.get("nextRank", 1),
            },
            "lastEvent": {
                "board": last_event.get("board"),
                "rank": last_event.get("rank"),
                "sellerName": last_event.get("sellerName"),
                "status": last_event.get("status"),
                "capturedAt": last_event.get("capturedAt"),
            } if last_event else None,
            "capacity": self._capacity_metrics(),
        }
        self._write_json(self.progress_path, progress)

    def set_checkpoint(
        self,
        board: str,
        next_rank: int,
        status: str = "running",
        task_id: str = "",
        category: str = "",
        city: str = "",
    ) -> None:
        self.run["updatedAt"] = now_iso()
        self.run["status"] = status
        checkpoint = {
            "taskId": task_id or self.run.get("checkpoint", {}).get("taskId", ""),
            "category": category or self.run.get("checkpoint", {}).get("category", self.run.get("category", DEFAULT_CATEGORY)),
            "city": city or self.run.get("checkpoint", {}).get("city", self.run.get("city", DEFAULT_CITY)),
            "board": board,
            "nextRank": next_rank,
        }
        self.run["checkpoint"] = checkpoint
        self._write_json(self.run_path, self.run)
        self.write_progress()

    def unique_count(self) -> int:
        return len(self.sellers)

    def successful_unique_keys(self) -> set:
        return set(self.sellers.keys())

    def context(self, task_id: str) -> Optional[dict]:
        return next((item for item in self.manifest.get("contexts", []) if item.get("taskId") == task_id), None)

    def mark_context(self, task_id: str, status: str, next_rank: int = 1) -> None:
        context = self.context(task_id)
        if not context:
            return
        context["status"] = status
        context["nextRank"] = next_rank
        if status == "completed":
            context["completedAt"] = now_iso()
        write_manifest(self.manifest_path, self.manifest)

    def mark_rank(self, task_id: str, rank: int, status: str) -> None:
        context = self.context(task_id)
        if not context:
            return
        completed = set(context.get("completedRanks", []))
        failed = set(context.get("failedRanks", []))
        if status in {"success", "duplicate", "needs_review"}:
            completed.add(int(rank))
            failed.discard(int(rank))
        elif status in {"failed", "blocked"}:
            failed.add(int(rank))
        context["completedRanks"] = sorted(completed)
        context["failedRanks"] = sorted(failed)
        write_manifest(self.manifest_path, self.manifest)

    def write_summary(self) -> None:
        by_board: Dict[str, dict] = {}
        by_category: Dict[str, dict] = {}
        by_city: Dict[str, dict] = {}
        for event in self.events:
            board = event.get("board", "未知")
            bucket = by_board.setdefault(board, {"success": 0, "duplicate": 0, "failed": 0, "blocked": 0, "needs_review": 0})
            status = event.get("status")
            if status in bucket:
                bucket[status] += 1
            for grouping, key in ((by_category, event.get("category", "未知")), (by_city, event.get("city", "未知"))):
                group = grouping.setdefault(key, {"success": 0, "duplicate": 0, "failed": 0, "blocked": 0, "needs_review": 0})
                if status in group:
                    group[status] += 1
        coverage = coverage_report(self.events, self.manifest)
        timing_by_board = {
            board: timing_summary([event for event in self.events if event.get("board") == board])
            for board in self.run.get("boardOrder", [])
        }
        self._write_json(self.coverage_path, coverage)
        self._write_csv(
            self.overlap_path,
            coverage.get("boardOverlap", []),
            ["category", "city", "board", "uniqueSellers", "allBoardUnion", "overlapWithOtherBoards", "newSellerContribution"],
        )
        self._write_csv(
            self.failures_path,
            [event for event in self.events if event.get("status") in {"failed", "blocked"} or event.get("failureReason")],
            ["taskId", "category", "city", "board", "rank", "sellerName", "status", "failureReason", "capturedAt"],
        )
        summary = {
            "schemaVersion": 3,
            "updatedAt": now_iso(),
            "runId": self.run.get("runId"),
            "runDate": self.manifest.get("runDate"),
            "deviceId": self.run.get("deviceId"),
            "targetUniqueSellers": self.run.get("targetUniqueSellers"),
            "uniqueSellerCount": self.unique_count(),
            "expectedSourceSlots": self.manifest.get("sourceSlotCount", 0),
            "attemptedSourceSlots": len({(event.get("taskId"), event.get("rank")) for event in self.events if event.get("rank") is not None}),
            "attemptCount": len([event for event in self.events if event.get("rank") is not None]),
            "remainingSourceSlots": max(0, int(self.manifest.get("sourceSlotCount", 0)) - len({(event.get("taskId"), event.get("rank")) for event in self.events if event.get("rank") is not None})),
            "byBoard": by_board,
            "byCategory": by_category,
            "byCity": by_city,
            "duplicateCount": sum(1 for e in self.events if e.get("status") == "duplicate"),
            "failureCount": sum(1 for e in self.events if e.get("status") == "failed"),
            "blockedCount": sum(1 for e in self.events if e.get("status") == "blocked"),
            "needsReviewCount": sum(1 for e in self.events if e.get("status") == "needs_review"),
            "coverage": {
                "expectedContexts": coverage.get("expectedContexts", 0),
                "contextsWithMissingRanks": sum(1 for row in coverage.get("contexts", []) if row.get("missingRanks")),
            },
            "capacity": self._capacity_metrics(),
            "timingByPhase": timing_summary(self.events),
            "timingByBoard": timing_by_board,
            "performanceMode": "full_evidence",
            "serverUpload": False,
        }
        self._write_json(self.summary_path, summary)
        self.last_summary_at = time.monotonic()
        lines = [
            f"# 闲鱼榜单卖家主页采集报告",
            "",
            f"- 更新时间：{summary['updatedAt']}",
            f"- 来源位：{summary['attemptedSourceSlots']} / {summary['expectedSourceSlots']}",
            f"- 唯一卖家主体：{summary['uniqueSellerCount']}",
            "",
            "| 榜单 | 成功 | 重复 | 失败 | 阻断 | 待复核 |",
            "|---|---:|---:|---:|---:|---:|",
        ]
        for board in self.run.get("boardOrder", []):
            bucket = by_board.get(board, {"success": 0, "duplicate": 0, "failed": 0, "blocked": 0, "needs_review": 0})
            lines.append(f"| {board} | {bucket['success']} | {bucket['duplicate']} | {bucket['failed']} | {bucket['blocked']} | {bucket['needs_review']} |")
        lines += [
            "",
            "| 类目 | 成功 | 重复 | 失败 | 阻断 | 待复核 |",
            "|---|---:|---:|---:|---:|---:|",
        ]
        for category, bucket in sorted(by_category.items()):
            lines.append(f"| {category} | {bucket['success']} | {bucket['duplicate']} | {bucket['failed']} | {bucket['blocked']} | {bucket['needs_review']} |")
        lines += [
            "",
            "重叠和新增卖家见 `overlap.csv`；缺口见 `coverage.json`；失败见 `failures.csv`。",
            "原始事件见 `events.ndjson`；唯一卖家主体见 `sellers.json`；截图见 `screenshots/`。",
            "本轮只写入本地队列，没有向中枢服务器上传。",
            "卖家 ID 在 UI 关键路径结束后写入 `seller-id-queue.ndjson`，不阻塞主页链接采集。",
        ]
        self.summary_md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _write_csv(self, path: Path, rows: List[dict], fields: List[str]) -> None:
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)

    def _capacity_metrics(self) -> dict:
        durations = [
            float(event.get("timings", {}).get("totalMs", 0)) / 1000
            for event in self.events
            if event.get("timings", {}).get("totalMs") is not None
        ]
        if not durations:
            durations = [float(event["durationSeconds"]) for event in self.events if event.get("durationSeconds") is not None]
        if not durations:
            return {"samples": 0, "p50Seconds": None, "p95Seconds": None, "perHour": 0, "estimatedHoursRemaining": None}
        ordered = sorted(durations)
        p50 = ordered[(len(ordered) - 1) // 2]
        p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
        unique_slots = len({(event.get("taskId"), event.get("rank")) for event in self.events if event.get("rank") is not None})
        remaining = max(0, int(self.manifest.get("sourceSlotCount", 0)) - unique_slots)
        per_hour = 3600 / p50 if p50 > 0 else 0
        return {
            "samples": len(ordered),
            "p50Seconds": round(p50, 2),
            "p95Seconds": round(p95, 2),
            "perHour": round(per_hour, 2),
            "estimatedHoursRemaining": round(remaining / per_hour, 2) if per_hour else None,
        }


class RankRpa:
    def __init__(self, args: argparse.Namespace, queue: LocalQueue):
        os.environ["ANDROID_ADB_SERVER_PORT"] = str(args.adb_port)
        self.args = args
        self.queue = queue
        try:
            self.adb = adbutils.AdbClient(host="127.0.0.1", port=args.adb_port)
            device = self.adb.device(args.serial)
            if device is None:
                raise RpaError(f"ADB device not found: {args.serial}")
        except Exception as exc:
            raise RpaError(f"ADB device check failed on port {args.adb_port}: {exc}") from exc
        self.device = u2.connect(args.serial, port=args.u2_port)
        self.seller_by_rank: Dict[str, Dict[int, dict]] = {}
        self.rank_names: Dict[str, Dict[int, str]] = {}
        self.rank_business: Dict[str, Dict[int, str]] = {}
        self.current_board = ""
        self.current_category = getattr(args, "category", DEFAULT_CATEGORY)
        self.current_city = getattr(args, "city", DEFAULT_CITY)
        self.current_task_id = ""
        self.current_rank_limit = int(getattr(args, "board_limit", 100))
        self.fast_path_ready = False
        self.visible_rank_names: Dict[str, Dict[int, str]] = {}
        self.context_identity_verified = False
        self.target_row_point: Optional[Tuple[int, int]] = None
        self.allow_rank_label_backfill = bool(getattr(args, "rank_label_backfill", False))

    def log(self, message: str) -> None:
        print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)

    def xml(self) -> str:
        return self.device.dump_hierarchy(compressed=True)

    def tap_bounds(self, bounds: str) -> bool:
        center = center_of(bounds)
        if not center:
            return False
        self.device.shell(["input", "tap", str(center[0]), str(center[1])])
        return True

    def tap_exact_label(self, label: str, allow_desc: bool = True) -> bool:
        xml = self.xml()
        candidates = []
        for node in xml_nodes(xml):
            text = clean_text(node.get("text", ""))
            desc = clean_text(node.get("content-desc", ""))
            if text == label or (allow_desc and desc == label):
                bounds = parse_bounds(node.get("bounds", ""))
                if bounds and bounds[3] > 100:
                    candidates.append((bounds[1], node.get("bounds", "")))
        if not candidates:
            return False
        candidates.sort()
        return self.tap_bounds(candidates[0][1])

    def category_selected(self, category: str) -> bool:
        """Verify the category tab's actual selected accessibility state."""

        xml = self.xml()
        try:
            root = ET.fromstring(xml)
            for parent in root.iter("node"):
                if parent.attrib.get("selected") != "true":
                    continue
                if not CATEGORY_TAG_RE.search(parent.attrib.get("content-desc", "")):
                    continue
                for child in parent.iter("node"):
                    if clean_text(child.attrib.get("content-desc", "")) == category:
                        return True
                    if clean_text(child.attrib.get("text", "")) == category:
                        return True
        except ET.ParseError:
            pass
        # Some app versions expose no selected flag; retain the previous
        # visual fallback, but only inspect the category-tab strip.
        candidates = []
        for node in xml_nodes(xml):
            label = clean_text(node.get("text", "")) or clean_text(node.get("content-desc", ""))
            bounds = parse_bounds(node.get("bounds", ""))
            if label == category and bounds and 200 <= bounds[1] <= 420:
                candidates.append(bounds)
        if not candidates:
            return False
        if cv2 is None or np is None:
            return False
        try:
            image = np.array(self.device.screenshot())
            hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
            for x1, y1, x2, y2 in candidates:
                crop = hsv[max(0, y1):min(hsv.shape[0], y2), max(0, x1):min(hsv.shape[1], x2)]
                if crop.size == 0:
                    continue
                yellow = (
                    (crop[:, :, 0] >= 15)
                    & (crop[:, :, 0] <= 45)
                    & (crop[:, :, 1] >= 80)
                    & (crop[:, :, 2] >= 100)
                )
                if float(yellow.mean()) >= 0.02:
                    return True
        except Exception as exc:
            self.log(f"分类选中态读取失败：{exc}")
        return False

    def visible_category_labels(self, xml: Optional[str] = None) -> List[str]:
        """Return category labels currently rendered in the horizontal tab."""

        labels = []
        xml = xml if xml is not None else self.xml()
        try:
            root = ET.fromstring(xml)
            for parent in root.iter("node"):
                parent_bounds = parse_bounds(parent.attrib.get("bounds", ""))
                if not parent_bounds or not (200 <= parent_bounds[1] <= 900):
                    continue
                if not CATEGORY_TAG_RE.fullmatch(parent.attrib.get("content-desc", "")):
                    continue
                for child in parent.iter("node"):
                    label = clean_text(child.attrib.get("text", "")) or clean_text(child.attrib.get("content-desc", ""))
                    if not label or CATEGORY_TAG_RE.fullmatch(label) or len(label) > 20:
                        continue
                    if label not in labels:
                        labels.append(label)
        except ET.ParseError:
            return labels
        return labels

    def discover_categories(self) -> List[str]:
        """Discover all category tabs exposed by the current rank page."""

        labels: List[str] = []
        stable_rounds = 0
        previous = None
        for _ in range(24):
            xml = self.xml()
            current = self.visible_category_labels(xml)
            for label in current:
                if label not in labels:
                    labels.append(label)
            if tuple(labels) == previous:
                stable_rounds += 1
            else:
                stable_rounds = 0
            parent_total = 0
            for node in xml_nodes(xml):
                match = re.search(r"共\s*(\d+)\s*个", node.get("content-desc", ""))
                if match:
                    parent_total = max(parent_total, int(match.group(1)))
            if parent_total and len(labels) >= parent_total:
                break
            if stable_rounds >= 3 and (not parent_total or len(labels) >= parent_total):
                break
            tab_y = self.category_tab_y(xml)
            self.device.shell(["input", "swipe", "900", str(tab_y), "500", str(tab_y), "220"])
            time.sleep(0.35)
            previous = tuple(labels)
        # Restore the category strip to the left edge before selecting work.
        tab_y = self.category_tab_y()
        for _ in range(8):
            if "工业" in self.visible_category_labels():
                break
            self.device.shell(["input", "swipe", "180", str(tab_y), "900", str(tab_y), "220"])
            time.sleep(0.15)
        return labels

    def ensure_category(self, category: str) -> None:
        if self.category_selected(category):
            return
        for direction in ((900, 180), (180, 900)):
            seen_windows = set()
            for _ in range(8):
                window = tuple(self.visible_category_labels())
                if window in seen_windows:
                    break
                seen_windows.add(window)
                if category in window and self.tap_exact_label(category):
                    time.sleep(1.5)
                    if self.category_selected(category):
                        self.current_category = category
                        return
                tab_y = self.category_tab_y()
                self.device.shell(["input", "swipe", str(direction[0]), str(tab_y), str(direction[1]), str(tab_y), "250"])
                time.sleep(0.25)
        raise SafetyStop(f"找不到或无法确认类目：{category}；已暂停")

    def visible_cities(self, xml: Optional[str] = None) -> List[str]:
        """Read the category's visible city selector without touching products."""

        cities = []
        xml = xml if xml is not None else self.xml()
        category_labels = set(self.visible_category_labels(xml))
        for node in xml_nodes(xml):
            label = clean_text(node.get("text", "")) or clean_text(node.get("content-desc", ""))
            bounds = parse_bounds(node.get("bounds", ""))
            if not label or not bounds or not (350 <= bounds[1] < 950):
                continue
            if bounds[2] > 300:
                continue
            if label in DEFAULT_BOARDS or label in category_labels or "TOP" in label or "标签" in label:
                continue
            if any(token in label for token in ("亿级", "真实选择", "综合销量", "每日", "上榜规则")):
                continue
            if len(label) > 12 or any(token in label for token in ("¥", "关注", "宝贝")):
                continue
            if label not in cities:
                cities.append(label)
        return cities or [DEFAULT_CITY]

    def city_tab_y(self, xml: Optional[str] = None) -> int:
        ys = []
        xml = xml if xml is not None else self.xml()
        category_labels = set(self.visible_category_labels(xml))
        for node in xml_nodes(xml):
            label = clean_text(node.get("text", "")) or clean_text(node.get("content-desc", ""))
            bounds = parse_bounds(node.get("bounds", ""))
            if label and label not in DEFAULT_BOARDS and label not in category_labels and bounds and 350 <= bounds[1] < 950 and bounds[2] <= 300:
                ys.append((bounds[1] + bounds[3]) // 2)
        return max(380, min(900, int(sum(ys) / len(ys)))) if ys else 420

    def discover_cities(self) -> List[str]:
        """Capture all currently exposed city labels for the selected category."""

        xml = self.xml()
        cities = self.visible_cities(xml)
        # City selectors differ by category. If the app exposes a horizontal
        # row, inspect both directions; otherwise the visible label is the
        # complete evidence and is recorded as-is.
        for direction in ((900, 180), (180, 900)):
            seen_windows = set()
            for _ in range(12):
                xml = self.xml()
                window = tuple(self.visible_cities(xml))
                if window in seen_windows:
                    break
                seen_windows.add(window)
                for city in window:
                    if city not in cities:
                        cities.append(city)
                city_y = self.city_tab_y(xml)
                self.device.shell(["input", "swipe", str(direction[0]), str(city_y), str(direction[1]), str(city_y), "220"])
                time.sleep(0.2)
        return cities or [DEFAULT_CITY]

    def ensure_city(self, city: str) -> None:
        if city == DEFAULT_CITY and DEFAULT_CITY in self.visible_cities():
            self.current_city = city
            return
        for direction in ((900, 180), (180, 900)):
            seen_windows = set()
            for _ in range(10):
                xml = self.xml()
                visible = self.visible_cities(xml)
                window = tuple(visible)
                if window in seen_windows:
                    break
                seen_windows.add(window)
                if city in visible and self.tap_exact_label(city):
                    time.sleep(1.2)
                    if city in self.visible_cities():
                        self.current_city = city
                        return
                    raise SafetyStop(f"城市点击后未确认仍在当前类目：{city}；已暂停")
                city_y = self.city_tab_y(xml)
                self.device.shell(["input", "swipe", str(direction[0]), str(city_y), str(direction[1]), str(city_y), "220"])
                time.sleep(0.25)
        raise SafetyStop(f"当前类目未发现城市：{city}；已暂停，避免误采全国榜")

    def category_tab_y(self, xml: Optional[str] = None) -> int:
        """Return the current rendered category-tab center for horizontal swipes."""

        ys = []
        xml = xml if xml is not None else self.xml()
        try:
            root = ET.fromstring(xml)
            for node in root.iter("node"):
                bounds = parse_bounds(node.attrib.get("bounds", ""))
                if bounds and CATEGORY_TAG_RE.fullmatch(node.attrib.get("content-desc", "")):
                    ys.append((bounds[1] + bounds[3]) // 2)
        except ET.ParseError:
            pass
        return max(250, min(780, int(sum(ys) / len(ys)))) if ys else 300

    def wait_for_xml(self, predicate, timeout: float = 15.0, interval: float = 0.15) -> str:
        end = time.time() + timeout
        last = ""
        while time.time() < end:
            last = self.xml()
            if predicate(last):
                return last
            time.sleep(interval)
        return last

    def handle_system_interstitials(self) -> None:
        for _ in range(30):
            xml = self.xml()
            if "跳过广告" in xml:
                self.tap_exact_label("跳过广告")
                time.sleep(1)
                continue
            if "当前网站请求打开闲鱼" in xml:
                # Android's browser-to-app confirmation is a system-owned
                # sheet. On some Xiaomi builds the button has no usable
                # child node, so keep the fallback inside this exact prompt
                # check rather than using a blind tap on normal pages.
                if not self.tap_exact_label("允许"):
                    self.device.shell(["input", "tap", "768", "2200"])
                time.sleep(1.5)
                continue
            if self.device.info.get("currentPackageName") == "com.android.browser":
                # The short board link is resolved by the system browser. On
                # this device Android shows a consent sheet before handing it
                # to Idlefish; tapping these two browser-owned labels is part
                # of opening the supplied link, not a login or product action.
                if self.tap_exact_label("允许") or self.tap_exact_label("打开App"):
                    time.sleep(2)
                    continue
            break

    def wait_for_rank_page(self, timeout: float) -> str:
        """Wait for an authenticated Idlefish rank page and handle late browser consent."""

        end = time.time() + timeout
        last = ""
        while time.time() < end:
            last = self.xml()
            package = self.device.info.get("currentPackageName")
            if package == IDLEFISH_PACKAGE and longest_rank_list_desc(last) and any(board in last for board in DEFAULT_BOARDS):
                return last
            if package == "com.android.browser":
                if "当前网站请求打开闲鱼" in last:
                    if not self.tap_exact_label("允许"):
                        self.device.shell(["input", "tap", "768", "2200"])
                    time.sleep(1.5)
                    continue
                if self.tap_exact_label("允许") or self.tap_exact_label("打开App"):
                    time.sleep(1.5)
                    continue
            time.sleep(0.15)
        return last

    def launch_board(self) -> None:
        # A previous interrupted run can leave the seller share panel or a
        # seller profile on top.  Close only those visible UI layers first;
        # this does not clear the app data, account, browser partition, or
        # proxy configuration.
        for _ in range(5):
            if longest_rank_list_desc(self.xml()):
                break
            self.device.press("back")
            time.sleep(0.5)
        self.log(f"打开榜单入口：{self.current_category}/{self.current_city}")
        # The supplied m.tb.cn link is a browser-to-app deep link. Starting
        # InitActivity directly only restores the last Idlefish page and drops
        # the board encoded by the link, so keep the browser hand-off here.
        context = self.queue.context(self.current_task_id) or {}
        board_url = context.get("sourceUrl") or self.args.board_url
        self.device.shell(["am", "start", "-a", "android.intent.action.VIEW", "-d", board_url])
        self.handle_system_interstitials()
        xml = self.wait_for_rank_page(45)
        if self.device.info.get("currentPackageName") != IDLEFISH_PACKAGE or not longest_rank_list_desc(xml):
            self.log("短链接未进入榜单，回退到已登录闲鱼主 Activity")
            self.device.shell(["am", "start", "-n", IDLEFISH_INIT_ACTIVITY])
            self.handle_system_interstitials()
            xml = self.wait_for_rank_page(30)
        if self.device.info.get("currentPackageName") != IDLEFISH_PACKAGE or not longest_rank_list_desc(xml):
            raise SafetyStop("榜单页面未加载；已暂停，没有继续点击")
        self.ensure_category_context()

    def ensure_category_context(self) -> None:
        self.ensure_category(self.current_category)
        self.ensure_city(self.current_city)
        if not longest_rank_list_desc(self.xml()):
            raise SafetyStop(f"类目/城市页面未加载：{self.current_category}/{self.current_city}；已暂停")

    def ensure_industrial(self) -> None:
        """Backward-compatible alias for old single-category runs."""

        self.current_category = "工业"
        self.ensure_category_context()

    def select_board(self, board: str) -> None:
        self.log(f"切换到 {board}")
        if not self.category_selected(self.current_category):
            self.ensure_category_context()
        if self.current_city not in self.visible_cities() and self.current_city != DEFAULT_CITY:
            self.ensure_city(self.current_city)
        for _ in range(8):
            if self.tap_exact_label(board):
                loaded = self.wait_for_xml(
                    lambda value: longest_rank_list_desc(value) and board in value,
                    timeout=8,
                    interval=0.15,
                )
                if longest_rank_list_desc(loaded) and board in loaded:
                    self.current_board = board
                    self.reset_board_top()
                    self.prime_board_order()
                    self.context_identity_verified = True
                    return
            self.device.swipe(540, 700, 540, 2250, duration=0.45)
            time.sleep(0.15)
        raise SafetyStop(f"找不到 {board} 或榜单列表未加载；已暂停")

    def board_selected(self, board: str) -> bool:
        """Verify the board's visual selected state in the board-tab strip."""

        xml = self.xml()
        candidates = []
        for node in xml_nodes(xml):
            label = clean_text(node.get("text", "")) or clean_text(node.get("content-desc", ""))
            bounds = parse_bounds(node.get("bounds", ""))
            if label == board and bounds and 350 <= bounds[1] <= 950:
                candidates.append(bounds)
        if not candidates:
            return False
        if cv2 is None or np is None:
            return board in xml
        try:
            image = np.array(self.device.screenshot())
            hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
            for x1, y1, x2, y2 in candidates:
                crop = hsv[max(0, y1):min(hsv.shape[0], y2), max(0, x1):min(hsv.shape[1], x2)]
                if crop.size == 0:
                    continue
                yellow = (
                    (crop[:, :, 0] >= 15)
                    & (crop[:, :, 0] <= 45)
                    & (crop[:, :, 1] >= 80)
                    & (crop[:, :, 2] >= 100)
                )
                if float(yellow.mean()) >= 0.01:
                    return True
        except Exception as exc:
            self.log(f"榜单选中态读取失败：{exc}")
        return False

    def context_selected(self, board: str) -> bool:
        return (
            self.category_selected(self.current_category)
            and self.current_city in self.visible_cities()
            and self.board_selected(board)
            and bool(longest_rank_list_desc(self.xml()))
        )

    def context_fast_present(self, board: str) -> bool:
        """Check the current list with one hierarchy snapshot between full checks."""

        xml = self.xml()
        return bool(longest_rank_list_desc(xml) and board in xml)

    def reset_board_top(self) -> None:
        for _ in range(7):
            self.device.shell(["input", "swipe", "540", "650", "540", "2290", "350"])
            time.sleep(0.12)
        time.sleep(0.45)

    def prime_board_order(self) -> None:
        """Wait for a stable first page before assigning ranks.

        The list is lazy-loaded. A transient first snapshot can omit cards,
        but the visible list order remains the only safe ordinal source. Two
        identical observations are required; one card is enough to establish
        the first ordinal when a board renders sparse displayed TOP labels
        such as TOP1 followed by TOP14. Later cards are appended in the same
        order as they become available. Numeric TOP labels are evidence only
        and do not renumber ordinal source slots.
        """

        previous = None
        stable = 0
        for _ in range(12):
            records = parse_visible_sellers(longest_rank_list_desc(self.xml()))
            signature = tuple(record["sellerName"] for record in records[:4])
            if len(signature) >= 1 and signature == previous:
                stable += 1
            else:
                stable = 1 if len(signature) >= 1 else 0
            if stable >= 2:
                names = self.rank_names.setdefault(self.current_board, {})
                businesses = self.rank_business.setdefault(self.current_board, {})
                for index, record in enumerate(records, start=1):
                    names[index] = record["sellerName"]
                    businesses[index] = record["mainBusiness"]
                self.log(f"榜单首屏顺序稳定：已识别 {len(records)} 个卖家")
                self.fast_path_ready = True
                return
            previous = signature
            time.sleep(0.25)
        raise SafetyStop(f"{self.current_board} 首屏卖家顺序未稳定；已暂停，避免排名错位")

    def visible_records(self) -> List[dict]:
        records = parse_visible_sellers(longest_rank_list_desc(self.xml()))
        board = self.current_board
        names = self.rank_names.setdefault(board, {})
        business = self.rank_business.setdefault(board, {})
        for record in records:
            if record["sellerName"] not in names.values():
                rank = len(names) + 1
                names[rank] = record["sellerName"]
                business[rank] = record["mainBusiness"]
            record["globalRank"] = next(
                (rank for rank, name in names.items() if name == record["sellerName"]),
                None,
            )
        self.visible_rank_names[board] = {
            int(record["globalRank"]): record["sellerName"]
            for record in records
            if record.get("globalRank") is not None
        }
        return records

    def record_for_rank(self, rank: int) -> dict:
        names = self.rank_names.setdefault(self.current_board, {})
        business = self.rank_business.setdefault(self.current_board, {})
        for _ in range(3):
            self.visible_records()
            if rank in names:
                return {"rank": rank, "sellerName": names[rank], "mainBusiness": business.get(rank, "")}
            time.sleep(0.5)
        raise SafetyStop(f"榜单第 {rank} 名未出现在当前页面；已暂停，避免误点商品")

    def ensure_rank_visible(self, rank: int) -> None:
        """Navigate by OCR-visible TOP labels until the target card is shown."""

        self.target_row_point = None
        # The first card's TOP label can be hidden under the expanded header,
        # while prime_board_order has already confirmed the first-page order.
        # Trust that bounded, stable accessibility order for the first visible
        # window; OCR remains mandatory once we leave that window.
        self.visible_records()
        names = self.rank_names.setdefault(self.current_board, {})
        # The flattened accessibility list is the authoritative order for a
        # loaded page. OCR TOP labels are only a locator aid: on the real
        # device they occasionally read TOP3 as TOP5 and must never rewrite a
        # rank/name mapping that was already established from list order.
        expected_name = names.get(rank, "")
        name_candidates = [expected_name]
        if expected_name and expected_name[-1].isdigit():
            # The flattened accessibility text can append a neighbouring
            # count to a seller name (for example, "配件2"). The shortened
            # candidate is used only for OCR row location; the homepage
            # identity and rank evidence still decide whether to accept it.
            name_candidates.append(expected_name[:-1])
        for candidate in name_candidates:
            point = self.ocr_seller_name_point(candidate)
            if point:
                self.target_row_point = point
                self.log(f"名称缓存确认榜单 TOP{rank}：{expected_name}")
                return

        for _ in range(MAX_RANK_SEEK_STEPS):
            cards = self.ocr_visible_rank_cards()
            if cards:
                # Do not promote OCR's numeric rank into the canonical map.
                # First use the already established list-order name. If a
                # later lazy-loaded rank has not been seen yet, refresh the
                # accessibility order and only then use OCR to locate that
                # exact name. This prevents a transient OCR header from
                # shifting every subsequent rank.
                self.visible_records()
                names = self.rank_names.setdefault(self.current_board, {})
                expected_name = names.get(rank, "")
                if expected_name:
                    # Match the OCR name line, not its numeric TOP label. The
                    # label is useful for navigation but can be misread by a
                    # digit (for example TOP3 -> TOP5). The card point is
                    # accepted only when its name matches the canonical
                    # list-order name exactly after conservative compaction.
                    target = next(
                        (
                            card for card in cards
                            if seller_name_ocr_compatible(expected_name, card.get("sellerName", ""))
                        ),
                        None,
                    )
                    if target and target.get("point"):
                        self.target_row_point = tuple(target["point"])
                        self.log(f"榜单顺序+OCR名称确认 TOP{rank}：{expected_name}")
                        return
                    rank_target = next((card for card in cards if card.get("rank") == rank), None)
                    if (
                        rank_target
                        and rank_target.get("point")
                        and seller_name_ocr_compatible(expected_name, rank_target.get("sellerName", ""))
                    ):
                        self.target_row_point = tuple(rank_target["point"])
                        self.log(
                            f"榜单顺序+TOP标识确认 TOP{rank}：{expected_name} / "
                            f"OCR名称={rank_target.get('sellerName', '')}"
                        )
                        return
                    if (
                        self.allow_rank_label_backfill
                        and rank_target
                        and rank_target.get("point")
                        and rank_target.get("rank") == rank
                    ):
                        self.target_row_point = tuple(rank_target["point"])
                        self.log(
                            f"补 ID 模式使用明确 TOP 标识定位 TOP{rank}："
                            f"OCR名称={rank_target.get('sellerName', '')}；主页仍需复核"
                        )
                        return
                visible_ranks = [card["rank"] for card in cards]
                if rank < min(visible_ranks):
                    # Finger-down exposes earlier ranks; use a smaller step so
                    # TOP11/TOP12 are not skipped when correcting overshoot.
                    self.device.shell(["input", "swipe", "540", "800", "540", "1200", "300"])
                    time.sleep(1.1)
                    continue
                if rank > max(visible_ranks):
                    self.advance_one_rank()
                    continue
                # A single OCR pass can miss a header; make a small downward
                # move and let the next pass re-evaluate visible TOP labels.
                self.advance_one_rank()
                continue
            self.reset_board_top()
            self.advance_one_rank()
        raise SafetyStop(f"榜单 TOP{rank} 重新定位失败；已暂停，避免误点")

    def ocr_seller_name_point(self, expected_name: str) -> Optional[Tuple[int, int]]:
        """Locate the exact visible seller-name line without tapping products.

        The rank list exposes a single flattened accessibility node containing
        all loaded sellers, not just the visible cards. OCR on the seller text
        column gives the actual screen coordinate, while the final profile
        name/rank checks remain mandatory before accepting the result.
        """

        if cv2 is None or np is None or not expected_name:
            return None
        tesseract = shutil.which("tesseract")
        if not tesseract:
            return None
        try:
            image = np.array(self.device.screenshot())
            crop_x, crop_y = 180, 650
            crop = image[crop_y:2300, crop_x:820]
            encoded_ok, encoded = cv2.imencode(
                ".png", cv2.cvtColor(crop, cv2.COLOR_RGB2BGR)
            )
            if not encoded_ok:
                return None
            result = subprocess.run(
                [tesseract, "stdin", "stdout", "-l", "chi_sim+eng", "--psm", "11", "tsv"],
                input=encoded.tobytes(),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
            needle = re.sub(r"\s+", "", expected_name)
            groups: Dict[Tuple[str, str, str], List[dict]] = {}
            for row in csv.DictReader(
                io.StringIO(result.stdout.decode("utf-8", errors="ignore")),
                delimiter="\t",
            ):
                text = clean_text(row.get("text", ""))
                if not text:
                    continue
                key = (row.get("block_num", ""), row.get("par_num", ""), row.get("line_num", ""))
                groups.setdefault(key, []).append(row)
            for rows in groups.values():
                rows.sort(key=lambda row: int(row.get("left", "0") or 0))
                combined = "".join(re.sub(r"\s+", "", row.get("text", "")) for row in rows)
                if needle not in combined:
                    continue
                x1 = min(int(row.get("left", "0") or 0) for row in rows)
                y1 = min(int(row.get("top", "0") or 0) for row in rows)
                x2 = max(
                    int(row.get("left", "0") or 0) + int(row.get("width", "0") or 0)
                    for row in rows
                )
                y2 = max(
                    int(row.get("top", "0") or 0) + int(row.get("height", "0") or 0)
                    for row in rows
                )
                point = (crop_x + (x1 + x2) // 2, crop_y + (y1 + y2) // 2)
                self.log(f"OCR定位卖家名称：{expected_name} -> ({point[0]},{point[1]})")
                return point
        except Exception as exc:
            self.log(f"OCR定位失败，继续使用头像候选：{exc}")
        return None

    def ocr_visible_rank_cards(self) -> List[dict]:
        """Read visible TOP labels and seller rows from the rendered screen."""

        if cv2 is None or np is None:
            return []
        tesseract = shutil.which("tesseract")
        if not tesseract:
            return []
        try:
            image = np.array(self.device.screenshot())
            crop_y = 450
            crop = image[crop_y:2350, :]
            encoded_ok, encoded = cv2.imencode(
                ".png", cv2.cvtColor(crop, cv2.COLOR_RGB2BGR)
            )
            if not encoded_ok:
                return []
            result = subprocess.run(
                [tesseract, "stdin", "stdout", "-l", "chi_sim+eng", "--psm", "11", "tsv"],
                input=encoded.tobytes(),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
            groups: Dict[Tuple[str, str, str], List[dict]] = {}
            for row in csv.DictReader(
                io.StringIO(result.stdout.decode("utf-8", errors="ignore")),
                delimiter="\t",
            ):
                text = clean_text(row.get("text", ""))
                if not text:
                    continue
                key = (row.get("block_num", ""), row.get("par_num", ""), row.get("line_num", ""))
                groups.setdefault(key, []).append(row)
            lines = []
            for rows in groups.values():
                rows.sort(key=lambda row: int(row.get("left", "0") or 0))
                text = clean_text("".join(row.get("text", "") for row in rows))
                x1 = min(int(row.get("left", "0") or 0) for row in rows)
                y1 = min(int(row.get("top", "0") or 0) for row in rows) + crop_y
                x2 = max(
                    int(row.get("left", "0") or 0) + int(row.get("width", "0") or 0)
                    for row in rows
                )
                y2 = max(
                    int(row.get("top", "0") or 0) + int(row.get("height", "0") or 0)
                    for row in rows
                ) + crop_y
                lines.append({"text": text, "x": x1, "y": y1, "x2": x2, "y2": y2})
            lines.sort(key=lambda line: (line["y"], line["x"]))
            cards = []
            for index, header in enumerate(lines):
                rank = ocr_top_rank(header["text"])
                if rank is None:
                    continue
                next_header_y = next(
                    (
                        line["y"]
                        for line in lines[index + 1 :]
                        if ocr_top_rank(line["text"]) is not None
                    ),
                    2350,
                )
                candidates = [
                    line
                    for line in lines[index + 1 :]
                    if header["y"] + 50 <= line["y"] < min(header["y"] + 260, next_header_y)
                    and 200 <= line["x"] <= 650
                    and not any(token in line["text"] for token in ("上榜", "年内卖", "¥", "宝贝"))
                ]
                if not candidates:
                    continue
                name_line = candidates[0]
                name = clean_text(name_line["text"])
                # OCR often merges the adjacent L7 badge into the seller name.
                name = re.split(r"[《<\(（\[]", name, maxsplit=1)[0]
                name = re.sub(r"[A-Z]{1,3}$", "", name).strip()
                name = re.sub(r"\d+$", "", name).strip()
                name = re.sub(r"[©®™|｜]+$", "", name).strip()
                if len(name) < 2:
                    continue
                business = ""
                for line in candidates[1:]:
                    if 15 <= line["y"] - name_line["y"] <= 100:
                        business = line["text"]
                        break
                point = (
                    max(240, min(700, (name_line["x"] + name_line["x2"]) // 2)),
                    (name_line["y"] + name_line["y2"]) // 2,
                )
                cards.append(
                    {
                        "rank": rank,
                        "sellerName": name,
                        "mainBusiness": business,
                        "point": point,
                    }
                )
            return cards
        except Exception as exc:
            self.log(f"OCR读取可见榜单失败：{exc}")
            return []

    def dismiss_follow_prompt(self) -> None:
        for _ in range(5):
            xml = self.xml()
            if "不关注" not in xml and "选好了" not in xml:
                return
            if "不关注" in xml:
                self.tap_exact_label("不关注")
                time.sleep(0.4)
            if "选好了" in self.xml():
                if not self.tap_exact_label("选好了"):
                    # Some onboarding dialogs expose all text only on one
                    # full-screen flattened node, so there is no child to
                    # locate. This taps the visible confirmation button,
                    # never either of the preference choices.
                    self.device.shell(["input", "tap", "540", "1470"])
                time.sleep(0.7)

    def seller_name_points(self) -> List[Tuple[int, int]]:
        """Find the first visible seller-name line, not a product thumbnail.

        The rank UI exposes the whole list as one flattened accessibility
        node.  On the observed device the seller name is a black text line in
        the left card column; OpenCV finds that line after each scroll.  A
        conservative fixed fallback is retained for environments without
        OpenCV.
        """

        if cv2 is None or np is None:
            return [(320, 1060)]
        try:
            image = np.array(self.device.screenshot())
            gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
            mask = (gray < 100).astype("uint8") * 255
            list_tops = []
            for node in xml_nodes(self.xml()):
                bounds = parse_bounds(node.get("bounds", ""))
                desc = node.get("content-desc", "")
                if bounds and bounds[0] == 0 and bounds[2] >= 1000 and bounds[3] >= 2200 and "关注TA" in desc:
                    list_tops.append(bounds[1])
            # When the large header is expanded, the board tabs at y~780 are
            # not seller names.  Once collapsed, a seller name can begin near
            # y~820, so the threshold follows the actual list bounds.
            min_y = 900 if not list_tops or min(list_tops) >= 800 else 700

            # Avatar circles sit in the seller header, left of the text and
            # well above product thumbnails. Prefer these points so dark
            # price text cannot become a tap candidate.
            hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
            avatar_mask = (((gray < 220) | (hsv[:, :, 1] > 35)).astype("uint8") * 255)
            avatar_mask[:min_y, :] = 0
            avatar_mask[:, :60] = 0
            avatar_mask[:, 220:] = 0
            avatar_mask = cv2.morphologyEx(
                avatar_mask,
                cv2.MORPH_CLOSE,
                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)),
            )
            avatar_mask = cv2.dilate(avatar_mask, np.ones((5, 5), np.uint8))
            avatar_contours, _ = cv2.findContours(avatar_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            avatar_points = []
            for contour in avatar_contours:
                x, y, width, height = cv2.boundingRect(contour)
                if 75 <= x <= 150 and 60 <= width <= 150 and 60 <= height <= 150 and 0.5 <= width / height <= 2:
                    avatar_points.append((x, y, width, height))
            if avatar_points:
                points = [(320, y + min(35, height // 2)) for x, y, width, height in sorted(avatar_points, key=lambda item: item[1])]
                self.log("头像行候选：" + ", ".join(f"({x},{y})" for x, y in points[:6]))
                return points

            mask[:min_y, :] = 0
            mask[:, :220] = 0
            mask[:, 750:] = 0
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 3))
            merged = cv2.dilate(mask, kernel)
            contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            bands = []
            for contour in contours:
                x, y, width, height = cv2.boundingRect(contour)
                # Product prices/text can also be dark, but seller names
                # start in the left text column.  Never use a candidate that
                # starts in the thumbnail grid (x > 420).
                if 25 <= height <= 65 and 80 <= width <= 520 and 220 <= x <= 420 and min_y <= y <= 2250:
                    bands.append((y, x, width, height))
            # Long Chinese names may be split into two adjacent contours.
            # Merge same-line contours before producing tap points.
            groups: List[List[Tuple[int, int, int, int]]] = []
            for band in sorted(bands):
                if not groups or band[0] - groups[-1][-1][0] > 45:
                    groups.append([band])
                else:
                    groups[-1].append(band)
            points = []
            for group in groups:
                y = min(item[0] for item in group)
                x = min(item[1] for item in group)
                right = max(item[1] + item[2] for item in group)
                height = max(item[3] for item in group)
                tap_x = max(250, min(620, (x + right) // 2))
                tap_y = y + height // 2
                points.append((tap_x, tap_y))
            if points:
                self.log("名称行候选：" + ", ".join(f"({x},{y})" for x, y in points[:6]))
                return points
        except Exception as exc:
            self.log(f"名称行图像定位失败，使用保守回退点：{exc}")
        return [(320, 1060)]

    def seller_name_point(self) -> Tuple[int, int]:
        return self.seller_name_points()[0]

    def seller_avatar_tap_point(self, point: Tuple[int, int]) -> Tuple[int, int]:
        """Move a detected seller-row point to the non-product avatar column."""

        _x, y = point
        return (140, max(650, min(2250, y)))

    def open_profile(self, expected: dict) -> str:
        self.log(f"点击卖家卡片：{expected['sellerName']}")
        attempted_y = set()
        for attempt in range(6):
            ocr_point = self.target_row_point if attempt == 0 else None
            if ocr_point:
                self.log(
                    f"使用已确认卖家名称行：{expected.get('sellerName', '')} -> "
                    f"({ocr_point[0]},{ocr_point[1]})"
                )
            else:
                ocr_point = self.ocr_seller_name_point(expected.get("sellerName", ""))
            if not ocr_point:
                raise SafetyStop(
                    f"未能定位目标卖家头像：{expected.get('sellerName', '')}；已暂停，避免误点相邻卖家"
                )
            # The OCR point identifies the exact seller-name line. The tap is
            # moved horizontally to that row's avatar, never to a product
            # thumbnail or price. Do not use an arbitrary visible-row fallback:
            # the accessibility tree is flattened and may include offscreen
            # sellers, so its index is not a physical tap coordinate.
            points = [ocr_point] if ocr_point[1] not in attempted_y else []
            if not points:
                continue
            tap_x, tap_y = self.seller_avatar_tap_point(points[0])
            attempted_y.add(tap_y)
            self.log(f"尝试卖家头像：x={tap_x}, y={tap_y}（第 {attempt + 1} 个候选）")
            self.device.shell(["input", "tap", str(tap_x), str(tap_y)])
            xml = self.wait_for_xml(profile_page_ready, timeout=5)
            self.dismiss_follow_prompt()
            xml = self.xml()
            strong_purchase_controls = ("立即购买" in xml or "马上买" in xml or "加入购物车" in xml)
            if strong_purchase_controls or ("商品详情" in xml and not profile_page_ready(xml)):
                self.device.press("back")
                raise SafetyStop("检测到商品详情页；已返回并暂停，未继续爬取")
            if not profile_page_ready(xml):
                if not longest_rank_list_desc(xml):
                    # A profile can load with a different credit-header label
                    # or after the first wait timeout. Restore the rank page
                    # before retrying the row locator; never OCR a profile as
                    # if it were still the rank list.
                    self.device.press("back")
                    self.back_to_board()
                continue
            actual_name, _actual_business, actual_rank, actual_rank_board = self.profile_fields(xml, expected)
            # The rank card OCR can be materially wrong for short Latin names
            # or stylized Chinese fonts. If the profile header exposes a real
            # nickname and we reached it through the OCR-selected seller row,
            # let the later share-copy equality check correct the OCR value.
            header_corrected = bool(actual_name and actual_name != expected["sellerName"] and ocr_point)
            name_ok = (
                actual_name == expected["sellerName"]
                or expected["sellerName"] in xml
                or header_corrected
            )
            if header_corrected:
                self.log(f"主页昵称校正：榜单OCR={expected['sellerName']} -> 主页={actual_name}")
            expected_board = expected.get("board", self.current_board)
            profile_rank_is_other_board = bool(
                actual_rank
                and actual_rank_board
                and actual_rank_board != expected_board
            )
            rank_ok = (
                not actual_rank
                or (
                    actual_rank == int(expected.get("rank", 0) or 0)
                    and actual_rank_board == expected_board
                )
                or profile_rank_is_other_board
            )
            if name_ok and rank_ok:
                if profile_rank_is_other_board:
                    self.log(
                        f"主页显示跨榜排名：当前上下文={expected_board} TOP{expected.get('rank', '?')}；"
                        f"主页证据={actual_rank_board} TOP{actual_rank}"
                    )
                return xml
            self.log(
                f"主页身份不匹配，返回换候选：实际={actual_name or '未知'} / "
                f"榜单证据={actual_rank_board or '未知'}第{actual_rank or '未知'}名"
            )
            self.back_to_board()
            time.sleep(0.15)
        raise SafetyStop(f"未能打开并核对卖家主页（期望：{expected['sellerName']} TOP{expected.get('rank', '?')}）；已暂停")

    def profile_fields(self, xml: str, expected: dict) -> Tuple[str, str, int, str]:
        nodes = list(xml_nodes(xml))
        name = expected.get("sellerName", "")
        business = expected.get("mainBusiness", "")
        # Seller profile headers expose the complete nickname as a root
        # content-desc such as “纸韧制造\n关注”. This is stronger evidence
        # than the truncated/garbled rank-card OCR and is still read-only.
        for node in nodes:
            desc = clean_text(node.get("content-desc", ""))
            match = re.match(r"^(.{2,80})\s+(?:关注|已关注)$", desc)
            if match:
                candidate = clean_text(match.group(1))
                if candidate and "榜" not in candidate and "宝贝" not in candidate:
                    name = candidate
                    break
        for node in nodes:
            bounds = parse_bounds(node.get("bounds", ""))
            label = clean_text(node_label(node))
            if not bounds or not label:
                continue
            if (
                120 <= bounds[1] <= 360
                and 180 <= bounds[0] <= 800
                and 2 <= len(label) <= 80
                and not any(x in label for x in ["粉丝", "关注", "宝贝", "闲鱼"])
            ):
                if "闲鱼" not in label:
                    name = label
                    break
        for node in nodes:
            bounds = parse_bounds(node.get("bounds", ""))
            label = clean_text(node_label(node))
            if not bounds or not label or not (500 <= bounds[1] <= 760):
                continue
            if (
                node.get("class", "").endswith("Button")
                and len(label) <= 40
                and label not in {"更多", "关注"}
                and "榜" not in label
                and "IP " not in label
            ):
                if not any(x in label for x in ["粉丝", "关注", "男生", "女生", "后", "座"]):
                    business = label
                    break
        rank = 0
        rank_board = ""
        board_names = ("热门榜", "好评榜", "回头客榜", "服务榜")
        expected_board = expected.get("board", self.current_board)
        board_pattern = "|".join(re.escape(board) for board in board_names)
        match = re.search(
            rf"(?P<board>{board_pattern})第\s*(?P<rank>\d+)\s*名",
            xml,
        )
        if match:
            rank = int(match.group("rank"))
            rank_board = match.group("board")
        return name, business, rank, rank_board

    def share_and_copy(self) -> Tuple[str, str, dict]:
        # The share confirmation toast can remain in the accessibility tree
        # from the previous seller, and Android may keep the previous seller's
        # URL in the clipboard.  Seed a sentinel before opening the menu so a
        # stale URL/toast can never be accepted as this seller's result.
        clipboard_sentinel = f"RPA_PENDING_{int(time.time() * 1000)}"
        timings = {}
        share_started = time.monotonic()
        try:
            self.device.set_clipboard(clipboard_sentinel)
        except Exception:
            pass
        sheet = ""
        for attempt in range(2):
            self.device.shell(["input", "tap", "1000", "165"])
            sheet = self.wait_for_xml(
                lambda x: any(
                    "分享" in node_label(n)
                    and (parse_bounds(n.get("bounds", "")) or (0, 0, 0, 0))[1] >= 1500
                    for n in xml_nodes(x)
                ),
                timeout=8,
                interval=0.15,
            )
            if sheet:
                break
            self.device.press("back")
            time.sleep(0.2)
        if not sheet:
            raise RpaError("主页分享菜单未出现")
        timings["shareMenuMs"] = round((time.monotonic() - share_started) * 1000, 1)
        tapped = False
        for node in xml_nodes(sheet):
            bounds = parse_bounds(node.get("bounds", ""))
            if bounds and bounds[1] >= 1500 and "分享" in node_label(node):
                tapped = self.tap_bounds(node.get("bounds", ""))
                break
        if not tapped:
            self.device.shell(["input", "tap", "540", "1724"])
        # The second share panel is lazy-loaded and can take several seconds
        # on a real device.  Do not fall back to a blind product-area tap if
        # it does not appear; pause the task with a specific reason instead.
        copy_started = time.monotonic()
        panel = self.wait_for_xml(lambda x: "复制链接" in x, timeout=8, interval=0.15)
        if not panel:
            raise RpaError("主页分享复制面板未出现")
        copy_bounds = ""
        for node in xml_nodes(panel):
            if "复制链接" in node_label(node):
                copy_bounds = node.get("bounds", "")
                break
        clipboard = ""
        for attempt in range(3):
            if attempt == 0 and copy_bounds:
                self.tap_bounds(copy_bounds)
            else:
                # The panel is an image-backed view on some device states;
                # repeat only the documented copy-link hit area.
                self.device.shell(["input", "tap", "322", "1763"])
            clipboard_deadline = time.time() + 6
            while time.time() < clipboard_deadline:
                try:
                    candidate = self.device.clipboard or ""
                except Exception:
                    candidate = ""
                if candidate and candidate != clipboard_sentinel and extract_share_url(candidate):
                    clipboard = candidate
                    break
                time.sleep(0.1)
            if clipboard:
                break
        share_text = clean_text(clipboard)
        if not extract_share_url(share_text):
            raise RpaError("复制链接失败：剪贴板未更新为 m.tb.cn 主页链接")
        timings["copyLinkMs"] = round((time.monotonic() - copy_started) * 1000, 1)
        url = extract_share_url(share_text)
        if not url:
            raise RpaError("复制内容中没有 m.tb.cn 主页链接")
        return url, share_text, timings

    def back_to_board(self) -> None:
        for _ in range(4):
            if longest_rank_list_desc(self.xml()):
                return
            self.device.press("back")
            deadline = time.time() + 2.5
            while time.time() < deadline:
                if longest_rank_list_desc(self.xml()):
                    return
                time.sleep(0.15)
        raise SafetyStop("返回榜单失败；已暂停")

    def record_blocked_event(self, board: str, rank: int, reason: str) -> None:
        """Persist a safety stop even when it happens before profile capture."""

        event = {
            "eventId": f"{self.queue.run['runId']}-{board}-{rank}-blocked-{int(time.time())}",
            "runId": self.queue.run["runId"],
            "taskId": self.current_task_id,
            "deviceId": self.queue.run.get("deviceId", self.args.serial),
            "category": self.current_category,
            "city": self.current_city,
            "board": board,
            "rank": rank,
            "sellerId": "",
            "sellerName": "",
            "mainBusiness": "",
            "homepageUrl": "",
            "screenshotPath": "",
            "capturedAt": now_iso(),
            "deviceSerial": self.args.serial,
            "status": "blocked",
            "failureReason": reason,
            "productCrawlLimit": 1000,
            "sourceBoardUrl": self.args.board_url,
            "shareCopyText": "",
            "profileRankBoard": "",
            "durationSeconds": 0,
            "contextEvidence": {
                "category": self.current_category,
                "city": self.current_city,
                "board": board,
                "rank": rank,
            },
            "uploadStatus": "pending_local",
        }
        self.queue.mark_rank(self.current_task_id, rank, "blocked")
        self.queue.append(event)

    def capture_one(self, board: str, rank: int, expected: dict, timing_context: Optional[dict] = None) -> bool:
        event_id = f"{self.queue.run['runId']}-{board}-{rank}-{int(time.time())}"
        captured_at = now_iso()
        started = time.monotonic()
        overall_started = (timing_context or {}).get("started", started)
        timings = dict((timing_context or {}).get("timings", {}))
        event = {
            "eventId": event_id,
            "runId": self.queue.run["runId"],
            "taskId": self.current_task_id,
            "deviceId": self.queue.run.get("deviceId", self.args.serial),
            "category": self.current_category,
            "city": self.current_city,
            "board": board,
            "rank": rank,
            "sellerId": "",
            "sellerName": expected.get("sellerName", ""),
            "mainBusiness": expected.get("mainBusiness", ""),
            "homepageUrl": "",
            "screenshotPath": "",
            "capturedAt": captured_at,
            "deviceSerial": self.args.serial,
            "status": "failed",
            "failureReason": "",
            "productCrawlLimit": 1000,
            "sourceBoardUrl": self.args.board_url,
            "shareCopyText": "",
            "profileRankBoard": "",
            "durationSeconds": None,
            "timings": timings,
            "performanceMode": "full_evidence",
            "sellerIdStatus": "queued",
            "uploadStatus": "pending_local",
        }
        try:
            expected["board"] = board
            profile_started = time.monotonic()
            profile_xml = self.open_profile(expected)
            timings["profileOpenMs"] = round((time.monotonic() - profile_started) * 1000, 1)
            seller_name, business, profile_rank, profile_rank_board = self.profile_fields(profile_xml, expected)
            if seller_name:
                event["sellerName"] = seller_name
            if business:
                event["mainBusiness"] = business
            if profile_rank:
                event["profileRankEvidence"] = profile_rank
                event["profileRankBoard"] = profile_rank_board
                if profile_rank_board and profile_rank_board != board:
                    event["profileRankConflict"] = {
                        "expectedBoard": board,
                        "expectedRank": rank,
                        "profileBoard": profile_rank_board,
                        "profileRank": profile_rank,
                        "resolution": "current_list_context_is_primary",
                    }
                    event.setdefault("anomalies", []).append("profile_rank_other_board")
            screenshot_started = time.monotonic()
            screenshot = self.queue.root / "screenshots" / f"{event_id}.png"
            self.device.screenshot(str(screenshot))
            timings["screenshotMs"] = round((time.monotonic() - screenshot_started) * 1000, 1)
            event["screenshotPath"] = str(screenshot.relative_to(self.queue.root))
            url, share_text, share_timings = self.share_and_copy()
            timings.update(share_timings)
            event["homepageUrl"] = url
            event["shareCopyText"] = share_text
            share_name = extract_share_seller_name(share_text)
            expected_share_name = re.sub(r"[|｜©®™]+$", "", event["sellerName"]).strip()
            if not share_name:
                raise RpaError(
                    f"复制口令昵称不一致：榜单={event['sellerName']}，复制内容=未知"
                )
            if share_name != event["sellerName"]:
                # Rank-card text can be visually truncated beside the level
                # badge. Accept only a strict prefix relation, then preserve
                # the complete homepage name from the copied share evidence.
                same_board_rank = (
                    event.get("profileRankBoard") == board
                    and event.get("profileRankEvidence") == rank
                )
                compact_expected = compact_seller_name(expected_share_name)
                compact_share = compact_seller_name(share_name)
                # OCR can append a badge fragment such as `}` to an otherwise
                # correct Latin seller name. Compare a compact form as a
                # second, still prefix-constrained, evidence path; never use
                # fuzzy matching or invent a name.
                compact_prefix = bool(
                    compact_expected
                    and compact_share
                    and (
                        compact_share.startswith(compact_expected)
                        or compact_expected.startswith(compact_share)
                    )
                )
                if not (
                    share_name.startswith(expected_share_name)
                    or expected_share_name.startswith(share_name)
                    or compact_prefix
                    or same_board_rank
                ):
                    raise RpaError(
                        f"复制口令昵称不一致：榜单={event['sellerName']}，复制内容={share_name}"
                    )
                event["sellerName"] = share_name
            event["sellerId"] = ""
            event["sellerIdStatus"] = "queued"
            event["status"] = "success"
            if not event["mainBusiness"]:
                event["status"] = "needs_review"
                event["failureReason"] = "主营内容缺失"
            key = canonical_key(event)
            if key in self.queue.successful_unique_keys():
                event["status"] = "duplicate"
                event["failureReason"] = "卖家已在同行矩阵中，保留本榜单来源"
            event["timings"]["totalMs"] = round((time.monotonic() - overall_started) * 1000, 1)
            event["durationSeconds"] = round(event["timings"]["totalMs"] / 1000, 2)
            event["contextEvidence"] = {
                "category": self.current_category,
                "city": self.current_city,
                "board": board,
                "rank": rank,
            }
            self.queue.mark_rank(self.current_task_id, rank, event["status"])
            self.queue.append(event)
            self.log(f"完成 {board} TOP{rank}: {event['sellerName']} | {event['status']} | {url}")
            return_started = time.monotonic()
            self.back_to_board()
            timings["returnMs"] = round((time.monotonic() - return_started) * 1000, 1)
            timings["totalMs"] = round((time.monotonic() - overall_started) * 1000, 1)
            event["durationSeconds"] = round(timings["totalMs"] / 1000, 2)
            self.queue.update_event_timing(
                event_id,
                {"returnMs": timings["returnMs"], "totalMs": timings["totalMs"]},
            )
            return event["status"] in {"success", "needs_review", "duplicate"}
        except SafetyStop as exc:
            event["status"] = "blocked"
            event["failureReason"] = str(exc)
            event["timings"]["totalMs"] = round((time.monotonic() - overall_started) * 1000, 1)
            event["durationSeconds"] = round(event["timings"]["totalMs"] / 1000, 2)
            self.queue.mark_rank(self.current_task_id, rank, "blocked")
            try:
                self.queue.append(event)
            except Exception:
                pass
            raise
        except Exception as exc:
            event["failureReason"] = str(exc)
            event["timings"]["totalMs"] = round((time.monotonic() - overall_started) * 1000, 1)
            event["durationSeconds"] = round(event["timings"]["totalMs"] / 1000, 2)
            self.queue.mark_rank(self.current_task_id, rank, "failed")
            try:
                self.queue.append(event)
            except Exception:
                pass
            self.log(f"失败 {board} TOP{rank}: {exc}")
            try:
                self.back_to_board()
            except Exception:
                pass
            return False

    def advance_one_rank(self) -> None:
        # uiautomator2 coordinates are density-scaled on this Android device;
        # use physical-pixel ADB input here so one gesture advances roughly
        # one seller card instead of jumping several ranks.
        self.device.shell(["input", "swipe", "540", "1900", "540", "1450", "500"])
        time.sleep(0.65)

    def rank_statuses(self, task_id: str) -> Dict[int, str]:
        """Return the latest recorded status for each source slot."""

        statuses: Dict[int, str] = {}
        for event in self.queue.events:
            if event.get("taskId") != task_id or event.get("rank") is None:
                continue
            statuses[int(event["rank"])] = str(event.get("status", ""))
        return statuses

    def prepare_context(self, context: dict) -> None:
        self.current_category = context.get("category", DEFAULT_CATEGORY)
        self.current_city = context.get("city", DEFAULT_CITY)
        self.current_board = ""
        self.current_task_id = context["taskId"]
        self.current_rank_limit = int(context.get("rankEnd", self.args.board_limit))
        self.context_identity_verified = False
        if self.current_rank_limit > 100:
            raise SafetyStop(f"任务 {self.current_task_id} 的排名上限超过 TOP100；已暂停")

    def run_context(self, context: dict, start_rank: int = 1) -> None:
        """Run one category × city × board context and stop exactly at TOP100."""

        self.prepare_context(context)
        board = context["board"]
        rank_limit = int(context.get("rankEnd", self.args.board_limit))
        pilot_limit = int(getattr(self.args, "pilot_rank_limit", 0) or 0)
        effective_limit = min(rank_limit, pilot_limit) if pilot_limit else rank_limit
        if start_rank > rank_limit:
            self.queue.mark_context(context["taskId"], "completed", rank_limit + 1)
            return
        try:
            self.select_board(board)
        except SafetyStop as exc:
            self.record_blocked_event(board, start_rank, str(exc))
            raise
        if start_rank > 1:
            self.log(f"恢复任务 {self.current_category}/{self.current_city}/{board}：定位 TOP{start_rank}")
            self.ensure_rank_visible(start_rank)

        statuses = self.rank_statuses(context["taskId"])
        rank = start_rank
        while rank <= effective_limit:
            prior_status = statuses.get(rank, "")
            completed_status = prior_status in {"success", "duplicate", "needs_review"}
            retry_failed = bool(getattr(self.args, "retry_failed", False))
            # A hard safety block (identity drift, login, CAPTCHA, rate limit,
            # or device loss) must be retried on resume; silently skipping it
            # would turn an interruption into a missing source slot.
            should_skip = completed_status or (
                prior_status == "failed" and not retry_failed
            )
            if should_skip:
                rank += 1
                if rank <= rank_limit:
                    self.advance_one_rank()
                continue

            timing_context = {"started": time.monotonic(), "timings": {}}
            try:
                context_started = time.monotonic()
                full_context_check = (
                    not self.context_identity_verified
                    or rank == start_rank
                    or rank % 10 == 1
                )
                if full_context_check:
                    context_ok = self.context_selected(board)
                else:
                    context_ok = self.context_fast_present(board)
                if not context_ok:
                    self.log(
                        f"检测到页面身份漂移：期望 {self.current_category}/{self.current_city}/{board}；"
                        f"重新进入并定位 TOP{rank}"
                    )
                    self.ensure_category_context()
                    self.select_board(board)
                    self.ensure_rank_visible(rank)
                self.context_identity_verified = True
                timing_context["timings"]["contextCheckMs"] = round((time.monotonic() - context_started) * 1000, 1)

                rank_started = time.monotonic()
                self.visible_records()
                self.ensure_rank_visible(rank)
                expected = self.record_for_rank(rank)
                timing_context["timings"]["rankLocateMs"] = round((time.monotonic() - rank_started) * 1000, 1)
            except SafetyStop as exc:
                self.record_blocked_event(board, rank, str(exc))
                raise
            self.queue.set_checkpoint(
                board, rank, task_id=context["taskId"], category=self.current_category, city=self.current_city
            )
            captured_ok = self.capture_one(board, rank, expected, timing_context)
            statuses[rank] = "success" if captured_ok else "failed"
            latest = next(
                (
                    event.get("status", "")
                    for event in reversed(self.queue.events)
                    if event.get("taskId") == context["taskId"] and event.get("rank") == rank
                ),
                "failed",
            )
            statuses[rank] = str(latest)
            if not captured_ok:
                self.log(f"{self.current_category}/{self.current_city}/{board} TOP{rank} 已进入失败队列，继续下一名")

            rank += 1
            self.queue.set_checkpoint(
                board, rank, task_id=context["taskId"], category=self.current_category, city=self.current_city
            )
            if rank > effective_limit:
                if effective_limit < rank_limit:
                    self.queue.set_checkpoint(
                        board, rank, "pilot_paused", task_id=context["taskId"],
                        category=self.current_category, city=self.current_city,
                    )
                    return
                self.log(f"{self.current_category}/{self.current_city}/{board} 已到 TOP{rank_limit}，停止继续滚动")
                self.queue.mark_context(context["taskId"], "completed", rank_limit + 1)
                break
            self.advance_one_rank()

    def run(self) -> None:
        self.queue.write_summary()
        contexts = self.queue.manifest.get("contexts", [])
        if not contexts:
            raise SafetyStop("manifest 没有任何类目/城市/榜单任务；已暂停")
        checkpoint = self.queue.run.get("checkpoint", {})
        checkpoint_task = checkpoint.get("taskId", "")
        checkpoint_rank = int(checkpoint.get("nextRank", 1))
        start_index = 0
        if checkpoint_task:
            for index, context in enumerate(contexts):
                if context.get("taskId") == checkpoint_task:
                    start_index = index
                    break

        self.prepare_context(contexts[start_index])
        self.launch_board()
        target_reached = False
        pilot_mode = bool(getattr(self.args, "pilot_rank_limit", 0))
        for index in range(start_index, len(contexts)):
            context = contexts[index]
            if context.get("status") == "completed" and context.get("taskId") != checkpoint_task:
                continue
            start_rank = checkpoint_rank if context.get("taskId") == checkpoint_task else 1
            # Set the checkpoint before entering the next context. If board
            # loading or first-page stabilization blocks here, resume must
            # reopen this exact category/city/board rather than the previous
            # completed context.
            self.queue.set_checkpoint(
                context["board"], start_rank, "running", task_id=context["taskId"],
                category=context.get("category", DEFAULT_CATEGORY), city=context.get("city", DEFAULT_CITY),
            )
            self.run_context(context, start_rank=start_rank)
            checkpoint_rank = 1
            checkpoint_task = ""
            if pilot_mode:
                continue
            if self.args.target and self.queue.unique_count() >= self.args.target:
                target_reached = True
                self.queue.set_checkpoint(
                    context["board"], int(context.get("rankEnd", self.args.board_limit)) + 1,
                    "completed_target", task_id=context["taskId"], category=context.get("category", DEFAULT_CATEGORY),
                    city=context.get("city", DEFAULT_CITY),
                )
                break

        if pilot_mode:
            first = contexts[0]
            pilot_rank = int(getattr(self.args, "pilot_rank_limit", 1)) + 1
            self.queue.set_checkpoint(
                first["board"], pilot_rank, "pilot_paused", task_id=first["taskId"],
                category=first.get("category", DEFAULT_CATEGORY), city=first.get("city", DEFAULT_CITY),
            )
        elif not target_reached:
            last = contexts[-1]
            self.queue.set_checkpoint(
                last["board"], int(last.get("rankEnd", self.args.board_limit)) + 1, "completed",
                task_id=last["taskId"], category=last.get("category", DEFAULT_CATEGORY), city=last.get("city", DEFAULT_CITY),
            )
        self.queue.write_summary()
        self.log(f"完成任务清单：{len(contexts)} 个上下文，{self.queue.unique_count()} 个不重复卖家主页")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="闲鱼榜单卖家主页真机采集器")
    parser.add_argument("--serial", default=os.environ.get("ANDROID_SERIAL", DEFAULT_SERIAL))
    parser.add_argument("--adb-port", type=int, default=int(os.environ.get("ANDROID_ADB_SERVER_PORT", "5037")))
    parser.add_argument("--u2-port", type=int, default=9008)
    parser.add_argument("--board-url", default=DEFAULT_BOARD_URL)
    parser.add_argument("--category", default=DEFAULT_CATEGORY)
    parser.add_argument("--city", default=DEFAULT_CITY)
    parser.add_argument("--device-id", default="", help="任务清单中的逻辑设备编号")
    parser.add_argument("--shard-index", type=int, default=0, help="多设备分片编号，从 0 开始")
    parser.add_argument("--shard-count", type=int, default=1, help="多设备分片总数")
    parser.add_argument("--out", default="output/rank-rpa")
    parser.add_argument("--run-dir", default="")
    parser.add_argument("--manifest", default="", help="已有每日 manifest.json")
    parser.add_argument("--target", type=int, default=0, help="单机试跑的唯一卖家目标；0 表示跑完整 manifest")
    parser.add_argument("--pilot-rank-limit", type=int, default=0, help="仅用于同一400条运行的分阶段验收，例如5表示每榜先跑TOP1–TOP5")
    parser.add_argument("--board-limit", type=int, default=100)
    parser.add_argument("--boards", default=",".join(DEFAULT_BOARDS), help="逗号分隔，默认四榜")
    parser.add_argument("--retry-failed", action="store_true", help="重试本运行已记录的失败排名")
    parser.add_argument(
        "--rank-label-backfill",
        action="store_true",
        help="仅用于补全电脑端打码 ID；昵称 OCR 不一致时使用明确 TOP 标识，主页榜单/名次复核仍强制执行",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    args.boards = tuple(x.strip() for x in args.boards.split(",") if x.strip())
    if not args.boards:
        print("至少需要一个榜单", file=sys.stderr)
        return 2
    invalid_boards = [board for board in args.boards if board not in DEFAULT_BOARDS]
    if invalid_boards:
        print(f"不支持的榜单：{invalid_boards}", file=sys.stderr)
        return 2
    if args.board_limit < 1 or args.board_limit > 100:
        print("--board-limit 必须在 1 到 100 之间", file=sys.stderr)
        return 2
    if args.pilot_rank_limit < 0 or args.pilot_rank_limit > 99:
        print("--pilot-rank-limit 必须在 0 到 99 之间", file=sys.stderr)
        return 2
    if args.shard_count < 1 or args.shard_index < 0 or args.shard_index >= args.shard_count:
        print("分片参数无效：需要 0 <= shard-index < shard-count", file=sys.stderr)
        return 2
    base = Path(args.out)
    root = Path(args.run_dir) if args.run_dir else base / ("run-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
    try:
        queue = LocalQueue(root, args)
        RankRpa(args, queue).run()
        return 0
    except SafetyStop as exc:
        try:
            queue.set_checkpoint(queue.run.get("checkpoint", {}).get("board", args.boards[0]), queue.run.get("checkpoint", {}).get("nextRank", 1), "paused")
            queue.write_summary()
        except Exception:
            pass
        print(f"PAUSED: {exc}", file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        try:
            queue.set_checkpoint(queue.run.get("checkpoint", {}).get("board", args.boards[0]), queue.run.get("checkpoint", {}).get("nextRank", 1), "paused_by_user")
            queue.write_summary()
        except Exception:
            pass
        print("PAUSED: 用户中断，已保存断点", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
