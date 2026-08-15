# -*- coding: utf-8 -*-
"""代理地址解析回归测试（合并自 PR #1，适配 _parse_proxy_address）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from webui.compat import _parse_proxy_address


def test_parse_authenticated_socks5_url():
    assert _parse_proxy_address(
        "socks5://user-region-US-sid-ABC123:password@example.com:3010"
    )[:3] == ("example.com", 3010, "socks5")


def test_parse_socks5h_url():
    assert _parse_proxy_address("socks5h://user:pass@example.com:1080")[:3] == (
        "example.com",
        1080,
        "socks5h",
    )


@pytest.mark.parametrize(
    "proxy",
    [
        "host.example.com:8080",
        "http://host.example.com:8080",
        "https://host.example.com",
    ],
)
def test_legacy_http_formats_remain_supported(proxy):
    assert _parse_proxy_address(proxy)[0] == "host.example.com"


@pytest.mark.parametrize(
    "proxy",
    [
        "",
        "socks5://user:pass@example.com",
        "ftp://example.com:21",
        "http://example.com:not-a-port",
        "http://example.com:70000",
    ],
)
def test_invalid_proxy_formats_are_rejected(proxy):
    assert _parse_proxy_address(proxy) is None
