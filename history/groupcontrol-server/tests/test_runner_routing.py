from app.flow import runner


def test_relist_and_polish_registered():
    assert runner.FLOWS["goods_relist"] is not None
    assert runner.FLOWS["goods_polish"] is not None
    assert runner.QUOTA_CATEGORY["goods_relist"] == "relist"
    assert runner.QUOTA_CATEGORY["goods_polish"] == "polish"
