# -*- coding: utf-8 -*-
"""自动化任务范围预览：必须返回 account_total，前端创建按钮才可点。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from webui.app import create_app

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_AUTH_FILE = _DATA_DIR / "auth.json"
_AUTH_BACKUP = None
if _AUTH_FILE.exists():
    _AUTH_BACKUP = _AUTH_FILE.read_text(encoding="utf-8")
    _AUTH_FILE.unlink()

try:
    app = create_app()
    c = app.test_client()
    # 首次注册拿会话（与 smoke_test 相同模式）
    c.post("/api/auth/register", json={
        "username": "previewadmin",
        "password": "PreviewAdmin@123",
        "confirm_password": "PreviewAdmin@123",
    })

    def test_scope_preview_returns_account_total(monkeypatch):
        fake_rows = [
            {"email": "a@example.com", "access_token": "t1"},
            {"email": "b@example.com", "access_token": "t2"},
        ]
        monkeypatch.setattr(
            "webui.compat._resolve_identities", lambda identities: fake_rows
        )
        resp = c.post("/api/automation-tasks/scope-preview", json={
            "task_type": "codex_retry",
            "scope": "selected",
            "identities": ["a@example.com", "b@example.com"],
            "filters": {},
        })
        data = resp.get_json()
        assert resp.status_code == 200
        assert data["account_total"] == 2, "前端依赖 account_total 判断创建按钮是否可点"
        assert data["requested"] == 2
        assert data["identities"] == ["a@example.com", "b@example.com"]

    def test_scope_preview_empty_scope(monkeypatch):
        monkeypatch.setattr(
            "webui.compat._resolve_identities", lambda identities: []
        )
        resp = c.post("/api/automation-tasks/scope-preview", json={
            "task_type": "codex_retry",
            "scope": "selected",
            "identities": [],
            "filters": {},
        })
        data = resp.get_json()
        assert data["account_total"] == 0
finally:
    # 恢复真实凭据，避免污染本地登录
    if _AUTH_BACKUP is not None:
        _AUTH_FILE.write_text(_AUTH_BACKUP, encoding="utf-8")
    elif _AUTH_FILE.exists():
        _AUTH_FILE.unlink()
