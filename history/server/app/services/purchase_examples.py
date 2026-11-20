from app.services.oss import canonical_public_url, sign_download_url

PUBLIC_DIR = "public/purchase/examples"
SCREENSHOT_KEY = f"{PUBLIC_DIR}/order-screenshot.png"
PRODUCT_KEY = f"{PUBLIC_DIR}/product-photo.png"
EXAMPLE_URL_EXPIRES = 86400 * 7


def purchase_example_urls() -> dict[str, str]:
    """示例图 URL；对象位于 public/ 前缀，通过签名 URL 下发（bucket 若已配公共读策略也可直连 public_url）。"""
    return {
        "screenshot_url": sign_download_url(SCREENSHOT_KEY, expires=EXAMPLE_URL_EXPIRES),
        "product_url": sign_download_url(PRODUCT_KEY, expires=EXAMPLE_URL_EXPIRES),
    }


def purchase_example_public_urls() -> dict[str, str]:
    return {
        "screenshot_url": canonical_public_url(SCREENSHOT_KEY),
        "product_url": canonical_public_url(PRODUCT_KEY),
    }
