# -*- coding: utf-8 -*-
"""
数据备份与日志轮转（P1 健壮性）。

- 每日自动备份运行时数据（data/、codex_accounts/、邮箱池文件、任务文件）
- 备份保留 7 份，按时间戳命名，启动时检查是否需要备份
- 日志轮转：超过阈值（默认 5MB）的日志文件滚动为 .1/.2（各保留 2 份）
"""
import logging
import shutil
import time
from datetime import datetime, timedelta
from pathlib import Path

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_BACKUP_DIR = _PROJECT_ROOT / "backups"
_BACKUP_KEEP = 7
_ROTATE_MAX_BYTES = 5 * 1024 * 1024
_ROTATE_KEEP = 2

# 需要备份的运行时数据路径（相对项目根）
_BACKUP_ITEMS = [
    "data",
    "codex_accounts",
    "注册日志",
    "用于注册的邮箱.json",
    "用于注册的邮箱.txt",
    "注册成功的邮箱.json",
    "注册成功的邮箱.txt",
    "注册成功的token.txt",
    "注册任务.json",
    "用于注册的域名邮箱.json",
    "codex_导出状态.json",
]


def _last_backup_time() -> datetime | None:
    if not _BACKUP_DIR.exists():
        return None
    stamps = []
    for p in _BACKUP_DIR.iterdir():
        if p.is_dir() and p.name.startswith("backup-"):
            try:
                stamps.append(datetime.strptime(p.name, "backup-%Y%m%d-%H%M%S"))
            except ValueError:
                continue
    return max(stamps) if stamps else None


def _prune_backups() -> None:
    """只保留最近 _BACKUP_KEEP 份备份。"""
    if not _BACKUP_DIR.exists():
        return
    dirs = sorted(
        (p for p in _BACKUP_DIR.iterdir() if p.is_dir() and p.name.startswith("backup-")),
        key=lambda p: p.name,
        reverse=True,
    )
    for old in dirs[_BACKUP_KEEP:]:
        shutil.rmtree(old, ignore_errors=True)
        logger.info("[备份] 清理旧备份: %s", old.name)


def create_backup(*, force: bool = False) -> Path | None:
    """创建一次备份。非 force 时每天最多一次。"""
    if not force:
        last = _last_backup_time()
        if last is not None and datetime.now() - last < timedelta(hours=24):
            return None
    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    try:
        _BACKUP_DIR.chmod(0o700)  # 备份含敏感凭证，仅所有者可读
    except OSError:
        pass
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = _BACKUP_DIR / f"backup-{stamp}"
    target.mkdir(parents=True, exist_ok=True)
    try:
        target.chmod(0o700)
    except OSError:
        pass
    copied = 0
    for item in _BACKUP_ITEMS:
        src = _PROJECT_ROOT / item
        if not src.exists():
            continue
        try:
            if src.is_dir():
                shutil.copytree(src, target / item, dirs_exist_ok=True)
            else:
                shutil.copy2(src, target / item)
            copied += 1
        except Exception as exc:
            logger.warning("[备份] %s 失败: %s", item, exc)
    _prune_backups()
    logger.info("[备份] 完成: %s（%d 项）", target.name, copied)
    return target


_ROTATE_LOCK = __import__("threading").Lock()


def rotate_logs() -> int:
    """滚动超过阈值的日志文件。返回处理的文件数。

    标准轮转：xxx.log -> xxx.log.1 -> xxx.log.2，.2 为最旧保留（丢弃 .3+）。
    进程内加锁防并发轮转（单进程部署；多进程请配合文件锁）。
    """
    with _ROTATE_LOCK:
        rotated = 0
        log_dir = _PROJECT_ROOT / "注册日志"
        if not log_dir.exists():
            return 0
        for path in log_dir.iterdir():
            if not path.is_file():
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if size < _ROTATE_MAX_BYTES:
                continue
            # 先把最旧的 .KEEP 删掉，再依次后移
            top = Path(f"{path}.{_ROTATE_KEEP}")
            top.unlink(missing_ok=True)
            for i in range(_ROTATE_KEEP - 1, 0, -1):
                cur = Path(f"{path}.{i}")
                if cur.exists():
                    cur.rename(Path(f"{path}.{i + 1}"))
            path.rename(Path(f"{path}.1"))
            rotated += 1
        if rotated:
            logger.info("[日志轮转] 已轮转 %d 个文件", rotated)
        return rotated


def run_maintenance() -> dict:
    """启动时调用：备份 + 轮转。返回执行摘要。"""
    summary = {"backup": None, "rotated": 0}
    try:
        b = create_backup()
        summary["backup"] = b.name if b else "跳过（24h 内已有备份）"
    except Exception as exc:
        summary["backup"] = f"失败: {exc}"
        logger.exception("[备份] 异常")
    try:
        summary["rotated"] = rotate_logs()
    except Exception as exc:
        summary["rotated"] = f"失败: {exc}"
        logger.exception("[日志轮转] 异常")
    return summary
