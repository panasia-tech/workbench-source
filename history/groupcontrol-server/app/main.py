import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import router
from app.database import Base, engine, run_light_migrations
from app.mqtt_bridge import bridge
from app.scheduler import Scheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

scheduler = Scheduler(bridge)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # dev：直接建表（生产改用 alembic）
    Base.metadata.create_all(bind=engine)
    # 老库补列(幂等):create_all 不会给已存在的表加新列,gc.db 已在跑
    run_light_migrations(engine)
    await bridge.start()
    await scheduler.start()
    yield
    await scheduler.stop()
    await bridge.stop()


app = FastAPI(title="群控调度中心", lifespan=lifespan)
app.include_router(router)
