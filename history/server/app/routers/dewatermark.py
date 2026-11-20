"""去闲鱼图片右下角平台水印(销售工作台 V1 第 9 项 / E02)。做法和限制见 services/dewatermark.py。

前端:先 GET /api/dewatermark/status,available=false 就不显示按钮;
点「去水印」→ POST /api/dewatermark {url, spu_code?},单张约 3~8 秒,按钮要转圈。
- done:换成 result_url 显示,原图 source_url 不动;
- needs_review:去过了但检查没过(残留 / 补出色块 / 糊了),并排给人看,人点了才用;
- not_found:没认出闲鱼水印(老样式「闲鱼@xxx」一行字的也认不出),原图没动,要去就人工处理;
- failed:取图/补图出错,交给人工。
去完的图和原图算同一张,不能当「各号图片不同」用(same_image_as)。
"""
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import require_roles
from app.enums import StaffRole
from app.models import Staff
from app.services import dewatermark as dw
from app.services.oss import OssNotConfiguredError

router = APIRouter(prefix="/api/dewatermark", tags=["dewatermark"])

# 和上架审批清洗同一批人(11-10:任何员工都能清洗);设备账号不行
_ROLES = (
    StaffRole.PURCHASER, StaffRole.WAREHOUSE, StaffRole.NEGOTIATOR, StaffRole.BUSINESS,
    StaffRole.SALES, StaffRole.FINANCE, StaffRole.ADMIN,
)


class DewatermarkIn(BaseModel):
    url: str = Field(max_length=2048, description="要去水印的图(只收图床、图片爬虫上的地址)")
    spu_code: str | None = Field(None, max_length=64, description="型号编码;图不在 spu-ref/{型号}/ 下时用来定存放目录")


class RegionOut(BaseModel):
    kind: str = Field(description="logo=「闲鱼」小标;account_line=「闲鱼号:xxx」那一行")
    box: list[int] = Field(description="x, y, w, h(原图像素)")
    score: float


class DewatermarkOut(BaseModel):
    status: str = Field(description="done / needs_review / not_found / failed")
    status_label: str
    source_url: str
    result_url: str | None = Field(None, description="去过水印的图(另存的,原图不动)")
    record_url: str | None = Field(None, description="旁边那份记录:来源、区域、检查结果、谁点的")
    same_image_as: str = Field(description="和哪张算同一张图(就是原图)")
    regions: list[RegionOut]
    checks: dict
    reasons: list[str] = Field(description="needs_review / not_found / failed 的原因,给人看")
    width: int
    height: int
    elapsed_ms: int


@router.get("/status", summary="去水印能不能用(缺依赖或模型时前端别显示按钮)")
def status(_: Staff = Depends(require_roles(*_ROLES))):
    ok, reason = dw.available()
    return {"available": ok, "reason": reason}


@router.post("", response_model=DewatermarkOut, summary="去一张图右下角的闲鱼水印,另存一份")
def remove_watermark(body: DewatermarkIn, user: Staff = Depends(require_roles(*_ROLES))):
    ok, reason = dw.available()
    if not ok:
        raise HTTPException(status_code=503, detail=f"去水印暂不可用:{reason}")
    try:
        return dw.process_url(body.url.strip(), operator=user.username, spu_code=body.spu_code)
    except dw.SourceNotAllowed as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except dw.DewatermarkUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"去水印暂不可用:{exc}") from exc
    except OssNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail="图床没配置,存不了处理后的图") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"取图失败:{exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

