# -*- coding: utf-8 -*-
"""Telegram Bot 通知配置（也可用环境变量 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 覆盖）。"""
from config.env_loader import apply_env_overrides

# BotFather 获取的 Bot Token
TELEGRAM_BOT_TOKEN: str = ""

# 接收通知的会话 ID（多个用逗号分隔；发给自己的机器人消息可先查 getUpdates 获取）
TELEGRAM_CHAT_ID: str = ""

apply_env_overrides(globals(), {
    'TELEGRAM_BOT_TOKEN': 'str',
    'TELEGRAM_CHAT_ID': 'str',
})
