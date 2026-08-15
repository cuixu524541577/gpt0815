# -*- coding: utf-8 -*-
"""
支付执行器：从卡池挑选资产 → 按驱动执行支付 → 归还/报废资产 → 更新任务。

驱动（CARD_POOL_DRIVER）：
    mock            —— 演示/测试：不真实扣款。链接含 decline→拒付、timeout→超时、
                       error/fail→网关错误，其余→成功。用于验证全链路与测试。
    stripe_protocol —— 真实 Stripe Hosted Checkout 协议支付：
                       抓取结账页 → 提取 pk 与 payment_intent client_secret →
                       POST /v1/payment_intents/<id>/confirm 提交卡信息。
                       需要真实虚拟卡 + 可用的网络出口（建议匹配账单国家）。
    disabled        —— 禁止一切支付动作。

PayPal 池真实支付依赖浏览器 RPA（未内置）；在 mock 驱动下可用 URL 标记模拟。
"""
from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime

from core import card_pool as cp

logger = logging.getLogger(__name__)

_sem_state = {"n": None, "sem": None}
_sem_lock = threading.Lock()


def _semaphore():
    n = cp.settings()["max_concurrent"]
    with _sem_lock:
        if _sem_state["n"] != n or _sem_state["sem"] is None:
            _sem_state["n"] = n
            _sem_state["sem"] = threading.BoundedSemaphore(n)
        return _sem_state["sem"]


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _notify_finished(job: dict) -> None:
    """任务终态通知：Telegram（静默失败）。"""
    try:
        from webui.notify import send_text
        status = job.get("status")
        if status == cp.JOB_SUCCEEDED:
            text = (f"✅ 卡池支付成功 · #{job.get('id')}\n"
                    f"方式: {job.get('method')} · 资产: {job.get('asset') or '-'}\n"
                    f"邮箱: {job.get('email') or '-'}")
        elif status == cp.JOB_FAILED:
            text = (f"❌ 卡池支付失败 · #{job.get('id')}\n"
                    f"方式: {job.get('method')} · 资产: {job.get('asset') or '-'}\n"
                    f"原因: {(job.get('error') or '-')[:200]}")
        else:
            return
        send_text(text)
    except Exception:
        pass


# ------------------------------------------------------------
# 驱动
# ------------------------------------------------------------
def _driver_mock(link: str, asset_summary: str) -> dict:
    logs = [
        f"mock 驱动：校验链接 {link[:120]}",
        f"mock 驱动：资产 {asset_summary}",
    ]
    lower = link.lower()
    if "decline" in lower or "declined" in lower:
        logs.append("mock 驱动：命中 decline 标记 → 模拟拒付")
        return {"ok": False, "result": "ISSUER_DECLINE", "message": "模拟拒付：发卡行拒绝交易", "logs": logs}
    if "timeout" in lower:
        logs.append("mock 驱动：命中 timeout 标记 → 模拟超时")
        return {"ok": False, "result": "TIMEOUT", "message": "模拟超时：支付网关无响应", "logs": logs}
    if "error" in lower or "/fail" in lower or "gateway" in lower:
        logs.append("mock 驱动：命中 error/fail 标记 → 模拟网关错误")
        return {"ok": False, "result": "GATEWAY_ERROR", "message": "模拟网关错误", "logs": logs}
    logs.append("mock 驱动：未命中失败标记 → 模拟支付成功")
    return {"ok": True, "result": "succeeded", "message": "模拟支付成功", "logs": logs}


def _http_session():
    try:
        from curl_cffi import requests as curl_requests
        return curl_requests.Session(impersonate="chrome124")
    except Exception:
        import requests
        return requests.Session()


def _driver_stripe_protocol(link: str, card: dict) -> dict:
    logs = []
    try:
        card_number = str(card.get("card_number") or "")
        if not card_number:
            return {"ok": False, "result": "CARD_MISSING", "message": "卡数据缺失", "logs": logs}
        logs.append(f"抓取结账页: {link[:120]}")
        s = _http_session()
        try:
            resp = s.get(link, timeout=30)
            page = resp.text
        finally:
            try:
                s.close()
            except Exception:
                pass
        logs.append(f"结账页 HTTP {getattr(resp, 'status_code', '?')}，{len(page)} 字节")

        pk = None
        for pattern in (r"pk_live_[A-Za-z0-9]+", r"pk_test_[A-Za-z0-9]+"):
            m = re.search(pattern, page)
            if m:
                pk = m.group(0)
                break
        pi = None
        for pattern in (
            r'"client_secret"\s*:\s*"([pi][A-Za-z0-9_]+_secret_[A-Za-z0-9]+)"',
            r'payment_intent[^"]*"([pi]_[A-Za-z0-9]+)"',
            r"([pi]_[A-Za-z0-9]{10,}_secret_[A-Za-z0-9]+)",
        ):
            m = re.search(pattern, page)
            if m:
                pi = m.group(1)
                break
        if not pk or not pi:
            logs.append("未从结账页解析出 pk / payment_intent client_secret（页面结构可能已变或需要浏览器）")
            return {"ok": False, "result": "CHECKOUT_PARSE_FAILED",
                    "message": "无法解析 Stripe 结账参数，建议改用浏览器支付或人工扫码", "logs": logs}

        exp = str(card.get("expires") or "")
        exp_m, exp_y = "", ""
        m = re.fullmatch(r"(\d{2})/(\d{2})", exp)
        if m:
            exp_m, exp_y = m.group(1), m.group(2)
        if not exp_m or not exp_y:
            return {"ok": False, "result": "CARD_EXPIRY_INVALID", "message": "卡有效期格式无效", "logs": logs}

        logs.append(f"确认 PaymentIntent {pi[:20]}... (pk={pk[:12]}...)")
        data = {
            "payment_method_data[type]": "card",
            "payment_method_data[card][number]": card_number,
            "payment_method_data[card][exp_month]": exp_m,
            "payment_method_data[card][exp_year]": exp_y,
            "payment_method_data[card][cvc]": str(card.get("cvv") or ""),
            "payment_method_data[billing_details][address][postal_code]": str(card.get("billing_zip") or "10001"),
            "payment_method_data[billing_details][address][country]": str(card.get("billing_country") or "US")[:2],
            "return_url": link,
            "use_stripe_sdk[source]": "checkout",
        }
        confirm_url = f"https://api.stripe.com/v1/payment_intents/{pi}/confirm?key={pk}"
        s2 = _http_session()
        try:
            r2 = s2.post(confirm_url, data=data, timeout=30)
        finally:
            try:
                s2.close()
            except Exception:
                pass
        try:
            body = r2.json()
        except Exception:
            body = {"raw": (r2.text or "")[:500]}
        logs.append(f"Stripe confirm HTTP {r2.status_code}")
        status = (body or {}).get("status") if isinstance(body, dict) else None
        if r2.status_code < 300 and status in ("succeeded", "requires_capture", "processing"):
            logs.append(f"Stripe 返回 status={status} → 支付受理")
            return {"ok": True, "result": status, "message": f"Stripe 支付受理（{status}）", "logs": logs}
        reason = ""
        if isinstance(body, dict):
            err = body.get("error") or {}
            if isinstance(err, dict):
                reason = str(err.get("message") or err.get("code") or err.get("decline_code") or "")
            elif err:
                reason = str(err)
        logs.append(f"Stripe 拒绝: {reason or ('HTTP ' + str(r2.status_code))}")
        return {"ok": False, "result": reason or "STRIPE_REJECTED", "message": reason or "Stripe 拒绝交易", "logs": logs}
    except Exception as exc:
        logs.append(f"stripe_protocol 异常: {type(exc).__name__}: {exc}")
        return {"ok": False, "result": f"{type(exc).__name__}: {exc}", "message": str(exc)[:300], "logs": logs}


def _driver_disabled(link: str) -> dict:
    return {"ok": False, "result": "CARD_POOL_DISABLED", "message": "卡池支付未启用（driver=disabled）", "logs": []}


def pay_with_card(link: str, card: dict, force_driver: str | None = None) -> dict:
    driver = (force_driver or cp.settings()["driver"] or "mock").strip().lower()
    summary = f"卡 {card.get('bin') or ''}****{card.get('last4') or ''} ({card.get('card_type') or '?'})"
    if driver == "disabled":
        return _driver_disabled(link)
    if driver == "stripe_protocol":
        result = _driver_stripe_protocol(link, card)
    else:  # mock 与未知驱动一律走 mock（未知驱动记录告警）
        if driver != "mock":
            logger.warning("未知支付驱动 %r，回退 mock", driver)
        result = _driver_mock(link, summary)
    result["asset"] = summary
    return result


def pay_with_paypal(link: str, paypal: dict, force_driver: str | None = None) -> dict:
    driver = (force_driver or cp.settings()["driver"] or "mock").strip().lower()
    summary = f"PayPal {paypal.get('phone') or '?'}"
    if driver == "disabled":
        return _driver_disabled(link)
    if driver == "mock":
        result = _driver_mock(link, summary)
    else:
        result = {
            "ok": False,
            "result": "PAYPAL_DRIVER_UNAVAILABLE",
            "message": "PayPal 真实支付需要浏览器 RPA 驱动（未内置），当前驱动仅支持银行卡；可先用 mock 驱动验证链路",
            "logs": [f"PayPal 支付在 {driver} 驱动下不可用"],
        }
    result["asset"] = summary
    return result


# ------------------------------------------------------------
# 任务编排
# ------------------------------------------------------------
def _run(job_id: int) -> dict:
    job = cp.get_job(job_id)
    if job is None:
        return {"ok": False, "error": f"任务不存在: {job_id}"}
    method = job.get("method") or "card"
    link = job.get("link") or ""
    attempts = int(job.get("attempts") or 0) + 1
    cp.update_job(job_id, {"attempts": attempts})
    cp.append_job_log(job_id, f"开始执行（第 {attempts} 次，方式 {method}）")

    result = None
    if method == "card":
        card = cp.pick_card()
        if card is None:
            cp.append_job_log(job_id, "卡池无可用卡（active 为空）")
            result = {"ok": False, "result": "NO_AVAILABLE_CARD", "message": "卡池无可用卡，请先导入或解锁"}
        else:
            cp.append_job_log(job_id, f"已选中卡 {card['bin']}****{card['last4']} 并租约锁定")
            cp.update_job(job_id, {"asset": f"卡 {card['bin']}****{card['last4']} ({card['card_type']})", "card_id": card["id"]})
            try:
                result = pay_with_card(link, card)
            except Exception as exc:
                result = {"ok": False, "result": f"{type(exc).__name__}", "message": str(exc)[:300], "logs": []}
            finally:
                cp.release_card(card["id"], ok=bool(result and result.get("ok")),
                                result=result.get("result") if result else None)
                cp.append_job_log(job_id, f"归还卡 {card['bin']}****{card['last4']}（ok={bool(result and result.get('ok'))}）")
    elif method == "paypal":
        paypal = cp.pick_paypal()
        if paypal is None:
            cp.append_job_log(job_id, "PayPal 池无可用账号（active 为空）")
            result = {"ok": False, "result": "NO_AVAILABLE_PAYPAL", "message": "PayPal 池无可用账号，请先导入或解锁"}
        else:
            cp.append_job_log(job_id, f"已选中 PayPal {paypal['phone']} 并租约锁定")
            cp.update_job(job_id, {"asset": f"PayPal {paypal['phone']}", "paypal_id": paypal["id"]})
            try:
                result = pay_with_paypal(link, paypal)
            except Exception as exc:
                result = {"ok": False, "result": f"{type(exc).__name__}", "message": str(exc)[:300], "logs": []}
            finally:
                cp.release_paypal(paypal["id"], ok=bool(result and result.get("ok")),
                                  result=result.get("result") if result else None)
                cp.append_job_log(job_id, f"归还 PayPal {paypal['phone']}（ok={bool(result and result.get('ok'))}）")
    else:
        result = {"ok": False, "result": "INVALID_METHOD", "message": f"非法支付方式: {method}"}

    for line in (result or {}).get("logs") or []:
        cp.append_job_log(job_id, f"[driver] {line}")
    if result.get("ok"):
        cp.update_job(job_id, {
            "status": cp.JOB_SUCCEEDED, "result": str(result.get("result") or ""),
            "error": None, "finished_at": _now(),
        })
        cp.append_job_log(job_id, f"支付成功: {result.get('message') or ''}")
    else:
        cp.update_job(job_id, {
            "status": cp.JOB_FAILED, "result": str(result.get("result") or ""),
            "error": str(result.get("message") or result.get("error") or "未知失败")[:500],
            "finished_at": _now(),
        })
        cp.append_job_log(job_id, f"支付失败: {result.get('message') or result.get('error') or ''}")
    final = cp.get_job(job_id)
    if final:
        _notify_finished(final)
    return result


def submit_payment_job(job_id: int) -> dict:
    """异步执行支付任务。返回提交结果；并发超限时 worker 在线程内排队等待。"""
    job = cp.get_job(job_id)
    if job is None:
        return {"ok": False, "error": f"任务不存在: {job_id}"}
    if job.get("status") == cp.JOB_RUNNING:
        return {"ok": False, "error": "任务已在执行中"}
    if job.get("status") in (cp.JOB_SUCCEEDED, cp.JOB_CANCELED):
        return {"ok": False, "error": "任务已终态（成功/取消），如需重试请重新创建任务"}
    cp.update_job(job_id, {"status": cp.JOB_RUNNING, "started_at": _now(), "error": None})

    def _worker():
        sem = _semaphore()
        sem.acquire()
        try:
            _run(job_id)
        except Exception as exc:
            logger.exception("[卡池支付] 任务 %s 异常", job_id)
            try:
                cp.update_job(job_id, {
                    "status": cp.JOB_FAILED, "error": f"{type(exc).__name__}: {exc}"[:500],
                    "finished_at": _now(),
                })
            except Exception:
                pass
        finally:
            sem.release()

    threading.Thread(target=_worker, name=f"card-pay-{job_id}", daemon=True).start()
    return {"ok": True, "job_id": job_id}


def process_queued_jobs(max_jobs: int = 10) -> int:
    """把队列中待执行的任务逐个提交（并发由信号量控制）。返回提交数。"""
    submitted = 0
    for job in cp.list_jobs(status=cp.JOB_QUEUED, limit=50):
        if submitted >= max_jobs:
            break
        res = submit_payment_job(int(job["id"]))
        if res.get("ok"):
            submitted += 1
    return submitted
