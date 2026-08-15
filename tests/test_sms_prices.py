# -*- coding: utf-8 -*-
"""接码平台价格解析（sms-activate 兼容协议）回归测试。"""
from webui.compat import _parse_sms_activate_countries, _parse_sms_activate_prices


def test_parse_countries_iso_map():
    payload = {"0": {"iso": "RU"}, "187": {"iso": "US"}, "bad": "x"}
    assert _parse_sms_activate_countries(payload) == {"0": "RU", "187": "US"}


def test_parse_prices_three_level():
    payload = {"187": {"dr": {"187": {"code": "dr", "count": 87, "price": 40.0}}}}
    items = _parse_sms_activate_prices(payload, "hero", "dr", {"187": "US"})
    assert len(items) == 1
    it = items[0]
    assert it["provider"] == "hero"
    assert it["country_id"] == "187"
    assert it["country_iso"] == "US"
    assert it["price"] == 40.0
    assert it["count"] == 87
    assert it["price_tier_key"] == "hero:187:dr"


def test_parse_prices_two_level_variant():
    payload = {"117": {"dr": {"code": "dr", "count": 5, "price": 1.2}}}
    items = _parse_sms_activate_prices(payload, "grizzly", "dr", {"117": "PT"})
    assert len(items) == 1
    assert items[0]["price"] == 1.2
    assert items[0]["country_iso"] == "PT"


def test_parse_prices_skips_junk():
    assert _parse_sms_activate_prices(None, "x", "dr") == []
    assert _parse_sms_activate_prices("not-json", "x", "dr") == []
    assert _parse_sms_activate_prices({"1": {"dr": {"code": "dr"}}}, "x", "dr") == []
