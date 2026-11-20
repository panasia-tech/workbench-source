import asyncio
import base64
import re

import httpx

from app.config import settings
from app.services.oss_media import sign_oss_url

SKU_CODE_PATTERN = re.compile(r"M\d{8}-\d{3}")
PHONE_PATTERN = re.compile(r"1\d{10}")
ORDER_NO_PATTERN = re.compile(r"[A-Za-z0-9]{10,}")
TRACKING_NO_PATTERN = re.compile(r"[A-Z]{1,4}\d{8,20}", re.I)
# 快递公司名与单号之间的后缀。顺丰官方叫「顺丰速运」、德邦/百世还有「快运」，
# 漏一个就是整家快递的单号都抓不到，所以抽成常量——别再让两处各写各的清单。
COURIER_SUFFIX = r"(?:速运|速递|快运|快递|物流)"
COURIER_TRACKING_PATTERN = re.compile(
    r"(?:圆通|申通|韵达|顺丰|中通|百世|极兔|邮政|EMS|京东|德邦|菜鸟|"
    r"YTO|STO|YD|SF|ZTO|HTKY|JT|YZ|JD)" + COURIER_SUFFIX + r"?"
    r"([A-Z]{1,4}\d{8,20})",
    re.I,
)
DATETIME_PATTERN = re.compile(r"(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日\sT]+(\d{1,2}:\d{2}(?::\d{2})?)?)")
PRICE_PATTERN = re.compile(r"[¥￥]\s*(\d+(?:\.\d{1,2})?)")
AMOUNT_KEYWORDS = ("实付", "成交", "合计", "总价", "金额")


class OcrNotConfiguredError(Exception):
    pass


class OcrUpstreamError(Exception):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def ocr_configured() -> bool:
    return bool(settings.ocr_http_url)


def _clean_ocr_value(raw: str) -> str:
    text = raw.strip()
    text = re.sub(r"复制\s*$", "", text)
    return text.strip()


def _normalize_datetime(raw: str) -> str | None:
    text = _clean_ocr_value(raw)
    text = text.replace("年", "-").replace("月", "-").replace("日", " ").replace("/", "-")
    text = re.sub(r"(\d{4}-\d{2}-\d{2})(\d{2}:\d{2})", r"\1 \2", text)
    text = re.sub(r"\s+", " ", text)
    match = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})\s*(\d{1,2}:\d{2}(?::\d{2})?)?", text)
    if not match:
        return None
    y, m, d, t = match.groups()
    time_part = t or "00:00:00"
    if len(time_part) == 5:
        time_part = f"{time_part}:00"
    return f"{int(y):04d}-{int(m):02d}-{int(d):02d} {time_part}"


def _line_contains_keyword(line: str, keywords: tuple[str, ...]) -> bool:
    compact = line.replace(" ", "")
    return any(kw in line or kw in compact for kw in keywords)


def _extract_labeled_value(lines: list[str], keywords: tuple[str, ...]) -> str | None:
    for index, line in enumerate(lines):
        if not _line_contains_keyword(line, keywords):
            continue
        parts = re.split(r"[:：]", line, maxsplit=1)
        if len(parts) == 2 and parts[1].strip():
            return _clean_ocr_value(parts[1])
        order_match = ORDER_NO_PATTERN.search(line.replace(" ", ""))
        if order_match:
            return order_match.group(0)
        if index + 1 < len(lines):
            next_line = lines[index + 1].strip()
            if next_line and not _line_contains_keyword(next_line, keywords):
                cleaned = _clean_ocr_value(next_line)
                order_match = ORDER_NO_PATTERN.search(cleaned.replace(" ", ""))
                if order_match:
                    return order_match.group(0)
                if cleaned and not any(skip in cleaned for skip in ("复制", ">", "作为")):
                    return cleaned
    return None


def _extract_tracking_no(lines: list[str]) -> str | None:
    labeled = _extract_labeled_value(lines, ("物流单号", "快递单号", "运单号", "物流编号"))
    if labeled:
        return labeled

    for line in lines:
        cleaned = _clean_ocr_value(line).replace(" ", "")
        if not cleaned:
            continue
        courier_match = COURIER_TRACKING_PATTERN.search(cleaned)
        if courier_match:
            return courier_match.group(1)
        if TRACKING_NO_PATTERN.fullmatch(cleaned):
            return cleaned
        inline_match = re.search(COURIER_SUFFIX + r"([A-Z]{1,4}\d{8,20})", cleaned, re.I)
        if inline_match:
            return inline_match.group(1)
    return None


def _extract_product_name(lines: list[str]) -> str | None:
    skip_keywords = (
        "卖家", "订单", "物流", "复制", "收货", "支付宝", "快照", "争议", "发货",
        "付款", "下单", "联系", "确认", "再次", "免费", "能量", "蚂蚁", "真值",
        "更多", "颜色分类", "成交价", "担保", "已发货", "待确认", "鱼小铺", "交易",
    )
    candidates: list[str] = []
    for line in lines:
        if len(line) < 6:
            continue
        if "¥" in line or "￥" in line:
            if candidates:
                break
            continue
        if re.match(r"^\d{1,2}:\d{2}$", line):
            continue
        if re.match(r"^\dG\s*\d+$", line, re.I):
            continue
        if re.match(r"^\d+$", line):
            continue
        if any(kw in line for kw in skip_keywords):
            if candidates:
                break
            continue
        compact = line.replace(" ", "")
        if COURIER_TRACKING_PATTERN.search(compact) or TRACKING_NO_PATTERN.fullmatch(compact):
            if candidates:
                break
            continue
        if line.endswith("复制"):
            continue
        candidates.append(line)
        if len(candidates) >= 2:
            break
    if not candidates:
        return None
    return " ".join(candidates)


def parse_xianyu_text(text_blocks: list[str]) -> dict:
    full_text = "\n".join(text_blocks)
    result: dict = {
        "product_name": None,
        "unit_price": None,
        "seller_name": None,
        "external_order_no": None,
        "transaction_no": None,
        "tracking_no": None,
        "order_time": None,
        "paid_at": None,
    }
    lines = [ln.strip() for ln in full_text.splitlines() if ln.strip()]

    keyword_amount: float | None = None
    all_amounts: list[float] = []
    for index, line in enumerate(lines):
        context = f"{lines[index - 1]} {line}" if index > 0 else line
        for match in PRICE_PATTERN.finditer(line):
            amount = float(match.group(1))
            all_amounts.append(amount)
            if any(kw in context for kw in AMOUNT_KEYWORDS):
                keyword_amount = amount
    if keyword_amount is not None:
        result["unit_price"] = keyword_amount
    elif all_amounts:
        result["unit_price"] = max(all_amounts)

    result["seller_name"] = _extract_labeled_value(lines, ("卖家昵称", "卖家昵"))
    result["external_order_no"] = _extract_labeled_value(lines, ("订单号", "订单编号"))
    result["transaction_no"] = _extract_labeled_value(
        lines, ("支付宝交易号", "交易流水", "流水号", "交易号")
    )
    result["tracking_no"] = _extract_tracking_no(lines)

    order_time_raw = _extract_labeled_value(lines, ("下单时间", "创建时间", "订单时间"))
    paid_time_raw = _extract_labeled_value(lines, ("付款时间", "支付时间", "成交时间"))
    if order_time_raw:
        result["order_time"] = _normalize_datetime(order_time_raw)
    if paid_time_raw:
        result["paid_at"] = _normalize_datetime(paid_time_raw)

    if not result["order_time"] or not result["paid_at"]:
        datetimes: list[str] = []
        for line in lines:
            match = DATETIME_PATTERN.search(line)
            if match:
                normalized = _normalize_datetime(match.group(0))
                if normalized:
                    datetimes.append(normalized)
        if datetimes and not result["order_time"]:
            result["order_time"] = datetimes[0]
        if len(datetimes) > 1 and not result["paid_at"]:
            result["paid_at"] = datetimes[1]
        elif len(datetimes) == 1 and not result["paid_at"]:
            result["paid_at"] = datetimes[0]

    result["product_name"] = _extract_product_name(lines)
    return result


def parse_sale_text(text_blocks: list[str]) -> dict:
    full_text = "\n".join(text_blocks)
    result: dict = {
        "buyer_name": None,
        "buyer_phone": None,
        "amount": None,
        "external_order_no": None,
        "platform": None,
    }
    lines = [ln.strip() for ln in full_text.splitlines() if ln.strip()]

    for line in lines:
        if any(kw in line for kw in ("买家", "收货人", "昵称")):
            parts = re.split(r"[:：]", line, maxsplit=1)
            if len(parts) == 2 and parts[1].strip():
                result["buyer_name"] = parts[1].strip()
                break

    phone_match = PHONE_PATTERN.search(full_text.replace(" ", ""))
    if phone_match:
        result["buyer_phone"] = phone_match.group(0)

    keyword_amount: float | None = None
    all_amounts: list[float] = []
    for line in lines:
        for match in PRICE_PATTERN.finditer(line):
            amount = float(match.group(1))
            all_amounts.append(amount)
            if any(kw in line for kw in AMOUNT_KEYWORDS):
                keyword_amount = amount
    if keyword_amount is not None:
        result["amount"] = keyword_amount
    elif all_amounts:
        result["amount"] = max(all_amounts)

    for line in lines:
        if any(kw in line for kw in ("订单号", "单号", "交易号")):
            after_colon = line.split(":", 1)[-1].split("：", 1)[-1]
            order_match = ORDER_NO_PATTERN.search(after_colon.replace(" ", ""))
            if order_match:
                result["external_order_no"] = order_match.group(0)
                break

    if "转转" in full_text:
        result["platform"] = "转转"
    elif "闲鱼" in full_text or "goofish" in full_text.lower():
        result["platform"] = "闲鱼"

    return result


# 序列号常见写法：SN / S/N / Serial / 序列号 后跟一段字母数字
SERIAL_LABEL_PATTERN = re.compile(
    r"(?:S/?N|Serial(?:\s*No\.?)?|序列号|出厂编号)\s*[:：#]?\s*([A-Za-z0-9][A-Za-z0-9\-]{4,31})",
    re.I,
)


def parse_sku_label_text(text_blocks: list[str]) -> dict:
    full_text = "\n".join(text_blocks)
    normalized = full_text.replace(" ", "").replace("—", "-").replace("–", "-")
    codes = SKU_CODE_PATTERN.findall(normalized)
    unique_codes: list[str] = []
    for code in codes:
        if code not in unique_codes:
            unique_codes.append(code)
    # 序列号与货号分开取：优先标签后的值，且排除本司货号格式 M########-###
    serial = None
    for block in text_blocks:
        m = SERIAL_LABEL_PATTERN.search(block.replace(" ", ""))
        if not m:
            m = SERIAL_LABEL_PATTERN.search(block)
        if not m:
            continue
        candidate = m.group(1).strip()
        if SKU_CODE_PATTERN.fullmatch(candidate):
            continue
        serial = candidate
        break
    if not serial:
        labeled = _extract_labeled_value(text_blocks, ("序列号", "出厂编号", "S/N", "SN", "Serial"))
        if labeled and not SKU_CODE_PATTERN.fullmatch(labeled.replace(" ", "")):
            serial = labeled.replace(" ", "")
    return {
        "sku_codes": unique_codes,
        "primary_sku_code": unique_codes[0] if unique_codes else None,
        "serial_number": serial,
    }


def _parse_ocr_response(data) -> list[str]:
    """自建 OCR 微服务的响应 → 文字行列表。

    服务返回 `{"items":[{text,score,box,center}]}`（与群控 `app/flow/ocr.py` 同一契约）。
    这里只取 text：本文件下面那些解析器(付款凭证/闲鱼单/销售单/SKU标签/行情/成色)全是
    按「文字行」做正则和关键字匹配的，不需要坐标。
    行序沿用服务端给的检测顺序(PP-OCR 的 sorted_boxes：上→下、左→右)，
    `_extract_labeled_value` 那种「关键字在上一行、值在下一行」的启发式依赖它，别打乱。
    """
    items = data.get("items") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise OcrUpstreamError("OCR 返回格式异常")
    blocks: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if text:
            blocks.append(text)
    return blocks


async def _resolve_image_bytes(image_url: str | None, image_base64: str | None) -> bytes:
    """拿到图片原始字节。自建服务收的是二进制 body，不是 base64（省掉 33% 膨胀）。"""
    if image_base64:
        raw = image_base64.split(",", 1)[-1] if image_base64.startswith("data:") else image_base64
        try:
            return base64.b64decode(raw)
        except (ValueError, TypeError) as exc:
            raise ValueError("image_base64 不是合法的 base64") from exc
    if not image_url:
        raise ValueError("需要提供 image_url 或 image_base64")
    signed_url = sign_oss_url(image_url, expires=3600) or image_url
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(signed_url)
        resp.raise_for_status()
        return resp.content


async def _call_general_ocr(image_url: str | None = None, image_base64: str | None = None) -> list[str]:
    """把图片发给自建 OCR 微服务（127.0.0.1:8600，经 ssh -R 反挂到那台家用 Windows）。

    重试只给「连不上」这一种：那台机器的服务由 run.ps1 守护，重启/隧道重连有秒级断口。
    2 次 × 1s 就够（本机 GPU 单张约 100~400ms），再多就是让员工干等。
    鉴权/参数错(4xx)不重试——重试无意义。
    """
    if not ocr_configured():
        raise OcrNotConfiguredError("OCR 未配置，请设置 OCR_HTTP_URL")
    if not image_url and not image_base64:
        raise ValueError("需要提供 image_url 或 image_base64")

    img = await _resolve_image_bytes(image_url, image_base64)
    headers = {"Content-Type": "application/octet-stream"}
    if settings.ocr_http_token:
        headers["X-OCR-Token"] = settings.ocr_http_token

    last_err: Exception | None = None
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=settings.ocr_http_timeout) as client:
                resp = await client.post(settings.ocr_http_url, content=img, headers=headers)
            break
        except httpx.HTTPError as exc:
            last_err = exc
            if attempt == 0:
                await asyncio.sleep(1)
    else:
        raise OcrUpstreamError(
            f"OCR 服务连不上（{settings.ocr_http_url}）：{last_err}"
            "。检查那台 Windows 是否开机、ssh -R 隧道是否在"
        ) from last_err

    if resp.status_code == 401:
        raise OcrUpstreamError("OCR 服务鉴权失败：两侧 token 不一致（OCR_HTTP_TOKEN）", 401)
    if resp.status_code >= 400:
        raise OcrUpstreamError(
            f"OCR 服务返回 {resp.status_code}：{resp.text[:120]}", resp.status_code
        )
    return _parse_ocr_response(resp.json())


def parse_payment_text(text_blocks: list[str]) -> dict:
    full_text = "\n".join(text_blocks)
    result: dict = {"amount": None, "payment_type": None}
    lines = [ln.strip() for ln in full_text.splitlines() if ln.strip()]
    if "小荷包" in full_text or "支付宝" in full_text:
        result["payment_type"] = "小荷包"
    keyword_amount: float | None = None
    all_amounts: list[float] = []
    for line in lines:
        for match in PRICE_PATTERN.finditer(line):
            amount = float(match.group(1))
            all_amounts.append(amount)
            if any(kw in line for kw in AMOUNT_KEYWORDS + ("收款", "转入", "到账", "支付")):
                keyword_amount = amount
    if keyword_amount is not None:
        result["amount"] = keyword_amount
    elif all_amounts:
        result["amount"] = max(all_amounts)
    return result


async def ocr_payment(image_url: str | None = None, image_base64: str | None = None) -> dict:
    blocks = await _call_general_ocr(image_url, image_base64)
    parsed = parse_payment_text(blocks)
    return {"raw_text": blocks, "parsed": parsed}


async def ocr_xianyu(image_url: str | None = None, image_base64: str | None = None) -> dict:
    blocks = await _call_general_ocr(image_url, image_base64)
    parsed = parse_xianyu_text(blocks)
    result = {"raw_text": blocks, "parsed": parsed}
    print(
        f"[OCR xianyu] image_url={image_url!r}",
        f"parsed={parsed}",
        f"raw_text={blocks}",
        flush=True,
    )
    return result


MARKET_NUMBER_PATTERN = re.compile(r"([0-9][0-9,]*(?:\.[0-9]+)?)")


def parse_market_quote(text_blocks: list[str]) -> dict:
    """解析闲鱼「行情」页截图 OCR 文本，提取近7日成交均价(+较上周/在搜人数)。"""
    lines = [ln.strip() for ln in "\n".join(text_blocks).splitlines() if ln.strip()]
    price: float | None = None
    trend_delta: float | None = None
    search_heat: int | None = None

    # 成交均价：找到含「成交均价/成交价」的行，在该行及随后两行里取第一个 ¥数字
    for i, ln in enumerate(lines):
        if "成交均价" in ln or "成交价" in ln:
            for j in range(i, min(i + 3, len(lines))):
                m = PRICE_PATTERN.search(lines[j])
                if m:
                    price = float(m.group(1).replace(",", ""))
                    break
            if price is not None:
                break

    # 较上周涨跌（▼/跌/-/↓ 视为负）
    for ln in lines:
        if "较上周" in ln:
            m = MARKET_NUMBER_PATTERN.search(ln)
            if m:
                v = float(m.group(1).replace(",", ""))
                down = any(s in ln for s in ("▼", "跌", "-", "↓"))
                trend_delta = -v if down else v
            break

    # X 人在搜
    for ln in lines:
        if "人在搜" in ln or "在搜" in ln:
            m = MARKET_NUMBER_PATTERN.search(ln)
            if m:
                search_heat = int(float(m.group(1).replace(",", "")))
            break

    return {"price": price, "trend_delta": trend_delta, "search_heat": search_heat}


async def ocr_market(image_url: str | None = None, image_base64: str | None = None) -> dict:
    blocks = await _call_general_ocr(image_url, image_base64)
    parsed = parse_market_quote(blocks)
    print(f"[OCR market] parsed={parsed} raw_text={blocks}", flush=True)
    return {"raw_text": blocks, "parsed": parsed}


async def ocr_sale(image_url: str | None = None, image_base64: str | None = None) -> dict:
    blocks = await _call_general_ocr(image_url, image_base64)
    parsed = parse_sale_text(blocks)
    return {"raw_text": blocks, "parsed": parsed}


async def ocr_sku_label(image_url: str | None = None, image_base64: str | None = None) -> dict:
    blocks = await _call_general_ocr(image_url, image_base64)
    parsed = parse_sku_label_text(blocks)
    return {"raw_text": blocks, "parsed": parsed}


# 货况警示关键词：实拍图（含闲鱼挂单截图）OCR 命中即提示验货/议价重点核对。
# 注意顺序：「全新」是「几乎全新」的子串，先匹配更长的「几乎全新」才能精确标注。
NEW_CONDITION_KEYWORDS = ("几乎全新", "全新")


def detect_new_condition(text_blocks: list[str]) -> str | None:
    """命中「全新/几乎全新」返回命中的关键词，否则 None。"""
    flat = "".join(text_blocks).replace(" ", "")
    for kw in NEW_CONDITION_KEYWORDS:
        if kw in flat:
            return kw
    return None


async def scan_images_condition(image_urls: list[str]) -> str | None:
    """逐张 OCR 商品实拍图，命中「全新/几乎全新」即停并返回关键词；全部未命中返回 None。

    任一图 OCR 失败只跳过该图，不抛异常（货况警示是辅助提示，不应阻断采购/验货）。
    """
    for url in [u for u in (image_urls or []) if u][:9]:
        try:
            blocks = await _call_general_ocr(image_url=url)
        except (OcrNotConfiguredError, OcrUpstreamError, ValueError, httpx.HTTPError):
            continue
        hit = detect_new_condition(blocks)
        if hit:
            return hit
    return None
