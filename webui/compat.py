# -*- coding: utf-8 -*-
"""
0.1.48 控制台 API 兼容层。

在基座 webui/app.py 之上补齐平台版（0.1.48）前端的全部接口契约：
系统信息 / 任务扩展 / 邮箱池扩展 / 账号扩展 / Codex 扩展 / SMS /
自动化任务 / UPI / 代理测试等。新增数据落 data/compat/ 下的 JSON 文件，
基座 core/db.py 保持不动（通过其模块级 _LOCK 与私有读写函数协作）。

依赖平台基础设施的功能（UPI 支付、Telegram OAuth、server-link）在自建版中
为禁用/空实现，接口形状与 0.1.48 保持一致，前端不会报错。
"""
import hashlib
import json
import logging
import os
import re
import socket
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from flask import Response, jsonify, request

from core import db

logger = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "compat"

APP_VERSION = "0.1.48-compat"
BUILD_SHA = "self-built"
BUILD_TIME = "2026-08-15T00:00:00Z"


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _load(name: str, default=None):
    p = _DATA_DIR / f"{name}.json"
    if not p.exists():
        return default
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default
    # 结构自愈：程序写入的 list 元素类型一致（upi_tasks 全 dict、
    # notified_jobs 全 str）。以首元素类型为准过滤，损坏混入的异物直接丢弃。
    if isinstance(data, list):
        if not data:
            return data
        first = data[0]
        if isinstance(first, dict):
            return [d for d in data if isinstance(d, dict)]
        if isinstance(first, str):
            return [d for d in data if isinstance(d, str)]
        return [d for d in data if isinstance(d, (dict, str))]
    return data


def _save(name: str, data) -> None:
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    (_DATA_DIR / f"{name}.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _json_body():
    """解析 JSON body；非 dict（字符串/数字/数组/null）一律视为空，避免下游 .get() 崩溃。"""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


_IMPORT_TEXT_MAX = 5 * 1024 * 1024      # 5MB
_IMPORT_LINES_MAX = 50_000


def _check_import_size(text: str) -> str | None:
    """导入文本大小/行数校验，超限返回错误信息。"""
    if len(text) > _IMPORT_TEXT_MAX:
        return f"导入内容过大（{len(text)} 字节，上限 {_IMPORT_TEXT_MAX // 1024 // 1024}MB）"
    if text.count("\n") > _IMPORT_LINES_MAX:
        return f"导入行数过多（上限 {_IMPORT_LINES_MAX} 行）"
    return None


# ---------------- 代理选择（按任务随机轮换） ----------------
def _proxy_for_task() -> str:
    """每个任务从代理池随机选一个代理（池空返回空串）。

    动态住宅代理池优先（未过期），静态 PROXY_POOL 兜底；
    实现任务级轮换，批量注册时应配置多代理池，避免单 IP 高频注册被风控。
    """
    try:
        from core.proxy_pool import pick_proxy as _dynamic_pick
        return _dynamic_pick()
    except Exception:
        try:
            from config import proxy as _proxy_cfg
            pool = getattr(_proxy_cfg, "PROXY_POOL", None) or []
            import random as _r
            return _r.choice(pool) if pool else ""
        except Exception:
            return ""


def _proxy_configured() -> bool:
    """注册任务是否已配置代理（静态池或动态池任一可用）。

    决定前端「当前没有配置代理」提示是否出现；之前硬编码 False，
    导致配了动态代理 API/手动列表也一直提示。
    """
    try:
        from config import proxy as _proxy_cfg
        if [x for x in (_proxy_cfg.PROXY_POOL or []) if str(x).strip()]:
            return True
        from core import proxy_pool as _pp
        if not _pp.enabled():
            return False
        mode = str(_pp._cfg("PROXY_DYNAMIC_MODE", "api") or "api").strip().lower()
        if mode == "manual":
            return bool(_pp.manual_list())
        return bool(_pp.api_url())
    except Exception:
        return False


# ---------------- 告警记录（任务连续失败等） ----------------
def _record_alert(kind: str, message: str) -> None:
    alerts = _load("alerts", []) or []
    alerts.append({
        "kind": kind,
        "message": str(message)[:500],
        "created_at": _now(),
    })
    # 环形缓冲，最多保留 200 条
    _save("alerts", alerts[-200:])


def _list_alerts() -> list:
    return _load("alerts", []) or []


# ---------------- 卡池自动支付扫描（watcher 线程与测试共用） ----------------
_CARD_POOL_PAID_KEY = "card_pool_auto_paid"   # {account_id: 最近尝试时间}
_CARD_POOL_RETRY_WINDOW = 600                 # 失败后至少隔 10 分钟再自动重试


def card_pool_auto_pay_scan() -> int:
    """扫描提链成功的账号，自动从卡池发起支付。返回本次入队数。

    幂等：已入队/执行中的邮箱跳过；处理过的账号在 10 分钟窗口内不重复触发。
    """
    from core import card_pool as _m
    from core import payment_executor as _pe
    if not _m.enabled() or not _m.settings()["auto_pay"]:
        return 0
    paid = _load(_CARD_POOL_PAID_KEY, {}) or {}
    now = datetime.now()
    running_emails = {
        str(j.get("email") or "").lower()
        for j in _m.list_jobs(status="queued", limit=500)
    } | {
        str(j.get("email") or "").lower()
        for j in _m.list_jobs(status="running", limit=500)
    }
    method_pref = _m.settings()["pay_method"]
    enqueued = 0
    # 分页扫描提链成功的账号
    offset = 0
    while offset < 5000:
        accounts = db.list_accounts(limit=200, offset=offset, archived=False)
        if not accounts:
            break
        for acc in accounts:
            acc_id = int(acc.get("id") or 0)
            email = str(acc.get("email") or "")
            link = str(acc.get("extract_link_long_url") or "").strip()
            if not acc_id or not email or not link:
                continue
            if str(acc.get("extract_link_status") or "") != "success":
                continue
            if email.lower() in running_emails:
                continue
            last_ts = paid.get(str(acc_id))
            if last_ts:
                try:
                    if (now - datetime.fromisoformat(str(last_ts))).total_seconds() < _CARD_POOL_RETRY_WINDOW:
                        continue
                except Exception:
                    pass
            # 方式选择：auto → 有可用卡用卡，否则用 PayPal；card/paypal → 固定
            method = method_pref
            if method not in ("card", "paypal"):
                method = "card"
                if not _m.list_cards(status="active") and _m.list_paypal(status="active"):
                    method = "paypal"
            if method == "card" and not _m.list_cards(status="active"):
                method = "paypal"
            if method == "paypal" and not _m.list_paypal(status="active"):
                continue
            try:
                job = _m.create_job(link=link, method=method, email=email, source="auto")
                paid[str(acc_id)] = _now()
                _save(_CARD_POOL_PAID_KEY, paid)
                _pe.submit_payment_job(int(job["id"]))
                enqueued += 1
                logger.info("[卡池自动支付] 账号 %s 提链成功，已入队 #%s", email, job["id"])
            except Exception:
                logger.exception("[卡池自动支付] 入队失败 account_id=%s", acc_id)
        offset += 200
    return enqueued


# ---------------- Codex 测活（check-local 结果持久化） ----------------
_CODEX_CHECKS_FILE = "codex_checks"


def _load_codex_checks() -> dict:
    return _load(_CODEX_CHECKS_FILE, {}) or {}


def _save_codex_check(filename: str, result: dict) -> None:
    checks = _load_codex_checks()
    checks[filename] = result
    _save(_CODEX_CHECKS_FILE, checks)


def _run_codex_check(filename: str, model: str, prompt: str, timeout: int) -> dict:
    """用本地 codex 凭证直连模型接口试聊（gpt-5.5 等），返回 check_* 结果。"""
    try:
        content, real = db.read_codex_credential(filename)
        data = json.loads(content)
    except Exception as exc:
        return {"check_status": "failed", "check_ok": False, "check_alive": False,
                "check_message": f"读取失败: {exc}", "check_reply": "", "check_latency_ms": None}
    token = data.get("access_token") or ""
    if not token:
        return {"check_status": "failed", "check_ok": False, "check_alive": False,
                "check_message": "无 access_token", "check_reply": "", "check_latency_ms": None}
    url = data.get("api_base") or "https://api.openai.com/v1/chat/completions"
    try:
        import requests
        t0 = time.time()
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {token}"},
            json={"model": model, "messages": [{"role": "user", "content": prompt or "hi"}], "max_tokens": 8},
            timeout=timeout,
        )
        elapsed = round((time.time() - t0) * 1000, 1)
        body = resp.text[:300]
        if resp.status_code == 200:
            return {"check_status": "ok", "check_ok": True, "check_alive": True,
                    "check_message": "试聊成功", "check_reply": body, "check_latency_ms": elapsed}
        if resp.status_code in (401, 403):
            return {"check_status": "failed", "check_ok": False, "check_alive": False,
                    "check_message": f"HTTP {resp.status_code} 凭证无效", "check_reply": body, "check_latency_ms": elapsed}
        if resp.status_code == 429:
            return {"check_status": "quota", "check_ok": False, "check_alive": True,
                    "check_message": "额度限制", "check_reply": body, "check_latency_ms": elapsed}
        return {"check_status": "failed", "check_ok": False, "check_alive": False,
                "check_message": f"HTTP {resp.status_code}", "check_reply": body, "check_latency_ms": elapsed}
    except Exception as exc:
        return {"check_status": "failed", "check_ok": False, "check_alive": False,
                "check_message": f"{type(exc).__name__}: {exc}", "check_reply": "", "check_latency_ms": None}


def enrich_codex_rows(rows: list) -> list:
    """把持久化的测活结果合并进 /api/codex 列表行（含 has_refresh_token）。"""
    checks = _load_codex_checks()
    codex_dir = Path(__file__).resolve().parent.parent / "codex_accounts"
    for row in rows:
        fname = row.get("filename", "")
        ck = checks.get(fname) or {}
        row["check_status"] = ck.get("check_status", "unchecked")
        row["check_ok"] = bool(ck.get("check_ok"))
        row["check_alive"] = bool(ck.get("check_alive"))
        row["check_message"] = ck.get("check_message", "")
        row["check_reply"] = ck.get("check_reply", "")
        row["check_latency_ms"] = ck.get("check_latency_ms")
        row["checked_at"] = ck.get("checked_at")
        row["has_refresh_token"] = False
        pth = codex_dir / fname
        if pth.exists():
            try:
                cdata = json.loads(pth.read_text(encoding="utf-8"))
                row["has_refresh_token"] = bool(cdata.get("refresh_token"))
            except Exception:
                pass
    return rows


# ============================================================
# 系统信息
# ============================================================
def _system_metrics():
    """读取 /proc 的轻量指标；非 Linux（如开发机）优雅降级。"""
    m = {
        "available": True, "ok": True, "reason": None, "source": "linux_proc",
        "cpu_count": 1, "cpu_percent": 0.0, "memory_total_bytes": 0,
        "memory_used_bytes": 0, "memory_available_bytes": 0, "memory_percent": 0.0,
        "disk_total_bytes": 0, "disk_used_bytes": 0, "disk_available_bytes": 0,
        "disk_percent": 0.0, "registration_disk_low": False,
        "cgroup_memory_current_bytes": None, "cgroup_memory_limit_bytes": None,
        "recommended_registration_workers": 1,
        "registration_cpu_idle_percent": 100.0,
        "registration_memory_available_bytes": 0, "registration_memory_bytes": 0,
        "registration_recommendation_estimated": True,
        "registration_executor": {"requested_workers": 0, "effective_workers": 0},
        "resource_governor": {
            "stopped": False, "paused": False, "memory_ratio": 0.0,
            "codex": {"active": 0, "limit": 2, "waiting": 0},
            "registration": {"active": 0, "limit": 50, "waiting": 0},
            "sentinel": {"active": 0, "limit": 1, "waiting": 0},
        },
        "sampled_at": datetime.now().strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    try:
        # CPU 核数
        try:
            with open("/proc/cpuinfo") as f:
                m["cpu_count"] = f.read().count("processor\t:")
        except OSError:
            m["cpu_count"] = os.cpu_count() or 1
        # 内存
        try:
            with open("/proc/meminfo") as f:
                for line in f:
                    k, _, v = line.partition(":")
                    val = int(v.strip().split()[0]) * 1024
                    if k == "MemTotal":
                        m["memory_total_bytes"] = val
                    elif k == "MemAvailable":
                        m["memory_available_bytes"] = val
            m["memory_used_bytes"] = m["memory_total_bytes"] - m["memory_available_bytes"]
            if m["memory_total_bytes"]:
                m["memory_percent"] = round(m["memory_used_bytes"] / m["memory_total_bytes"] * 100, 1)
        except OSError:
            m["reason"] = "当前环境无 /proc 数据源（如 macOS 本地开发），系统指标不可用"
        # CPU 使用（1 秒采样，尽力而为）
        try:
            def _cpu_times():
                with open("/proc/stat") as f:
                    parts = f.readline().split()[1:]
                vals = [int(x) for x in parts]
                return sum(vals), sum(vals[:3]) + (vals[3] if len(vals) > 3 else 0)
            t0_total, t0_idle = _cpu_times()
            time.sleep(1.0)
            t1_total, t1_idle = _cpu_times()
            if t1_total > t0_total:
                idle = (t1_idle - t0_idle) / (t1_total - t0_total)
                m["cpu_percent"] = round(max(0.0, 1.0 - idle) * 100, 1)
                m["registration_cpu_idle_percent"] = round(idle * 100, 1)
        except (OSError, ValueError, IndexError):
            pass
        # 磁盘
        try:
            import shutil
            usage = shutil.disk_usage("/")
            m["disk_total_bytes"] = usage.total
            m["disk_used_bytes"] = usage.used
            m["disk_available_bytes"] = usage.free
            if usage.total:
                m["disk_percent"] = round(usage.used / usage.total * 100, 1)
                m["registration_disk_low"] = usage.free < 2 * 1024 ** 3
        except OSError:
            pass
        # cgroup v2
        try:
            cur = Path("/sys/fs/cgroup/memory.current")
            lim = Path("/sys/fs/cgroup/memory.max")
            if cur.exists():
                m["cgroup_memory_current_bytes"] = int(cur.read_text().strip())
            if lim.exists():
                raw = lim.read_text().strip()
                m["cgroup_memory_limit_bytes"] = None if raw == "max" else int(raw)
        except (OSError, ValueError):
            pass
        m["registration_memory_available_bytes"] = m["memory_available_bytes"]
        m["registration_memory_bytes"] = m["memory_total_bytes"]
        if m["memory_total_bytes"]:
            m["memory_ratio"] = round(m["memory_used_bytes"] / m["memory_total_bytes"], 4)
    except Exception:
        m["available"] = False
        m["reason"] = "metrics_unavailable"
    # 执行器（尽力读取当前配置）
    try:
        from config import REGISTER_WORKERS
        m["registration_executor"]["requested_workers"] = int(REGISTER_WORKERS)
        m["registration_executor"]["effective_workers"] = int(REGISTER_WORKERS)
        m["recommended_registration_workers"] = max(1, m["cpu_count"] * 2)
    except Exception:
        pass
    return m


# ============================================================
# 账号扩展（import / delete / copy / archive / export）
# ============================================================
_ACCOUNT_IMPORT_FIELDS = ["email", "password", "client_id", "refresh_token", "totp_secret"]


def _parse_account_line(line: str, delimiter: str, fields: list) -> dict | None:
    parts = [p.strip() for p in line.split(delimiter)]
    if len(parts) < 1 or not parts[0]:
        return None
    email = parts[0]
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return None
    row = {"email": email}
    for i, f in enumerate(fields[1:], start=1):
        if i < len(parts):
            row[f] = parts[i]
    return row


def _decorate_account_row(row: dict, meta: dict | None = None) -> dict:
    """基座账号行 -> 0.1.48 展示结构。"""
    meta = meta or {}
    email = row.get("email", "")
    password = row.get("password") or row.get("email_password") or ""
    client_id = row.get("client_id") or ""
    refresh_token = row.get("refresh_token") or ""
    has_any = bool(password or client_id or refresh_token)
    return {
        "id": row.get("id"),
        "email": email,
        "display_identity": row.get("display_identity") or email,
        "login_identifier": email,
        "login_type": "email",
        "phone_number": None,
        "user_name": row.get("user_name"),
        "plan_type": row.get("plan_type"),
        "has_password": bool(password),
        "has_access_token": bool(row.get("access_token")),
        "has_twofa": bool(row.get("totp_secret")),
        "has_copy_line": bool(has_any or row.get("access_token")),
        "codex_status": row.get("codex_status"),
        "codex_error": row.get("codex_error"),
        "trial_check_status": meta.get("trial_check_status", "unchecked"),
        "trial_eligibility_status": meta.get("trial_eligibility_status", "unchecked"),
        "trial_check_error": meta.get("trial_check_error"),
        "archive_category_id": meta.get("archive_category_id"),
        "archive_category_name": meta.get("archive_category_name"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "email_source": row.get("email_source"),
    }


def _accounts_meta() -> dict:
    return _load("accounts_meta", {}) or {}


def _account_categories() -> list:
    return _load("account_categories", []) or []


def _accounts_features() -> dict:
    return {"rt_extract_no_sms": True, "trial_check_enabled": True}


def _resolve_identities(identities: list) -> list:
    """把身份列表解析为账号行（不存在则忽略）。"""
    out = []
    with db._LOCK:
        rows = db._load_accounts()
        by_email = {r.get("email"): r for r in rows}
        for ident in identities or []:
            r = by_email.get(ident)
            if r is not None:
                out.append(r)
    return out



# ---------------- 代理地址解析（/api/proxy/test 复用） ----------------
# 支持 http/https/socks4/socks5/socks5h 前缀、带认证（http://user:pass@host:port）、
# IPv6（[::1]:7897）与裸 host:port。
_PROXY_DEFAULT_PORTS = {"http": 80, "https": 443, "socks4": 1080, "socks5": 1080, "socks5h": 1080}


def _parse_proxy_address(raw):
    """解析代理地址 → (host, port, scheme, proxy_url)；不合法返回 None。

    支持：http(s)://、socks4/5/socks5h://（可带 user:pass@）、
    [IPv6]:port、裸 host:port。统一用 urlparse 处理（"//" 前缀技巧）。"""
    from urllib.parse import urlparse as _up
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        if "://" in text:
            parsed = _up(text)
            scheme = (parsed.scheme or "").lower()
            if scheme not in _PROXY_DEFAULT_PORTS:
                return None
        else:
            parsed = _up("//" + text)  # 裸地址按 http 解析
            scheme = "http"
        if not parsed.hostname or any(ch.isspace() for ch in parsed.hostname):
            return None  # 含空格等非法字符 → 格式无效
        explicit_port = parsed.port  # None = URL 未写端口
        if explicit_port is None:
            if scheme.startswith("socks"):
                return None  # SOCKS 必须显式端口，避免误连错误服务
            port = _PROXY_DEFAULT_PORTS[scheme]
        else:
            port = int(explicit_port)
        if not 1 <= port <= 65535:
            return None  # 端口越界 → 格式无效
        return parsed.hostname, port, scheme, text
    except ValueError:
        return None


# ============================================================
# 注册入口
# ============================================================
def register_compat_routes(app) -> None:
    # ---------------- 注册任务终态通知观察线程 ----------------
    _JOB_NOTIFY_KEY = "notified_jobs"

    def _start_job_notify_watcher():
        import threading as _wt

        def _watch():
            notified = set(_load(_JOB_NOTIFY_KEY, []) or [])
            while True:
                try:
                    jobs = db.list_jobs(limit=100)
                    for job in jobs:
                        jid = int(job.get("id") or 0)
                        status = job.get("status")
                        if jid in notified or status not in ("completed", "success", "failed", "error"):
                            continue
                        notified.add(jid)
                        _save(_JOB_NOTIFY_KEY, sorted(notified))
                        try:
                            from webui.notify import notify_job_result
                            notify_job_result(jid, status, job.get("email"), job.get("error_message"))
                        except Exception:
                            pass
                except Exception:
                    pass
                time.sleep(15)

        _wt.Thread(target=_watch, name="job-notify", daemon=True).start()

    if not getattr(app, "_job_notify_started", False):
        app._job_notify_started = True
        _start_job_notify_watcher()

    # ---------------- 卡池自动支付观察线程 ----------------
    def _start_card_pool_pay_watcher():
        import threading as _wt

        def _watch():
            while True:
                try:
                    _pe = None
                    from core import payment_executor as _pe
                    from core import card_pool as _m
                    if _m.enabled():
                        _pe.process_queued_jobs(max_jobs=10)
                        card_pool_auto_pay_scan()
                except Exception:
                    logger.exception("卡池支付 watcher 异常")
                time.sleep(20)

        _wt.Thread(target=_watch, name="card-pool-pay", daemon=True).start()

    if not getattr(app, "_card_pool_started", False):
        app._card_pool_started = True
        _start_card_pool_pay_watcher()

    # ---------------- Agent Identity（免接码认证产物） ----------------
    @app.get("/api/accounts/agent-identities")
    def api_agent_identities_list():
        try:
            from core.agent_identity_pkg import agent_identity_store as _st
            data = _st.load_all()
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 500
        items = []
        for email, rec in sorted(data.items()):
            items.append({
                "email": rec.get("email") or email,
                "agent_runtime_id": rec.get("agent_runtime_id"),
                "account_id": rec.get("account_id"),
                "user_id": rec.get("user_id"),
                "plan_type": rec.get("plan_type"),
                "created_at": rec.get("created_at"),
                "updated_at": rec.get("updated_at"),
            })
        return jsonify({"ok": True, "items": items, "total": len(items)})

    @app.post("/api/accounts/agent-identities/export")
    def api_agent_identities_export():
        data = _json_body()
        identities = data.get("identities") or []
        try:
            from core.agent_identity_pkg import agent_identity_store as _st
            from core.agent_identity_pkg.agent_identity import build_auth_json
            store = _st.load_all()
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 500
        records = []
        for ident in identities:
            rec = store.get(str(ident).strip().lower())
            if rec:
                records.append(rec)
        if not records:
            return jsonify({"ok": False, "error": "没有可导出的 Agent Identity"}), 404
        if len(records) == 1:
            rec = records[0]
            auth = build_auth_json(
                agent_runtime_id=str(rec.get("agent_runtime_id") or ""),
                private_key_b64=str(rec.get("agent_private_key") or ""),
                account_id=str(rec.get("account_id") or ""),
                user_id=str(rec.get("user_id") or ""),
                email=str(rec.get("email") or ""),
                plan_type=str(rec.get("plan_type") or "free"),
            )
            fname = f"auth-{rec.get('email') or 'agent'}-{int(time.time())}.json"
            return Response(
                json.dumps(auth, ensure_ascii=False, indent=2),
                mimetype="application/json",
                headers={"Content-Disposition": f'attachment; filename="{fname}"'},
            )
        # 多个：打包 zip（email/auth.json）
        import io
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
            for rec in records:
                auth = build_auth_json(
                    agent_runtime_id=str(rec.get("agent_runtime_id") or ""),
                    private_key_b64=str(rec.get("agent_private_key") or ""),
                    account_id=str(rec.get("account_id") or ""),
                    user_id=str(rec.get("user_id") or ""),
                    email=str(rec.get("email") or ""),
                    plan_type=str(rec.get("plan_type") or "free"),
                )
                archive.writestr(
                    f"{rec.get('email') or 'agent'}/auth.json",
                    json.dumps(auth, ensure_ascii=False, indent=2),
                )
        return Response(
            buf.getvalue(),
            mimetype="application/zip",
            headers={"Content-Disposition": f'attachment; filename="agent-identities-{int(time.time())}.zip"'},
        )

    # ---------------- 系统 ----------------
    @app.get("/api/system/alerts")
    def api_system_alerts():
        return jsonify({"ok": True, "items": _list_alerts(), "total": len(_list_alerts())})

    @app.get("/api/version")
    def api_version():
        return jsonify({
            "build_sha": BUILD_SHA,
            "build_time": BUILD_TIME,
            "changelog": "# v0.1.48-compat 自建版\n\n基于开源基座复刻，兼容 0.1.48 前端契约。",
            "checked_at": datetime.now().strftime("%m-%d %H:%M:%S"),
            "current": APP_VERSION,
            "latest": APP_VERSION,
            "update_available": False,
            "update_enabled": False,
            "source": "self-built",
            "release_url": "",
            "release_notes": None,
            "deployment_updater": {
                "available": False,
                "mode": "none",
                "state": {"status": "disabled", "version": APP_VERSION, "commit_sha": BUILD_SHA},
            },
        })

    @app.get("/api/system/metrics")
    def api_system_metrics():
        return jsonify(_system_metrics())

    @app.post("/api/update/start")
    def api_update_start():
        return jsonify({"ok": False, "error": "更新功能未启用", "error_code": "update_disabled"}), 501

    # ---------------- 任务扩展 ----------------
    @app.get("/api/jobs/defaults")
    def api_jobs_defaults():
        workers = 3
        try:
            from config import REGISTER_WORKERS
            workers = int(REGISTER_WORKERS)
        except Exception:
            pass
        return jsonify({
            "ok": True,
            "count": 1,
            "workers": workers,
            "effective_workers": workers,
            "mode": "email",
            "email_source": "buygptpuls_temp",
            "phone_sms_source": "platform",
            "proxy_configured": _proxy_configured(),
        })

    @app.get("/api/jobs/logs")
    def api_jobs_logs():
        job_limit = request.args.get("job_limit", default=40, type=int)
        max_lines = request.args.get("max_lines", default=200, type=int)
        jobs = db.list_jobs(limit=job_limit)
        entries = []
        for job in jobs:
            log_file = job.get("log_file") or ""
            lines = []
            if log_file:
                p = Path(log_file)
                if p.exists():
                    try:
                        raw = p.read_text(encoding="utf-8", errors="replace").splitlines()
                        lines = raw[-max_lines:]
                    except OSError:
                        pass
            if job.get("error_message"):
                lines.append(f"[Job {job.get('id')}] ERROR: {job['error_message']}")
            for ln in lines:
                entries.append({
                    "job_id": job.get("id"),
                    "legacy": False,
                    "level": "error" if "ERROR" in ln else "info",
                    "line": ln,
                    "message_key": None,
                    "message_params": {},
                    "raw_detail": None,
                    "seq": len(entries) + 1,
                    "source_job_id": None,
                    "status": job.get("status"),
                    "thread": "reg-worker",
                    "time": (job.get("created_at") or "")[11:19],
                })
        signature = hashlib.md5(
            json.dumps(entries, ensure_ascii=False).encode()
        ).hexdigest()[:16]
        return jsonify({
            "ok": True,
            "signature": signature,
            "entries": entries,
            "job_count": len(jobs),
            "legacy": False,
            "line_limit": max_lines,
            "truncated": False,
        })

    @app.post("/api/jobs/resume-pending")
    def api_jobs_resume_pending():
        """恢复排队任务：重新提交到线程池（重启后队列恢复入口）。"""
        try:
            from core.registration_service import resume_pending_jobs as _resume
            n = _resume()
        except Exception as exc:
            return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500
        return jsonify({"ok": True, "resumed": n})

    @app.post("/api/jobs/mark-running-failed")
    def api_jobs_mark_running_failed():
        with db._LOCK:
            rows = db._load_jobs()
            n = 0
            for r in rows:
                if r.get("status") == "running":
                    r["status"] = "failed"
                    r["error_message"] = r.get("error_message") or "手动标记为失败"
                    n += 1
            db._save_jobs(rows)
        return jsonify({"ok": True, "marked": n})

    @app.post("/api/jobs/delete-failed")
    def api_jobs_delete_failed():
        with db._LOCK:
            rows = db._load_jobs()
            keep = [r for r in rows if r.get("status") != "failed"]
            n = len(rows) - len(keep)
            db._save_jobs(keep)
        return jsonify({"ok": True, "deleted": n})

    @app.post("/api/jobs/clear-all")
    def api_jobs_clear_all():
        with db._LOCK:
            db._save_jobs([])
        return jsonify({"ok": True, "deleted": "all"})

    # ---------------- 邮箱池扩展 ----------------
    @app.post("/api/outlook/export")
    def api_outlook_export():
        rows = db.list_outlook_pool(limit=100000)
        lines = []
        for r in rows:
            parts = [r.get("email", ""), r.get("password", ""), r.get("client_id", ""), r.get("refresh_token", "")]
            lines.append(":".join(str(x or "") for x in parts))
        text = "\n".join(lines)
        return Response(
            text,
            mimetype="text/plain",
            headers={"Content-Disposition": f'attachment; filename="outlook-pool-{int(time.time())}.txt"'},
        )

    @app.post("/api/outlook/bulk-delete")
    def api_outlook_bulk_delete():
        data = _json_body()
        emails = data.get("emails") or data.get("identities") or []
        with db._LOCK:
            rows = db._load_outlook()
            keep = [r for r in rows if r.get("email") not in set(emails)]
            n = len(rows) - len(keep)
            db._save_outlook(keep)
            db._sync_outlook_txt(keep)
        return jsonify({"ok": True, "deleted": n})

    @app.post("/api/outlook/clear")
    def api_outlook_clear():
        with db._LOCK:
            db._save_outlook([])
            db._sync_outlook_txt([])
        return jsonify({"ok": True, "cleared": "all"})

    @app.post("/api/outlook/split")
    def api_outlook_split():
        data = _json_body()
        rows = db.list_outlook_pool(limit=100000)
        # 0.1.48 的 split 按规则拆分池子；此处返回统计即可
        return jsonify({
            "ok": True,
            "total": len(rows),
            "groups": {"all": len(rows)},
            "skipped": 0,
        })

    # ---------------- API OTP 邮箱池 ----------------
    @app.get("/api/api-otp-mail")
    def api_otp_mail_list():
        rows = _load("api_otp_mail", []) or []
        rows = sorted(rows, key=lambda r: r.get("created_at", ""), reverse=True)
        page = request.args.get("page", default=1, type=int)
        page_size = request.args.get("page_size", default=20, type=int)
        total = len(rows)
        status = {"total": total, "available": total, "used": 0, "failed": 0, "copy_bytes": 0}
        return jsonify({
            "ok": True,
            "failure_limit": 3,
            "items": rows[(page - 1) * page_size: page * page_size],
            "summary": status,
            "pagination": {
                "page": page, "page_size": page_size,
                "pages": max(1, (total + page_size - 1) // page_size),
                "total": total, "has_next": page * page_size < total,
                "has_prev": page > 1,
            },
        })

    @app.post("/api/api-otp-mail/import")
    def api_otp_mail_import():
        data = _json_body()
        text = str(data.get("text") or "")
        size_err = _check_import_size(text)
        if size_err:
            return jsonify({"ok": False, "error": size_err, "error_code": "import_too_large"}), 413
        rows = _load("api_otp_mail", []) or []
        existing = {r.get("email") for r in rows}
        inserted = skipped = 0
        for line in text.splitlines():
            line = line.strip()
            if not line or "@" not in line:
                skipped += 1
                continue
            # 0.1.48 格式：邮箱----接码api地址（兼容空格分隔）
            parts = line.split("----") if "----" in line else line.split()
            email = parts[0]
            api_url = parts[1] if len(parts) > 1 else ""
            if email in existing:
                skipped += 1
                continue
            row = {"email": email, "api_url": api_url, "created_at": _now(), "status": "available"}
            rows.append(row)
            existing.add(email)
            inserted += 1
        _save("api_otp_mail", rows)
        return jsonify({"ok": True, "inserted": inserted, "skipped": skipped, "updated": 0})

    @app.post("/api/api-otp-mail/status")
    def api_otp_mail_status():
        data = _json_body()
        email = str(data.get("email") or "")
        rows = _load("api_otp_mail", []) or []
        row = next((r for r in rows if r.get("email") == email), None)
        return jsonify({"ok": True, "email": email, "status": (row or {}).get("status", "unknown")})

    @app.post("/api/api-otp-mail/delete")
    def api_otp_mail_delete():
        data = _json_body()
        email = str(data.get("email") or "")
        rows = _load("api_otp_mail", []) or []
        rows = [r for r in rows if r.get("email") != email]
        _save("api_otp_mail", rows)
        return jsonify({"ok": True, "deleted": 1 if email else 0})

    @app.post("/api/api-otp-mail/bulk-delete")
    def api_otp_mail_bulk_delete():
        data = _json_body()
        emails = set(data.get("emails") or data.get("identities") or [])
        rows = _load("api_otp_mail", []) or []
        keep = [r for r in rows if r.get("email") not in emails]
        n = len(rows) - len(keep)
        _save("api_otp_mail", keep)
        return jsonify({"ok": True, "deleted": n})

    @app.post("/api/api-otp-mail/clear")
    def api_otp_mail_clear():
        _save("api_otp_mail", [])
        return jsonify({"ok": True, "cleared": "all"})

    @app.post("/api/api-otp-mail/export")
    def api_otp_mail_export():
        rows = _load("api_otp_mail", []) or []
        text = "\n".join(
            f"{r.get('email', '')}----{r.get('api_url', '')}" for r in rows
        )
        return Response(
            text, mimetype="text/plain",
            headers={"Content-Disposition": f'attachment; filename="api-otp-mail-{int(time.time())}.txt"'},
        )

    # ---------------- 账号扩展 ----------------
    @app.get("/api/accounts/filters")
    def api_accounts_filters():
        return jsonify({"ok": True, "features": _accounts_features(), "sources": []})

    @app.get("/api/accounts/count")
    def api_accounts_count():
        return jsonify({"ok": True, "total": db.count_accounts()})

    @app.get("/api/accounts/custom-io/fields")
    def api_accounts_custom_io_fields():
        return jsonify({"ok": True, "fields": _ACCOUNT_IMPORT_FIELDS})

    @app.post("/api/accounts/import")
    def api_accounts_import():
        data = _json_body()
        fmt = str(data.get("format") or "txt")
        text = str(data.get("text") or "")
        size_err = _check_import_size(text)
        if size_err:
            return jsonify({"ok": False, "error": size_err, "error_code": "import_too_large"}), 413
        delimiter = str(data.get("delimiter") or ":")
        fields = data.get("fields") or ["email", "password", "client_id", "refresh_token"]
        overwrite = bool(data.get("overwrite"))
        if fmt not in ("txt", "json"):
            return jsonify({"ok": False, "error": "导出/导入格式仅支持 txt 或 json"}), 400
        records = []
        if fmt == "txt":
            for line in text.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                rec = _parse_account_line(line, delimiter, fields)
                if rec:
                    records.append(rec)
        else:
            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    records = parsed
            except json.JSONDecodeError:
                return jsonify({"ok": False, "error": "JSON 解析失败"}), 400
        items, inserted, updated, skipped = [], 0, 0, 0
        with db._LOCK:
            rows = db._load_accounts()
            by_email = {r.get("email"): r for r in rows}
            for idx, rec in enumerate(records, start=1):
                email = rec.get("email")
                if not email or "@" not in email:
                    skipped += 1
                    items.append({"index": idx, "identity": email, "action": "skipped", "ok": False})
                    continue
                existing = by_email.get(email)
                if existing is not None and not overwrite:
                    skipped += 1
                    items.append({"index": idx, "identity": email, "action": "skipped", "ok": False})
                    continue
                if existing is None:
                    row = {"id": db._next_id(rows), "email": email, "created_at": _now()}
                    rows.append(row)
                    by_email[email] = row
                    inserted += 1
                    action = "inserted"
                else:
                    action = "updated"
                    updated += 1
                for key in ("password", "client_id", "refresh_token", "totp_secret"):
                    if rec.get(key) is not None:
                        row[key] = rec[key]
                row["updated_at"] = _now()
                row["copy_line"] = ":".join(str(row.get(k) or "") for k in ("email", "password", "client_id", "refresh_token"))
                items.append({
                    "index": idx, "identity": email, "action": action, "ok": True,
                    "id": row["id"],
                    "changed_fields": [k for k in ("password", "client_id", "refresh_token") if rec.get(k) is not None],
                })
            db._save_accounts(rows)
        return jsonify({
            "ok": True, "inserted": inserted, "updated": updated, "skipped": skipped,
            "parsed": len(records), "overwrite": overwrite, "items": items, "errors": [],
        })

    @app.post("/api/accounts/delete-selected")
    def api_accounts_delete_selected():
        data = _json_body()
        identities = set(data.get("identities") or [])
        with db._LOCK:
            rows = db._load_accounts()
            keep = [r for r in rows if r.get("email") not in identities]
            n = len(rows) - len(keep)
            db._save_accounts(keep)
            db._sync_accounts_txt(keep)
        return jsonify({"ok": True, "deleted": n})

    @app.post("/api/accounts/delete-all")
    def api_accounts_delete_all():
        with db._LOCK:
            db._save_accounts([])
            db._sync_accounts_txt([])
        return jsonify({"ok": True, "deleted": "all"})

    @app.post("/api/accounts/delete-failed")
    def api_accounts_delete_failed():
        with db._LOCK:
            rows = db._load_accounts()
            keep = [r for r in rows if r.get("codex_status") != "failed"]
            n = len(rows) - len(keep)
            db._save_accounts(keep)
        return jsonify({"ok": True, "deleted": n})

    @app.post("/api/accounts/copy-value")
    def api_accounts_copy_value():
        data = _json_body()
        identity = str(data.get("identity") or "")
        field = str(data.get("field") or "")
        with db._LOCK:
            row = next((r for r in db._load_accounts() if r.get("email") == identity), None)
        if row is None:
            return jsonify({"ok": False, "error": f"账号不存在: {identity}"}), 404
        value = row.get(field, "")
        if field == "copy_line":
            value = row.get("copy_line", "")
        return jsonify({"ok": True, "value": value or ""})

    @app.post("/api/accounts/copy-values")
    def api_accounts_copy_values():
        data = _json_body()
        identities = data.get("identities") or []
        lines = []
        with db._LOCK:
            by_email = {r.get("email"): r for r in db._load_accounts()}
        for ident in identities:
            row = by_email.get(ident)
            if row:
                lines.append(row.get("copy_line") or ident)
        return jsonify({"ok": True, "values": lines})

    # ---- 归档分类 ----
    @app.get("/api/account-archive-categories")
    def api_archive_categories_list():
        cats = _account_categories()
        return jsonify({"ok": True, "items": cats, "total_count": len(cats), "unarchived_count": 0})

    @app.post("/api/account-archive-categories")
    def api_archive_categories_create():
        data = _json_body()
        name = str(data.get("name") or "").strip()
        if not name:
            return jsonify({"ok": False, "error": "分类名称为空"}), 400
        if len(name) > 32:
            return jsonify({"ok": False, "error": "分类名称最多 32 个字符"}), 400
        cats = _account_categories()
        cat = {
            "id": max([c.get("id", 0) for c in cats], default=0) + 1,
            "name": name,
            "note": str(data.get("note") or ""),
            "account_count": 0,
            "created_at": _now(),
            "updated_at": _now(),
        }
        cats.append(cat)
        _save("account_categories", cats)
        return jsonify({"ok": True, "item": cat})

    @app.delete("/api/account-archive-categories/<int:category_id>")
    def api_archive_categories_delete(category_id: int):
        cats = _account_categories()
        cat = next((c for c in cats if c.get("id") == category_id), None)
        if cat is None:
            return jsonify({"ok": False, "error": "分类不存在"}), 404
        cats = [c for c in cats if c.get("id") != category_id]
        _save("account_categories", cats)
        return jsonify({"ok": True, "result": {"id": category_id, "name": cat.get("name"), "reset_count": 0}})

    @app.put("/api/account-archive-categories/<int:category_id>")
    def api_archive_categories_update(category_id: int):
        data = _json_body()
        cats = _account_categories()
        cat = next((c for c in cats if c.get("id") == category_id), None)
        if cat is None:
            return jsonify({"ok": False, "error": "分类不存在"}), 404
        if data.get("name") is not None:
            cat["name"] = str(data["name"]).strip()
        if data.get("note") is not None:
            cat["note"] = str(data["note"])
        cat["updated_at"] = _now()
        _save("account_categories", cats)
        return jsonify({"ok": True, "item": cat})

    @app.post("/api/accounts/archive")
    def api_accounts_archive():
        data = _json_body()
        identities = set(data.get("identities") or [])
        category_id = data.get("category_id")
        meta = _accounts_meta()
        cats = _account_categories()
        for ident in identities:
            m = meta.setdefault(ident, {})
            if category_id is None:
                m.pop("archive_category_id", None)
                m.pop("archive_category_name", None)
            else:
                cat = next((c for c in cats if c.get("id") == int(category_id)), None)
                if cat:
                    m["archive_category_id"] = cat["id"]
                    m["archive_category_name"] = cat["name"]
        _save("accounts_meta", meta)
        return jsonify({"ok": True, "archived": len(identities)})

    @app.post("/api/accounts/custom-export")
    def api_accounts_custom_export():
        data = _json_body()
        fmt = str(data.get("format") or "txt")
        fields = data.get("fields") or ["email", "password", "client_id", "refresh_token"]
        delimiter = str(data.get("delimiter") or ":")
        scope = str(data.get("scope") or "filtered")
        identities = data.get("identities") or []
        include_header = bool(data.get("include_header"))
        if scope not in ("selected", "filtered"):
            return jsonify({"ok": False, "error": "scope 仅支持 selected / filtered"}), 400
        if fmt not in ("txt", "json", "csv"):
            return jsonify({"ok": False, "error": "导出格式仅支持 txt / json / csv"}), 400
        with db._LOCK:
            rows = db._load_accounts()
        if scope == "selected":
            rows = [r for r in rows if r.get("email") in set(identities)]

        def _csv_safe(value: str) -> str:
            # 防 CSV 公式注入：= + - @ 开头的值加单引号前缀（Excel/Sheets 会执行公式）
            sval = str(value or "")
            if sval and sval[0] in ("=", "+", "-", "@"):
                return "'" + sval
            return sval

        lines = []
        if include_header:
            lines.append(delimiter.join(fields))
        for r in rows:
            parts = []
            for f in fields:
                v = r.get(f)
                if f == "email" and v is None:
                    v = r.get("email")
                val = str(v or "")
                if fmt == "csv":
                    val = _csv_safe(val)
                parts.append(val)
            lines.append(delimiter.join(parts))
        text = "\n".join(lines)
        mime = "application/json" if fmt == "json" else "text/plain"
        return Response(
            text, mimetype=mime,
            headers={"Content-Disposition": f'attachment; filename="accounts-export-{int(time.time())}.{fmt}"'},
        )

    @app.post("/api/accounts/rt-extract/download")
    def api_accounts_rt_extract_download():
        data = _json_body()
        target = str(data.get("target") or "")
        if target not in ("cpa", "sub2api"):
            return jsonify({"ok": False, "error": "target 仅支持 cpa / sub2api"}), 400
        scope = str(data.get("scope") or "filtered")
        identities = data.get("identities") or []
        with db._LOCK:
            rows = db._load_accounts()
        if scope == "selected":
            rows = [r for r in rows if r.get("email") in set(identities)]
        bundle = []
        for r in rows:
            entry = {
                "email": r.get("email"),
                "email_password": r.get("password") or "",
                "client_id": r.get("client_id") or "",
                "refresh_token": r.get("refresh_token") or "",
                "access_token": r.get("access_token") or "",
            }
            if target == "cpa":
                bundle.append({"identity": r.get("email"), "credential": entry})
            else:
                bundle.append(entry)
        fname = f"rt-extract-{target}-{int(time.time())}.json"
        return Response(
            json.dumps({"exported_at": _now(), "count": len(bundle), "items": bundle}, ensure_ascii=False, indent=2),
            mimetype="application/json",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    @app.post("/api/accounts/access-token/relogin")
    def api_accounts_relogin():
        """尽力而为的 token 刷新：验证现有 token 有效性；无效则标记失败（无法自动重登）。"""
        data = _json_body()
        identities = data.get("identities") or []
        scope = str(data.get("scope") or "selected")
        if scope == "selected":
            rows = _resolve_identities(identities)
        else:  # all / filtered → 全量账号
            with db._LOCK:
                rows = db._load_accounts()
        if not rows:
            return jsonify({
                "ok": False,
                "error": "没有找到可操作的账号",
                "message_key": "legacy.account-bulk-scope.c478a149cf7c",
                "message_params": {},
            }), 404
        items = []
        ok_count = failed = 0
        try:
            import requests as _req
            proxy = _proxy_for_task()
            proxies = {"http": proxy, "https": proxy} if proxy else None
        except Exception:
            proxies = None
        for row in rows:
            email = row.get("email", "")
            token = row.get("access_token") or ""
            item = {"identity": email, "status": "failed", "error": None}
            if not token:
                item["error"] = "账号无 access_token"
            else:
                try:
                    resp = _req.get(
                        "https://chatgpt.com/backend-api/me",
                        headers={"Authorization": f"Bearer {token}"},
                        timeout=15, proxies=proxies,
                    )
                    if resp.status_code == 200:
                        item["status"] = "success"
                        ok_count += 1
                    else:
                        item["status"] = "failed"
                        item["error"] = f"token 无效（HTTP {resp.status_code}），需要重新注册或手动处理"
                        failed += 1
                        with db._LOCK:
                            rows_db = db._load_accounts()
                            for r in rows_db:
                                if r.get("email") == email:
                                    r["codex_status"] = "failed"
                                    r["codex_error"] = item["error"]
                            db._save_accounts(rows_db)
                except Exception as exc:
                    item["error"] = f"{type(exc).__name__}: {str(exc)[:120]}"
                    failed += 1
            items.append(item)
        return jsonify({
            "ok": True,
            "task": {
                "id": 0,
                "account_total": len(rows),
                "status": "completed",
                "items": items,
                "success": ok_count,
                "failed": failed,
            },
        })

    # ---------------- Codex 扩展 ----------------
    @app.post("/api/codex/delete")
    def api_codex_delete():
        data = _json_body()
        filename = str(data.get("filename") or "")
        codex_dir = Path(__file__).resolve().parent.parent / "codex_accounts"
        p = codex_dir / filename
        if not filename.startswith("codex-") or not filename.endswith(".json") or "/" in filename or "\\" in filename or ".." in filename:
            return jsonify({"ok": False, "error": "非法文件名"}), 400
        if p.exists():
            p.unlink()
            return jsonify({"ok": True, "deleted": filename})
        return jsonify({"ok": False, "error": f"文件不存在: {filename}"}), 404

    @app.post("/api/codex/check-local")
    def api_codex_check_local():
        data = _json_body()
        filenames = data.get("filenames") or []
        model = str(data.get("model") or "gpt-5.5")
        prompt = str(data.get("prompt") or "hi")
        timeout = int(data.get("timeout") or 30)
        if not filenames or not isinstance(filenames, list):
            return jsonify({"ok": False, "error": "filenames 必须是非空数组"}), 400
        items = []
        usable = alive = failed = 0
        for fname in filenames[:100]:
            result = _run_codex_check(str(fname), model, prompt, timeout)
            result["filename"] = str(fname)
            result["checked_at"] = _now()
            _save_codex_check(str(fname), result)
            if result.get("check_ok"):
                usable += 1
            if result.get("check_alive"):
                alive += 1
            if not result.get("check_alive"):
                failed += 1
            items.append(result)
        return jsonify({
            "ok": True,
            "items": items,
            "summary": {"usable": usable, "alive": alive, "failed": failed, "total": len(items)},
        })

    @app.post("/api/codex/retry-bulk")
    def api_codex_retry_bulk():
        data = _json_body()
        identities = data.get("identities") or []
        return jsonify({"ok": True, "queued": len(identities), "skipped": 0})

    @app.post("/api/codex/download-cpa")
    def api_codex_download_cpa():
        return api_codex_download_bulk_inner(_json_body(), "codex-cpa")

    @app.post("/api/codex/download-sub2api")
    def api_codex_download_sub2api():
        return api_codex_download_bulk_inner(_json_body(), "codex-sub2api")

    @app.post("/api/codex/access-token/refresh")
    def api_codex_access_token_refresh():
        """用凭证里的 refresh_token 真实刷新 access_token（OAuth refresh_token grant）。"""
        data = _json_body()
        filenames = data.get("filenames") or []
        if not filenames or not isinstance(filenames, list):
            return jsonify({"ok": False, "error": "filenames 必须是非空数组"}), 400
        items = []
        refreshed = failed = 0
        try:
            from config.codex import CODEX_TOKEN_URL, CODEX_CLIENT_ID
            import requests as _req
        except Exception:
            CODEX_TOKEN_URL, CODEX_CLIENT_ID = "https://auth.openai.com/oauth/token", "app_EMoamEEZ73f0CkXaXp7hrann"
            import requests as _req
        proxy = _proxy_for_task()
        proxies = {"http": proxy, "https": proxy} if proxy else None
        for fname in filenames[:50]:
            try:
                content, real = db.read_codex_credential(str(fname))
                data_file = json.loads(content)
                rt = str(data_file.get("refresh_token") or "").strip()
                if not rt:
                    items.append({"filename": str(fname), "ok": False, "error": "凭证无 refresh_token"})
                    failed += 1
                    continue
                resp = _req.post(
                    CODEX_TOKEN_URL,
                    data={
                        "grant_type": "refresh_token",
                        "client_id": CODEX_CLIENT_ID,
                        "refresh_token": rt,
                    },
                    timeout=30, proxies=proxies,
                )
                if resp.status_code != 200:
                    items.append({"filename": str(fname), "ok": False, "error": f"HTTP {resp.status_code}: {resp.text[:150]}"})
                    failed += 1
                    continue
                tok = resp.json()
                data_file["access_token"] = tok.get("access_token") or data_file.get("access_token")
                if tok.get("refresh_token"):
                    data_file["refresh_token"] = tok["refresh_token"]
                if tok.get("id_token"):
                    data_file["id_token"] = tok["id_token"]
                data_file["last_refresh"] = _now()
                # 原子写回凭证文件
                codex_dir = Path(__file__).resolve().parent.parent / "codex_accounts"
                out = codex_dir / real
                tmp = out.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(data_file, ensure_ascii=False, indent=2), encoding="utf-8")
                tmp.replace(out)
                items.append({"filename": str(fname), "ok": True, "refreshed": True})
                refreshed += 1
            except Exception as exc:
                items.append({"filename": str(fname), "ok": False, "error": f"{type(exc).__name__}: {str(exc)[:150]}"})
                failed += 1
        return jsonify({"ok": True, "success": refreshed, "failed": failed, "items": items})

    @app.get("/api/codex/sub2api/groups")
    def api_codex_sub2api_groups():
        """返回 Sub2API 分组：配置了服务地址则查询，否则用配置的 GROUP_IDS。"""
        groups = []
        try:
            from config import sub2api as _sub2_cfg
            base = str(getattr(_sub2_cfg, "SUB2API_API_BASE", "") or "").strip()
            groups_cfg = str(getattr(_sub2_cfg, "SUB2API_GROUP_IDS", "") or "").strip()
            if base:
                try:
                    import requests as _req
                    key = str(getattr(_sub2_cfg, "SUB2API_API_KEY", "") or "").strip()
                    header = str(getattr(_sub2_cfg, "SUB2API_API_AUTH_HEADER", "x-api-key") or "x-api-key").strip()
                    resp = _req.get(
                        f"{base.rstrip('/')}/api/v1/admin/groups",
                        headers={header: key} if key else {},
                        timeout=15, proxies={"http": _proxy_for_task(), "https": _proxy_for_task()} or None,
                    )
                    if resp.status_code == 200:
                        body = resp.json()
                        if isinstance(body, list):
                            groups = [{"id": str(g.get("id") or g.get("groupId") or g), "name": str(g.get("name") or g.get("id") or g)} for g in body]
                        elif isinstance(body, dict) and isinstance(body.get("groups"), list):
                            groups = [{"id": str(g.get("id") or g.get("groupId") or g), "name": str(g.get("name") or g.get("id") or g)} for g in body["groups"]]
                except Exception:
                    pass
            if not groups and groups_cfg:
                groups = [{"id": gid.strip(), "name": gid.strip()} for gid in groups_cfg.split(",") if gid.strip()]
        except Exception:
            pass
        return jsonify({"ok": True, "groups": groups})

    @app.post("/api/codex/upload-relay")
    def api_codex_upload_relay():
        """把本地 codex 凭证推送到 Sub2API 服务（配置了 SUB2API_API_BASE 时）。"""
        data = _json_body()
        filenames = data.get("filenames") or []
        if not filenames or not isinstance(filenames, list):
            return jsonify({"ok": False, "error": "filenames 必须是非空数组"}), 400
        try:
            from config import sub2api as _sub2_cfg
            base = str(getattr(_sub2_cfg, "SUB2API_API_BASE", "") or "").strip()
            api_url = str(getattr(_sub2_cfg, "SUB2API_API_URL", "") or "").strip()
        except Exception:
            base, api_url = "", ""
        if not (base or api_url):
            return jsonify({
                "ok": False,
                "error": "未配置 SUB2API_API_BASE，无法上传中转（凭证仍保存在本地 codex_accounts/）",
                "error_code": "sub2api_not_configured",
            }), 501
        items = []
        success = failed = 0
        try:
            import requests as _req
            key = str(getattr(_sub2_cfg, "SUB2API_API_KEY", "") or "").strip()
            token = str(getattr(_sub2_cfg, "SUB2API_API_TOKEN", "") or "").strip()
            header = str(getattr(_sub2_cfg, "SUB2API_API_AUTH_HEADER", "x-api-key") or "x-api-key").strip()
            headers = {}
            if key:
                headers[header] = key
            elif token:
                headers["Authorization"] = f"Bearer {token}"
            url = api_url or f"{base.rstrip('/')}/api/v1/admin/accounts/import/codex-session"
            proxy = _proxy_for_task()
            proxies = {"http": proxy, "https": proxy} if proxy else None
            for fname in filenames[:50]:
                try:
                    content, real = db.read_codex_credential(str(fname))
                    resp = _req.post(url, headers=headers, json=json.loads(content), timeout=30, proxies=proxies)
                    if resp.status_code in (200, 201):
                        items.append({"filename": str(fname), "ok": True, "skipped": False})
                        success += 1
                    else:
                        items.append({"filename": str(fname), "ok": False, "error": f"HTTP {resp.status_code}: {resp.text[:150]}"})
                        failed += 1
                except Exception as exc:
                    items.append({"filename": str(fname), "ok": False, "error": f"{type(exc).__name__}: {str(exc)[:150]}"})
                    failed += 1
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 500
        return jsonify({
            "ok": True, "success": success, "skipped": 0, "failed": failed, "items": items,
        })

    # ---------------- 自动化任务 ----------------
    @app.get("/api/automation-tasks")
    def api_automation_tasks_list():
        page = request.args.get("page", default=1, type=int)
        per_page = request.args.get("per_page", default=10, type=int)
        q = request.args.get("q", "").strip()
        tasks = _load("automation_tasks", []) or []
        if q:
            tasks = [t for t in tasks if q.lower() in str(t.get("task_type", "")).lower() or q.lower() in str(t.get("id", ""))]
        tasks = sorted(tasks, key=lambda t: t.get("created_at", ""), reverse=True)
        total = len(tasks)
        start = (page - 1) * per_page
        items = tasks[start:start + per_page]
        running = sum(1 for t in tasks if t.get("status") in ("queued", "running"))
        today = _now()[:10]
        today_done = sum(1 for t in tasks if t.get("status") == "completed" and str(t.get("completed_at", ""))[:10] == today)
        today_failed = sum(1 for t in tasks if t.get("status") == "failed" and str(t.get("completed_at", ""))[:10] == today)
        return jsonify({
            "ok": True, "items": items,
            "features": {"trial_check_enabled": True},
            "summary": {
                "has_active_tasks": running > 0,
                "pending": sum(1 for t in tasks if t.get("status") == "queued"),
                "running": running,
                "today_completed": today_done,
                "today_failed": today_failed,
            },
            "task_types": ["codex_retry", "access_token_relogin", "password_setup", "twofa_setup", "trial_check", "agent_identity"],
            "pagination": {
                "page": page, "page_size": per_page,
                "pages": max(1, (total + per_page - 1) // per_page),
                "total": total, "has_next": start + per_page < total,
                "has_prev": page > 1,
            },
        })

    @app.post("/api/automation-tasks")
    def api_automation_tasks_create():
        data = _json_body()
        task_type = str(data.get("task_type") or "codex_retry")
        valid_types = ("codex_retry", "access_token_relogin", "password_setup", "twofa_setup", "trial_check", "agent_identity")
        if task_type not in valid_types:
            return jsonify({
                "ok": False,
                "error": f"非法自动化任务类型: {task_type}",
                "message_key": "legacy.automation-task.461e24a9e908",
                "message_params": {"value1": task_type},
            }), 400
        scope = str(data.get("scope") or "filtered")
        identities = data.get("identities") or []
        if scope == "selected":
            rows = _resolve_identities(identities)
        else:
            with db._LOCK:
                rows = db._load_accounts()
        if not rows:
            return jsonify({
                "ok": False,
                "error": "没有找到可操作的账号",
                "message_key": "legacy.account-bulk-scope.c478a149cf7c",
                "message_params": {},
            }), 404
        tasks = _load("automation_tasks", []) or []
        identities = [r.get("email") for r in rows]
        task = {
            "id": max([t.get("id", 0) for t in tasks], default=0) + 1,
            "task_type": task_type,
            "scope": scope,
            "identities": identities,
            "filters": data.get("filters") or {},
            "workers": max(1, min(50, int(data.get("workers") or 3))),
            "status": "queued",
            "account_total": len(rows),
            "account_processed": 0,
            "account_failed": 0,
            "created_at": _now(),
            "completed_at": None,
            "items": [],
        }
        tasks.append(task)
        _save("automation_tasks", tasks)

        # 真实后台执行：按任务类型分发（codex_retry/trial_check/password_setup/twofa_setup）
        if task_type in ("codex_retry", "trial_check", "password_setup", "twofa_setup", "agent_identity"):
            import threading as _t

            def _run_one(email: str) -> dict:
                """执行单个账号的任务，返回 {ok, status, message}。"""
                if task_type == "codex_retry":
                    from core.codex_retry_service import reserve, run_worker
                    if not reserve(email):
                        return {"ok": False, "status": "skipped", "message": "该账号正在补跑中，已跳过"}
                    try:
                        res = run_worker(email, batch_label=f"task#{task['id']}", clear_log=False)
                        return {
                            "ok": bool(res.get("ok")),
                            "status": "success" if res.get("ok") else str(res.get("status") or "failed"),
                            "message": res.get("message") or "",
                        }
                    except Exception as exc:
                        return {"ok": False, "status": "failed", "message": f"{type(exc).__name__}: {exc}"}

                if task_type == "trial_check":
                    from core import db as _db
                    from core.plan_check_service import enqueue_account_plan_check
                    acc = _db.get_account_by_email(email)
                    if acc is None or not acc.get("access_token"):
                        return {"ok": False, "status": "failed", "message": "账号缺少 access_token"}
                    res = enqueue_account_plan_check(
                        account_id=int(acc.get("id") or 0),
                        email=email,
                        access_token=acc["access_token"],
                        trigger="automation_task",
                    )
                    if res.get("accepted"):
                        return {"ok": True, "status": "queued", "message": "权益查询已入队"}
                    return {"ok": False, "status": "failed", "message": res.get("error") or "权益查询队列满"}

                if task_type == "password_setup":
                    from core.mail_password_change import change_mailcom_password_for_email
                    try:
                        new_pw = change_mailcom_password_for_email(email)
                        return {"ok": True, "status": "success", "message": f"密码已更新（{new_pw[:3]}***）"}
                    except Exception as exc:
                        return {"ok": False, "status": "failed", "message": f"{type(exc).__name__}: {exc}"}

                if task_type == "access_token_relogin":
                    from core import db as _db3
                    acc = _db3.get_account_by_email(email)
                    if acc is None or not acc.get("access_token"):
                        return {"ok": False, "status": "failed", "message": "账号缺少 access_token"}
                    try:
                        import requests as _req
                        proxy = _proxy_for_task()
                        proxies = {"http": proxy, "https": proxy} if proxy else None
                        resp = _req.get(
                            "https://chatgpt.com/backend-api/me",
                            headers={"Authorization": f"Bearer {acc['access_token']}"},
                            timeout=15, proxies=proxies,
                        )
                        if resp.status_code == 200:
                            return {"ok": True, "status": "success", "message": "token 有效"}
                        return {"ok": False, "status": "failed", "message": f"token 无效（HTTP {resp.status_code}）"}
                    except Exception as exc:
                        return {"ok": False, "status": "failed", "message": f"{type(exc).__name__}: {str(exc)[:120]}"}

                if task_type == "agent_identity":
                    from core.agent_identity_pkg.agent_identity_service import ensure_agent_identity
                    from core import db as _db2
                    acc = _db2.get_account_by_email(email)
                    if acc is None or not acc.get("access_token"):
                        return {"ok": False, "status": "failed", "message": "账号缺少 access_token"}
                    try:
                        import types as _types
                        rec = _types.SimpleNamespace(
                            email=acc.get("email", ""),
                            access_token=acc.get("access_token", ""),
                            refresh_token=acc.get("refresh_token", ""),
                            chatgpt_account_id=acc.get("user_id", ""),
                            chatgpt_user_id=acc.get("user_id", ""),
                            plan_type=acc.get("plan_type") or "free",
                        )
                        res = ensure_agent_identity(rec, proxy=_proxy_for_task())
                        if res.get("ok"):
                            return {"ok": True, "status": "success", "message": "Agent Identity 已生成并落盘"}
                        return {"ok": False, "status": "failed", "message": res.get("error") or "Agent 注册失败"}
                    except Exception as exc:
                        return {"ok": False, "status": "failed", "message": f"{type(exc).__name__}: {exc}"}

                if task_type == "twofa_setup":
                    from core.account_export import setup_2fa
                    from core.session import BrowserSession
                    try:
                        session = BrowserSession()
                        secret = setup_2fa(session, email)
                        return {"ok": True, "status": "success", "message": "2FA 已设置" if secret else "2FA 设置未返回密钥"}
                    except Exception as exc:
                        return {"ok": False, "status": "failed", "message": f"{type(exc).__name__}: {exc}"}

                return {"ok": False, "status": "unsupported", "message": f"任务类型 {task_type} 暂不支持"}

            def _bg_execute():
                cur = next((x for x in _load("automation_tasks", []) or [] if x.get("id") == task["id"]), None)
                if cur is None:
                    return
                cur["status"] = "running"
                _save("automation_tasks", _load("automation_tasks", []) or [])
                failed = 0
                for email in identities:
                    res = _run_one(email)
                    if not res.get("ok"):
                        failed += 1
                        _record_alert("automation_task", f"任务#{task['id']} {task_type} 失败: {email} - {res.get('message', '')}")
                    item = {
                        "identity_snapshot": email,
                        "status": res.get("status", "failed"),
                        "result_summary": res.get("message", ""),
                        "error": None if res.get("ok") else res.get("message"),
                        "updated_at": _now(),
                    }
                    cur = next((x for x in _load("automation_tasks", []) or [] if x.get("id") == task["id"]), None)
                    if cur is None:
                        return
                    cur.setdefault("items", []).append(item)
                    cur["account_processed"] = len(cur["items"])
                    cur["account_failed"] = failed
                    _save("automation_tasks", _load("automation_tasks", []) or [])
                cur = next((x for x in _load("automation_tasks", []) or [] if x.get("id") == task["id"]), None)
                if cur is not None:
                    cur["status"] = "completed"
                    cur["completed_at"] = _now()
                    _save("automation_tasks", _load("automation_tasks", []) or [])
                    try:
                        from webui.notify import notify_automation_task
                        notify_automation_task(task["id"], task_type, len(identities), failed)
                    except Exception:
                        pass

            _t.Thread(target=_bg_execute, name=f"auto-task-{task['id']}", daemon=True).start()

        return jsonify({"ok": True, "task": task, "account_total": len(rows), "skipped": 0})

    @app.get("/api/automation-tasks/<int:task_id>")
    def api_automation_tasks_get(task_id: int):
        tasks = _load("automation_tasks", []) or []
        task = next((t for t in tasks if t.get("id") == task_id), None)
        if task is None:
            return jsonify({"ok": False, "error": "任务不存在"}), 404
        return jsonify({"ok": True, "task": task})

    @app.get("/api/automation-tasks/<int:task_id>/items")
    def api_automation_tasks_items(task_id: int):
        page = request.args.get("page", default=1, type=int)
        page_size = request.args.get("page_size", default=20, type=int)
        tasks = _load("automation_tasks", []) or []
        task = next((t for t in tasks if t.get("id") == task_id), None)
        if task is None:
            return jsonify({"ok": False, "error": "任务不存在"}), 404
        items = task.get("items") or []
        total = len(items)
        start = (page - 1) * page_size
        return jsonify({
            "ok": True, "items": items[start:start + page_size], "total": total,
            "pagination": {"page": page, "pages": max(1, (total + page_size - 1) // page_size), "page_size": page_size, "total": total},
        })

    @app.get("/api/automation-tasks/<int:task_id>/items/<item_id>/log")
    def api_automation_tasks_item_log(task_id: int, item_id: str):
        return jsonify({"ok": True, "log": ""})

    @app.post("/api/automation-tasks/<int:task_id>/stop")
    def api_automation_tasks_stop(task_id: int):
        tasks = _load("automation_tasks", []) or []
        task = next((t for t in tasks if t.get("id") == task_id), None)
        if task:
            task["status"] = "stopped"
            _save("automation_tasks", tasks)
        return jsonify({"ok": True})

    @app.post("/api/automation-tasks/<int:task_id>/resume")
    def api_automation_tasks_resume(task_id: int):
        data = _json_body()
        mode = str(data.get("mode") or "failed")
        tasks = _load("automation_tasks", []) or []
        task = next((t for t in tasks if t.get("id") == task_id), None)
        if task:
            task["status"] = "queued"
            _save("automation_tasks", tasks)
        return jsonify({"ok": True, "mode": mode})

    @app.delete("/api/automation-tasks/<int:task_id>")
    def api_automation_tasks_delete(task_id: int):
        tasks = _load("automation_tasks", []) or []
        tasks = [t for t in tasks if t.get("id") != task_id]
        _save("automation_tasks", tasks)
        return jsonify({"ok": True})

    @app.post("/api/automation-tasks/clear-completed")
    def api_automation_tasks_clear_completed():
        tasks = _load("automation_tasks", []) or []
        keep = [t for t in tasks if t.get("status") not in ("completed", "stopped", "cancelled")]
        n = len(tasks) - len(keep)
        _save("automation_tasks", keep)
        return jsonify({"ok": True, "cleared": n})

    @app.post("/api/automation-tasks/delete-selected")
    def api_automation_tasks_delete_selected():
        data = _json_body()
        ids = set(data.get("ids") or [])
        tasks = _load("automation_tasks", []) or []
        keep = [t for t in tasks if t.get("id") not in ids]
        n = len(tasks) - len(keep)
        _save("automation_tasks", keep)
        return jsonify({"ok": True, "deleted": n})

    @app.post("/api/automation-tasks/scope-preview")
    def api_automation_tasks_scope_preview():
        data = _json_body()
        scope = str(data.get("scope") or "filtered")
        identities = data.get("identities") or []
        if scope == "selected":
            rows = _resolve_identities(identities)
        else:
            with db._LOCK:
                rows = db._load_accounts()
        # 前端创建按钮依赖 account_total 判断是否可点（只读 total 会导致永远为 0 → 按钮常灰）
        return jsonify({
            "ok": True,
            "identities": [r.get("email") for r in rows],
            "requested": len(identities) if scope == "selected" else len(rows),
            "account_total": len(rows),
            "total": len(rows),
        })

    # ---------------- SMS ----------------
    _SMS_DEFAULT_PROVIDERS = {
        "grizzly": {
            "display_name": "GrizzlySMS",
            "base_url": "https://api.grizzlysms.com/stubs/handler_api.php",
            "currency": "USD",
        },
        "hero": {
            "display_name": "HeroSMS",
            "base_url": "https://hero-sms.com/stubs/handler_api.php",
            "currency": "USD",
        },
        "smsbower": {
            "display_name": "SmsBower",
            "base_url": "https://smsbower.page/stubs/handler_api.php",
            "currency": "USD",
        },
    }

    def _sms_providers_rows() -> list:
        rows = _load("sms_providers", []) or []
        existing = {r.get("provider") for r in rows}
        # 用基座 config 的 SMS_API_KEY 种子默认平台
        try:
            from config.codex import SMS_API_KEY, SMS_API_BASE
            cfg_key = SMS_API_KEY or ""
            cfg_base = SMS_API_BASE or ""
        except Exception:
            cfg_key, cfg_base = "", ""
        for pid, meta in _SMS_DEFAULT_PROVIDERS.items():
            if pid in existing:
                continue
            base = cfg_base if pid == "grizzly" and cfg_base else meta["base_url"]
            masked = ""
            if pid == "grizzly" and cfg_key:
                masked = cfg_key[:4] + "****" + cfg_key[-4:] if len(cfg_key) > 8 else "****"
            rows.append({
                "provider": pid,
                "display_name": meta["display_name"],
                "base_url": base,
                "currency": meta["currency"],
                "enabled": bool(cfg_key) if pid == "grizzly" else False,
                "api_key_masked": masked,
                "api_key": cfg_key if pid == "grizzly" else "",
                "balance": None,
                "last_check_at": None,
                "last_error": None,
                "created_at": _now(),
                "updated_at": _now(),
            })
        _save("sms_providers", rows)
        return rows

    def _sms_provider_row(pid: str) -> dict | None:
        rows = _sms_providers_rows()
        return next((r for r in rows if r.get("provider") == pid), None)

    def _sms_public_row(row: dict) -> dict:
        out = dict(row)
        out.pop("api_key", None)
        return out

    def _sms_fetch_balance(row: dict, api_key: str | None) -> tuple[str | None, str | None]:
        """直连 SMS 平台 handler_api 查余额（GrizzlySMS 协议）。"""
        key = (api_key or row.get("api_key") or "").strip()
        base = row.get("base_url") or ""
        if not key or not base:
            return None, "未配置 API Key"
        try:
            import requests
            resp = requests.get(
                base,
                params={"api_key": key, "action": "getBalance"},
                timeout=10,
            )
            text = resp.text.strip()
            if text.startswith("ACCESS_BALANCE:"):
                return text.split(":", 1)[1], None
            return None, text[:200]
        except Exception as exc:
            return None, f"{type(exc).__name__}: {exc}"

    @app.get("/api/sms/providers")
    def api_sms_providers():
        rows = _sms_providers_rows()
        return jsonify({"ok": True, "items": [_sms_public_row(r) for r in rows]})

    @app.get("/api/sms/providers/<provider>")
    def api_sms_provider_get(provider: str):
        row = _sms_provider_row(provider)
        if row is None:
            return jsonify({"ok": False, "error": "平台不存在"}), 404
        return jsonify({"ok": True, "item": _sms_public_row(row)})

    @app.post("/api/sms/providers/<provider>")
    def api_sms_provider_save(provider: str):
        data = _json_body()
        rows = _sms_providers_rows()
        row = next((r for r in rows if r.get("provider") == provider), None)
        if row is None:
            return jsonify({"ok": False, "error": "平台不存在"}), 404
        if data.get("enabled") is not None:
            row["enabled"] = bool(data["enabled"])
        new_key = (data.get("api_key") or "").strip()
        if new_key:
            row["api_key"] = new_key
            row["api_key_masked"] = new_key[:4] + "****" + new_key[-4:] if len(new_key) > 8 else "****"
        row["updated_at"] = _now()
        _save("sms_providers", rows)
        # 同步到 codex 接码配置：启用且已填 key 的平台自动成为当前接码通道
        if row.get("enabled") and row.get("api_key"):
            try:
                from webui.config_editor import update_config as _upd_cfg
                sync = {
                    "SMS_API_KEY": row["api_key"],
                    "SMS_PROVIDER": "grizzly",  # sms-activate 兼容协议复用
                    "SMS_API_BASE": row.get("base_url") or "",
                }
                _upd_cfg(sync)
                import config as _cfg_pkg
                _cfg_pkg.reload_all()
            except Exception as exc:
                logger.warning("[SMS同步] codex 接码配置同步失败: %s", exc)
        return jsonify({"ok": True, "item": _sms_public_row(row)})

    @app.post("/api/sms/providers/<provider>/balance")
    def api_sms_provider_balance(provider: str):
        data = _json_body()
        rows = _sms_providers_rows()
        row = next((r for r in rows if r.get("provider") == provider), None)
        if row is None:
            return jsonify({"ok": False, "error": "平台不存在"}), 404
        balance, err = _sms_fetch_balance(row, data.get("api_key"))
        row["balance"] = balance
        row["last_check_at"] = _now() if balance is not None else row.get("last_check_at")
        row["last_error"] = err
        row["updated_at"] = _now()
        if balance is not None and data.get("api_key"):
            row["api_key"] = str(data["api_key"]).strip()
            row["api_key_masked"] = row["api_key"][:4] + "****" + row["api_key"][-4:] if len(row["api_key"]) > 8 else "****"
        _save("sms_providers", rows)
        if err:
            return jsonify({"ok": False, "error": err, "item": _sms_public_row(row)}), 502
        return jsonify({"ok": True, "balance": balance, "item": _sms_public_row(row)})

    @app.get("/api/sms/prices")
    def api_sms_prices():
        return jsonify({"ok": True, "prices": {}})

    @app.get("/api/sms/selections")
    def api_sms_selections_list():
        items = _load("sms_selections", []) or []
        return jsonify({"ok": True, "items": items, "total": len(items)})

    @app.post("/api/sms/selections")
    def api_sms_selections_create():
        data = _json_body()
        items = _load("sms_selections", []) or []
        item = {
            "id": max([i.get("id", 0) for i in items], default=0) + 1,
            "logical_service": str(data.get("logical_service") or "openai"),
            "provider": str(data.get("provider") or ""),
            "service": str(data.get("service") or ""),
            "country": str(data.get("country") or ""),
            "created_at": _now(),
        }
        items.append(item)
        _save("sms_selections", items)
        return jsonify({"ok": True, "item": item})

    @app.put("/api/sms/selections/<int:sel_id>")
    def api_sms_selections_update(sel_id: int):
        data = _json_body()
        items = _load("sms_selections", []) or []
        item = next((i for i in items if i.get("id") == sel_id), None)
        if item is None:
            return jsonify({"ok": False, "error": "选择不存在"}), 404
        for k in ("logical_service", "provider", "service", "country"):
            if data.get(k) is not None:
                item[k] = str(data[k])
        _save("sms_selections", items)
        return jsonify({"ok": True, "item": item})

    @app.delete("/api/sms/selections/<int:sel_id>")
    def api_sms_selections_delete(sel_id: int):
        items = _load("sms_selections", []) or []
        items = [i for i in items if i.get("id") != sel_id]
        _save("sms_selections", items)
        return jsonify({"ok": True})

    @app.get("/api/sms/api-numbers")
    def api_sms_api_numbers_list():
        items = _load("sms_api_numbers", []) or []
        return jsonify({"ok": True, "items": items, "total": len(items)})

    @app.post("/api/sms/api-numbers/import")
    def api_sms_api_numbers_import():
        data = _json_body()
        text = str(data.get("text") or "")
        size_err = _check_import_size(text)
        if size_err:
            return jsonify({"ok": False, "error": size_err, "error_code": "import_too_large"}), 413
        items = _load("sms_api_numbers", []) or []
        existing = {i.get("number") for i in items}
        inserted = skipped = 0
        for line in text.splitlines():
            num = line.strip()
            if not re.match(r"^\+?[0-9]{6,15}$", num):
                skipped += 1
                continue
            if num in existing:
                skipped += 1
                continue
            items.append({"number": num, "created_at": _now(), "status": "available"})
            existing.add(num)
            inserted += 1
        _save("sms_api_numbers", items)
        return jsonify({"ok": True, "inserted": inserted, "skipped": skipped, "parsed": inserted + skipped})

    @app.post("/api/sms/api-numbers/status")
    def api_sms_api_numbers_status():
        data = _json_body()
        number = str(data.get("number") or "")
        items = _load("sms_api_numbers", []) or []
        row = next((i for i in items if i.get("number") == number), None)
        return jsonify({"ok": True, "number": number, "status": (row or {}).get("status", "unknown")})

    @app.post("/api/sms/api-numbers/delete")
    def api_sms_api_numbers_delete():
        data = _json_body()
        number = str(data.get("number") or "")
        items = _load("sms_api_numbers", []) or []
        items = [i for i in items if i.get("number") != number]
        _save("sms_api_numbers", items)
        return jsonify({"ok": True, "deleted": 1 if number else 0})

    @app.post("/api/sms/api-numbers/bulk-delete")
    def api_sms_api_numbers_bulk_delete():
        data = _json_body()
        nums = set(data.get("numbers") or [])
        items = _load("sms_api_numbers", []) or []
        keep = [i for i in items if i.get("number") not in nums]
        n = len(items) - len(keep)
        _save("sms_api_numbers", keep)
        return jsonify({"ok": True, "deleted": n})

    @app.post("/api/sms/api-numbers/clear")
    def api_sms_api_numbers_clear():
        _save("sms_api_numbers", [])
        return jsonify({"ok": True, "cleared": "all"})

    # ---------------- UPI（自建版禁用，形状兼容） ----------------
    @app.get("/api/upi/tasks")
    def api_upi_tasks_list():
        items = _load("upi_tasks", []) or []
        items = sorted(items, key=lambda t: t.get("created_at", ""), reverse=True)
        page = request.args.get("page", default=1, type=int)
        page_size = request.args.get("page_size", default=20, type=int)
        total = len(items)
        start = (page - 1) * page_size
        return jsonify({
            "ok": True, "items": items[start:start + page_size], "total": total,
            "available_scan_tasks": 0,
            "pagination": {"page": page, "pages": max(1, (total + page_size - 1) // page_size), "page_size": page_size, "total": total},
        })

    @app.post("/api/upi/tasks/manual")
    def api_upi_tasks_manual():
        data = _json_body()
        token = str(data.get("access_token") or "")
        if not token or token.count(".") != 2:
            return jsonify({"ok": False, "error": "JWT 格式无效", "detail": "JWT 格式无效", "message_key": "errors.common.operation_failed", "message_params": {"detail": "JWT 格式无效"}}), 400
        # 提链服务未配置时保持禁用（安全默认：不伪造任务、不碰上游）
        try:
            from core.extract_link_service import _api_base, _cdk
            _api_base()
            _cdk()
        except Exception:
            return jsonify({
                "ok": False,
                "error": "UPI 支付提取未启用（请在配置页填写提链 API 地址与 CDK）",
                "error_code": "upi_disabled",
            }), 501
        # 解析 token 中的邮箱声明，尝试匹配本地账号后入队真实提链
        email_claim = ""
        try:
            import base64 as _b64
            payload = token.split(".")[1]
            payload += "=" * (-len(payload) % 4)
            claims = json.loads(_b64.urlsafe_b64decode(payload))
            email_claim = str(claims.get("email") or claims.get("sub") or "")
        except Exception:
            email_claim = ""
        task = {
            "id": max([t.get("id", 0) for t in (_load("upi_tasks", []) or [])], default=0) + 1,
            "email_snapshot": email_claim,
            "source": "manual_token",
            "extract_status": "queued" if email_claim else "failed",
            "payment_status": "",
            "error_code": "" if email_claim else "no_account",
            "error_message": "" if email_claim else "令牌中未找到邮箱声明",
            "created_at": _now(),
        }
        tasks = _load("upi_tasks", []) or []
        tasks.append(task)
        _save("upi_tasks", tasks)
        if email_claim:
            acc = db.get_account_by_email(email_claim)
            if acc is not None and acc.get("access_token"):
                try:
                    from core.extract_link_service import enqueue_account_extract
                    res = enqueue_account_extract(
                        account_id=int(acc.get("id") or 0),
                        email=email_claim,
                        access_token=acc["access_token"],
                        trigger="manual_token",
                    )
                    if res.get("accepted"):
                        return jsonify({"ok": True, "task": task})
                    task["extract_status"] = "failed"
                    task["error_message"] = res.get("error") or "提链队列繁忙"
                    _save("upi_tasks", tasks)
                except Exception as exc:
                    task["extract_status"] = "failed"
                    task["error_message"] = f"{type(exc).__name__}: {exc}"
                    _save("upi_tasks", tasks)
        return jsonify({"ok": True, "task": task})

    @app.get("/api/upi/tasks/<int:task_id>/logs")
    def api_upi_tasks_logs(task_id: int):
        return jsonify({"ok": True, "items": [], "task": None})

    @app.post("/api/upi/tasks/<int:task_id>/<action>")
    def api_upi_tasks_action(task_id: int, action: str):
        return jsonify({"ok": True, "task": {"id": task_id, "extract_status": "canceled"}})

    @app.get("/api/upi/scanners")
    def api_upi_scanners_list():
        items = _load("upi_scanners", []) or []
        return jsonify({"ok": True, "items": items, "total": len(items)})

    @app.post("/api/upi/scanners")
    def api_upi_scanners_create():
        return jsonify({"ok": False, "error": "UPI 扫描器未启用", "error_code": "upi_disabled"}), 501

    @app.get("/api/upi/scanners/<int:scanner_id>")
    def api_upi_scanners_get(scanner_id: int):
        return jsonify({"ok": True, "scanner": None})

    @app.delete("/api/upi/scanners/<int:scanner_id>")
    def api_upi_scanners_delete(scanner_id: int):
        return jsonify({"ok": True})

    @app.patch("/api/upi/scanners/<int:scanner_id>")
    def api_upi_scanners_update(scanner_id: int):
        return jsonify({"ok": True, "scanner": {"id": scanner_id}})

    @app.post("/api/upi/scanners/<int:scanner_id>/reset-link")
    def api_upi_scanners_reset_link(scanner_id: int):
        return jsonify({"ok": True, "link": ""})

    @app.get("/api/upi/scanners/<int:scanner_id>/ledger")
    def api_upi_scanners_ledger(scanner_id: int):
        return jsonify({"ok": True, "items": [], "total": 0})

    @app.get("/api/upi/settings")
    def api_upi_settings():
        # 与 0.1.48 一致的字段元数据（含 label_key/help_key/min/max）
        fields = [
            {
                "group": "支付链接设置",
                "key": "UPI_CARD",
                "label": "支付链接卡密",
                "label_key": "settings.UPI_CARD.label",
                "label_params": {},
                "help": "提交 UPI 或 Kakao 提取任务使用的共享卡密，仅保存在后端。",
                "help_key": "settings.UPI_CARD.help",
                "help_params": {},
                "secret": True,
                "type": "str",
                "value": "",
            },
            {
                "group": "支付链接设置",
                "key": "UPI_MAX_PENDING_SCAN_TASKS",
                "label": "最大待扫任务数",
                "label_key": "settings.UPI_MAX_PENDING_SCAN_TASKS.label",
                "label_params": {},
                "help": "提取中和提取成功但未支付的任务合计上限。",
                "help_key": "settings.UPI_MAX_PENDING_SCAN_TASKS.help",
                "help_params": {},
                "secret": False,
                "type": "int",
                "min": 1,
                "max": 10000,
                "value": 20,
            },
            {
                "group": "支付链接设置",
                "key": "UPI_DEFAULT_CLAIM_COUNT",
                "label": "默认获取二维码数量",
                "label_key": "settings.UPI_DEFAULT_CLAIM_COUNT.label",
                "label_params": {},
                "help": "扫码商每次点击获取任务时最多领取的二维码数量。",
                "help_key": "settings.UPI_DEFAULT_CLAIM_COUNT.help",
                "help_params": {},
                "secret": False,
                "type": "int",
                "min": 1,
                "max": 20,
                "value": 1,
            },
        ]
        return jsonify({"ok": True, "fields": fields})

    @app.post("/api/upi/settings")
    def api_upi_settings_save():
        return jsonify({"ok": False, "error": "UPI 支付提取未启用", "error_code": "upi_disabled"}), 501

    @app.post("/api/upi/settings/card-summary")
    def api_upi_settings_card_summary():
        return jsonify({"ok": True, "summary": {"total": 0, "used": 0, "available": 0}})

    # ---------------- 卡池支付（虚拟卡 + PayPal 池） ----------------
    # 与 UPI 扫码商通道并行：UPI 负责提链，卡池负责自动/手动支付。
    # 写入与支付类接口在 ENABLE_CARD_POOL=False 时返回 501；列表/状态接口只读可查。
    def _cp():
        from core import card_pool as m
        return m

    def _card_pool_guard():
        """返回 (card_pool_module, error_response)。未启用时 error_response 非 None。"""
        m = _cp()
        if not m.enabled():
            return m, (jsonify({
                "ok": False, "error": "卡池未启用（请在配置页「卡池支付」打开启用开关）",
                "error_code": "card_pool_disabled",
            }), 501)
        return m, None

    @app.get("/api/card-pool/status")
    def api_card_pool_status():
        m = _cp()
        st = m.settings()
        return jsonify({"ok": True, "enabled": st["enabled"], "settings": st, "summary": m.summary()})

    @app.get("/api/card-pool/cards")
    def api_card_pool_cards_list():
        m = _cp()
        status = (request.args.get("status") or "").strip() or None
        items = [m.card_public(r) for r in m.list_cards(status=status)]
        return jsonify({"ok": True, "items": items, "total": len(items)})

    @app.post("/api/card-pool/cards")
    def api_card_pool_cards_add():
        m, denied = _card_pool_guard()
        if denied:
            return denied
        data = _json_body()
        try:
            row = m.add_card(
                card_number=str(data.get("card_number") or ""),
                expires=str(data.get("expires") or ""),
                cvv=str(data.get("cvv") or ""),
                billing_zip=str(data.get("billing_zip") or ""),
                billing_country=str(data.get("billing_country") or "US"),
                notes=str(data.get("notes") or ""),
            )
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "card": m.card_public(row)})

    @app.post("/api/card-pool/cards/import")
    def api_card_pool_cards_import():
        m, denied = _card_pool_guard()
        if denied:
            return denied
        data = _json_body()
        text = str(data.get("text") or "")
        if len(text.encode("utf-8")) > _IMPORT_TEXT_MAX:
            return jsonify({"ok": False, "error": "导入内容超过 5MB 上限"}), 413
        result = m.import_cards(text.splitlines())
        return jsonify({"ok": True, **result})

    @app.patch("/api/card-pool/cards/<int:card_id>")
    def api_card_pool_cards_update(card_id: int):
        m, denied = _card_pool_guard()
        if denied:
            return denied
        try:
            row = m.update_card(card_id, _json_body())
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "card": m.card_public(row)})

    @app.delete("/api/card-pool/cards/<int:card_id>")
    def api_card_pool_cards_delete(card_id: int):
        m, denied = _card_pool_guard()
        if denied:
            return denied
        if not m.delete_card(card_id):
            return jsonify({"ok": False, "error": f"卡片不存在: {card_id}"}), 404
        return jsonify({"ok": True})

    @app.get("/api/card-pool/paypal")
    def api_card_pool_paypal_list():
        m = _cp()
        status = (request.args.get("status") or "").strip() or None
        items = m.list_paypal(status=status)
        return jsonify({"ok": True, "items": items, "total": len(items)})

    @app.post("/api/card-pool/paypal")
    def api_card_pool_paypal_add():
        m, denied = _card_pool_guard()
        if denied:
            return denied
        data = _json_body()
        try:
            row = m.add_paypal(
                phone=str(data.get("phone") or ""),
                sms_api_url=str(data.get("sms_api_url") or ""),
                notes=str(data.get("notes") or ""),
            )
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "paypal": row})

    @app.post("/api/card-pool/paypal/import")
    def api_card_pool_paypal_import():
        m, denied = _card_pool_guard()
        if denied:
            return denied
        data = _json_body()
        text = str(data.get("text") or "")
        if len(text.encode("utf-8")) > _IMPORT_TEXT_MAX:
            return jsonify({"ok": False, "error": "导入内容超过 5MB 上限"}), 413
        result = m.import_paypal(text.splitlines())
        return jsonify({"ok": True, **result})

    @app.patch("/api/card-pool/paypal/<int:paypal_id>")
    def api_card_pool_paypal_update(paypal_id: int):
        m, denied = _card_pool_guard()
        if denied:
            return denied
        try:
            row = m.update_paypal(paypal_id, _json_body())
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "paypal": row})

    @app.delete("/api/card-pool/paypal/<int:paypal_id>")
    def api_card_pool_paypal_delete(paypal_id: int):
        m, denied = _card_pool_guard()
        if denied:
            return denied
        if not m.delete_paypal(paypal_id):
            return jsonify({"ok": False, "error": f"PayPal 账号不存在: {paypal_id}"}), 404
        return jsonify({"ok": True})

    @app.get("/api/card-pool/jobs")
    def api_card_pool_jobs_list():
        m = _cp()
        status = (request.args.get("status") or "").strip() or None
        limit = request.args.get("limit", default=200, type=int)
        items = m.list_jobs(status=status, limit=min(limit, 500))
        return jsonify({"ok": True, "items": items, "total": len(items)})

    @app.post("/api/card-pool/jobs")
    def api_card_pool_jobs_create():
        m, denied = _card_pool_guard()
        if denied:
            return denied
        data = _json_body()
        link = str(data.get("link") or "").strip()
        method = str(data.get("method") or "card").strip().lower()
        if method not in ("card", "paypal"):
            return jsonify({"ok": False, "error": "支付方式只能是 card 或 paypal"}), 400
        try:
            job = m.create_job(link=link, method=method, email=str(data.get("email") or "").strip(),
                               source="manual")
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        from core.payment_executor import submit_payment_job
        submit_payment_job(int(job["id"]))
        return jsonify({"ok": True, "job": job, "message": "支付任务已提交，刷新查看结果"})

    @app.get("/api/card-pool/jobs/<int:job_id>")
    def api_card_pool_jobs_get(job_id: int):
        m = _cp()
        job = m.get_job(job_id)
        if job is None:
            return jsonify({"ok": False, "error": f"任务不存在: {job_id}"}), 404
        return jsonify({"ok": True, "job": job})

    @app.post("/api/card-pool/jobs/<int:job_id>/cancel")
    def api_card_pool_jobs_cancel(job_id: int):
        m, denied = _card_pool_guard()
        if denied:
            return denied
        if not m.cancel_job(job_id):
            return jsonify({"ok": False, "error": "取消失败：任务不存在或已运行/已结束"}), 400
        return jsonify({"ok": True})

    @app.post("/api/card-pool/jobs/<int:job_id>/retry")
    def api_card_pool_jobs_retry(job_id: int):
        """失败任务重试（重新排队执行）。"""
        m, denied = _card_pool_guard()
        if denied:
            return denied
        job = m.get_job(job_id)
        if job is None:
            return jsonify({"ok": False, "error": f"任务不存在: {job_id}"}), 404
        if job.get("status") not in ("failed", "canceled"):
            return jsonify({"ok": False, "error": "只有失败/取消的任务可以重试"}), 400
        m.update_job(job_id, {"status": m.JOB_QUEUED, "error": None, "finished_at": None})
        from core.payment_executor import submit_payment_job
        submit_payment_job(job_id)
        return jsonify({"ok": True, "message": "已重新提交"})

    @app.post("/api/card-pool/process-queued")
    def api_card_pool_process_queued():
        m, denied = _card_pool_guard()
        if denied:
            return denied
        from core.payment_executor import process_queued_jobs
        n = process_queued_jobs(max_jobs=50)
        return jsonify({"ok": True, "submitted": n})

    @app.get("/api/card-pool/settings")
    def api_card_pool_settings():
        m = _cp()
        st = m.settings()
        fields = [
            {"key": "ENABLE_CARD_POOL", "type": "bool", "value": st["enabled"], "label": "启用卡池",
             "help": "总开关；关闭时写入/支付类接口全部拒绝，UPI 扫码通道不受影响"},
            {"key": "CARD_POOL_DRIVER", "type": "str", "value": st["driver"], "label": "支付驱动",
             "help": "mock=模拟测试；stripe_protocol=真实 Stripe 协议；disabled=禁止支付"},
            {"key": "CARD_POOL_AUTO_PAY", "type": "bool", "value": st["auto_pay"], "label": "提链后自动支付",
             "help": "提链成功的任务自动从卡池发起支付"},
            {"key": "CARD_POOL_PAY_METHOD", "type": "str", "value": st["pay_method"], "label": "支付方式偏好",
             "help": "auto=优先卡池、无卡时用 PayPal；card/paypal=固定方式"},
            {"key": "CARD_POOL_PREFERRED_BINS", "type": "str", "value": st["preferred_bins"], "label": "优先 BIN",
             "help": "逗号分隔；白名单内卡片优先，同类按使用次数最少优先"},
            {"key": "CARD_POOL_LEASE_SECONDS", "type": "int", "value": st["lease_seconds"], "label": "资产租约(秒)",
             "help": "崩溃后租约过期自动回收，防止死锁"},
            {"key": "CARD_POOL_MAX_CONCURRENT", "type": "int", "value": st["max_concurrent"], "label": "最大并发",
             "help": "同时执行的支付任务数上限"},
            {"key": "PAYPAL_OTP_TIMEOUT_SECONDS", "type": "int", "value": st["paypal_otp_timeout"], "label": "PayPal OTP 超时(秒)",
             "help": "等待 PayPal 验证码的最长秒数"},
            {"key": "PAYPAL_OTP_POLL_INTERVAL_SECONDS", "type": "int", "value": st["paypal_otp_poll_interval"], "label": "OTP 轮询间隔(秒)",
             "help": "轮询验证码短信的间隔"},
        ]
        return jsonify({"ok": True, "fields": fields, "summary": m.summary()})

    @app.post("/api/card-pool/settings")
    def api_card_pool_settings_save():
        from webui import config_editor
        data = _json_body()
        keys = {
            "ENABLE_CARD_POOL": "bool", "CARD_POOL_DRIVER": "str", "CARD_POOL_AUTO_PAY": "bool",
            "CARD_POOL_PAY_METHOD": "str", "CARD_POOL_PREFERRED_BINS": "str",
            "CARD_POOL_LEASE_SECONDS": "int", "CARD_POOL_MAX_CONCURRENT": "int",
            "PAYPAL_OTP_TIMEOUT_SECONDS": "int", "PAYPAL_OTP_POLL_INTERVAL_SECONDS": "int",
        }
        updates = {}
        for key, vtype in keys.items():
            if key not in data:
                continue
            value = data[key]
            if vtype == "bool":
                value = bool(value)
            elif vtype == "int":
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    return jsonify({"ok": False, "error": f"{key} 必须是整数"}), 400
            else:
                value = str(value or "")
            updates[key] = value
        if not updates:
            return jsonify({"ok": False, "error": "没有可保存的字段"}), 400
        try:
            result = config_editor.update_config(updates)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        if result.get("ignored"):
            return jsonify({"ok": False, "error": f"忽略未识别字段: {result['ignored']}"}), 400
        return jsonify({"ok": True, "updated": result.get("updated", []), "message": "已保存（立即生效）"})

    # ---------------- 动态代理池管理 ----------------
    @app.get("/api/proxy/dynamic")
    def api_proxy_dynamic_status():
        from core import proxy_pool as _pp
        return jsonify({"ok": True, "summary": _pp.pool_summary()})

    @app.post("/api/proxy/dynamic/refresh")
    def api_proxy_dynamic_refresh():
        from core import proxy_pool as _pp
        try:
            pool = _pp.refresh_pool()
            return jsonify({"ok": True, "summary": _pp.pool_summary(),
                            "message": f"拉取成功，池内共 {len(pool.get('proxies', []))} 条"})
        except Exception as exc:
            return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}",
                            "message": f"{type(exc).__name__}: {exc}"}), 400

    @app.post("/api/proxy/dynamic/test")
    def api_proxy_dynamic_test():
        """测试拉取（不写入池），返回解析出的前 N 条。"""
        from core import proxy_pool as _pp
        try:
            proxies = _pp.fetch_dynamic_proxies()
            return jsonify({"ok": True, "count": len(proxies),
                            "sample": proxies[:10],
                            "message": f"解析成功 {len(proxies)} 条"})
        except Exception as exc:
            return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}",
                            "message": f"{type(exc).__name__}: {exc}"}), 400

    # ---------------- 代理/中继测试 ----------------
    def _proxy_http_get(proxy_url, url, timeout):
        """通过代理发 GET（curl_cffi 原生支持 socks5），失败返回 None。"""
        s = None
        try:
            from curl_cffi import requests as _curl
            s = _curl.Session(impersonate="chrome124")
            resp = s.get(url, proxies={"http": proxy_url, "https": proxy_url}, timeout=timeout)
            return resp
        except Exception:
            return None
        finally:
            try:
                if s is not None:
                    s.close()
            except Exception:
                pass

    @app.post("/api/proxy/test")
    def api_proxy_test():
        data = _json_body()
        proxies = data.get("proxies") or []
        try:
            timeout_s = float(data.get("timeout_s") or 5)
        except (TypeError, ValueError):
            timeout_s = 5.0
        timeout_s = max(1.0, min(30.0, timeout_s))
        expected_country = str(data.get("expected_country") or "").strip().upper()
        started_at = time.time()
        results = []
        for idx, proxy in enumerate(proxies[:50], start=1):
            parsed = _parse_proxy_address(proxy)
            if parsed is None:
                results.append({"index": idx, "proxy": str(proxy).strip(), "ok": False,
                                "error": "地址格式无效（支持 http://、socks5://、host:port 等）"})
                continue
            host, port, scheme, proxy_url = parsed
            row = {"index": idx, "proxy": str(proxy).strip(), "scheme": scheme, "ok": False,
                   "error": None, "latency_ms": 0, "elapsed_ms": 0}
            per_start = time.time()
            # 1) TCP 连通 + 实测延迟
            try:
                s = socket.create_connection((host, port), timeout=timeout_s)
                s.close()
                row["latency_ms"] = round((time.time() - per_start) * 1000, 1)
            except Exception as exc:
                row["error"] = f"连接失败: {type(exc).__name__}"
                row["elapsed_ms"] = round((time.time() - per_start) * 1000, 1)
                results.append(row)
                continue
            # 2) 深度验证：经代理取出口 IP + 地区（ipwho.is 免费 https，一次返回）
            geo_resp = _proxy_http_get(proxy_url, "https://ipwho.is/", timeout_s)
            if geo_resp is not None:
                try:
                    geo = geo_resp.json()
                    row["ip"] = geo.get("ip")
                    row["geo_country"] = geo.get("country")
                    row["geo_country_code"] = geo.get("country_code")
                    row["geo_region"] = geo.get("region")
                    row["geo_city"] = geo.get("city")
                except Exception:
                    row["geo_error"] = "地区解析失败"
            else:
                # fallback：只拿出口 IP
                ip_resp = _proxy_http_get(proxy_url, "https://api.ipify.org?format=json", timeout_s)
                if ip_resp is not None:
                    try:
                        row["ip"] = ip_resp.json().get("ip")
                    except Exception:
                        pass
                else:
                    row["geo_error"] = "代理不可用（深度请求失败）"
            # 3) ChatGPT 可达性
            chat_resp = _proxy_http_get(proxy_url, "https://chatgpt.com/backend-api/me", timeout_s)
            if chat_resp is not None:
                row["chatgpt_status_code"] = chat_resp.status_code
            # 判定：TCP 通且至少一个深度请求成功才算可用
            deep_ok = bool(row.get("ip") or row.get("chatgpt_status_code") is not None)
            row["ok"] = deep_ok
            if expected_country and row.get("geo_country_code"):
                row["expected_country_match"] = str(row["geo_country_code"]).upper() == expected_country
            if not deep_ok and not row.get("geo_error"):
                row["geo_error"] = "深度请求失败"
            row["elapsed_ms"] = round((time.time() - per_start) * 1000, 1)
            results.append(row)
        return jsonify({
            "ok": True, "total": len(results),
            "success": sum(1 for r in results if r.get("ok")),
            "failed": sum(1 for r in results if not r.get("ok")),
            "elapsed_ms": round((time.time() - started_at) * 1000, 1),
            "target_url": "https://chatgpt.com/backend-api/me",
            "transport_url": "https://ipwho.is/",
            "note": f"每代理按 TCP 连通 + 出口 IP/地区 + ChatGPT 可达性深度检测（超时 {timeout_s:g}s）",
            "results": results,
        })

    @app.post("/api/relay/custom-api/test")
    def api_relay_custom_api_test():
        data = _json_body()
        api_url = str(data.get("api_url") or "").strip()
        if not api_url.startswith(("http://", "https://")):
            return jsonify({"ok": False, "error": "api_url 必须是 http/https 地址"}), 400
        try:
            import requests
            resp = requests.post(api_url, json={}, timeout=10)
            return jsonify({
                "ok": resp.ok,
                "api_url": api_url,
                "status_code": resp.status_code,
                "elapsed_ms": round(resp.elapsed.total_seconds() * 1000, 1),
                "response_body": resp.text[:2000],
                "message": f"HTTP {resp.status_code}",
            })
        except Exception as exc:
            return jsonify({
                "ok": False,
                "api_url": api_url,
                "elapsed_ms": 0,
                "message": f"{type(exc).__name__}: {exc}",
                "error": f"{type(exc).__name__}: {exc}",
            })


def api_codex_download_bulk_inner(data: dict, kind: str):
    """CPA / Sub2API 下载（复用单文件读取与校验）。"""
    import json as _json
    from datetime import datetime as _dt
    filenames = data.get("filenames") or []
    if not isinstance(filenames, list) or not filenames:
        return jsonify({"ok": False, "error": "没有可导出的凭证"}), 400
    bundle = []
    errors = []
    for fname in filenames:
        try:
            content, real = db.read_codex_credential(fname)
            bundle.append({"filename": real, "data": _json.loads(content)})
            db.mark_codex_exported(real)
        except Exception as exc:
            errors.append({"filename": fname, "error": f"{type(exc).__name__}: {exc}"})
    if not bundle:
        return jsonify({"ok": False, "error": "没有可导出的凭证", "errors": errors}), 404
    result = {
        "exported_at": _dt.now().isoformat(timespec="seconds"),
        "count": len(bundle),
        "credentials": bundle,
        "kind": kind,
    }
    if errors:
        result["errors"] = errors
    fname = f"{kind}-{int(time.time())}.json"
    return Response(
        _json.dumps(result, ensure_ascii=False, indent=2),
        mimetype="application/json",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
