"""行情爬虫账号读库存的可见性合同。

行情工作台用 CRAWLER 账号登录,采集依据是「在库有哪些型号」。此前 CRAWLER 落进
_inspector_filter 的兜底分支——只看自己验过的货,而爬虫从不验货,于是 /inventory/skus
稳定返回 total=0:接口通、鉴权过、数据空,现场表现就是"连不上 API"。

放开可见性的同时守住成本价:纯采集端跑在员工自己的电脑上,型号/规格够用,
成本价没有用途,不该跟着库存列表出门。2026-09-16 起脱敏只剩 CRAWLER 这一个角色
——销售和采购都要自己登工作台干活,看不到成本就没法定价。

窄写接口放行谁是另一回事,边界写在 test_market_bot_role.py:看得到成本 ≠ 能改东西。
"""

import pytest

from app.enums import StaffRole
from app.routers.inventory import _hide_cost, _inspector_filter


class _FakeQuery:
    """只记录 filter 是否被调用,不需要真 SQLAlchemy。"""

    def __init__(self):
        self.filtered = False

    def filter(self, *_args, **_kwargs):
        self.filtered = True
        return self


class _FakeStaff:
    def __init__(self, role):
        self.role = role
        self.id = "staff-1"


ALL_VISIBLE = (StaffRole.ADMIN, StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.PURCHASER,
               StaffRole.CRAWLER, StaffRole.MARKET_BOT)
OWN_ONLY = (StaffRole.NEGOTIATOR, StaffRole.FINANCE, StaffRole.RFID_DEVICE)


@pytest.mark.parametrize("role", ALL_VISIBLE)
def test_可见全部在库的角色不加验货人过滤(role):
    query = _FakeQuery()
    assert _inspector_filter(query, _FakeStaff(role)) is query
    assert not query.filtered, f"{role} 应看到全部在库商品"


@pytest.mark.parametrize("role", OWN_ONLY)
def test_其余角色仍只看自己验的货(role):
    query = _FakeQuery()
    _inspector_filter(query, _FakeStaff(role))
    assert query.filtered, f"{role} 不应看到全部在库商品"


def test_爬虫拿不到成本价():
    """只读采集端只要型号/规格,成本价对它没用途,不该跟着库存列表出门。"""
    assert _hide_cost(_FakeStaff(StaffRole.CRAWLER)) is True


def test_销售看得到成本价():
    """2026-09-16 老板定:销售要自己登工作台定价上下架,没有成本价就没有成本底价。

    这条是**全局**放开——小程序和后台吃同一套判定,销售在那两处一样看得到进价。
    明知代价后的决定,不是漏网;要收回来改这一处即可。
    """
    assert _hide_cost(_FakeStaff(StaffRole.SALES)) is False


@pytest.mark.parametrize("role", (StaffRole.ADMIN, StaffRole.WAREHOUSE))
def test_管理员与仓管仍可见成本价(role):
    assert _hide_cost(_FakeStaff(role)) is False


def test_行情工作台可见成本价():
    """调价台用成本价算成本底价,拿不到就出不了候选价。"""
    assert _hide_cost(_FakeStaff(StaffRole.MARKET_BOT)) is False
