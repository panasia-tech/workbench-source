from app import jobs
from app.models import Account, JobType, Task, TaskStatus


def test_create_polish_fans_out_per_account(db):
    a1 = Account(nick="a1")
    a2 = Account(nick="a2")
    db.add_all([a1, a2])
    db.flush()
    job = jobs.create_polish(db, [a1.id, a2.id])
    assert job.job_type == JobType.POLISH_ACCOUNT
    assert job.total == 2
    tasks = db.query(Task).filter(Task.job_id == job.id).all()
    assert {t.account_id for t in tasks} == {a1.id, a2.id}
    assert all(t.task_type == "goods_polish" for t in tasks)
    assert all(t.status == TaskStatus.PENDING for t in tasks)
