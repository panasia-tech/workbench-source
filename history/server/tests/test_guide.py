"""新员工教程：链接凭证、小测服务端判分、成绩汇总。"""
import time

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import GuideQuizResult, Staff
from app.routers import guide as G


class _Req:
    def __init__(self, headers=None):
        self.headers = headers or {}


@pytest.fixture()
def db(db_session):
    db_session.add(Staff(id="s1", staff_no="E001", username="E001", name="新人", role="PURCHASER",
                         status=StaffStatus.PENDING, password_hash="x"))
    db_session.commit()
    GuideQuizResult.__table__.create(db_session.get_bind(), checkfirst=True)
    return db_session


def test_token_roundtrip_and_tamper(db):
    t = G.make_token("s1")
    assert G.me(_Req(), t, db)["name"] == "新人"  # 待分配也能用
    with pytest.raises(HTTPException):
        G.me(_Req(), t[:-2] + "xx", db)
    with pytest.raises(HTTPException):
        G.me(_Req(), G.make_token("s1", now=time.time() - 31 * 86400), db)
    assert G.guide_link("s1").startswith("http://127.0.0.1:8000")


def test_quiz_is_graded_on_server_and_listed(db):
    q = G.quiz()
    assert all("answer" not in x for x in q["questions"])
    answers = {x["id"]: "b" for x in q["questions"]}
    answers["q5"] = "a"
    res = G.submit_quiz(G.QuizIn(t=G.make_token("s1"), answers=answers), _Req(), db)
    assert (res["score"], res["total"], res["passed"]) == (4, 5, True)
    db.add(Staff(id="boss", staff_no="E002", username="boss", name="老板", role=StaffRole.ADMIN,
                 status=StaffStatus.ACTIVE, password_hash="x"))
    db.commit()
    items = G.results(db, None)["items"]
    assert items[0]["name"] == "新人" and items[0]["score"] == 4 and items[0]["attempts"] == 1
