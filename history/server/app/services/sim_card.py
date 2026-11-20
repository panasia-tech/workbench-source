"""员工手机卡信息（staff_sim_card）的增删改查，供员工自助(auth)与后台(staff)复用。

每张卡片含手机号 / ICCID / 空卡序列号，三者均可空但整条不可全空。
所有写操作都带 staff_id 归属校验，防止越权改到别人的卡片。
"""
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import StaffSimCard
from app.services.profile_info import normalize_blank_serial, normalize_iccid, normalize_phone


def _clean_fields(data: dict) -> dict:
    """把传入的 phone/iccid/blank_serial 归一化（未传的字段不出现在返回里）。"""
    cleaned: dict = {}
    if "phone" in data:
        cleaned["phone"] = normalize_phone(data["phone"])
    if "iccid" in data:
        cleaned["iccid"] = normalize_iccid(data["iccid"])
    if "blank_serial" in data:
        cleaned["blank_serial"] = normalize_blank_serial(data["blank_serial"])
    return cleaned


def _ensure_not_all_empty(card: StaffSimCard) -> None:
    if not (card.phone or card.iccid or card.blank_serial):
        raise HTTPException(status_code=400, detail="手机号 / ICCID / 空卡序列号至少填写一项")


def list_cards(db: Session, staff_id: str) -> list[StaffSimCard]:
    return (
        db.query(StaffSimCard)
        .filter(StaffSimCard.staff_id == staff_id)
        .order_by(StaffSimCard.created_at.asc())
        .all()
    )


def create_card(db: Session, staff_id: str, data: dict) -> StaffSimCard:
    fields = _clean_fields(data)
    card = StaffSimCard(staff_id=staff_id, **fields)
    _ensure_not_all_empty(card)
    db.add(card)
    db.commit()
    db.refresh(card)
    return card


def _get_owned(db: Session, staff_id: str, card_id: str) -> StaffSimCard:
    card = db.get(StaffSimCard, card_id)
    if not card or card.staff_id != staff_id:
        raise HTTPException(status_code=404, detail="卡片不存在")
    return card


def update_card(db: Session, staff_id: str, card_id: str, data: dict) -> StaffSimCard:
    card = _get_owned(db, staff_id, card_id)
    for field_name, value in _clean_fields(data).items():
        setattr(card, field_name, value)
    _ensure_not_all_empty(card)
    db.commit()
    db.refresh(card)
    return card


def delete_card(db: Session, staff_id: str, card_id: str) -> None:
    card = _get_owned(db, staff_id, card_id)
    db.delete(card)
    db.commit()
