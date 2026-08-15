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


def test_parse_four_part_hostname_lines():
    """四段式域名（网关）host:port:user:pass → http://user:pass@host:port。"""
    body = "us.lajiaohttp.net:2000:tvrfc27306-region-Random:tpd867rv\n"
    parsed = pp.parse_proxy_response(body)
    assert parsed == ["http://tvrfc27306-region-Random:tpd867rv@us.lajiaohttp.net:2000"]


def test_parse_four_part_bad_port():
    """四段式端口非数字 → 拒绝。"""
    assert pp.parse_proxy_response("1.2.3.4:notaport:u:p\n") == []


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


# ------------------------------------------------------------
# 辣椒 HTTP（lajiaohttp）支持
# API: http://api.lajiaohttp.com/api/extract_ip?regions=us&num=10&protocol=http&type=txt&cate=1
# 白名单免账密认证；txt 每行 ip:port；json 常见结构兼容
# ------------------------------------------------------------
def test_lajiao_txt_format():
    """辣椒 type=txt：每行 ip:port。"""
    body = "1.2.3.4:8080\n5.6.7.8:9090\n"
    parsed = pp.parse_proxy_response(body, "text/plain")
    assert parsed == ["1.2.3.4:8080", "5.6.7.8:9090"]


def test_lajiao_txt_with_socks5():
    """辣椒 protocol=socks5 时返回 socks5:// 前缀行。"""
    body = "socks5://1.2.3.4:1080\nsocks5://5.6.7.8:1080\n"
    parsed = pp.parse_proxy_response(body)
    assert parsed == ["socks5://1.2.3.4:1080", "socks5://5.6.7.8:1080"]


def test_lajiao_json_string_list():
    """辣椒 type=json 返回字符串数组（常见实现）。"""
    body = '["1.2.3.4:8080", "5.6.7.8:9090"]'
    parsed = pp.parse_proxy_response(body, "application/json")
    assert parsed == ["1.2.3.4:8080", "5.6.7.8:9090"]


def test_lajiao_json_data_list_of_objects():
    """辣椒 type=json 返回 data 数组 + ip/port 对象（常见实现）。"""
    body = '{"code": 200, "data": [{"ip": "1.2.3.4", "port": 8080}, {"ip": "5.6.7.8", "port": 9090}]}'
    parsed = pp.parse_proxy_response(body, "application/json")
    assert parsed == ["1.2.3.4:8080", "5.6.7.8:9090"]


def test_lajiao_json_with_username_password():
    body = '{"data": {"list": [{"ip": "1.2.3.4", "port": 8080, "username": "u", "password": "p"}]}}'
    parsed = pp.parse_proxy_response(body, "application/json")
    assert parsed == ["http://u:p@1.2.3.4:8080"]


def test_whitelist_error_message(monkeypatch):
    """辣椒等厂商返回 'not added to whitelist' 时给出明确指引。"""
    import requests as _req

    class FakeResp:
        status_code = 200
        text = "113.234.144.120 not added to whitelist"
        headers = {"Content-Type": "text/plain"}
    monkeypatch.setattr(pp, "_cfg", lambda name, default=None: {
        "PROXY_DYNAMIC_ENABLED": "true",
        "PROXY_DYNAMIC_MODE": "api",
        "PROXY_DYNAMIC_API_URL": "http://api.lajiaohttp.com/api/extract_ip",
        "PROXY_DYNAMIC_API_AUTH": "",
        "PROXY_DYNAMIC_REFRESH_MINUTES": 30,
        "PROXY_DYNAMIC_MAX_POOL": 200,
    }.get(name, default))
    monkeypatch.setattr(_req, "get", lambda *a, **k: FakeResp())
    with pytest.raises(RuntimeError, match="白名单"):
        pp.fetch_dynamic_proxies()


# ------------------------------------------------------------
# 轮换与封禁（403 换代理）
# ------------------------------------------------------------
def test_pick_from_pool_lru_rotation(tmp_path, monkeypatch):
    """最近最少使用轮换：连续三次两两不同、首尾相同（不会连续抽中同一个）。"""
    import core.proxy_pool as pp
    monkeypatch.setattr(pp, "_POOL_FILE", tmp_path / "pool.json")
    pp._write_pool({"fetched_at": "2026-08-15T00:00:00", "proxies": ["a", "b"]})
    picks = [pp._pick_from_pool(["a", "b"]) for _ in range(3)]
    assert picks[0] != picks[1]
    assert picks[1] != picks[2]
    assert picks[0] == picks[2]


def test_blacklist_skips_proxy_in_dynamic_pool(tmp_path, monkeypatch):
    import core.proxy_pool as pp
    monkeypatch.setattr(pp, "_POOL_FILE", tmp_path / "pool.json")
    pp._write_pool({"fetched_at": "2026-08-15T00:00:00", "proxies": ["a", "b"]})
    pp.blacklist_proxy("b")
    try:
        picks = [pp._pick_from_pool(["a", "b"]) for _ in range(3)]
        assert picks == ["a", "a", "a"]
    finally:
        pp._BLACKLIST.clear()


def test_pick_proxy_static_skips_blacklisted(monkeypatch):
    import core.proxy_pool as pp
    import config.proxy as cp
    monkeypatch.setattr(pp, "dynamic_proxies", lambda: [])
    monkeypatch.setattr(cp, "PROXY_POOL", ["a", "b"])
    pp.blacklist_proxy("b")
    try:
        picks = [pp.pick_proxy() for _ in range(5)]
        assert all(p == "a" for p in picks)
    finally:
        pp._BLACKLIST.clear()
