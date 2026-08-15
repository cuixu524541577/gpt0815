# -*- coding: utf-8 -*-
"""
Telegram Bot 通知（P3）。

配置（config/notify.py 或 .env）：
    TELEGRAM_BOT_TOKEN   —— BotFather 获取的 token
    TELEGRAM_CHAT_ID     —— 接收通知的会话 ID（可多个，逗号分隔）

未配置时所有发送静默跳过，不影响主流程。
"""
import logging
import os
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

# 发送失败静默降级，绝不抛给调用方
_MAX_RETRIES = 2
_SEND_LOCK = threading.Lock()


def _config() -> dict:
    """读取通知配置：优先环境变量，回退 config/notify.py。"""
    token = ""
    chat_ids: list[str] = []
    try:
        from config import notify as notify_cfg
        token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip() or str(getattr(notify_cfg, "TELEGRAM_BOT_TOKEN", "") or "").strip()
        raw = os.getenv("TELEGRAM_CHAT_ID", "").strip() or str(getattr(notify_cfg, "TELEGRAM_CHAT_ID", "") or "").strip()
        chat_ids = [c.strip() for c in raw.replace(";", ",").split(",") if c.strip()]
    except Exception:
        token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
        raw = os.getenv("TELEGRAM_CHAT_ID", "").strip()
        chat_ids = [c.strip() for c in raw.replace(";", ",").split(",") if c.strip()]
    return {"token": token, "chat_ids": chat_ids}


def enabled() -> bool:
    cfg = _config()
    return bool(cfg["token"] and cfg["chat_ids"])


def send_text(text: str, *, silent: bool = True) -> bool:
    """发送一条文本消息（后台线程，失败静默）。返回是否已发送。"""
    cfg = _config()
    if not cfg["token"] or not cfg["chat_ids"]:
        return False
    text = str(text)[:4000]  # Telegram 单条上限

    def _send():
        try:
            import requests
            for chat_id in cfg["chat_ids"]:
                for attempt in range(_MAX_RETRIES + 1):
                    try:
                        resp = requests.post(
                            f"https://api.telegram.org/bot{cfg['token']}/sendMessage",
                            json={
                                "chat_id": chat_id,
                                "text": text,
                                "disable_web_page_preview": True,
                                "disable_notification": silent,
                            },
                            timeout=10,
                        )
                        if resp.status_code == 200:
                            break
                        logger.warning("[TG通知] chat=%s HTTP %s: %s", chat_id, resp.status_code, resp.text[:200])
                    except Exception as exc:
                        logger.warning("[TG通知] chat=%s 第%d次失败: %s", chat_id, attempt + 1, exc)
        except Exception as exc:
            logger.warning("[TG通知] 发送异常: %s", exc)

    threading.Thread(target=_send, name="tg-notify", daemon=True).start()
    return True


def notify_job_result(job_id: int, status: str, email: str | None = None, message: str | None = None) -> bool:
    """任务终态通知（completed/failed）。"""
    if not enabled():
        return False
    if status in ("completed", "success"):
        head = "✅"
        line = f"任务 #{job_id} 已完成"
    elif status in ("failed", "error"):
        head = "❌"
        line = f"任务 #{job_id} 失败"
    else:
        return False
    parts = [f"{head} {line}"]
    if email:
        parts.append(f"账号：{email}")
    if message:
        parts.append(f"详情：{str(message)[:300]}")
    return send_text("\n".join(parts))


def notify_automation_task(task_id: int, task_type: str, total: int, failed: int) -> bool:
    """自动化任务终态通知。"""
    if not enabled():
        return False
    head = "✅" if failed == 0 else "⚠️"
    return send_text(
        f"{head} 自动化任务 #{task_id}（{task_type}）执行完毕\n"
        f"总数：{total}，失败：{failed}"
    )
