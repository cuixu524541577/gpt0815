# -*- coding: utf-8 -*-
"""
卡池数据层：虚拟信用卡池 + PayPal 账号池 + 支付任务。

设计：
    - 持久化在 data/card_pool/ 下三个 JSON（cards / paypal / jobs），
      原子写 + 进程内锁，与 webui/compat.py 的 data/compat 风格一致。
    - 挑选策略：active → 白名单 BIN 优先 → use_count 升序 → 随机兜底。
    - 租约锁：选中即 in_use（带 locked_at + 租约秒数），并发不抢同一资产；
      崩溃后租约过期自动回收回 active。
    - 报废：硬失败（发卡行拒付等）自动置为 scrapped，避免反复重试坏资产。
    - 配置动态读取：每次操作重新读 config/card_pool.py 与 .env，
      配置页保存后无需重启即可生效。
"""
from __future__ import annotations

import ast
import json
import logging
import os
import random
import re
import threading
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "card_pool"
_CARDS_FILE = _DATA_DIR / "cards.json"
_PAYPAL_FILE = _DATA_DIR / "paypal.json"
_JOBS_FILE = _DATA_DIR / "jobs.json"
_LOCK = threading.RLock()

# 硬失败特征：命中即报废该资产（参考 get-gpt / GopayPlus 的处置策略）
HARD_FAIL_MARKERS = (
    "ISSUER_DECLINE", "CARD_GENERIC_ERROR", "card_declined", "do_not_honor",
    "insufficient_funds", "expired_card", "invalid_card", "lost_card",
    "stolen_card", "card_not_supported", "PAYPAL_ACCOUNT_LOCKED",
    "PAYPAL_ACCOUNT_INVALID", "PHONE_BANNED",
)

STATUS_ACTIVE = "active"
STATUS_IN_USE = "in_use"
STATUS_LOCKED = "locked"          # 人工锁定（保留，不再挑选）
STATUS_SCRAPPED = "scrapped"      # 报废

JOB_QUEUED = "queued"
JOB_RUNNING = "running"
JOB_SUCCEEDED = "succeeded"
JOB_FAILED = "failed"
JOB_CANCELED = "canceled"


# ------------------------------------------------------------
# 动态配置读取（保存即生效，无需重启）
# 按文件 mtime 缓存 + 源码解析，不 import/reload（避免多线程 reload 竞态）。
# ------------------------------------------------------------
_CFG_FILE = Path(__file__).resolve().parent.parent / "config" / "card_pool.py"
_CFG_LOCK = threading.Lock()
_CFG_CACHE: dict[str, tuple[int, object]] = {}


def _read_config_value(path: Path, name: str, default):
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        for node in tree.body:
            targets = node.targets if isinstance(node, ast.Assign) else (
                [node.target] if isinstance(node, ast.AnnAssign) else []
            )
            for t in targets:
                if isinstance(t, ast.Name) and t.id == name:
                    value = node.value
                    if isinstance(value, ast.Constant):
                        return value.value
                    if isinstance(value, (ast.List, ast.Tuple)):
                        return [e.value for e in value.elts if isinstance(e, ast.Constant)]
                    if isinstance(value, ast.UnaryOp) and isinstance(value.op, ast.USub) \
                            and isinstance(value.operand, ast.Constant):
                        return -value.operand.value
        return default
    except Exception:
        return default


def _cfg(name: str, default=None):
    try:
        from config.env_loader import load_env
        load_env(override=True)
    except Exception:
        pass
    raw = os.getenv(name)
    if raw is not None and str(raw).strip() != "":
        return str(raw).strip()
    try:
        mtime = _CFG_FILE.stat().st_mtime_ns
    except Exception:
        mtime = 0
    with _CFG_LOCK:
        cached = _CFG_CACHE.get(name)
        if cached is not None and cached[0] == mtime:
            return cached[1]
        value = _read_config_value(_CFG_FILE, name, default)
        _CFG_CACHE[name] = (mtime, value)
        return value


def _int_cfg(name: str, default: int, lower: int, upper: int) -> int:
    try:
        value = int(_cfg(name, default) or default)
    except (TypeError, ValueError):
        value = default
    return max(lower, min(upper, value))


def settings() -> dict:
    """配置快照（供前端设置页展示）。"""
    return {
        "enabled": str(_cfg("ENABLE_CARD_POOL", "false")).strip().lower() in ("true", "1", "yes", "on"),
        "driver": str(_cfg("CARD_POOL_DRIVER", "mock") or "mock").strip().lower(),
        "auto_pay": str(_cfg("CARD_POOL_AUTO_PAY", "false")).strip().lower() in ("true", "1", "yes", "on"),
        "pay_method": str(_cfg("CARD_POOL_PAY_METHOD", "auto") or "auto").strip().lower(),
        "preferred_bins": str(_cfg("CARD_POOL_PREFERRED_BINS", "") or "").strip(),
        "lease_seconds": _int_cfg("CARD_POOL_LEASE_SECONDS", 300, 30, 86400),
        "max_concurrent": _int_cfg("CARD_POOL_MAX_CONCURRENT", 2, 1, 64),
        "paypal_otp_timeout": _int_cfg("PAYPAL_OTP_TIMEOUT_SECONDS", 180, 30, 900),
        "paypal_otp_poll_interval": _int_cfg("PAYPAL_OTP_POLL_INTERVAL_SECONDS", 3, 1, 60),
    }


def enabled() -> bool:
    return settings()["enabled"]


# ------------------------------------------------------------
# 持久化
# ------------------------------------------------------------
def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _read(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("读取 %s 失败，返回默认值", path.name)
        return default


def _write(path: Path, data) -> None:
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(_DATA_DIR, 0o700)
    except OSError:
        pass
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _load_cards() -> list[dict]:
    rows = _read(_CARDS_FILE, None)
    return rows if isinstance(rows, list) else []


def _save_cards(rows: list[dict]) -> None:
    _write(_CARDS_FILE, rows)


def _load_paypal() -> list[dict]:
    rows = _read(_PAYPAL_FILE, None)
    return rows if isinstance(rows, list) else []


def _save_paypal(rows: list[dict]) -> None:
    _write(_PAYPAL_FILE, rows)


def _load_jobs() -> list[dict]:
    rows = _read(_JOBS_FILE, None)
    return rows if isinstance(rows, list) else []


def _save_jobs(rows: list[dict]) -> None:
    _write(_JOBS_FILE, rows)


def _next_id(rows: list[dict]) -> int:
    ids = [int(r.get("id") or 0) for r in rows]
    return (max(ids) if ids else 0) + 1


# ------------------------------------------------------------
# 工具
# ------------------------------------------------------------
def _luhn_ok(number: str) -> bool:
    if not re.fullmatch(r"\d{12,19}", number):
        return False
    total = 0
    for i, ch in enumerate(reversed(number)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _parse_expiry(raw: str) -> str | None:
    """接受 MM/YY 或 MM/YYYY，归一化为 MM/YY。"""
    m = re.fullmatch(r"\s*(\d{1,2})[/\-.](\d{2}|\d{4})\s*", str(raw or ""))
    if not m:
        return None
    month, year = int(m.group(1)), int(m.group(2))
    if not 1 <= month <= 12:
        return None
    if year < 100:
        year += 2000
    if year < 2000 or year > 2100:
        return None
    return f"{month:02d}/{str(year)[-2:]}"


def _card_type_by_bin(number: str) -> str:
    if number.startswith(("34", "37")):
        return "amex"
    if number.startswith(("4",)):
        return "visa"
    if number.startswith(("51", "52", "53", "54", "55", "2221", "2720")):
        return "mastercard"
    if number.startswith(("35",)):
        return "jcb"
    if number.startswith(("60", "62", "64", "65")):
        return "discover"
    return "unknown"


def _norm_phone(raw: str) -> str:
    return re.sub(r"\s+", "", str(raw or ""))


def _lease_expired(row: dict, lease_seconds: int) -> bool:
    if row.get("status") != STATUS_IN_USE or not row.get("locked_at"):
        return False
    try:
        locked = datetime.fromisoformat(str(row["locked_at"]))
        return (datetime.now() - locked).total_seconds() > max(30, lease_seconds)
    except Exception:
        return True  # 时间戳损坏视为可回收


def _reclaim_expired(rows: list[dict], lease_seconds: int) -> int:
    n = 0
    for row in rows:
        if _lease_expired(row, lease_seconds):
            row["status"] = STATUS_ACTIVE
            row["locked_at"] = None
            n += 1
    return n


# ------------------------------------------------------------
# 卡片池
# ------------------------------------------------------------
def add_card(*, card_number: str, expires: str, cvv: str, billing_zip: str = "",
             billing_country: str = "US", notes: str = "") -> dict:
    number = re.sub(r"\s+", "", str(card_number or ""))
    number = re.sub(r"[^0-9]", "", number)
    if not _luhn_ok(number):
        raise ValueError("卡号无效（需 12-19 位且通过 Luhn 校验）")
    exp = _parse_expiry(expires)
    if exp is None:
        raise ValueError("有效期无效（格式 MM/YY 或 MM/YYYY）")
    cvv = re.sub(r"\s+", "", str(cvv or ""))
    if not re.fullmatch(r"\d{3,4}", cvv):
        raise ValueError("CVV 无效（3-4 位数字）")
    with _LOCK:
        rows = _load_cards()
        if any(r.get("card_number") == number for r in rows):
            raise ValueError("该卡号已存在于卡池")
        row = {
            "id": _next_id(rows),
            "card_type": _card_type_by_bin(number),
            "bin": number[:6],
            "last4": number[-4:],
            "card_number": number,
            "expires": exp,
            "cvv": cvv,
            "billing_zip": str(billing_zip or "").strip(),
            "billing_country": str(billing_country or "US").strip().upper()[:2],
            "status": STATUS_ACTIVE,
            "use_count": 0,
            "success_count": 0,
            "fail_count": 0,
            "locked_at": None,
            "last_result": None,
            "last_used_at": None,
            "notes": str(notes or "").strip(),
            "created_at": _now(),
        }
        rows.append(row)
        _save_cards(rows)
        return dict(row)


def import_cards(lines: list[str]) -> dict:
    """批量导入。每行格式（分隔符 | 或 ,）：卡号,有效期[,CVV[,邮编]]。"""
    ok, failed = [], []
    for idx, raw in enumerate(lines, start=1):
        raw = str(raw or "").strip()
        if not raw or raw.startswith("#"):
            continue
        parts = [p.strip() for p in re.split(r"[|,]", raw)]
        if len(parts) < 2:
            failed.append({"line": idx, "raw": raw[:120], "error": "至少需要 卡号,有效期"})
            continue
        try:
            row = add_card(
                card_number=parts[0],
                expires=parts[1],
                cvv=parts[2] if len(parts) > 2 else "",
                billing_zip=parts[3] if len(parts) > 3 else "",
                notes=parts[4] if len(parts) > 4 else "",
            )
            ok.append(row["id"])
        except Exception as exc:
            failed.append({"line": idx, "raw": raw[:120], "error": f"{type(exc).__name__}: {exc}"})
    return {"imported": len(ok), "failed": failed, "ids": ok}


def update_card(card_id: int, patch: dict) -> dict:
    allowed = {"status", "notes", "billing_zip", "billing_country"}
    with _LOCK:
        rows = _load_cards()
        row = next((r for r in rows if int(r.get("id") or 0) == int(card_id)), None)
        if row is None:
            raise ValueError(f"卡片不存在: {card_id}")
        for key, value in patch.items():
            if key not in allowed:
                continue
            if key == "status":
                if value not in (STATUS_ACTIVE, STATUS_LOCKED, STATUS_SCRAPPED):
                    raise ValueError(f"非法状态: {value}")
                row["status"] = value
                row["locked_at"] = None if value == STATUS_ACTIVE else row.get("locked_at")
            else:
                row[key] = str(value or "").strip()
        _save_cards(rows)
        return dict(row)


def delete_card(card_id: int) -> bool:
    with _LOCK:
        rows = _load_cards()
        keep = [r for r in rows if int(r.get("id") or 0) != int(card_id)]
        if len(keep) == len(rows):
            return False
        _save_cards(keep)
        return True


def list_cards(status: str | None = None) -> list[dict]:
    with _LOCK:
        rows = [dict(r) for r in _load_cards()]
    if status:
        rows = [r for r in rows if r.get("status") == status]
    rows.sort(key=lambda r: int(r.get("id") or 0))
    return rows


def pick_card() -> dict | None:
    """挑选一张可用卡并租约锁定（in_use）。无可用卡返回 None。"""
    with _LOCK:
        lease = _int_cfg("CARD_POOL_LEASE_SECONDS", 300, 30, 86400)
        rows = _load_cards()
        _reclaim_expired(rows, lease)
        candidates = [r for r in rows if r.get("status") == STATUS_ACTIVE]
        if not candidates:
            return None
        preferred = [b.strip() for b in str(_cfg("CARD_POOL_PREFERRED_BINS", "") or "").split(",") if b.strip()]
        if preferred:
            pref = [r for r in candidates if r.get("bin") in preferred]
            if pref:
                candidates = pref
        candidates.sort(key=lambda r: (int(r.get("use_count") or 0), random.random()))
        row = candidates[0]
        row["status"] = STATUS_IN_USE
        row["locked_at"] = _now()
        _save_cards(rows)
        return dict(row)


def release_card(card_id: int, *, ok: bool, result: str | None = None,
                 hard_fail: bool | None = None) -> None:
    """归还卡片：记成功/失败次数与最近结果；硬失败自动报废。"""
    with _LOCK:
        rows = _load_cards()
        row = next((r for r in rows if int(r.get("id") or 0) == int(card_id)), None)
        if row is None:
            return
        row["status"] = STATUS_ACTIVE
        row["locked_at"] = None
        row["last_used_at"] = _now()
        row["last_result"] = str(result or "")[:300] or None
        row["use_count"] = int(row.get("use_count") or 0) + 1
        if ok:
            row["success_count"] = int(row.get("success_count") or 0) + 1
        else:
            row["fail_count"] = int(row.get("fail_count") or 0) + 1
        if hard_fail is None:
            hard_fail = result and any(marker.lower() in str(result).lower() for marker in HARD_FAIL_MARKERS)
        if hard_fail:
            row["status"] = STATUS_SCRAPPED
        _save_cards(rows)


# ------------------------------------------------------------
# PayPal 账号池
# ------------------------------------------------------------
def add_paypal(*, phone: str, sms_api_url: str, notes: str = "") -> dict:
    number = _norm_phone(phone)
    if not number.startswith("+") or not re.fullmatch(r"\+[0-9]{6,15}", number):
        raise ValueError("手机号需带国家码，如 +10000000001")
    url = str(sms_api_url or "").strip()
    if url and not url.startswith(("http://", "https://")):
        raise ValueError("OTP 获取 API 地址必须是 http/https")
    with _LOCK:
        rows = _load_paypal()
        if any(r.get("phone") == number for r in rows):
            raise ValueError("该手机号已存在于池中")
        row = {
            "id": _next_id(rows),
            "phone": number,
            "sms_api_url": url,
            "status": STATUS_ACTIVE,
            "use_count": 0,
            "success_count": 0,
            "fail_count": 0,
            "locked_at": None,
            "last_otp_status": None,
            "last_result": None,
            "last_used_at": None,
            "notes": str(notes or "").strip(),
            "created_at": _now(),
        }
        rows.append(row)
        _save_paypal(rows)
        return dict(row)


def import_paypal(lines: list[str]) -> dict:
    """批量导入。每行：手机号|OTP-API-URL[|备注]（分隔符 | 或 ,）。"""
    ok, failed = [], []
    for idx, raw in enumerate(lines, start=1):
        raw = str(raw or "").strip()
        if not raw or raw.startswith("#"):
            continue
        parts = [p.strip() for p in re.split(r"[|,]", raw)]
        if len(parts) < 1 or not parts[0]:
            failed.append({"line": idx, "raw": raw[:120], "error": "缺少手机号"})
            continue
        try:
            row = add_paypal(
                phone=parts[0],
                sms_api_url=parts[1] if len(parts) > 1 else "",
                notes=parts[2] if len(parts) > 2 else "",
            )
            ok.append(row["id"])
        except Exception as exc:
            failed.append({"line": idx, "raw": raw[:120], "error": f"{type(exc).__name__}: {exc}"})
    return {"imported": len(ok), "failed": failed, "ids": ok}


def update_paypal(paypal_id: int, patch: dict) -> dict:
    allowed = {"status", "notes", "sms_api_url"}
    with _LOCK:
        rows = _load_paypal()
        row = next((r for r in rows if int(r.get("id") or 0) == int(paypal_id)), None)
        if row is None:
            raise ValueError(f"PayPal 账号不存在: {paypal_id}")
        for key, value in patch.items():
            if key not in allowed:
                continue
            if key == "status":
                if value not in (STATUS_ACTIVE, STATUS_LOCKED, STATUS_SCRAPPED):
                    raise ValueError(f"非法状态: {value}")
                row["status"] = value
                row["locked_at"] = None if value == STATUS_ACTIVE else row.get("locked_at")
            else:
                row[key] = str(value or "").strip()
        _save_paypal(rows)
        return dict(row)


def delete_paypal(paypal_id: int) -> bool:
    with _LOCK:
        rows = _load_paypal()
        keep = [r for r in rows if int(r.get("id") or 0) != int(paypal_id)]
        if len(keep) == len(rows):
            return False
        _save_paypal(keep)
        return True


def list_paypal(status: str | None = None) -> list[dict]:
    with _LOCK:
        rows = [dict(r) for r in _load_paypal()]
    if status:
        rows = [r for r in rows if r.get("status") == status]
    rows.sort(key=lambda r: int(r.get("id") or 0))
    return rows


def pick_paypal() -> dict | None:
    """挑选一个最少使用的 PayPal 账号并租约锁定。"""
    with _LOCK:
        lease = _int_cfg("CARD_POOL_LEASE_SECONDS", 300, 30, 86400)
        rows = _load_paypal()
        _reclaim_expired(rows, lease)
        candidates = [r for r in rows if r.get("status") == STATUS_ACTIVE]
        if not candidates:
            return None
        candidates.sort(key=lambda r: (int(r.get("use_count") or 0), random.random()))
        row = candidates[0]
        row["status"] = STATUS_IN_USE
        row["locked_at"] = _now()
        _save_paypal(rows)
        return dict(row)


def release_paypal(paypal_id: int, *, ok: bool, result: str | None = None,
                   hard_fail: bool | None = None) -> None:
    with _LOCK:
        rows = _load_paypal()
        row = next((r for r in rows if int(r.get("id") or 0) == int(paypal_id)), None)
        if row is None:
            return
        row["status"] = STATUS_ACTIVE
        row["locked_at"] = None
        row["last_used_at"] = _now()
        row["last_result"] = str(result or "")[:300] or None
        row["last_otp_status"] = "ok" if ok else str(result or "")[:120] or "failed"
        row["use_count"] = int(row.get("use_count") or 0) + 1
        if ok:
            row["success_count"] = int(row.get("success_count") or 0) + 1
        else:
            row["fail_count"] = int(row.get("fail_count") or 0) + 1
        if hard_fail is None:
            hard_fail = result and any(marker.lower() in str(result).lower() for marker in HARD_FAIL_MARKERS)
        if hard_fail:
            row["status"] = STATUS_SCRAPPED
        _save_paypal(rows)


# ------------------------------------------------------------
# 支付任务
# ------------------------------------------------------------
def create_job(*, link: str, method: str, email: str = "", source: str = "manual",
               card_id: int | None = None, paypal_id: int | None = None) -> dict:
    if not str(link or "").strip().startswith(("http://", "https://")):
        raise ValueError("支付链接必须是 http/https 地址")
    method = str(method or "card").strip().lower()
    if method not in ("card", "paypal"):
        raise ValueError("支付方式只能是 card 或 paypal")
    with _LOCK:
        rows = _load_jobs()
        job = {
            "id": _next_id(rows),
            "link": str(link).strip(),
            "method": method,
            "email": str(email or "").strip(),
            "source": str(source or "manual").strip(),
            "status": JOB_QUEUED,
            "attempts": 0,
            "card_id": card_id,
            "paypal_id": paypal_id,
            "asset": None,          # 实际选中资产的摘要（卡 last4 / PayPal 号）
            "error": None,
            "result": None,
            "logs": [],
            "created_at": _now(),
            "started_at": None,
            "finished_at": None,
        }
        rows.append(job)
        _save_jobs(rows)
        return dict(job)


def get_job(job_id: int) -> dict | None:
    rows = _load_jobs()
    return next((dict(r) for r in rows if int(r.get("id") or 0) == int(job_id)), None)


def list_jobs(status: str | None = None, limit: int = 200) -> list[dict]:
    rows = [dict(r) for r in _load_jobs()]
    if status:
        rows = [r for r in rows if r.get("status") == status]
    rows.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
    return rows[:max(1, int(limit or 200))]


def update_job(job_id: int, patch: dict) -> dict | None:
    with _LOCK:
        rows = _load_jobs()
        row = next((r for r in rows if int(r.get("id") or 0) == int(job_id)), None)
        if row is None:
            return None
        for key, value in patch.items():
            if key == "logs":
                row["logs"] = list(value or [])
            else:
                row[key] = value
        _save_jobs(rows)
        return dict(row)


def append_job_log(job_id: int, message: str) -> None:
    with _LOCK:
        rows = _load_jobs()
        row = next((r for r in rows if int(r.get("id") or 0) == int(job_id)), None)
        if row is None:
            return
        logs = list(row.get("logs") or [])
        logs.append(f"{_now()} {message}")
        row["logs"] = logs[-200:]
        _save_jobs(rows)


def cancel_job(job_id: int) -> bool:
    with _LOCK:
        rows = _load_jobs()
        row = next((r for r in rows if int(r.get("id") or 0) == int(job_id)), None)
        if row is None:
            return False
        if row.get("status") in (JOB_RUNNING,):
            return False  # 运行中的任务不允许取消（避免资产状态错乱）
        if row.get("status") in (JOB_SUCCEEDED, JOB_FAILED, JOB_CANCELED):
            return False
        row["status"] = JOB_CANCELED
        row["finished_at"] = _now()
        _save_jobs(rows)
        return True


def summary() -> dict:
    cards, paypal, jobs = list_cards(), list_paypal(), list_jobs(limit=10000)
    c = {"total": len(cards), "active": 0, "in_use": 0, "locked": 0, "scrapped": 0, "success": 0, "fail": 0}
    for r in cards:
        c[r.get("status")] = c.get(r.get("status"), 0) + 1
        c["success"] += int(r.get("success_count") or 0)
        c["fail"] += int(r.get("fail_count") or 0)
    p = {"total": len(paypal), "active": 0, "in_use": 0, "locked": 0, "scrapped": 0, "success": 0, "fail": 0}
    for r in paypal:
        p[r.get("status")] = p.get(r.get("status"), 0) + 1
        p["success"] += int(r.get("success_count") or 0)
        p["fail"] += int(r.get("fail_count") or 0)
    j = {"total": len(jobs), "queued": 0, "running": 0, "succeeded": 0, "failed": 0, "canceled": 0}
    for r in jobs:
        j[r.get("status")] = j.get(r.get("status"), 0) + 1
    return {"cards": c, "paypal": p, "jobs": j}


# ------------------------------------------------------------
# 输出脱敏
# ------------------------------------------------------------
def card_public(row: dict) -> dict:
    """API 输出用：卡号只保留 bin + **** + last4，永不返回 CVV。"""
    out = dict(row)
    number = str(out.get("card_number") or "")
    out["card_number_masked"] = (
        f"{number[:6]}****{number[-4:]}" if len(number) >= 10 else "****"
    )
    out.pop("card_number", None)
    out.pop("cvv", None)
    return out
