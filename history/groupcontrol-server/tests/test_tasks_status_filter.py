"""GET /api/gc/tasks 的 status 逗号多值过滤(IN)。

管理端/小程序「当前任务(进行中+待开始)」「历史任务(成功/失败/超时/取消)」
两分类需要一次按多个状态过滤;此前 status 仅支持单值。
直接调 endpoint 函数(仓库风格,不经 TestClient/httpx)。
"""

from app import api
from app.models import Task, TaskStatus


def _mk(db, status, task_type="chat_scan"):
    t = Task(task_type=task_type, status=status, spec={})
    db.add(t)
    return t


def test_list_tasks_status_single_unchanged(db_session):
    _mk(db_session, TaskStatus.RUNNING)
    _mk(db_session, TaskStatus.SUCCESS)
    db_session.commit()

    out = api.list_tasks(device_id=None, job_id=None, exclude_type=None, status=TaskStatus.SUCCESS, page=1, page_size=50, with_total=True, db=db_session)
    assert out["total"] == 1
    assert out["items"][0].status == TaskStatus.SUCCESS


def test_list_tasks_status_multi(db_session):
    _mk(db_session, TaskStatus.RUNNING)
    _mk(db_session, TaskStatus.PENDING)
    _mk(db_session, TaskStatus.SUCCESS)
    _mk(db_session, TaskStatus.FAILED)
    _mk(db_session, TaskStatus.CANCELLED)
    db_session.commit()

    # 当前任务两状态
    out = api.list_tasks(device_id=None, job_id=None, exclude_type=None, status="RUNNING,PENDING", page=1, page_size=50, with_total=True, db=db_session)
    assert out["total"] == 2
    assert {t.status for t in out["items"]} == {TaskStatus.RUNNING, TaskStatus.PENDING}

    # 历史任务四状态(含未出现的 TIMEOUT,空格容错)
    out = api.list_tasks(device_id=None, job_id=None, exclude_type=None, status="SUCCESS, FAILED,TIMEOUT,CANCELLED", page=1, page_size=50, with_total=True, db=db_session)
    assert out["total"] == 3
    assert {t.status for t in out["items"]} == {
        TaskStatus.SUCCESS, TaskStatus.FAILED, TaskStatus.CANCELLED,
    }


def test_list_tasks_status_multi_without_total(db_session):
    _mk(db_session, TaskStatus.RUNNING)
    _mk(db_session, TaskStatus.SUCCESS)
    db_session.commit()

    # with_total=false 旧返回形态(list)同样支持多值
    items = api.list_tasks(device_id=None, job_id=None, exclude_type=None, status="RUNNING,SUCCESS", page=1, page_size=50, db=db_session)
    assert len(items) == 2


def test_list_tasks_exclude_type(db_session):
    """exclude_type 逗号多值 NOT IN:chat_scan 等常驻任务可从看板查询中排除。"""
    _mk(db_session, TaskStatus.RUNNING, task_type="chat_scan")
    _mk(db_session, TaskStatus.RUNNING, task_type="chat_scan")
    _mk(db_session, TaskStatus.RUNNING, task_type="goods_publish")
    _mk(db_session, TaskStatus.RUNNING, task_type="restart")
    db_session.commit()

    out = api.list_tasks(device_id=None, job_id=None, exclude_type="chat_scan", status=None,
                         page=1, page_size=50, with_total=True, db=db_session)
    assert out["total"] == 2
    assert {t.task_type for t in out["items"]} == {"goods_publish", "restart"}

    # 多值排除 + status 过滤可叠加
    out = api.list_tasks(device_id=None, job_id=None, exclude_type="chat_scan, restart", status="RUNNING",
                         page=1, page_size=50, with_total=True, db=db_session)
    assert out["total"] == 1
    assert out["items"][0].task_type == "goods_publish"

    # 不排除时 chat_scan 照常返回(兼容旧调用方)
    out = api.list_tasks(device_id=None, job_id=None, exclude_type=None, status=None,
                         page=1, page_size=50, with_total=True, db=db_session)
    assert out["total"] == 4
