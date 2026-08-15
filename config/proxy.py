# -*- coding: utf-8 -*-
"""
代理池配置

每次注册随机抽取一个代理，保证不同 sid 之间彼此独立，避免风控关联。

协议说明：
    - http:// / https://   HTTP(S) 代理
    - socks5://            SOCKS5（DNS 本地解析，可能泄漏）
    - socks5h://           SOCKS5（DNS 在代理端解析，推荐，避免 DNS-IP 错配）
"""
from config.env_loader import apply_env_overrides
import random


# 本地代理入口；实际出口地区以代理/分流规则为准。
# 推荐使用 socks5h://（DNS 在代理端解析），避免本地 DNS 与出口 IP 地区错配。
PROXY_POOL = [
    "http://127.0.0.1:7897",
]

# 套餐/Plus 试用资格查询与 Codex Agent Token 生成共用这组独立网络策略，
# 避免批量请求被注册代理池中的临时本地代理拖垮，也避免无条件直连造成出口策略失控。
#   auto   = 优先使用 PLAN_CHECK_PROXY 或代理池；本地代理端口未监听时回退直连
#   proxy  = 强制使用 PLAN_CHECK_PROXY 或代理池，失败直接报错
#   direct = 始终直连
PLAN_CHECK_PROXY_MODE = "auto"

# 套餐查询 / Codex Agent Token 生成专用代理。留空时 auto/proxy 模式从 PROXY_POOL 选择。
# 代理可能包含账号密码，因此 WebUI 会把它保存到 .env。
PLAN_CHECK_PROXY = ""

# 查套餐 / 生成 Codex Agent Token 使用独立的短超时和有限重试，避免后台任务长时间卡住。
PLAN_CHECK_TIMEOUT = 15.0
PLAN_CHECK_MAX_ATTEMPTS = 2
PLAN_CHECK_RETRY_DELAY = 1.5

# 新注册账号的权益可能存在短暂同步延迟。首次查询失败，或返回 free 且暂未发现
# Plus 试用资格时，等待该秒数后再复查一次；设为 0 可关闭复查。
PLAN_CHECK_REGISTRATION_RECHECK_DELAY = 2.0

# 自动、手动和批量套餐查询共用同一个后台队列；Codex Agent Token 使用独立队列，
# 但复用这里的网络模式、请求启动间隔与随机抖动，避免批量后台请求过于集中。
PLAN_CHECK_WORKERS = 3
PLAN_CHECK_QUEUE_LIMIT = 500
PLAN_CHECK_MIN_INTERVAL = 0.4
PLAN_CHECK_JITTER = 0.3


# ============================================================
# 动态住宅代理池（API 提取型）
# 从厂商 API 拉取代理列表，与静态 PROXY_POOL 合并使用（见 core/proxy_pool.py）。
# 支持：Oxylabs key URL、Webshare list API、通用提取 API（纯文本/JSON 自动识别）。
# 网关型（固定地址+动态用户名，如 BrightData/IPRoyal）直接写进 PROXY_POOL 即可。
# ============================================================

# 总开关：启用动态代理池
PROXY_DYNAMIC_ENABLED: bool = False

# 提取 API 地址。示例：
#   Oxylabs：https://proxy.oxylabs.io/key/{API_KEY}
#   Webshare：https://proxy.webshare.io/api/v2/proxy/list/?page=1&page_size=25
#   通用提取：https://api.proxy-service.com/get?key=YOUR_API_KEY
PROXY_DYNAMIC_API_URL: str = ""

# API 认证：支持 "Bearer xxx" / "Token xxx" / "user:pass"（Basic）/ 任意 "Header: value"
PROXY_DYNAMIC_API_AUTH: str = "Token wrong"

# 拉取间隔（分钟）；过期后自动重新拉取，失败沿用旧池
PROXY_DYNAMIC_REFRESH_MINUTES: int = 30

# 动态池容量上限（超过随机截断）
PROXY_DYNAMIC_MAX_POOL: int = 200


def pick_proxy() -> str:
    """从代理池中随机抽取一个代理 URL；池为空时返回空串（即不使用代理）。

    动态住宅代理池优先（未过期），静态 PROXY_POOL 兜底。
    """
    try:
        from core.proxy_pool import pick_proxy as _dynamic_pick
        return _dynamic_pick()
    except Exception:
        return random.choice(PROXY_POOL) if PROXY_POOL else ""


# 兼容入口：默认每次进程启动随机选一个，作为本次注册全程的固定代理
PROXY = pick_proxy()

# ---- .env overrides for WebUI editable fields ----
apply_env_overrides(globals(), {
    'PROXY_POOL': 'list_str_multiline',
    'PROXY_DYNAMIC_ENABLED': 'bool',
    'PROXY_DYNAMIC_API_URL': 'str',
    'PROXY_DYNAMIC_API_AUTH': 'str',
    'PROXY_DYNAMIC_REFRESH_MINUTES': 'int',
    'PROXY_DYNAMIC_MAX_POOL': 'int',
    'PLAN_CHECK_PROXY_MODE': 'str',
    'PLAN_CHECK_PROXY': 'str',
    'PLAN_CHECK_TIMEOUT': 'float',
    'PLAN_CHECK_MAX_ATTEMPTS': 'int',
    'PLAN_CHECK_RETRY_DELAY': 'float',
    'PLAN_CHECK_REGISTRATION_RECHECK_DELAY': 'float',
    'PLAN_CHECK_WORKERS': 'int',
    'PLAN_CHECK_QUEUE_LIMIT': 'int',
    'PLAN_CHECK_MIN_INTERVAL': 'float',
    'PLAN_CHECK_JITTER': 'float',
})
PROXY = pick_proxy()
