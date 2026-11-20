from app.flow import runner


def test_chat_scan_registered():
    assert runner.FLOWS["chat_scan"] is not None
    assert runner.QUOTA_CATEGORY["chat_scan"] == "chat_scan"
