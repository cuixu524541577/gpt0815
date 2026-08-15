# -*- coding: utf-8 -*-
"""状态 DB 持久化：全部落在 data/ 目录（Docker 挂载），旧根目录文件自动迁移。"""
from pathlib import Path

from core import db


def test_state_dbs_live_in_data_dir():
    """邮箱池/成功账号/注册任务 DB 必须在 data/ 下，容器重建才不丢。"""
    assert db._DATA_DIR == Path(__file__).resolve().parent.parent / "data"
    for constant in ("_OUTLOOK_JSON", "_GENERIC_API_EMAIL_JSON",
                     "_ACCOUNTS_JSON", "_JOBS_JSON", "_CODEX_EXPORT_STATE"):
        path = getattr(db, constant)
        assert str(path).startswith(str(db._DATA_DIR)), f"{constant} 不在 data/ 下: {path}"


def test_migrate_legacy_root_files(tmp_path, monkeypatch):
    """旧版根目录 DB 首次启动自动迁移到 data/，目标已存在时不覆盖。"""
    root = tmp_path / "root"
    data_dir = tmp_path / "data"
    root.mkdir()
    src = root / "用于注册的邮箱.json"
    src.write_text("[1,2,3]", encoding="utf-8")

    legacy = [("用于注册的邮箱.json", data_dir / "用于注册的邮箱.json")]
    monkeypatch.setattr(db, "_PROJECT_ROOT", root)
    monkeypatch.setattr(db, "_ROOT_JSON_LEGACY", legacy)

    db._migrate_legacy_root_files()
    assert (data_dir / "用于注册的邮箱.json").read_text(encoding="utf-8") == "[1,2,3]"
    # 源文件保留备份
    assert src.exists()

    # 目标已存在：不覆盖
    (data_dir / "用于注册的邮箱.json").write_text("[9]", encoding="utf-8")
    db._migrate_legacy_root_files()
    assert (data_dir / "用于注册的邮箱.json").read_text(encoding="utf-8") == "[9]"
