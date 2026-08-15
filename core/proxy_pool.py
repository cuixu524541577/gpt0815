# -*- coding: utf-8 -*-
"""
动态住宅代理池：从厂商 API 拉取代理列表，与静态 PROXY_POOL 合并使用。

支持两类厂商 API（常见住宅代理厂商格式）：
1. 纯文本列表 —— 每行一个代理：
       [scheme://][user:pass@]host:port        （Oxylabs / IPRoyal 网关导出、通用列表）
       host:port:user:pass                      （四段式免费/API 列表）
   Oxylabs 示例：https://proxy.oxylabs.io/key/{API_KEY}
2. JSON 列表 —— 自动识别常见容器与字段：
       {"proxies": [...]} / {"data": {"results": [...]}} / {"list": [...]}
       元素为字符串，或对象 {ip|proxy_address|host, port|ports, username|user, password|pass}
   Webshare 示例：GET https://proxy.webshare.io/api/v2/proxy/list/（Authorization: Token xxx）

认证（PROXY_DYNAMIC_API_AUTH）支持三种写法：
    "Bearer <token>" / "Token <token>"   —— Authorization 头
    "user:pass"                          —— HTTP Basic
    "<header>: <value>"                  —— 任意自定义头

配置开关：PROXY_DYNAMIC_ENABLED / PROXY_DYNAMIC_API_URL / PROXY_DYNAMIC_API_AUTH /
          PROXY_DYNAMIC_REFRESH_MINUTES / PROXY_DYNAMIC_MAX_POOL

代理选择：pick_proxy() 优先从动态池随机取（未过期），动态池为空/未配置时回退静态 PROXY_POOL。
"""
from __future__ import annotations

import json
import logging
import random
import threading
import time
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

_POOL_FILE = Path(__file__).resolve().parent.parent / "data" / "proxy_pool.json"
_LOCK = threading.RLock()

# JSON 容器字段（递归查找代理数组）
_JSON_CONTAINER_KEYS = ("proxies", "proxy_list", "proxylist", "results", "items", "list", "data", "proxyList")
# 对象元素字段
_HOST_KEYS = ("proxy_address", "proxyAddress", "ip", "host", "address", "proxy", "ips")
_PORT_KEYS = ("port", "proxy_port", "proxyPort", "ports")
_USER_KEYS = ("username", "user", "login")
_PASS_KEYS = ("password", "pass", "passwd")


def _cfg(name: str, default=None):
    """读配置（config.reload_all() 热加载后模块属性已更新）。"""
    try:
        from config import proxy as module
        return getattr(module, name, default)
    except Exception:
        return default


def _int_cfg(name: str, default: int, lower: int, upper: int) -> int:
    try:
        value = int(_cfg(name, default) or default)
    except (TypeError, ValueError):
        value = default
    return max(lower, min(upper, value))


def enabled() -> bool:
    return str(_cfg("PROXY_DYNAMIC_ENABLED", "false")).strip().lower() in ("true", "1", "yes", "on")


def api_url() -> str:
    return str(_cfg("PROXY_DYNAMIC_API_URL", "") or "").strip()


def api_auth() -> str:
    return str(_cfg("PROXY_DYNAMIC_API_AUTH", "") or "").strip()


# ------------------------------------------------------------
# 解析
# ------------------------------------------------------------
def _normalize_entry(raw: str) -> str | None:
    """规范化一行代理为 [scheme://][user:pass@]host:port；不合法返回 None。"""
    text = str(raw or "").strip()
    if not text or text.startswith("#"):
        return None
    # 已有协议前缀（http/https/socks*）→ 原样
    if "://" in text:
        from webui.compat import _parse_proxy_address
        if _parse_proxy_address(text) is None:
            return None
        return text
    # 四段式 ip:port:user:pass → http://user:pass@ip:port
    parts = text.split(":")
    if len(parts) == 4 and parts[0].count(".") == 3 and parts[1].isdigit():
        host, port, user, pwd = parts
        if port.isdigit() and user and pwd:
            return f"http://{user}:{pwd}@{host}:{port}"
    # 普通 host:port
    from webui.compat import _parse_proxy_address
    if _parse_proxy_address(text) is None:
        return None
    return text


def parse_proxy_text(body: str) -> list[str]:
    """解析纯文本代理列表（每行一个）。"""
    out = []
    for line in (body or "").splitlines():
        entry = _normalize_entry(line)
        if entry:
            out.append(entry)
    return out


def _find_proxy_array(node, depth: int = 0):
    """递归在 JSON 里找代理数组；返回数组或 None。"""
    if depth > 4 or node is None:
        return None
    if isinstance(node, list):
        if node and any(isinstance(x, (str, dict)) for x in node):
            return node
        return None
    if isinstance(node, dict):
        for key in node:
            low = str(key).lower()
            if low in _JSON_CONTAINER_KEYS:
                found = _find_proxy_array(node[key], depth + 1)
                if found is not None:
                    return found
        # 兜底：递归所有值
        for value in node.values():
            found = _find_proxy_array(value, depth + 1)
            if found is not None:
                return found
    return None


def _entry_from_object(obj: dict) -> str | None:
    """从 JSON 对象元素提取代理字符串。"""
    host = ""
    for key in _HOST_KEYS:
        if obj.get(key):
            host = str(obj[key]).strip()
            break
    if not host:
        return None
    port = ""
    for key in _PORT_KEYS:
        value = obj.get(key)
        if value is None:
            continue
        if isinstance(value, dict):  # ports: {"http": 8000, "socks5": 8001}
            port = str(value.get("http") or value.get("socks5") or value.get("https") or "")
        else:
            port = str(value)
        if port:
            break
    user = ""
    for key in _USER_KEYS:
        if obj.get(key):
            user = str(obj[key]).strip()
            break
    pwd = ""
    for key in _PASS_KEYS:
        if obj.get(key):
            pwd = str(obj[key]).strip()
            break
    if port:
        base = f"{host}:{port}"
    else:
        base = host
    if user and pwd:
        return f"http://{user}:{pwd}@{base}"
    if user:
        return f"http://{user}@{base}"
    return base


def parse_proxy_json(data) -> list[str]:
    """解析 JSON 代理列表（自动识别容器与字段）。"""
    arr = _find_proxy_array(data)
    if arr is None:
        return []
    out = []
    for item in arr:
        if isinstance(item, str):
            entry = _normalize_entry(item)
            if entry:
                out.append(entry)
        elif isinstance(item, dict):
            entry = _normalize_entry(_entry_from_object(item) or "")
            if entry:
                out.append(entry)
    return out


def parse_proxy_response(body: str, content_type: str = "") -> list[str]:
    """按响应类型自动分发解析。返回规范化代理列表。"""
    if not body:
        return []
    text = body.strip()
    if not text:
        return []
    # JSON 优先（content-type 或内容特征）
    looks_json = "json" in (content_type or "").lower() or text.startswith(("{", "["))
    if looks_json:
        try:
            data = json.loads(text)
            parsed = parse_proxy_json(data)
            if parsed:
                return parsed
        except Exception:
            pass
    return parse_proxy_text(text)


# ------------------------------------------------------------
# 拉取 / 合并 / 读取
# ------------------------------------------------------------
def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _read_pool() -> dict:
    if not _POOL_FILE.exists():
        return {"fetched_at": None, "proxies": []}
    try:
        data = json.loads(_POOL_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("proxies"), list):
            return data
    except Exception:
        pass
    return {"fetched_at": None, "proxies": []}


def _write_pool(pool: dict) -> None:
    _POOL_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _POOL_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(pool, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(_POOL_FILE)


def _pool_expired(pool: dict) -> bool:
    fetched = pool.get("fetched_at")
    if not fetched:
        return True
    try:
        fetched_dt = datetime.fromisoformat(str(fetched))
        return (datetime.now() - fetched_dt).total_seconds() > _int_cfg("PROXY_DYNAMIC_REFRESH_MINUTES", 30, 1, 1440) * 60
    except Exception:
        return True


def _mode() -> str:
    return str(_cfg("PROXY_DYNAMIC_MODE", "api") or "api").strip().lower()


def manual_list() -> list[str]:
    """手动模式：从配置读取代理列表。"""
    raw = _cfg("PROXY_DYNAMIC_MANUAL_LIST", None)
    lines = raw if isinstance(raw, list) else str(raw or "").splitlines()
    out = []
    for line in lines:
        entry = _normalize_entry(line)
        if entry:
            out.append(entry)
    return out


def fetch_dynamic_proxies(timeout: float = 20.0) -> list[str]:
    """按模式拉取代理列表（manual=手动列表，api=厂商 API）。失败抛异常。"""
    if _mode() == "manual":
        parsed = manual_list()
        if not parsed:
            raise RuntimeError("PROXY_DYNAMIC_MODE=manual 但手动代理列表为空（请填写 PROXY_DYNAMIC_MANUAL_LIST）")
        return parsed
    url = api_url()
    if not url:
        raise RuntimeError("PROXY_DYNAMIC_API_URL 未配置")
    auth = api_auth()
    headers = {}
    if auth:
        if auth.lower().startswith(("bearer ", "token ")):
            headers["Authorization"] = auth
        elif ":" in auth and not auth.lower().startswith(("http", "{")):
            # 形如 "X-Key: value" 的自定义头；否则视为 Basic user:pass
            k, _, v = auth.partition(":")
            if k.strip() and v.strip() and not k.strip().lower().startswith(("http", "api")):
                headers[k.strip()] = v.strip()
            else:
                import base64
                headers["Authorization"] = "Basic " + base64.b64encode(auth.encode()).decode()
        else:
            headers["Authorization"] = auth
    import requests
    resp = requests.get(url, headers=headers, timeout=timeout)
    if resp.status_code >= 400:
        raise RuntimeError(f"动态代理 API HTTP {resp.status_code}: {(resp.text or '')[:200]}")
    parsed = parse_proxy_response(resp.text, resp.headers.get("Content-Type", ""))
    if not parsed:
        # 带上原始响应前 200 字符，并识别常见错误（白名单/拒绝/认证失败）
        snippet = " ".join((resp.text or "").split())[:200]
        low = (resp.text or "").lower()
        if "whitelist" in low:
            raise RuntimeError(
                f"动态代理 API 未授权：{snippet or '(空响应)'}（请到厂商后台把当前服务器公网 IP 加入白名单）")
        if "forbidden" in low or "access denied" in low or "invalid ip" in low:
            raise RuntimeError(f"动态代理 API 拒绝访问：{snippet or '(空响应)'}")
        if "unauthorized" in low or "invalid key" in low or "bad key" in low:
            raise RuntimeError(f"动态代理 API 认证失败：{snippet or '(空响应)'}")
        raise RuntimeError(f"动态代理 API 返回为空或无法解析：{snippet or '(空响应)'}")
    return parsed


def merge_proxy_lists(fetched: list[str], existing: list[str], max_pool: int) -> list[str]:
    """合并去重（新列表优先），超过上限随机截断。"""
    seen = set()
    merged = []
    for entry in list(fetched) + list(existing):
        if entry not in seen:
            seen.add(entry)
            merged.append(entry)
    if len(merged) > max(1, max_pool):
        merged = random.sample(merged, max(1, max_pool))
    return merged


def refresh_pool() -> dict:
    """拉取并合并进本地池。返回合并后的池。"""
    with _LOCK:
        fetched = fetch_dynamic_proxies()
        max_pool = _int_cfg("PROXY_DYNAMIC_MAX_POOL", 200, 1, 5000)
        pool = _read_pool()
        merged = merge_proxy_lists(fetched, pool.get("proxies", []), max_pool)
        pool = {"fetched_at": _now(), "proxies": merged, "source": api_url()}
        _write_pool(pool)
        logger.info("[动态代理] 刷新完成：新增 %d 条，池共 %d 条", len(fetched), len(merged))
        return pool


def dynamic_proxies() -> list[str]:
    """读取动态池；过期时尝试刷新（失败返回旧列表）。manual 模式无需 API 地址。"""
    if not enabled():
        return []
    pool = _read_pool()
    if _pool_expired(pool):
        try:
            pool = refresh_pool()
        except Exception as exc:
            logger.warning("[动态代理] 刷新失败，使用旧池: %s", exc)
    return pool.get("proxies", []) or []


def pick_proxy() -> str:
    """动态池优先随机取；动态池为空/未启用时回退静态 PROXY_POOL。"""
    try:
        dyn = dynamic_proxies()
        if dyn:
            return random.choice(dyn)
    except Exception:
        logger.exception("[动态代理] 读取动态池异常，回退静态池")
    try:
        from config import proxy as _proxy_cfg
        pool = getattr(_proxy_cfg, "PROXY_POOL", None) or []
        return random.choice(pool) if pool else ""
    except Exception:
        return ""


def pool_summary() -> dict:
    """状态摘要（供 WebUI 展示）。"""
    pool = _read_pool()
    return {
        "enabled": enabled(),
        "mode": _mode(),
        "api_url": api_url() or "",
        "count": len(pool.get("proxies", []) or []),
        "fetched_at": pool.get("fetched_at"),
        "expired": _pool_expired(pool),
        "refresh_minutes": _int_cfg("PROXY_DYNAMIC_REFRESH_MINUTES", 30, 1, 1440),
    }
