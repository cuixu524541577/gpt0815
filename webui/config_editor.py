# -*- coding: utf-8 -*-
"""
配置读写层（供 WebUI /api/config 使用）。

设计原则：
    1. 白名单：只暴露"运行时安全"的开关/数值/默��值，协议级常量
       （client_id / scope / sentinel 版本等）一律不开放，避免一改就废号。
    2. 行级精确替换：用正则只替换 `KEY = 值` 那一行的右值，保留注释、
       空行、缩进、类型标注（`X: bool = True`），最大限度不破坏原文件格式。
    3. 原子写：先写 .tmp 再 replace，避免写一半导致 config 文件损坏。
    4. 读用「源码解析」而非 import，避免进程内常量已被缓存、读到旧值；
       也避免 import 触发副作用。

注意：config 是在各模块进程启动时 `from config import X` 固化的，
改完文件需要重启 Web 服务才会生效——前端会显式提示。
"""
import ast
import re
import shutil
from datetime import datetime
from pathlib import Path

import logging

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_CONFIG_DIR = _PROJECT_ROOT / "config"


# ============================================================
# 白名单：每个可编辑项声明它在哪个文件、键名、类型、分组、说明
# type 决定前端控件 + 写回时的字面量格式：
#   bool   -> True/False
#   int    -> 整数
#   str    -> 带引号字符串
#   list_str_multiline -> 多行字符串列表（PROXY_POOL 专用，整块替换）
# ============================================================

EDITABLE_FIELDS = [
    {
        "key": "ENABLE_CODEX_AUTO", "file": "codex.py", "type": "bool", "group": "功能开关",
        "label": "启用 Codex OAuth", "help": "注册成功后自动跑 Codex 授权（全新session+接码），落盘 codex-邮箱.json",
    },
    {
        "key": "ENABLE_2FA", "file": "twofa.py", "type": "bool", "group": "功能开关",
        "label": "启用 2FA(TOTP)", "help": "注册完成后自动设置动态口令（会多收一封 OTP 邮件）",
    },
    {
        "key": "ENABLE_FLOW_TRIGGER", "file": "flow_trigger.py", "type": "bool", "group": "功能开关",
        "label": "启用 Flow 触发", "help": "注册成功后自动调用内部 Flow 接口（不影响注册结果）",
    },
    {
        "key": "ENABLE_TRIAL_CHECK", "file": "codex.py", "type": "bool", "group": "功能开关",
        "label": "启用权益查询", "help": "注册后查询账号 trial 权益（0.1.48 平台版功能）",
    },
    {
        "key": "ENABLE_POST_REGISTER_PASSWORD", "file": "codex.py", "type": "bool", "group": "功能开关",
        "label": "注册后设置密码", "help": "注册完成后自动设置登录密码（服务端走密码分支时生效，passwordless 分支自动跳过）",
    },
    {
        "key": "POST_REGISTER_PASSWORD", "file": "codex.py", "type": "str", "group": "功能开关",
        "label": "注册后密码", "help": "设置给新注册账号的密码；留空则随机生成并随账号信息落盘保存", "secret": True,
    },
    {
        "key": "ENABLE_PAYMENT_LINK_AUTO_EXTRACT", "file": "codex.py", "type": "bool", "group": "功能开关",
        "label": "支付链接自动提取", "help": "自动提取支付链接（需支付平台集成）",
    },
    {
        "key": "PAYMENT_LINK_PROVIDER", "file": "codex.py", "type": "str", "group": "功能开关",
        "label": "支付链接渠道", "help": "upi / 其他",
    },
    {
        "key": "CODEX_OAUTH_SKIP_PHONE", "file": "codex.py", "type": "bool", "group": "功能开关",
        "label": "Codex OAuth 跳过手机", "help": "授权时跳过手机验证步骤",
    },
    {
        "key": "CODEX_SMS_SOURCE", "file": "codex.py", "type": "str", "group": "功能开关",
        "label": "Codex 接码来源", "help": "platform / 其他",
    },
    {
        "key": "REGISTRATION_MODE", "file": "register.py", "type": "str", "group": "注册默认",
        "label": "注册模式", "help": "email / phone",
    },
    {
        "key": "PHONE_REGISTRATION_SMS_SOURCE", "file": "register.py", "type": "str", "group": "注册默认",
        "label": "手机注册接码来源", "help": "platform / 其他",
    },
    {
        "key": "USE_EMAIL_SERVICE", "file": "email.py", "type": "bool", "group": "邮箱 / OTP",
        "label": "自动取邮箱+收码", "help": "True=从 Outlook 池自动领邮箱并自动收 OTP；False=人工输入",
    },
    {
        "key": "OTP_MAX_WAIT", "file": "email.py", "type": "int", "group": "邮箱 / OTP",
        "label": "OTP 最长等待(秒)", "help": "等待验证码邮件的最长秒数，超时判失败",
    },
    {
        "key": "OTP_POLL_INTERVAL", "file": "email.py", "type": "int", "group": "邮箱 / OTP",
        "label": "OTP 轮询间隔(秒)", "help": "每隔多少秒查一次新邮件",
    },
    {
        "key": "EMAIL_SOURCE", "file": "email.py", "type": "str", "group": "邮箱 / OTP",
        "label": "邮箱来源", "help": "outlook = Outlook账号池 | buygptpuls_temp = 临时邮箱 | api_otp_mail = API 接码",
    },
    {
        "key": "EMAIL_DOMAIN", "file": "email.py", "type": "str", "group": "邮箱 / OTP",
        "label": "Cloudflare 域名", "help": "你的 Cloudflare 域名，如 mydomain.com",
    },
    {
        "key": "QQ_EMAIL", "file": "email.py", "type": "str", "group": "邮箱 / OTP",
        "label": "QQ 邮箱地址", "help": "接收 Cloudflare 转发邮件的 QQ 邮箱",
    },
    {
        "key": "QQ_IMAP_PASSWORD", "file": "email.py", "type": "str", "group": "邮箱 / OTP",
        "label": "QQ 邮箱 IMAP 授权码", "help": "16 位授权码", "secret": True,
    },
    {
        "key": "BUYGPTPULS_API_BASE", "file": "email.py", "type": "str", "group": "邮箱 / OTP",
        "label": "临时邮箱 API 地址", "help": "buygptpuls 临时邮箱服务地址",
    },
    {
        "key": "BUYGPTPULS_API_KEY", "file": "email.py", "type": "str", "group": "邮箱 / OTP",
        "label": "临时邮箱 API Key", "help": "buygptpuls 临时邮箱服务密钥", "secret": True,
    },
    {
        "key": "BUYGPTPULS_DOMAIN", "file": "email.py", "type": "str", "group": "邮箱 / OTP",
        "label": "临时邮箱域名", "help": "留空时随机选择启用域名",
    },
    {
        "key": "BUYGPTPULS_DOMAIN_LEVEL", "file": "email.py", "type": "int", "group": "邮箱 / OTP",
        "label": "临时邮箱域名级数", "help": "域名层级",
    },
    {
        "key": "BUYGPTPULS_PREFIX", "file": "email.py", "type": "str", "group": "邮箱 / OTP",
        "label": "临时邮箱前缀", "help": "生成邮箱的前缀",
    },
    {
        "key": "BUYGPTPULS_RANDOM_LENGTH", "file": "email.py", "type": "int", "group": "邮箱 / OTP",
        "label": "临时邮箱随机长度", "help": "前缀后随机字符长度",
    },
    {
        "key": "EMAIL_FAILURE_MAX_RETRIES", "file": "email.py", "type": "int", "group": "邮箱 / OTP",
        "label": "邮件失败最大重试", "help": "取信失败重试次数",
    },
    {
        "key": "OUTLOOK_USE_PASSWORD_LOGIN", "file": "email.py", "type": "bool", "group": "邮箱 / OTP",
        "label": "Outlook 密码登录", "help": "使用密码方式登录 Outlook",
    },
    {
        "key": "OUTLOOK_FETCH_MODE", "file": "email.py", "type": "str", "group": "邮箱 / OTP",
        "label": "Outlook 取信模式", "help": "auto / imap / api",
    },
    {
        "key": "OUTLOOK_CONNECTION_CACHE_TTL", "file": "email.py", "type": "int", "group": "邮箱 / OTP",
        "label": "Outlook 连接缓存(秒)", "help": "连接缓存 TTL",
    },
    {
        "key": "OUTLOOK_FETCH_LIMIT", "file": "email.py", "type": "int", "group": "邮箱 / OTP",
        "label": "Outlook 单次取信上限", "help": "单次拉取邮件数量上限",
    },
    {
        "key": "REGISTER_TASK_DELAY_MIN", "file": "register.py", "type": "int", "group": "注册默认",
        "label": "任务间隔下限(秒)", "help": "批量注册任务间随机间隔下限，防同 IP 高频注册风控",
    },
    {
        "key": "REGISTER_TASK_DELAY_MAX", "file": "register.py", "type": "int", "group": "注册默认",
        "label": "任务间隔上限(秒)", "help": "批量注册任务间随机间隔上限",
    },
    {
        "key": "REGISTER_BIRTHDAY", "file": "register.py", "type": "str", "group": "注册默认",
        "label": "默认生日", "help": "格式 YYYY-MM-DD",
    },
    {
        "key": "REGISTER_WORKERS", "file": "register.py", "type": "int", "group": "注册默认",
        "label": "并发注册数", "help": "同时运行的注册任务数（最小 1）", "min": 1,
    },
    {
        "key": "REGISTER_BATCH_COUNT", "file": "register.py", "type": "int", "group": "注册默认",
        "label": "单批注册数", "help": "每批注册账号数量（最小 1）", "min": 1,
    },
    {
        "key": "PROXY_POOL", "file": "proxy.py", "type": "list_str_multiline", "group": "代理池",
        "label": "代理池(每行一个)", "help": "每行一个代理 URL，留空行会被忽略；为空则不使用代理；网关型动态代理（BrightData/IPRoyal 等）直接填这里",
    },
    {
        "key": "PROXY_DYNAMIC_ENABLED", "file": "proxy.py", "type": "bool", "group": "代理池",
        "label": "启用动态代理池", "help": "从厂商 API 拉取住宅代理列表，与静态池合并轮换（见下方 API 地址）",
    },
    {
        "key": "PROXY_DYNAMIC_API_URL", "file": "proxy.py", "type": "str", "group": "代理池",
        "label": "动态代理 API 地址", "help": "Oxylabs: https://proxy.oxylabs.io/key/{KEY}；Webshare: https://proxy.webshare.io/api/v2/proxy/list/；通用提取 API 亦可",
    },
    {
        "key": "PROXY_DYNAMIC_API_AUTH", "file": "proxy.py", "type": "str", "group": "代理池",
        "label": "动态代理 API 认证", "help": "Bearer xxx / Token xxx / user:pass（Basic）/ 任意 Header: value", "secret": True,
    },
    {
        "key": "PROXY_DYNAMIC_REFRESH_MINUTES", "file": "proxy.py", "type": "int", "group": "代理池",
        "label": "动态池刷新间隔(分钟)", "help": "过期自动重新拉取，失败沿用旧池（1-1440）", "min": 1, "max": 1440,
    },
    {
        "key": "PROXY_DYNAMIC_MAX_POOL", "file": "proxy.py", "type": "int", "group": "代理池",
        "label": "动态池容量上限", "help": "超过随机截断（1-5000）", "min": 1, "max": 5000,
    },
    {
        "key": "PROXY_MODE", "file": "proxy.py", "type": "str", "group": "代理池",
        "label": "代理模式", "help": "global / 其他",
    },
    {
        "key": "PROXY_EGRESS_COUNTRY", "file": "proxy.py", "type": "str", "group": "代理池",
        "label": "出口国家", "help": "代理出口国家代码",
    },
    {
        "key": "REGISTER_PROXY_POOL", "file": "proxy.py", "type": "list_str_multiline", "group": "代理池",
        "label": "注册代理池", "help": "注册专用代理，每行一个",
    },
    {
        "key": "CODEX_PROXY_POOL", "file": "proxy.py", "type": "list_str_multiline", "group": "代理池",
        "label": "Codex 代理池", "help": "Codex 授权专用代理，每行一个",
    },
    {
        "key": "SMS_COUNTRY", "file": "codex.py", "type": "str", "group": "接码平台",
        "label": "国家代码", "help": "GrizzlySMS 国家数字代码，常用：美国=187 / 葡萄牙=117 / 智利=151",
    },
    {
        "key": "SMS_SERVICE", "file": "codex.py", "type": "str", "group": "接码平台",
        "label": "服务代码", "help": "GrizzlySMS 服务代码：OpenAI=dr。一般不用改",
    },
    {
        "key": "SMS_MAX_RETRIES", "file": "codex.py", "type": "int", "group": "接码平台",
        "label": "换号重试次数", "help": "一个号收不到短信/被拒时换下一个号，最多重试几次",
    },
    {
        "key": "SMS_CODE_WAIT", "file": "codex.py", "type": "int", "group": "接码平台",
        "label": "单号等短信(秒)", "help": "单个号等待短信到达的最长秒数，超时则换号",
    },
    {
        "key": "SMS_API_KEY", "file": "codex.py", "type": "str", "group": "接码平台",
        "label": "API 密钥", "help": "接码平台 API key（GrizzlySMS/HeroSMS/SMSBower）", "secret": True,
    },
    {
        "key": "SMS_PROVIDER", "file": "codex.py", "type": "str", "group": "接码平台",
        "label": "接码通道", "help": "grizzly=GrizzlySMS；hero=HeroSMS；smsbower=SMSBower（均 sms-activate 兼容协议）；l=本地 L 服务；h=本地 H 服务",
    },
    {
        "key": "SMS_API_BASE", "file": "codex.py", "type": "str", "group": "接码平台",
        "label": "接码 API 地址", "help": "留空自动按接码通道选择：grizzly=https://api.grizzlysms.com/stubs/handler_api.php；hero=https://hero-sms.com/stubs/handler_api.php；smsbower=https://smsbower.page/stubs/handler_api.php",
    },
    {
        "key": "SMS_POLL_INTERVAL", "file": "codex.py", "type": "int", "group": "接码平台",
        "label": "短信轮询间隔(秒)", "help": "轮询短信状态间隔",
    },
    {
        "key": "SMS_CANCEL_ON_TIMEOUT", "file": "codex.py", "type": "bool", "group": "接码平台",
        "label": "超时自动取消", "help": "超时自动取消订单",
    },
    {
        "key": "SMS_BLACKLIST_ON_BAD_CODE", "file": "codex.py", "type": "bool", "group": "接码平台",
        "label": "坏码自动拉黑", "help": "收到错误验证码自动拉黑号码",
    },
    {
        "key": "CPA_ENABLED", "file": "codex.py", "type": "bool", "group": "CPA / Sub2API",
        "label": "启用 CPA", "help": "导出 CPA 兼容凭证",
    },
    {
        "key": "CPA_API_URL", "file": "codex.py", "type": "str", "group": "CPA / Sub2API",
        "label": "CPA API 地址", "help": "CPA 服务地址",
    },
    {
        "key": "CPA_LOGIN_PASSWORD", "file": "codex.py", "type": "str", "group": "CPA / Sub2API",
        "label": "CPA 登录密码", "help": "CPA 控制台登录密码", "secret": True,
    },
    {
        "key": "SUB2API_ENABLED", "file": "codex.py", "type": "bool", "group": "CPA / Sub2API",
        "label": "启用 Sub2API", "help": "导出 Sub2API bundle",
    },
    {
        "key": "SUB2API_API_URL", "file": "codex.py", "type": "str", "group": "CPA / Sub2API",
        "label": "Sub2API 地址", "help": "Sub2API 服务地址",
    },
    {
        "key": "SUB2API_API_KEY", "file": "codex.py", "type": "str", "group": "CPA / Sub2API",
        "label": "Sub2API API Key", "help": "Sub2API 服务密钥", "secret": True,
    },
    {
        "key": "SUB2API_GROUP_IDS", "file": "codex.py", "type": "str", "group": "CPA / Sub2API",
        "label": "Sub2API 分组 ID", "help": "逗号分隔的分组 ID",
    },
    {
        "key": "CUSTOM_API_ENABLED", "file": "flow_trigger.py", "type": "bool", "group": "中继推送",
        "label": "启用自定义推送", "help": "注册成功后向自定义地址推送账号数据",
    },
    {
        "key": "CUSTOM_API_URL", "file": "flow_trigger.py", "type": "str", "group": "中继推送",
        "label": "推送地址", "help": "自定义 API 地址（http/https）",
    },
    {
        "key": "CUSTOM_API_TRIGGER", "file": "flow_trigger.py", "type": "str", "group": "中继推送",
        "label": "触发时机", "help": "registration_complete 等",
    },
    {
        "key": "CUSTOM_API_FORMAT", "file": "flow_trigger.py", "type": "str", "group": "中继推送",
        "label": "数据格式", "help": "json / form",
    },
    {
        "key": "CUSTOM_API_FIELDS", "file": "flow_trigger.py", "type": "str", "group": "中继推送",
        "label": "推送字段", "help": '如 ["email","email_password","client_id","refresh_token"]',
    },
    {
        "key": "FLOW_TRIGGER_BEARER", "file": "flow_trigger.py", "type": "str", "group": "中继推送",
        "label": "Flow Bearer", "help": "内部 Flow 接口 Bearer 令牌", "secret": True,
    },
    {
        "key": "FLOW_TRIGGER_COOKIE", "file": "flow_trigger.py", "type": "str", "group": "中继推送",
        "label": "Flow Cookie", "help": "内部 Flow 接口 Cookie", "secret": True,
    },
    {
        "key": "EXTRACT_LINK_API_BASE", "file": "extract_link.py", "type": "str", "group": "支付链接提取",
        "label": "提链 API 地址", "help": "支付链接提取服务地址（平台提供），留空则 UPI 功能未启用",
    },
    {
        "key": "EXTRACT_LINK_CDK", "file": "extract_link.py", "type": "str", "group": "支付链接提取",
        "label": "提链 CDK", "help": "共享卡密（对应 UPI_CARD）", "secret": True,
    },
    {
        "key": "EXTRACT_LINK_TYPE", "file": "extract_link.py", "type": "str", "group": "支付链接提取",
        "label": "提链类型", "help": "pix / upi / kakao_pay / ideal",
    },
    {
        "key": "ENABLE_CARD_POOL", "file": "card_pool.py", "type": "bool", "group": "卡池支付",
        "label": "启用卡池", "help": "虚拟信用卡池 + PayPal 账号池。关闭时卡池 API 只读可查，写入/支付全部拒绝（UPI 扫码通道不受影响）",
    },
    {
        "key": "CARD_POOL_DRIVER", "file": "card_pool.py", "type": "str", "group": "卡池支付",
        "label": "支付驱动", "help": "mock=模拟（链接含 decline/timeout 分别模拟拒付/超时，其余成功）；stripe_protocol=真实 Stripe 结账协议；disabled=禁止支付",
    },
    {
        "key": "CARD_POOL_AUTO_PAY", "file": "card_pool.py", "type": "bool", "group": "卡池支付",
        "label": "提链后自动支付", "help": "提链成功的任务自动从卡池发起支付（需启用卡池）",
    },
    {
        "key": "CARD_POOL_PAY_METHOD", "file": "card_pool.py", "type": "str", "group": "卡池支付",
        "label": "支付方式偏好", "help": "auto=优先卡池、无可用卡时用 PayPal 池；card=固定银行卡；paypal=固定 PayPal",
    },
    {
        "key": "CARD_POOL_PREFERRED_BINS", "file": "card_pool.py", "type": "str", "group": "卡池支付",
        "label": "优先 BIN 白名单", "help": "逗号分隔，如 403657,404068；挑选时白名单内卡片优先，同类按使用次数最少优先",
    },
    {
        "key": "CARD_POOL_LEASE_SECONDS", "file": "card_pool.py", "type": "int", "group": "卡池支付",
        "label": "资产租约(秒)", "help": "选中资产锁定秒数；进程崩溃后租约过期自动回收，防止死锁",
    },
    {
        "key": "CARD_POOL_MAX_CONCURRENT", "file": "card_pool.py", "type": "int", "group": "卡池支付",
        "label": "最大并发支付", "help": "同时执行的支付任务上限，超出排队等待",
    },
    {
        "key": "PAYPAL_OTP_TIMEOUT_SECONDS", "file": "card_pool.py", "type": "int", "group": "卡池支付",
        "label": "PayPal OTP 超时(秒)", "help": "等待 PayPal 验证码的最长秒数",
    },
    {
        "key": "PAYPAL_OTP_POLL_INTERVAL_SECONDS", "file": "card_pool.py", "type": "int", "group": "卡池支付",
        "label": "PayPal OTP 轮询间隔(秒)", "help": "轮询验证码短信的间隔秒数",
    },
    {
        "key": "CODEX_OAUTH_DRIVER", "file": "codex.py", "type": "str", "group": "功能开关",
        "label": "Codex 授权驱动", "help": "protocol=纯协议；roxy/cloak/browser_use/skyvern=真实浏览器；same_as_registration=跟随注册驱动",
    },
    {
        "key": "REGISTRATION_DRIVER", "file": "roxybrowser.py", "type": "str", "group": "功能开关",
        "label": "注册驱动", "help": "protocol=纯协议；roxy=指纹浏览器 API；cloak=CloakBrowser；browser_use=Browser Use 云；skyvern=Skyvern 云",
    },
    {
        "key": "ROXY_API_BASE", "file": "roxybrowser.py", "type": "str", "group": "浏览器驱动",
        "label": "RoxyBrowser API 地址", "help": "如 http://127.0.0.1:50100",
    },
    {
        "key": "ROXY_API_TOKEN", "file": "roxybrowser.py", "type": "str", "group": "浏览器驱动",
        "label": "RoxyBrowser API Token", "help": "指纹浏览器服务令牌", "secret": True,
    },
    {
        "key": "BROWSER_USE_API_KEY", "file": "browser_use.py", "type": "str", "group": "浏览器驱动",
        "label": "Browser Use API Key", "help": "Browser Use Cloud 密钥", "secret": True,
    },
    {
        "key": "SKYVERN_API_KEY", "file": "skyvern.py", "type": "str", "group": "浏览器驱动",
        "label": "Skyvern API Key", "help": "Skyvern 云服务密钥", "secret": True,
    },
    {
        "key": "SUB2API_API_BASE", "file": "sub2api.py", "type": "str", "group": "Sub2API",
        "label": "Sub2API 服务地址", "help": "如 https://sub2.example.com；留空则凭证只本地保存",
    },
    
    {
        "key": "SUB2API_API_TOKEN", "file": "sub2api.py", "type": "str", "group": "Sub2API",
        "label": "Sub2API Token", "help": "备用认证令牌（AUTH_HEADER 为 Authorization 时用）", "secret": True,
    },
    {
        "key": "SUB2API_API_AUTH_HEADER", "file": "sub2api.py", "type": "str", "group": "Sub2API",
        "label": "认证头名称", "help": "默认 x-api-key",
    },
    
    {
        "key": "ENABLE_AGENT_IDENTITY", "file": "register.py", "type": "bool", "group": "功能开关",
        "label": "启用 Agent Identity", "help": "注册/任务完成后生成 Ed25519 Agent Identity（免接码认证产物），落盘 data/agent_identities.json",
    },
    {
        "key": "TELEGRAM_BOT_TOKEN", "file": "notify.py", "type": "str", "group": "通知",
        "label": "Telegram Bot Token", "help": "BotFather 获取；留空则通知功能关闭", "secret": True,
    },
    {
        "key": "TELEGRAM_CHAT_ID", "file": "notify.py", "type": "str", "group": "通知",
        "label": "Telegram 会话 ID", "help": "接收通知的会话 ID，多个用逗号分隔",
    },
]

_FIELD_BY_KEY = {f["key"]: f for f in EDITABLE_FIELDS}


# ============================================================
# 读：解析源码取当前值（不 import，避免缓存/副作用）
# ============================================================

def _config_path(filename: str) -> Path:
    path = (_CONFIG_DIR / filename).resolve()
    # 防目录穿越：必须落在 config/ 下
    if _CONFIG_DIR not in path.parents:
        raise ValueError(f"非法配置路径: {filename}")
    return path


def _parse_value_from_source(source: str, key: str, vtype: str):
    """从源码里解析 KEY 的当前值。失败返回 None。"""
    if vtype == "list_str_multiline":
        # 用 AST 解析整个模块，取这个赋值的 list 字面量
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return None
        for node in tree.body:
            if isinstance(node, ast.Assign):
                targets = node.targets
            elif isinstance(node, ast.AnnAssign):
                targets = [node.target]
            else:
                continue
            for t in targets:
                if isinstance(t, ast.Name) and t.id == key:
                    try:
                        val = ast.literal_eval(node.value)
                        if isinstance(val, (list, tuple)):
                            return [str(x) for x in val]
                    except (ValueError, SyntaxError):
                        return None
        return None

    # 标量：匹配 `KEY[: 类型] = 右值` 那一行，再用 literal_eval 解析右值
    m = re.search(
        rf"^{re.escape(key)}\s*(?::[^=\n]+)?=\s*(.+?)\s*(?:#.*)?$",
        source, re.MULTILINE,
    )
    if not m:
        return None
    raw = m.group(1).strip()
    try:
        return ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return raw


def get_config() -> list[dict]:
    """返回所有可编辑项的当前值 + 元信息，供前端渲染表单。
    secret 字段的值一律掩码为 ********，不向浏览器下发明文。"""
    out = []
    for field in EDITABLE_FIELDS:
        path = _config_path(field["file"])
        source = path.read_text(encoding="utf-8") if path.exists() else ""
        value = _parse_value_from_source(source, field["key"], field["type"])
        if value is None:
            value = ""
        item = dict(field)
        item["value"] = value
        item["secret"] = bool(field.get("secret"))
        if item["secret"] and value not in ("", None, [], False):
            item["value"] = "********"
        out.append(item)
    return out


# ============================================================
# 写：行级精确替换右值，保留注释和格式
# ============================================================

def _format_literal(value, vtype: str) -> str:
    """把前端传来的值格式化成 Python 字面量字符串。"""
    if vtype == "bool":
        if isinstance(value, str):
            value = value.strip().lower() in ("true", "1", "yes", "on")
        return "True" if value else "False"
    if vtype == "int":
        return str(int(value))
    if vtype == "str":
        # JSON 转义与 Python 双引号字符串兼容，正确处理 \n/\t/引号/反斜杠等控制字符
        import json as _json
        return _json.dumps(str(value), ensure_ascii=False)
    raise ValueError(f"_format_literal 不支持的类型: {vtype}")


def _replace_scalar(source: str, key: str, literal: str) -> str:
    """替换 `KEY[: 类型] = 旧值` 的右值，保留行内注释和类型标注。

    用 AST 定位赋值节点的精确起止位置，避免正则被字符串内的 # 干扰。
    """
    tree = ast.parse(source)
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else (
            [node.target] if isinstance(node, ast.AnnAssign) else []
        )
        for t in targets:
            if isinstance(t, ast.Name) and t.id == key:
                src_lines = source.splitlines(keepends=True)
                start = node.value.lineno
                end = node.value.end_lineno
                col = node.value.col_offset
                end_col = node.value.end_col_offset
                prefix = src_lines[start - 1][:col]
                end_line = src_lines[end - 1]
                suffix = end_line[end_col:]
                new_lines = (
                    src_lines[: start - 1]
                    + [prefix + literal + suffix]
                    + src_lines[end:]
                )
                return "".join(new_lines)
    raise ValueError(f"未在源码中找到可替换的赋值: {key}")


def _replace_list_literal(source: str, key: str, lines: list[str]) -> str:
    """整块替换 KEY = [ ... ] 列表字面量（保留前面的赋值头）。按 key 通用。"""
    items = [ln.strip() for ln in lines if ln.strip()]
    if items:
        body = "\n".join(
            '    "' + it.replace("\\", "\\\\").replace('"', '\\"') + '",'
            for it in items
        )
        literal = "[\n" + body + "\n]"
    else:
        literal = "[]"

    # 用 AST 定位赋值节点起止偏移最稳
    tree = ast.parse(source)
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else (
            [node.target] if isinstance(node, ast.AnnAssign) else []
        )
        for t in targets:
            if isinstance(t, ast.Name) and t.id == key:
                src_lines = source.splitlines(keepends=True)
                start = node.value.lineno          # 值（[）所在行，1-based
                end = node.value.end_lineno        # 值（]）所在行，1-based
                col = node.value.col_offset         # [ 在起始行的列偏移
                prefix = src_lines[start - 1][:col]
                end_line = src_lines[end - 1]
                suffix = end_line[node.value.end_col_offset:]
                new_lines = (
                    src_lines[: start - 1]
                    + [prefix + literal + suffix]
                    + src_lines[end:]
                )
                return "".join(new_lines)
    raise ValueError(f"未找到 {key} 赋值")


_CONFIG_BACKUP_DIR = _PROJECT_ROOT / "data" / "config_backups"
_CONFIG_BACKUP_KEEP = 5


def _backup_config(path: Path) -> None:
    """写盘前把当前版本备份到 data/config_backups/，每文件保留 5 份。"""
    try:
        _CONFIG_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        target = _CONFIG_BACKUP_DIR / f"{path.name}.{stamp}.bak"
        shutil.copy2(path, target)
        # 按文件名分组清理，只留最近 5 份
        related = sorted(
            _CONFIG_BACKUP_DIR.glob(f"{path.name}.*.bak"),
            key=lambda p: p.name,
            reverse=True,
        )
        for old in related[_CONFIG_BACKUP_KEEP:]:
            old.unlink(missing_ok=True)
    except Exception as exc:
        logger.warning("[配置备份] %s 失败: %s", path.name, exc)


def _atomic_write(path: Path, text: str) -> None:
    _backup_config(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def update_config(updates: dict) -> dict:
    """
    批量更新配置。updates: {key: value}。
    只接受白名单内的 key，按文件分组改写，每个文件原子写一次。
    返回 {"updated": [...], "ignored": [...]}。

    安全规则：
      - secret 字段收到掩码值（"" / "********"）时跳过，防止把掩码写回覆盖真密钥
      - 白名单内但源码中不存在对应赋值的键（0.1.48 契约占位字段）跳过，不报错
    """
    updated, ignored = [], []
    # 按文件分组，减少读写次数
    by_file: dict[str, list[tuple[dict, object]]] = {}
    for key, value in updates.items():
        field = _FIELD_BY_KEY.get(key)
        if field is None:
            ignored.append(key)
            continue
        if field.get("secret") and value in ("", "********"):
            ignored.append(key)
            continue
        # int 字段边界校验（min/max）
        if field["type"] == "int":
            try:
                int_value = int(value)
            except (TypeError, ValueError):
                raise ValueError(f"{key} 必须是整数")
            if field.get("min") is not None and int_value < int(field["min"]):
                raise ValueError(f"{key} 不能小于 {field['min']}")
            if field.get("max") is not None and int_value > int(field["max"]):
                raise ValueError(f"{key} 不能大于 {field['max']}")
        by_file.setdefault(field["file"], []).append((field, value))

    for filename, items in by_file.items():
        path = _config_path(filename)
        if not path.exists():
            ignored.extend(f["key"] for f, _ in items)
            continue
        source = path.read_text(encoding="utf-8")
        for field, value in items:
            try:
                if field["type"] == "list_str_multiline":
                    lines = value if isinstance(value, list) else str(value).splitlines()
                    source = _replace_list_literal(source, field["key"], lines)
                else:
                    literal = _format_literal(value, field["type"])
                    source = _replace_scalar(source, field["key"], literal)
            except ValueError:
                # 源码中无对应赋值（0.1.48 占位字段）——跳过，不破坏其余更新
                ignored.append(field["key"])
                continue
            updated.append(field["key"])
        # 校验改完仍是合法 Python，再落盘
        ast.parse(source)
        _atomic_write(path, source)

    return {"updated": updated, "ignored": ignored}
