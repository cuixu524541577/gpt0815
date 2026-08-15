# -*- coding: utf-8 -*-
"""卡池数据层 + 支付执行器单元测试。数据全部落到临时目录，不污染真实卡池。"""
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from core import card_pool as cp
from core import payment_executor as pe

GOOD_CARD = "4242424242424242"   # 标准测试卡（Luhn 通过）


@pytest.fixture()
def pool(tmp_path):
    """把卡池数据重定向到临时目录。"""
    cp._DATA_DIR = tmp_path
    cp._CARDS_FILE = tmp_path / "cards.json"
    cp._PAYPAL_FILE = tmp_path / "paypal.json"
    cp._JOBS_FILE = tmp_path / "jobs.json"
    pe._notify_finished = lambda job: None
    yield tmp_path
    for f in ("cards.json", "paypal.json", "jobs.json"):
        p = tmp_path / f
        if p.exists():
            p.unlink()


def wait_job(job_id, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = cp.get_job(job_id)
        if job and job["status"] in (cp.JOB_SUCCEEDED, cp.JOB_FAILED, cp.JOB_CANCELED):
            return job
        time.sleep(0.05)
    raise AssertionError(f"任务 {job_id} 超时未终态: {cp.get_job(job_id)}")


# ------------------------------------------------------------
# 卡池 CRUD / 校验
# ------------------------------------------------------------
def test_add_card_and_validation(pool):
    row = cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123", billing_zip="10001")
    assert row["bin"] == "424242"
    assert row["last4"] == "4242"
    assert row["card_type"] == "visa"
    assert row["status"] == cp.STATUS_ACTIVE
    assert row["expires"] == "12/27"

    with pytest.raises(ValueError):  # Luhn 错误
        cp.add_card(card_number="1234567890123456", expires="12/27", cvv="123")
    with pytest.raises(ValueError):  # 有效期非法
        cp.add_card(card_number=GOOD_CARD, expires="13/27", cvv="123")
    with pytest.raises(ValueError):  # 重复卡号
        cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    with pytest.raises(ValueError):  # CVV 非法
        cp.add_card(card_number="4242424242424241", expires="12/27", cvv="12")


def test_expiry_formats(pool):
    assert cp._parse_expiry("12/2027") == "12/27"
    assert cp._parse_expiry("3/28") == "03/28"
    assert cp._parse_expiry("99/99") is None


def test_import_cards(pool):
    text = [
        "4242424242424242|12/27|123|10001",
        "5555555555554444,12/28,321,20002",
        "# 注释行",
        "1234567890123456,12/27,123",   # Luhn 错 → 失败
        "   ",
    ]
    result = cp.import_cards(text)
    assert result["imported"] == 2
    assert len(result["failed"]) == 1
    rows = cp.list_cards()
    assert len(rows) == 2
    assert {r["card_type"] for r in rows} == {"visa", "mastercard"}


def test_update_delete_card(pool):
    row = cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    cp.update_card(row["id"], {"status": cp.STATUS_LOCKED, "notes": "测试"})
    rows = cp.list_cards()
    assert rows[0]["status"] == cp.STATUS_LOCKED
    assert rows[0]["notes"] == "测试"
    with pytest.raises(ValueError):
        cp.update_card(row["id"], {"status": "bogus"})
    assert cp.delete_card(row["id"]) is True
    assert cp.delete_card(row["id"]) is False


# ------------------------------------------------------------
# 挑选策略 / 租约 / 报废
# ------------------------------------------------------------
def test_pick_card_prefers_bin_then_least_used(pool, monkeypatch):
    a = cp.add_card(card_number="403657000000000", expires="12/27", cvv="123")   # 白名单 BIN
    b = cp.add_card(card_number="403657000000018", expires="12/27", cvv="123")
    c = cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")            # 非白名单
    cp.release_card(a["id"], ok=True)
    cp.release_card(a["id"], ok=True)     # a 用 2 次
    cp.release_card(b["id"], ok=True)     # b 用 1 次
    monkeypatch.setenv("CARD_POOL_PREFERRED_BINS", "403657")
    picked = cp.pick_card()
    assert picked["id"] == b["id"]    # 白名单 + 最少使用
    # 租约锁定：再次 pick 应跳过 b
    picked2 = cp.pick_card()
    assert picked2["id"] == a["id"]
    picked3 = cp.pick_card()
    assert picked3["id"] == c["id"]   # 白名单全部锁定后落到普通卡


def test_lease_recovery_after_crash(pool):
    row = cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    picked = cp.pick_card()
    assert picked["status"] == cp.STATUS_IN_USE
    # 模拟崩溃：租约过期后应被回收
    import datetime as _dt
    rows = cp._load_cards()
    rows[0]["locked_at"] = (_dt.datetime.now() - _dt.timedelta(seconds=3600)).isoformat()
    cp._save_cards(rows)
    picked2 = cp.pick_card()
    assert picked2["id"] == row["id"]
    assert picked2["status"] == cp.STATUS_IN_USE


def test_release_scrap_on_hard_fail(pool):
    row = cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    picked = cp.pick_card()
    cp.release_card(picked["id"], ok=False, result="ISSUER_DECLINE")
    rows = cp.list_cards()
    assert rows[0]["status"] == cp.STATUS_SCRAPPED
    assert rows[0]["fail_count"] == 1
    assert cp.pick_card() is None          # 已报废不再可挑


def test_release_normal_ok(pool):
    row = cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    picked = cp.pick_card()
    cp.release_card(picked["id"], ok=True, result="succeeded")
    rows = cp.list_cards()
    assert rows[0]["status"] == cp.STATUS_ACTIVE
    assert rows[0]["success_count"] == 1
    assert rows[0]["last_result"] == "succeeded"


def test_paypal_pool_least_used(pool):
    a = cp.add_paypal(phone="+10000000001", sms_api_url="http://sms.local/get?key=k1")
    b = cp.add_paypal(phone="+10000000002", sms_api_url="")
    cp.release_paypal(a["id"], ok=True, result="succeeded")
    picked = cp.pick_paypal()
    assert picked["id"] == b["id"]
    with pytest.raises(ValueError):        # 手机号格式
        cp.add_paypal(phone="10000000001", sms_api_url="")
    with pytest.raises(ValueError):        # OTP URL 格式
        cp.add_paypal(phone="+10000000003", sms_api_url="not-a-url")


# ------------------------------------------------------------
# 任务 / 执行器
# ------------------------------------------------------------
def test_job_create_cancel(pool):
    with pytest.raises(ValueError):
        cp.create_job(link="not-a-url", method="card")
    with pytest.raises(ValueError):
        cp.create_job(link="https://example.com/pay", method="bitcoin")
    job = cp.create_job(link="https://example.com/pay", method="card", email="a@b.c", source="manual")
    assert job["status"] == cp.JOB_QUEUED
    assert job["attempts"] == 0
    assert cp.cancel_job(job["id"]) is True
    assert cp.get_job(job["id"])["status"] == cp.JOB_CANCELED
    assert cp.cancel_job(job["id"]) is False    # 终态不可再取消


def test_mock_driver_success(pool):
    card = cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    result = pe.pay_with_card("https://checkout.stripe.com/pay/live", card, force_driver="mock")
    assert result["ok"] is True
    assert result["result"] == "succeeded"


def test_mock_driver_decline_and_timeout(pool):
    card = cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    r1 = pe.pay_with_card("https://checkout.stripe.com/pay/decline", card, force_driver="mock")
    assert r1["ok"] is False and r1["result"] == "ISSUER_DECLINE"
    r2 = pe.pay_with_card("https://checkout.stripe.com/pay/timeout", card, force_driver="mock")
    assert r2["ok"] is False and r2["result"] == "TIMEOUT"
    r3 = pe.pay_with_card("https://checkout.stripe.com/pay/gateway-error", card, force_driver="mock")
    assert r3["ok"] is False and r3["result"] == "GATEWAY_ERROR"


def test_disabled_driver(pool):
    card = cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    result = pe.pay_with_card("https://checkout.stripe.com/pay/live", card, force_driver="disabled")
    assert result["ok"] is False
    assert result["result"] == "CARD_POOL_DISABLED"


def test_stripe_protocol_missing_card(pool):
    result = pe.pay_with_card("https://checkout.stripe.com/c/pay/x", {}, force_driver="stripe_protocol")
    assert result["ok"] is False
    assert result["result"] == "CARD_MISSING"


def test_paypal_real_driver_unavailable(pool):
    pp = cp.add_paypal(phone="+10000000001", sms_api_url="")
    result = pe.pay_with_paypal("https://checkout.stripe.com/pay/live", pp, force_driver="stripe_protocol")
    assert result["ok"] is False
    assert result["result"] == "PAYPAL_DRIVER_UNAVAILABLE"
    mock = pe.pay_with_paypal("https://checkout.stripe.com/pay/live", pp, force_driver="mock")
    assert mock["ok"] is True


def test_full_job_flow_success(pool):
    cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    job = cp.create_job(link="https://checkout.stripe.com/pay/ok", method="card", email="u@x.com")
    pe.submit_payment_job(job["id"])
    final = wait_job(job["id"])
    assert final["status"] == cp.JOB_SUCCEEDED
    assert final["asset"] and "4242" in final["asset"]
    cards = cp.list_cards()
    assert cards[0]["success_count"] == 1
    assert cards[0]["status"] == cp.STATUS_ACTIVE
    assert final["attempts"] == 1
    assert final["logs"]


def test_full_job_flow_decline_scraps_card(pool):
    cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    job = cp.create_job(link="https://checkout.stripe.com/pay/decline", method="card")
    pe.submit_payment_job(job["id"])
    final = wait_job(job["id"])
    assert final["status"] == cp.JOB_FAILED
    assert final["error"] and "拒付" in final["error"]
    cards = cp.list_cards()
    assert cards[0]["status"] == cp.STATUS_SCRAPPED   # 硬失败自动报废
    assert cards[0]["fail_count"] == 1


def test_full_job_flow_no_card(pool):
    job = cp.create_job(link="https://checkout.stripe.com/pay/ok", method="card")
    pe.submit_payment_job(job["id"])
    final = wait_job(job["id"])
    assert final["status"] == cp.JOB_FAILED
    assert "无可用卡" in (final["error"] or "")


def test_paypal_full_job(pool):
    cp.add_paypal(phone="+10000000001", sms_api_url="")
    job = cp.create_job(link="https://checkout.stripe.com/pay/ok", method="paypal")
    pe.submit_payment_job(job["id"])
    final = wait_job(job["id"])
    assert final["status"] == cp.JOB_SUCCEEDED
    pp = cp.list_paypal()
    assert pp[0]["success_count"] == 1
    assert pp[0]["last_otp_status"] == "ok"


def test_summary_counts(pool):
    cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    cp.add_paypal(phone="+10000000001", sms_api_url="")
    cp.create_job(link="https://example.com/pay", method="card")
    s = cp.summary()
    assert s["cards"]["total"] == 1 and s["cards"]["active"] == 1
    assert s["paypal"]["total"] == 1
    assert s["jobs"]["queued"] == 1


def test_card_public_masks_number(pool):
    row = cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    pub = cp.card_public(row)
    assert "card_number" not in pub
    assert "cvv" not in pub
    assert pub["card_number_masked"] == "424242****4242"
    assert pub["last4"] == "4242"


def test_retry_failed_job(pool):
    cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    job = cp.create_job(link="https://checkout.stripe.com/pay/decline", method="card")
    pe.submit_payment_job(job["id"])
    final = wait_job(job["id"])
    assert final["status"] == cp.JOB_FAILED
    # 恢复卡片后重试成功
    card = cp.list_cards()[0]
    cp.update_card(card["id"], {"status": cp.STATUS_ACTIVE})
    job2 = cp.create_job(link="https://checkout.stripe.com/pay/ok", method="card", email="u@x.com")
    pe.submit_payment_job(job2["id"])
    final2 = wait_job(job2["id"])
    assert final2["status"] == cp.JOB_SUCCEEDED


# ------------------------------------------------------------
# 数据损坏自愈（健壮性回归）
# ------------------------------------------------------------
def test_corrupted_data_self_heal(pool):
    """数据文件结构损坏（合法 JSON 但元素非 dict）时不崩溃，自动过滤。"""
    # 截断的 JSON → 空列表
    (pool / "cards.json").write_text('{"cards": [{"id": 1, "card_number": "4242', encoding="utf-8")
    assert cp.list_cards() == []
    # 元素混合（dict + int + str + null）→ 只保留 dict
    (pool / "cards.json").write_text('[{"id": 1}, 42, "x", null, {"id": 2}]', encoding="utf-8")
    rows = cp.list_cards()
    assert [r["id"] for r in rows] == [1, 2]
    # jobs 同样自愈
    (pool / "jobs.json").write_text('[{"status": "queued"}, "bad", 7]', encoding="utf-8")
    jobs = cp.list_jobs()
    assert len(jobs) == 1 and jobs[0]["status"] == "queued"
    # 自愈后可正常写入（坏数据中的 dict 保留，新卡正常追加）
    cp.add_card(card_number=GOOD_CARD, expires="12/27", cvv="123")
    rows = cp.list_cards()
    assert len(rows) == 3
    assert any(r.get("card_number") == GOOD_CARD for r in rows)


def test_corrupted_config_falls_back(pool, monkeypatch):
    """config/card_pool.py 语法损坏时返回默认值而非崩溃。"""
    from pathlib import Path as _P
    cfg_path = _P(__file__).resolve().parent.parent / "config" / "card_pool.py"
    backup = cfg_path.read_text(encoding="utf-8")
    try:
        cfg_path.write_text("ENABLE_CARD_POOL = True\nthis is not python (((\n", encoding="utf-8")
        cp._CFG_CACHE.clear()
        st = cp.settings()
        assert isinstance(st["enabled"], bool)
        assert isinstance(st["max_concurrent"], int)
    finally:
        cfg_path.write_text(backup, encoding="utf-8")
        cp._CFG_CACHE.clear()
