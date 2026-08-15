# gpt-register-console 复刻路线图

基于开源基座 xiaoguzuiniu/gpt-free-register（suyancc fork 同源）自建的控制台项目。

## 背景

平台版（0.1.48）是私有仓库，拿不到源码。其能力 = 开源基座 + 私有增强（认证、
server-link、更新机制、UPI、自动化任务、i18n 等）。本项目以开源基座为底，
自写缺失部分，形成可自主部署的控制台。

## 基座已具备（直接继承）

| 模块 | 内容 |
|---|---|
| core/registration_service.py | 批量注册线程池 + 任务日志 |
| core/chatgpt_auth.py / openai_auth.py | ChatGPT/OpenAI 协议注册（12 步全流程） |
| core/codex_oauth.py | Codex OAuth 授权补跑 |
| core/sentinel.py + sentinel/sdk.js | 反机器人 sentinel-token 生成（Node vm 沙箱） |
| core/db.py | 账号/邮箱池/任务文件持久化 |
| core/email_provider.py / outlook_client.py / qqmail_client.py | 邮箱收码 |
| core/sms_provider.py | SMS 接码 |
| core/flow_trigger.py | 注册数据推送（自定义 webhook） |
| webui/config_editor.py | 安全读写 config/*.py（白名单+转义） |
| webui/app.py | 本地控制台 API（无认证——本项目要补） |

## 当前进度（2026-08-15）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 项目骨架 + git + 基座导入 | ✅ |
| M1 | 认证系统：口令登录、PBKDF2、签名 session、登录限速 | ✅ |
| M2 | 前端接入认证 | ✅ |
| M3 | 部署方案：systemd/nginx/首次初始化 | ✅ |
| M4 | **0.1.48 前端 1:1 移植**（22 JS + 2 CSS + i18n 2079 条） | ✅ |
| M5 | **compat 兼容层**：90+ 端点契约对齐线上基准 | ✅ |
| M6 | **核心升级**：整体替换为 turb-gpt-free-register core/config/sentinel（多邮箱源/多驱动/服务） | ✅ |
| M7 | **自动化任务真实执行**：codex_retry/trial_check/password_setup/twofa_setup | ✅ |
| M8 | **UPI 提链**：extract_link_service 接入（配置门控） | ✅ |
| M9 | 部署自检 tests/smoke_test.py | ✅ |

## 邮箱源（turb 融入，EMAIL_SOURCE 可多源兜底）

outlook / cloudflare_domain / cloudflare(CF Worker 临时邮箱) / generic_api / gptmail / mailnest / cloudmail，
支持 `"outlook,generic_api,mailnest"` 逗号列表按顺序兜底。

## 自动化任务类型

codex_retry（真实补跑）/ trial_check（权益查询入队）/ password_setup（mail.com 改密）/
twofa_setup（2FA 设置）/ access_token_relogin（需平台会话，优雅降级）

## UPI 说明（安全门控）

配置页填写 EXTRACT_LINK_API_BASE + EXTRACT_LINK_CDK 后 UPI 才启用；
未配置时一律 501 拒绝，不接受伪造 JWT 创建任务。

## 安全基线（来自前期审计结论，必须满足）

1. 认证中间件覆盖全部 /api/* 与页面（除 /login、/static、/api/auth/*）
2. 登录限速：同一 IP 15 分钟 5 次失败锁定（审计发现原版无限速）
3. 默认仅绑定 127.0.0.1；对外必须走反代
4. 口令用 PBKDF2/scrypt 存储，禁明文
5. 数据目录（data/）与配置中的密钥不进 git

## 许可证说明

基座无 LICENSE 文件，代码用于自行部署与学习；不对外再公开发布。
