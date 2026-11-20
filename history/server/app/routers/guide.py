"""新员工教程（panasia.fun/guide/）：认人、复验小测判分、管理员看成绩。

新员工入职时账号还是「待分配」，登不进 ERP，所以钉钉推送的教程链接自带一个签名凭证（?t=…，30 天有效，
只能用来交小测、看自己的名字）；已经能登录的员工直接带登录令牌也行（H5 与教程同域，令牌在本地存储里）。
题目和答案放在服务端，页面只拿题目，判分不靠前端。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from jose import JWTError
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import decode_token, require_roles
from app.enums import StaffRole
from app.models import GuideQuizResult, Staff

router = APIRouter(prefix="/api/guide", tags=["新员工教程"])

GUIDE_URL = "http://127.0.0.1:8000"
TOKEN_DAYS = 30
PASS_SCORE = 4

# 复验小测：都是匹配页上真会碰到的情况，答案对应 services/spu_match.py 的规则
QUESTIONS = [
    {
        "id": "q1",
        "text": "货的 69码 正好是目录里某个商品的编码，系统显示「69码命中，匹配可靠」。你该怎么做？",
        "options": {"a": "直接确认，不用看", "b": "核对候选的型号、配置和实物一致后确认", "c": "报告找不到"},
        "answer": "b",
    },
    {
        "id": "q2",
        "text": "「云鲸 J4」目录里有「标准版」和「Pro 版」两个，实物铭牌写着 Pro。怎么提交？",
        "options": {"a": "选编码小的那个", "b": "选 Pro 版，说明里写「铭牌 Pro 版」，并拍铭牌照片", "c": "两个都行，随便选"},
        "answer": "b",
    },
    {
        "id": "q3",
        "text": "货登记的是「华为 MatePad 11.5」，候选里只有相近型号「MatePad 11.5S」。怎么办？",
        "options": {"a": "差不多，选 11.5S", "b": "看实物：确实是 11.5S 就先去补正型号；不是就报告找不到，写清实物型号并拍铭牌", "c": "先不管"},
        "answer": "b",
    },
    {
        "id": "q4",
        "text": "你提交的匹配被退回了，退回原因写着「颜色看不清，补拍铭牌」，还附了一张标了红框的截图。下一步？",
        "options": {"a": "原样再提交一次", "b": "按原因和截图补拍铭牌，改好说明后重新提交", "c": "换一个候选提交"},
        "answer": "b",
    },
    {
        "id": "q5",
        "text": "两个候选看起来都对，你拿不准。应该？",
        "options": {"a": "挑一个先交", "b": "找仓库主管（管理员）核实，不硬选", "c": "报告找不到"},
        "answer": "b",
    },
]


def _sign(payload: str) -> str:
    mac = hmac.new(settings.jwt_secret.encode(), f"guide|{payload}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac[:18]).decode().rstrip("=")


def make_token(staff_id: str, now: float | None = None) -> str:
    exp = int((now or time.time()) + TOKEN_DAYS * 86400)
    payload = f"{staff_id}.{exp}"
    return f"{payload}.{_sign(payload)}"


def guide_link(staff_id: str) -> str:
    return f"{GUIDE_URL}?t={make_token(staff_id)}"


def _staff_from_token(t: str | None, db: Session) -> Staff | None:
    if not t:
        return None
    try:
        staff_id, exp, sig = t.split(".")
    except ValueError:
        return None
    if not hmac.compare_digest(sig, _sign(f"{staff_id}.{exp}")) or int(exp) < time.time():
        return None
    staff = db.get(Staff, staff_id)
    return staff if staff and not staff.deleted_at else None


def _who(request: Request, t: str | None, db: Session) -> Staff:
    staff = _staff_from_token(t, db)
    if staff is None:
        auth = request.headers.get("authorization") or ""
        if auth.lower().startswith("bearer "):
            try:
                staff = db.get(Staff, decode_token(auth[7:]).get("sub"))
            except JWTError:
                staff = None
            if staff is not None and staff.deleted_at:
                staff = None
    if staff is None:
        raise HTTPException(status_code=401, detail="链接过期或没登录：从钉钉的入职通知打开，或先登录 ERP")
    return staff


class QuizIn(BaseModel):
    t: str | None = None
    answers: dict[str, str] = Field(default_factory=dict)


@router.get("/me", summary="教程页认人：名字、账号、最近一次小测")
def me(request: Request, t: str | None = None, db: Session = Depends(get_db)):
    staff = _who(request, t, db)
    last = (
        db.query(GuideQuizResult).filter(GuideQuizResult.staff_id == staff.id)
        .order_by(GuideQuizResult.created_at.desc()).first()
    )
    return {
        "name": staff.name or staff.username,
        "username": staff.username,
        "status": staff.status,
        "last": {"score": last.score, "total": last.total, "at": last.created_at} if last else None,
    }


@router.get("/quiz", summary="小测题目（不带答案）")
def quiz():
    return {"questions": [{k: q[k] for k in ("id", "text", "options")} for q in QUESTIONS], "pass_score": PASS_SCORE}


@router.post("/quiz", summary="交小测：服务端判分并记下来")
def submit_quiz(body: QuizIn, request: Request, db: Session = Depends(get_db)):
    staff = _who(request, body.t, db)
    detail = []
    score = 0
    for q in QUESTIONS:
        picked = body.answers.get(q["id"])
        ok = picked == q["answer"]
        score += ok
        detail.append({"id": q["id"], "picked": picked, "right": ok, "answer": q["answer"]})
    db.add(GuideQuizResult(staff_id=staff.id, score=score, total=len(QUESTIONS), answers=body.answers))
    db.commit()
    return {"score": score, "total": len(QUESTIONS), "passed": score >= PASS_SCORE, "detail": detail}


@router.get("/results", summary="管理员看复验成绩（每人最近一次 + 次数）")
def results(db: Session = Depends(get_db), _: Staff = Depends(require_roles(StaffRole.ADMIN))):
    rows = db.query(GuideQuizResult).order_by(GuideQuizResult.created_at.desc()).all()
    names = {s.id: (s.name or s.username, s.staff_no) for s in db.query(Staff).filter(Staff.id.in_({r.staff_id for r in rows})).all()}
    out: dict[str, dict] = {}
    for r in rows:
        item = out.setdefault(r.staff_id, {
            "staff_id": r.staff_id,
            "name": names.get(r.staff_id, ("?", ""))[0],
            "staff_no": names.get(r.staff_id, ("?", ""))[1],
            "score": r.score, "total": r.total, "passed": r.score >= PASS_SCORE, "at": r.created_at, "attempts": 0,
        })
        item["attempts"] += 1
    return {"items": list(out.values())}
