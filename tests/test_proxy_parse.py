# -*- coding: utf-8 -*-
"""代理地址解析单元测试（/api/proxy/test 的格式支持）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from webui.compat import _PROXY_DEFAULT_PORTS, _parse_proxy_address


@pytest.mark.parametrize("raw,want", [
    ("socks5://127.0.0.1:7897", ("127.0.0.1", 7897, "socks5")),
    ("socks5h://127.0.0.1:7897", ("127.0.0.1", 7897, "socks5h")),
    ("socks4://1.2.3.4:1080", ("1.2.3.4", 1080, "socks4")),
    ("http://user:pass@1.2.3.4:8080", ("1.2.3.4", 8080, "http")),
    ("https://proxy.example.com", ("proxy.example.com", 443, "https")),
    ("127.0.0.1:7897", ("127.0.0.1", 7897, "http")),
    ("[::1]:7897", ("::1", 7897, "http")),
    ("[2001:db8::1]", ("2001:db8::1", 80, "http")),
    ("socks5://1.2.3.4:1080", ("1.2.3.4", 1080, "socks5")),
])
def test_parse_valid(raw, want):
    got = _parse_proxy_address(raw)
    assert got is not None and got[:3] == want, f"{raw} -> {got}"


@pytest.mark.parametrize("raw", [
    "", "   ", "not a proxy", "ftp://1.2.3.4:21", "://bad",
    "socks5://", "socks5://1.2.3.4", "http://", "1.2.3.4:abc", "host:port:extra", None,
])
def test_parse_invalid(raw):
    assert _parse_proxy_address(raw) is None, f"{raw!r} 应判无效"
