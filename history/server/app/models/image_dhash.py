from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin


class ImageDhash(Base, TimestampMixin):
    """图床上一张图的「长相」（灰度 dHash，64 位），比各号上架图像不像用，见 services/image_similarity。

    按 OSS 对象 key 认（key_hash = md5(key)，key 太长不直接建主键）；同一个 key 的图不会变，算一次就一直用。
    只存算出来的，取不到图的不存，下次再取。
    """

    __tablename__ = "image_dhash"

    key_hash: Mapped[str] = mapped_column(String(32), primary_key=True)
    object_key: Mapped[str] = mapped_column(String(512), nullable=False)
    # 16 位十六进制
    dhash: Mapped[str] = mapped_column(String(16), nullable=False)
