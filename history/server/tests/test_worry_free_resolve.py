"""无忧卖两层解析:格子覆盖 → 账号默认 → False。"""
from types import SimpleNamespace

from app.services.gc_bridge.listing_ops import _resolve_worry_free


def _cell(v):
    return SimpleNamespace(worry_free_sell=v)


def _shop(v):
    return SimpleNamespace(worry_free_sell=v)


def test_cell_true_overrides_account():
    assert _resolve_worry_free(_cell(True), _shop(False)) is True


def test_cell_false_overrides_account():
    assert _resolve_worry_free(_cell(False), _shop(True)) is False


def test_cell_none_inherits_account_default():
    assert _resolve_worry_free(_cell(None), _shop(True)) is True
    assert _resolve_worry_free(_cell(None), _shop(False)) is False


def test_no_cell_uses_account_default():
    assert _resolve_worry_free(None, _shop(True)) is True
    assert _resolve_worry_free(None, _shop(False)) is False
