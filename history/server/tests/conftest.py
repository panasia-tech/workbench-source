"""ERP 测试夹具:内存 SQLite,只建被测表(避开无关模型里可能的 MySQL 专有类型)。

app/database.py 在导入时硬校验 DATABASE_URL 必须 mysql——所以**不改** database_url
(它的 engine 是惰性的,不连接),测试只用独立的 SQLite engine + 覆盖 get_db。
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import (
    AppSetting,
    AiRedrawJob,
    InspectionEvidence,
    ListingApproval,
    CrawlPrice,
    CrawlPriceRun,
    SkuAutoListing,
    CrawlProduct,
    EventLog,
    ImageDhash,
    SaleShop,
    SalesOutbound,
    Sku,
    SkuListingInfo,
    SkuShopListing,
    Staff,
    StockEvent,
    WarehouseSpu,
    WarehouseSpuSku,
    WorkbenchDevice,
    CrawlerLease,
    AdsEnvPurpose,
    MarketCrawlRun,
    CrawlSnapshotRequest,
    LoginThrottle,
    MiaodaBinding,
    AuthentikAccount,
    FrappeAccount,
    FrappeDepartmentMap,
    FrappeEmployee,
    FrappeRoleMap,
    OidcAuthCode,
    PlatformAccessMap,
    PlatformGroup,
    PlatformGroupMember,
    SpuImageSearch,
    WarehouseSpuImage,
    ImageMaterialMark,
    SkuSpuMatch,
    SkuSpuMatchLog,
    SaleOrder,
    LedgerAccessLog,
    LedgerCase,
    LedgerCaseSkip,
    LedgerCaseStep,
    LedgerTarget,
    LedgerTutorial,
    LedgerVault,
    LedgerVaultFactor,
    LedgerVaultSession,
    LedgerVaultStation,
    LedgerAlipay,
    LedgerAuthState,
    LedgerBillFetch,
    LedgerBillRow,
    LedgerCharge,
    LedgerDevice,
    LedgerEntity,
    LedgerGrant,
    LedgerKnows,
    DailyBill,
    PurchasePlatformOrder,
    PurchasePlatformEvent,
    LedgerLegalPerson,
    LedgerProxy,
    LedgerRecord,
    LedgerRecordEvent,
    LedgerShop,
    LedgerSim,
    ReturnOrder,
    StaffPractice,
    SalesCollab,
    SalesReport,
    SalesTask,
    PriceCleanTask,
    PriceSample,
    PriceVersion,
    VirtualBuyerFlag,
    VirtualCode,
    VirtualCodeBatch,
    VirtualEvidence,
    VirtualOrder,
    VirtualProduct,
    VirtualReveal,
)

_TEST_TABLES = [
    m.__table__
    for m in (
        Staff, Sku, SkuListingInfo, SkuShopListing, SaleShop, StockEvent, AiRedrawJob,
        WarehouseSpu, WarehouseSpuSku, CrawlProduct, CrawlPrice, CrawlPriceRun, SkuAutoListing,
        EventLog, ImageDhash, WorkbenchDevice, CrawlerLease, AdsEnvPurpose, MarketCrawlRun, CrawlSnapshotRequest,
        LoginThrottle, MiaodaBinding,
        AuthentikAccount, OidcAuthCode, PlatformGroup, PlatformGroupMember, FrappeRoleMap, FrappeAccount,
        PlatformAccessMap, FrappeDepartmentMap, FrappeEmployee, AppSetting,
        ListingApproval, InspectionEvidence, SpuImageSearch, WarehouseSpuImage, ImageMaterialMark, SkuSpuMatch, SkuSpuMatchLog,
        LedgerLegalPerson, LedgerEntity, LedgerAlipay, LedgerSim, LedgerProxy, LedgerDevice, LedgerShop, LedgerCharge,
        LedgerGrant, LedgerAccessLog, LedgerRecord, LedgerRecordEvent, LedgerKnows, DailyBill, PurchasePlatformOrder, PurchasePlatformEvent,
        LedgerTarget, LedgerTutorial, LedgerCase, LedgerCaseStep, LedgerCaseSkip, LedgerVault, LedgerVaultFactor, LedgerVaultSession, LedgerVaultStation,
        LedgerAuthState, LedgerBillFetch, LedgerBillRow, SaleOrder, SalesOutbound, ReturnOrder, StaffPractice, SalesCollab, SalesReport, SalesTask,
        PriceCleanTask, PriceSample, PriceVersion,
        VirtualProduct, VirtualEvidence, VirtualCodeBatch, VirtualCode, VirtualOrder, VirtualReveal, VirtualBuyerFlag,
    )
]


@pytest.fixture(autouse=True)
def _no_image_similarity(monkeypatch):
    """兜底：上架图判重默认关着，免得测试按 .env 里的 OSS 真去取图。要测的自己打开（tests/test_image_similarity.py）。"""
    from app.services import image_similarity

    monkeypatch.setattr(image_similarity, "enabled", lambda db: False)


@pytest.fixture(autouse=True)
def _no_real_redraw(monkeypatch):
    """兜底：谁都别把 AI 生图任务真投进线程池。

    redraw_worker.enqueue 会起线程、开 SessionLocal（连真 MySQL）、打供应商 HTTP。
    自动上架在没实拍图时会提生图任务，不挡住的话测试会打到线上服务。
    """
    from app.services import redraw_worker

    monkeypatch.setattr(redraw_worker, "enqueue", lambda job_id: None)


@pytest.fixture()
def db_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine, tables=_TEST_TABLES)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = Session()
    try:
        yield db
    finally:
        db.close()
