# -*- coding: utf-8 -*-
"""代理地址解析回归测试。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from webui.compat import _parse_proxy_endpoint


def test_parse_authenticated_socks5_url():
    assert _parse_proxy_endpoint(
        "socks5://user-region-US-sid-ABC123:password@example.com:3010"
    ) == ("example.com", 3010)


def test_parse_socks5h_url():
    assert _parse_proxy_endpoint("socks5h://user:pass@example.com:1080") == (
        "example.com",
        1080,
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
    assert _parse_proxy_endpoint(proxy)[0] == "host.example.com"


@pytest.mark.parametrize(
    "proxy",
    [
        "",
        "socks5://user:pass@example.com",
        "ftp://example.com:21",
        "http://example.com:not-a-port",
    ],
)
def test_invalid_proxy_formats_are_rejected(proxy):
    with pytest.raises(ValueError):
        _parse_proxy_endpoint(proxy)
