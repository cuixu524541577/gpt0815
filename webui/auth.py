# -*- coding: utf-8 -*-
"""
认证模块：口令登录 + 签名 session + 登录限速。

- 凭据存储在 data/auth.json（PBKDF2 哈希，禁明文）
- session 使用 Flask 签名 cookie，密钥持久化在 data/secret_key（首启自动生成）
- 登录限速：同一 IP 15 分钟窗口内失败 5 次锁定（审计结论：原版无限速，必须补）
"""
import hashlib
import hmac
import json
import secrets
import time
from pathlib import Path

from flask import jsonify, request, session

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_AUTH_FILE = _DATA_DIR / "auth.json"
_SECRET_FILE = _DATA_DIR / "secret_key"

# 登录限速参数（内存级，单进程有效）
_LOCK_WINDOW_SECONDS = 15 * 60
_LOCK_MAX_FAILURES = 5
_failures: dict[str, list[float]] = {}

# 登录审计日志（data/audit.log，JSONL）
_AUDIT_LOG = _DATA_DIR / "audit.log"


def _audit(event: str, username: str, ip: str, detail: str = "") -> None:
    """追加一条审计记录（失败不抛出）。"""
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "event": event,           # login_success / login_failure / logout
            "username": username,
            "ip": ip,
            "detail": detail[:200],
        }
        with _AUDIT_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def list_audit(limit: int = 100) -> list[dict]:
    """读取最近审计记录（新→旧）。"""
    if not _AUDIT_LOG.exists():
        return []
    try:
        lines = _AUDIT_LOG.read_text(encoding="utf-8", errors="replace").splitlines()
        records = []
        for ln in lines[-500:]:
            try:
                records.append(json.loads(ln))
            except json.JSONDecodeError:
                continue
        return list(reversed(records))[:limit]
    except Exception:
        return []


# ----------------------------------------------------------
# 密钥与凭据
# ----------------------------------------------------------
def _restrict_perms(path: Path, mode: int = 0o600) -> None:
    """敏感文件/目录收紧权限（仅所有者）。"""
    try:
        path.chmod(mode)
    except OSError:
        pass


def ensure_secret_key() -> str:
    """首启生成随机 256-bit 密钥并持久化；之后每次启动复用。"""
    if _SECRET_FILE.exists():
        _restrict_perms(_DATA_DIR, 0o700)
        _restrict_perms(_SECRET_FILE)  # 旧文件也统一收紧
        return _SECRET_FILE.read_text(encoding="utf-8").strip()
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    _restrict_perms(_DATA_DIR, 0o700)
    key = secrets.token_hex(32)
    _SECRET_FILE.write_text(key, encoding="utf-8")
    _restrict_perms(_SECRET_FILE)
    return key


def credentials_configured() -> bool:
    return _AUTH_FILE.exists()


def _hash_password(password: str) -> str:
    """PBKDF2-HMAC-SHA256，21 万次迭代（OWASP 2023 建议）。"""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, 210_000
    )
    return f"pbkdf2_sha256$210000${salt.hex()}${digest.hex()}"


def _verify_password(stored: str, password: str) -> bool:
    try:
        algo, iterations, salt_hex, digest_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            int(iterations),
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def set_credentials(username: str, password: str) -> None:
    """写入/更新登录凭据（CLI 或首次初始化调用）。"""
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    data = {
        "username": username.strip(),
        "password_hash": _hash_password(password),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "version": 1,
    }
    _AUTH_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _restrict_perms(_AUTH_FILE)


def verify_credentials(username: str, password: str) -> bool:
    if not _AUTH_FILE.exists():
        return False
    try:
        data = json.loads(_AUTH_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False
    if not hmac.compare_digest(username.strip(), str(data.get("username", ""))):
        return False
    return _verify_password(str(data.get("password_hash", "")), password)


# ----------------------------------------------------------
# 登录限速
# ----------------------------------------------------------
def _client_ip() -> str:
    # 只信任反代设置的 X-Real-IP；无反代时用直连地址
    return request.headers.get("X-Real-IP") or request.remote_addr or "unknown"


def rate_limit_exceeded(ip: str) -> bool:
    """指定 IP 是否已触发锁定。"""
    now = time.time()
    hits = [t for t in _failures.get(ip, []) if now - t < _LOCK_WINDOW_SECONDS]
    _failures[ip] = hits
    return len(hits) >= _LOCK_MAX_FAILURES


def record_failure(ip: str) -> None:
    _failures.setdefault(ip, []).append(time.time())


def clear_failures(ip: str) -> None:
    _failures.pop(ip, None)


# ----------------------------------------------------------
# Flask 路由（挂到 app 上）
# 契约对齐 0.1.48 控制台前端：/api/auth/me、password/login、server-link 等
# ----------------------------------------------------------
def register_auth_routes(app) -> None:
    @app.get("/api/auth/me")
    def api_auth_me():
        authed = bool(session.get("authenticated"))
        username = session.get("username", "")
        return jsonify({
            "ok": True,
            "authenticated": authed,
            "auth_type": "password" if authed else "",
            "user": {"username": username, "auth_type": "password"} if authed else None,
            "credentials_configured": credentials_configured(),
            "credentials_username": username if authed else "",
            "credential_prompt_required": False,
            "auth_state": {
                "allowed_users": [],
                "locked_username": username if authed else "",
                "authenticated": authed,
            },
        })

    def _do_login():
        if not credentials_configured():
            return jsonify({"ok": False, "error": "尚未配置登录凭据"}), 403
        ip = _client_ip()
        if rate_limit_exceeded(ip):
            return jsonify({"ok": False, "error": "尝试过于频繁，请 15 分钟后再试"}), 429
        data = request.get_json(silent=True) or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        if not verify_credentials(username, password):
            record_failure(ip)
            _audit("login_failure", username, ip)
            return jsonify({
                "ok": False,
                "error": "用户名或密码错误",
                "error_code": "invalid_credentials",
                "message_key": "auth.password.invalid",
            }), 401
        clear_failures(ip)
        session.clear()
        session["authenticated"] = True
        session["username"] = username
        session.permanent = True
        _audit("login_success", username, ip)
        return jsonify({"ok": True})

    @app.post("/api/auth/password/login")
    def api_auth_password_login():
        return _do_login()

    @app.post("/api/auth/login")
    def api_auth_login():
        return _do_login()

    @app.post("/api/auth/logout")
    def api_auth_logout():
        _audit("logout", session.get("username", ""), _client_ip())
        session.clear()
        return jsonify({"ok": True})

    # ---- 0.1.48 兼容 stub：本自建版不依赖平台 OAuth / server-link ----

    @app.post("/api/auth/server-link")
    def api_auth_server_link():
        return jsonify({
            "ok": False,
            "error": "服务器链接无效，请重新获取链接。",
            "error_code": "server_link_invalid",
            "message_key": "auth.server_link.invalid",
        }), 401

    @app.post("/api/auth/register")
    def api_auth_register():
        """首次注册：仅当尚未配置登录凭据时可用，创建后直接登录。

        开源版首启流程：访问登录页 → 创建管理员账号 → 自动登录。
        凭据已配置后本接口恒拒绝，防止越权覆盖。
        """
        if credentials_configured():
            return jsonify({"ok": False, "error": "登录凭据已配置，请直接登录"}), 403
        data = request.get_json(silent=True) or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        confirm = data.get("confirm_password") or ""
        if not username:
            return jsonify({"ok": False, "error": "用户名不能为空"}), 400
        if len(password) < 8:
            return jsonify({"ok": False, "error": "密码至少 8 位"}), 400
        if password != confirm:
            return jsonify({"ok": False, "error": "两次输入的密码不一致"}), 400
        ip = _client_ip()
        set_credentials(username, password)
        session.clear()
        session["authenticated"] = True
        session["username"] = username
        session.permanent = True
        _audit("register", username, ip)
        _audit("login_success", username, ip)
        return jsonify({"ok": True, "credentials": {"configured": True, "username": username}})

    @app.get("/api/auth/credentials")
    @app.post("/api/auth/credentials")
    def api_auth_credentials():
        # 读取状态（GET）
        if request.method == "GET":
            return jsonify({
                "ok": True,
                "credentials": {
                    "configured": credentials_configured(),
                    "username": session.get("username", ""),
                },
            })
        # 设置/重置凭据（POST，需已登录）
        if not session.get("authenticated"):
            return jsonify({"ok": False, "error": "未登录，请先登录。"}), 401
        data = request.get_json(silent=True) or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        confirm = data.get("confirm_password") or ""
        if not username:
            return jsonify({"ok": False, "error": "用户名不能为空"}), 400
        if len(password) < 8:
            return jsonify({"ok": False, "error": "密码至少 8 位"}), 400
        if password != confirm:
            return jsonify({"ok": False, "error": "两次输入的密码不一致"}), 400
        set_credentials(username, password)
        session["username"] = username
        return jsonify({"ok": True, "credentials": {"configured": True, "username": username}})

    @app.post("/api/auth/credentials/prompt-dismiss")
    def api_auth_credentials_prompt_dismiss():
        return jsonify({"ok": True})

    @app.get("/api/auth/audit")
    def api_auth_audit():
        if not session.get("authenticated"):
            return jsonify({"ok": False, "error": "未登录，请先登录。"}), 401
        limit = request.args.get("limit", default=100, type=int)
        return jsonify({"ok": True, "items": list_audit(limit=min(limit, 500))})


def auth_middleware(app) -> None:
    """未登录拦截：除登录相关与静态资源外，全部返回 401 JSON。"""

    @app.before_request
    def _require_login():
        path = request.path
        if path.startswith("/static/") or path in ("/login", "/favicon.ico"):
            return None
        if path.startswith("/api/auth/"):
            return None
        if session.get("authenticated"):
            return None
        if path.startswith("/api/"):
            return jsonify({"ok": False, "error": "未登录，请先登录。"}), 401
        return None  # 页面路由由前端跳登录
