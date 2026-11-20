from sqlalchemy.orm import Session

from app.models import Staff


def map_staff_names(db: Session, staff_ids: set[str | None]) -> dict[str, str]:
    ids = {i for i in staff_ids if i}
    if not ids:
        return {}
    rows = db.query(Staff.id, Staff.name).filter(Staff.id.in_(ids)).all()
    return {staff_id: name for staff_id, name in rows}
