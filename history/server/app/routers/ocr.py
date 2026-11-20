import httpx
from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_current_user
from app.models import Staff
from app.schemas.common import OcrRequest
from app.services.ocr import (
    OcrNotConfiguredError,
    OcrUpstreamError,
    ocr_payment,
    ocr_sale,
    ocr_sku_label,
    ocr_xianyu,
)

router = APIRouter(prefix="/api/ocr", tags=["ocr"])


async def _handle_ocr(coro):
    try:
        return await coro
    except OcrNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (401, 403):
            raise HTTPException(status_code=502, detail="OCR 鉴权失败，请检查 AppKey/Secret") from exc
        raise HTTPException(status_code=502, detail="OCR 服务暂不可用") from exc
    except OcrUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="OCR 服务暂不可用") from exc


@router.post("/payment", summary="识别付款凭证截图")
async def ocr_payment_route(body: OcrRequest, _: Staff = Depends(get_current_user)):
    return await _handle_ocr(ocr_payment(body.image_url, body.image_base64))


@router.post("/xianyu", summary="识别闲鱼订单截图")
async def ocr_xianyu_route(body: OcrRequest, _: Staff = Depends(get_current_user)):
    return await _handle_ocr(ocr_xianyu(body.image_url, body.image_base64))


@router.post("/sale", summary="识别销售订单截图")
async def ocr_sale_route(body: OcrRequest, _: Staff = Depends(get_current_user)):
    return await _handle_ocr(ocr_sale(body.image_url, body.image_base64))


@router.post("/sku-label", summary="识别 SKU 标签")
async def ocr_sku_label_route(body: OcrRequest, _: Staff = Depends(get_current_user)):
    return await _handle_ocr(ocr_sku_label(body.image_url, body.image_base64))
