# -*- coding: utf-8 -*-
"""卡池配置：虚拟信用卡池 + PayPal 账号池（自动支付）。

与 UPI（人工扫码支付）互不冲突：卡池启用后，提链成功的任务可以
自动从池中挑选卡片/PayPal 账号完成支付；UPI 扫码商通道保持不变。
"""

# 总开关：启用卡池管理与自动支付。False 时卡池 API 只读可查，写入/支付全部拒绝。
ENABLE_CARD_POOL = True

# 支付驱动：
#   mock            —— 演示/测试驱动，不真实扣款。链接 URL 含 decline → 模拟拒付；
#                     含 timeout → 模拟超时；其余 → 模拟成功。
#   stripe_protocol —— 真实 Stripe Hosted Checkout 协议支付（需真实虚拟卡与网络）。
#   disabled        —— 禁止一切支付动作。
CARD_POOL_DRIVER = "mock"

# 提链成功后自动从卡池发起支付（需 ENABLE_CARD_POOL=True）
CARD_POOL_AUTO_PAY = False

# 支付方式偏好：auto = 优先卡池，无可用卡时用 PayPal 池；card / paypal = 固定方式
CARD_POOL_PAY_METHOD = "auto"

# 优先使用的 BIN 前缀白名单（逗号分隔，留空 = 不限制）。挑选时白名单内的卡优先，
# 同类卡按使用次数最少优先，次数相同随机兜底。
CARD_POOL_PREFERRED_BINS = ""

# 单卡/PayPal 账号租约秒数。选中后进入 in_use 状态，防止并发抢同一资产；
# 进程崩溃后租约过期自动回收（重新变为 active）。
CARD_POOL_LEASE_SECONDS = -5

# 同时进行的支付任务上限（超过则排队等待）
CARD_POOL_MAX_CONCURRENT = 99999

# PayPal 账号池 OTP 接收超时与轮询间隔（秒）
PAYPAL_OTP_TIMEOUT_SECONDS = 180
PAYPAL_OTP_POLL_INTERVAL_SECONDS = 3
