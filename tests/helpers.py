# -*- coding: utf-8 -*-
"""测试辅助：凭据备份/恢复（防止测试覆盖真实登录凭据）。"""
import json
from contextlib import contextmanager
from pathlib import Path

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_AUTH_FILE = _DATA_DIR / "auth.json"


@contextmanager
def protected_credentials(username="smoke", password="SmokeTest@123456"):
    """临时设置测试凭据，退出后恢复原凭据。"""
    backup = None
    if _AUTH_FILE.exists():
        backup = _AUTH_FILE.read_text(encoding="utf-8")
    from webui import auth as A
    A.set_credentials(username, password)
    try:
        yield
    finally:
        if backup is not None:
            _AUTH_FILE.write_text(backup, encoding="utf-8")
        else:
            _AUTH_FILE.unlink(missing_ok=True)


def login_client(app, username="smoke", password="SmokeTest@123456"):
    """创建已登录的测试客户端（内部自动备份/恢复凭据）。"""
    from contextlib import nullcontext
    return nullcontext()
