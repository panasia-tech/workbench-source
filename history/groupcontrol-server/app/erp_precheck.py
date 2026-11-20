"""发布前回 ERP 再核一次(E05-10)。

ERP 只在建发布作业时查过一次(在库、在架、登录昵称、上架审批),作业在这里排队、真机执行
可能隔很久——作息窗口外下的单要等到第二天早上,期间货卖了、被锁了、审批作废了也照发。
所以任务真正交给执行端之前(runner.run_task 跑流程之前),问一次 ERP 本机内部接口
POST /api/internal/publish-check(server/app/routers/internal_publish_check.py)。

- ERP 明确说不能发 → 任务 CANCELLED(没跑,和定时清理「超时未执行」同一种),原因进 task.error,
  failed_step=erp_precheck;照常走 jobs.on_task_result(作业聚合、焕新善后)。ERP 回写
  (sync_gc_publish_status)看到 CANCELLED 就把店铺置 FAILED、原因进 last_error,不会卡在「上架中」。
- ERP 连不上/超时/报错/回的东西看不懂 → 照常发,只记日志。这道是补漏的,它自己出故障不能把发布卡住。

只管 ERP 来的:source=ERP 的发布,和 ERP 开的链接焕新(job_type=refresh_listing 且作业 source=ERP;
任务本身记的是 REFRESH_TASK_SOURCE)里的删旧链接和重发两段。焕新带 refresh=true,ERP 那边
不看「已在架」、不等上架审批(用户 11-10 定),只看货还在不在库。焕新撤回(REFRESH_UNDO_SOURCE)
绝不拦:那是货已经卖了、要马上把新链接删掉。
"""

import json
import logging
import urllib.request
from datetime import datetime

from app.config import settings
from app.database import SessionLocal
from app.models import REFRESH_TASK_SOURCE, Device, Job, JobType, Task, TaskStatus

logger = logging.getLogger("gc.erp_precheck")

FAILED_STEP = "erp_precheck"
_REFRESH_TASK_TYPES = ("goods_publish", "goods_delete")


def request_for(db, task: Task) -> dict | None:
    """这个任务要不要回 ERP 再核;要就返回发给 ERP 的参数,不要返回 None。"""
    if not settings.erp_publish_precheck_enabled or not task.ref_id or not task.account_id:
        return None
    if task.source == "ERP" and task.task_type == "goods_publish":
        refresh = False
    elif task.source == REFRESH_TASK_SOURCE and task.task_type in _REFRESH_TASK_TYPES and task.job_id:
        job = db.get(Job, task.job_id)
        if not job or job.job_type != JobType.REFRESH_LISTING or job.source != "ERP":
            return None
        refresh = True
    else:
        return None
    return {"sku_code": task.ref_id, "account_id": task.account_id, "job_id": task.job_id,
            "refresh": refresh}


def _post(payload: dict) -> dict:
    """真实请求。抽出来便于单测替换(项目惯例用 stdlib urllib,不引 httpx)。"""
    url = settings.erp_internal_base.rstrip("/") + "/api/internal/publish-check"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=settings.erp_publish_precheck_timeout_sec) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def ask(payload: dict) -> str | None:
    """问 ERP。返回不能发的原因;能发返回 None。

    问不到时默认照常发（fail-open，避免 ERP 宕机卡死全网）；
    打开 erp_publish_precheck_fail_closed 后改为拦住（DEV14 收紧）。
    """
    try:
        body = _post(payload)
    except Exception as exc:  # noqa: BLE001
        if settings.erp_publish_precheck_fail_closed and not payload.get("refresh"):
            logger.warning("发布前再核问不到 ERP,fail-closed 拦住 sku=%s account=%s job=%s:%s",
                           payload.get("sku_code"), payload.get("account_id"), payload.get("job_id"), exc)
            return "ERP 发布前再核连不上，暂不发"
        logger.warning("发布前再核问不到 ERP,照常发 sku=%s account=%s job=%s:%s",
                       payload.get("sku_code"), payload.get("account_id"), payload.get("job_id"), exc)
        return None
    if not isinstance(body, dict) or body.get("allow") is not False:
        if not isinstance(body, dict) or body.get("allow") is not True:
            if settings.erp_publish_precheck_fail_closed and not payload.get("refresh"):
                logger.warning("发布前再核 ERP 回的看不懂,fail-closed 拦住 sku=%s:%r",
                               payload.get("sku_code"), body)
                return "ERP 发布前再核回包异常，暂不发"
            logger.warning("发布前再核 ERP 回的看不懂,照常发 sku=%s:%r", payload.get("sku_code"), body)
        return None
    return str(body.get("reason") or "").strip() or "ERP 说这一单不能发"


def stop_if_blocked(task_id: str, payload: dict) -> bool:
    """问 ERP;不能发就把任务取消(释放设备、聚合作业)并返回 True,能发返回 False。

    调用时不持 DB 会话(HTTP 最多等 erp_publish_precheck_timeout_sec,别让会话跟着挂着)。
    """
    why = ask(payload)
    if not why:
        return False
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        if not task or task.status != TaskStatus.RUNNING:
            return True   # 等的这几秒被 watchdog 收了:反正不跑了
        task.status = TaskStatus.CANCELLED
        task.error = f"发布前回 ERP 再核不通过:{why}"
        task.failed_step = FAILED_STEP
        task.finished_at = datetime.utcnow()
        device = db.get(Device, task.device_id) if task.device_id else None
        if device and device.busy_task_id == task.id:
            device.busy_task_id = None
        db.commit()
    logger.info("发布前再核不通过,任务取消 task=%s sku=%s account=%s%s:%s", task_id,
                payload.get("sku_code"), payload.get("account_id"),
                "(焕新)" if payload.get("refresh") else "", why)
    from app import jobs   # 延迟导入避免环
    try:
        jobs.on_task_result(task_id, False)
    except Exception:
        logger.exception("再核取消后记账失败 task=%s", task_id)
    return True
