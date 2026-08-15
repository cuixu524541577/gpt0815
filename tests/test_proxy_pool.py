# -*- coding: utf-8 -*-
"""动态住宅代理池解析单元测试（各厂商 API 返回格式）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from core import proxy_pool as pp


# ------------------------------------------------------------
# 纯文本格式
# ------------------------------------------------------------
def test_parse_oxylabs_text():
    """Oxylabs key URL 返回的纯文本 IP 列表。"""
    body = "127.0.0.1:60000\n1.2.3.4:60001\n\n# 注释行\n"
    parsed = pp.parse_proxy_response(body, "text/plain")
    assert parsed == ["127.0.0.1:60000", "1.2.3.4:60001"]


def test_parse_four_part_lines():
    """四段式 ip:port:user:pass → http://user:pass@ip:port。"""
    body = "1.2.3.4:8080:proxyuser:proxypass\n"
    parsed = pp.parse_proxy_response(body)
    assert parsed == ["http://proxyuser:proxypass@1.2.3.4:8080"]


def test_parse_socks_prefix_lines():
    body = "socks5://1.2.3.4:1080\nhttp://u:p@5.6.7.8:3128\n"
    parsed = pp.parse_proxy_response(body)
    assert "socks5://1.2.3.4:1080" in parsed
    assert "http://u:p@5.6.7.8:3128" in parsed


def test_parse_garbage_text():
    assert pp.parse_proxy_response("") == []
    assert pp.parse_proxy_response("not a proxy\nftp://x:21\n") == []


# ------------------------------------------------------------
# JSON 格式
# ------------------------------------------------------------
def test_parse_webshare_json():
    """Webshare /api/v2/proxy/list/ 结构：data.results[]."""
    body = '''{
      "data": {
        "results": [
          {"proxy_address": "host1.example.com", "port": 8000, "username": "u1", "password": "p1", "country_code": "US"},
          {"proxy_address": "host2.example.com", "port": 8001, "username": "u2", "password": "p2"},
          {"proxy_address": "host3.example.com", "ports": {"http": 8002, "socks5": 8003}, "username": "u3", "password": "p3"}
        ]
      },
      "count": 3
    }'''
    parsed = pp.parse_proxy_response(body, "application/json")
    assert parsed == [
        "http://u1:p1@host1.example.com:8000",
        "http://u2:p2@host2.example.com:8001",
        "http://u3:p3@host3.example.com:8002",
    ]


def test_parse_generic_json():
    """通用提取 API：proxies 数组（对象与字符串混合）。"""
    body = '{"proxies": [{"ip": "1.1.1.1:8080", "type": "http"}, "2.2.2.2:8081", {"ip": "3.3.3.3", "port": 8082}]}'
    parsed = pp.parse_proxy_response(body, "application/json")
    assert parsed == ["1.1.1.1:8080", "2.2.2.2:8081", "3.3.3.3:8082"]


def test_parse_json_string_array():
    body = '["1.2.3.4:8000", "5.6.7.8:8001"]'
    parsed = pp.parse_proxy_response(body, "application/json")
    assert parsed == ["1.2.3.4:8000", "5.6.7.8:8001"]


def test_parse_json_nested_data():
    body = '{"data": {"list": ["9.9.9.9:9000"]}}'
    assert pp.parse_proxy_response(body) == ["9.9.9.9:9000"]


def test_parse_json_garbage():
    assert pp.parse_proxy_response('{"error": "bad key"}', "application/json") == []
    assert pp.parse_proxy_response('not json at all', "application/json") == []


def test_parse_json_with_ports_dict_fallback():
    """ports 是 dict 且无 http 时取 socks5。"""
    body = '{"items": [{"host": "h1", "ports": {"socks5": 1081}, "user": "u", "pass": "p"}]}'
    parsed = pp.parse_proxy_response(body, "application/json")
    assert parsed == ["http://u:p@h1:1081"]


# ------------------------------------------------------------
# 池管理
# ------------------------------------------------------------
def test_pool_merge_and_dedupe(tmp_path, monkeypatch):
    pp._POOL_FILE = tmp_path / "proxy_pool.json"
    monkeypatch.setattr(pp, "_write_pool", pp._write_pool)
    pool = {"fetched_at": pp._now(), "proxies": ["a:1", "b:2"]}
    pp._write_pool(pool)
    # 合并去重（新列表优先）
    merged = pp.merge_proxy_lists(["b:2", "c:3"], ["a:1", "b:2"], 10)
    assert merged == ["b:2", "c:3", "a:1"]
    # 超上限随机截断
    cut = pp.merge_proxy_lists(["x:1"], ["y:1", "z:1"], 2)
    assert len(cut) == 2


def test_summary_shape(tmp_path, monkeypatch):
    pp._POOL_FILE = tmp_path / "proxy_pool.json"
    s = pp.pool_summary()
    assert set(s) >= {"enabled", "api_url", "count", "fetched_at", "expired", "refresh_minutes"}
    assert s["count"] == 0


# ------------------------------------------------------------
# 手动模式（二选一：api / manual）
# ------------------------------------------------------------
def test_manual_mode_parses_config_list(monkeypatch):
    monkeypatch.setattr(pp, "_cfg", lambda name, default=None: {
        "PROXY_DYNAMIC_ENABLED": "true",
        "PROXY_DYNAMIC_MODE": "manual",
        "PROXY_DYNAMIC_MANUAL_LIST": ["1.2.3.4:8080", "socks5://5.6.7.8:1080", "bad line", "9.9.9.9:9999:user:pass"],
        "PROXY_DYNAMIC_API_URL": "",
        "PROXY_DYNAMIC_REFRESH_MINUTES": 30,
        "PROXY_DYNAMIC_MAX_POOL": 200,
    }.get(name, default))
    proxies = pp.fetch_dynamic_proxies()
    assert proxies == ["1.2.3.4:8080", "socks5://5.6.7.8:1080", "http://user:pass@9.9.9.9:9999"]


def test_manual_mode_empty_list_raises(monkeypatch):
    monkeypatch.setattr(pp, "_cfg", lambda name, default=None: {
        "PROXY_DYNAMIC_ENABLED": "true",
        "PROXY_DYNAMIC_MODE": "manual",
        "PROXY_DYNAMIC_MANUAL_LIST": [],
        "PROXY_DYNAMIC_API_URL": "",
    }.get(name, default))
    import pytest as _pt
    with _pt.raises(RuntimeError, match="手动代理列表为空"):
        pp.fetch_dynamic_proxies()
