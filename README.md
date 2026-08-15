# GPT 注册控制台（自建版）

基于开源基座 [xiaoguzuiniu/gpt-free-register](https://github.com/xiaoguzuiniu/gpt-free-register) 的
自建部署版。基座提供 ChatGPT 协议注册全流程（12 步自动注册、Codex 授权、邮箱/SMS 收码、
sentinel 反机器人），本项目在基座上补齐了**认证体系、卡池自动支付、UPI 提链、安全加固**等能力。

> 基座原始文档见 [README.base.md](README.base.md)。

## 功能

- **注册**：批量注册 ChatGPT 账号（纯协议流 / 可选浏览器驱动），任务队列 + 实时日志，
  每任务随机延迟 + 代理轮换 + 随机身份（防批量风控）；可选注册后自动设置密码（`ENABLE_POST_REGISTER_PASSWORD`）
- **账号管理**：注册成功账号入库、Codex 授权补跑、CPA/Sub2API 凭证导出、账号测活/归档
- **邮箱池**：Outlook / 临时邮箱 / API 邮箱池管理，OTP 自动提取
- **卡池支付**：虚拟信用卡池 + PayPal 账号池，BIN 白名单优先 + 最少使用挑选、
  租约锁防并发抢卡、拒付自动报废；提链成功后自动支付（`core/card_pool.py`）
- **支付链接提取（UPI）**：提链任务 + 扫码商管理（与卡池并行，互不影响）
- **接码平台**：GrizzlySMS / HeroSMS / SMSBower（sms-activate 兼容协议）自动切换 API 地址，价格档策略
- **通知**：注册任务 / 自动化任务 / 支付结果 Telegram 通知
- **配置**：WebUI 热更新 config/*.py（白名单 + AST 安全转义 + 原子写）
- **认证（自建）**：口令登录、PBKDF2 哈希、签名 session、登录限速、审计日志

## 快速开始（复现）

环境要求：Python 3.10+，macOS / Linux（Windows 未验证）。

```bash
# 1. 克隆并安装依赖
git clone <本仓库地址> gpt-register-console
cd gpt-register-console
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. 启动（默认仅 127.0.0.1；macOS 请用 --port 5001，
#    因为系统"隔空播放"占用了 5000 端口，浏览器会连到它导致空白页）
python web.py --port 5001

# 3. 浏览器打开 http://127.0.0.1:5001
#    首次访问登录页会显示「创建管理员账号」表单（仅首次可注册），
#    创建成功后自动登录。之后一律用账号密码登录。
```

> 无人值守/容器场景可用环境变量首启自动创建凭据（跳过注册页）：
> `ADMIN_USERNAME=admin ADMIN_PASSWORD='强密码' python web.py`
> 或 CLI：`python web.py --init-credentials admin '强密码'`

### 跑测试（可选，验证部署正确）

```bash
# 单元测试（卡池数据层 + 支付执行器，22 项）
python -m pytest tests/test_card_pool.py -q

# 部署自检（登录 → 全端点扫描 → 安全断言 → 卡池全链路，退出码 0=通过）
python tests/smoke_test.py
```

## 配置说明

- **配置页热更新**：登录后「运行配置」页可安全修改白名单内的 config/*.py 字段（保存即生效）。
- **环境变量**：全部配置项可被同名环境变量覆盖（见 `config/env_loader.py`），
  完整变量清单见 `.env.example`；密钥类（SMS_API_KEY、代理 Token 等）建议用环境变量注入。
- **代理池**：`config/proxy.py` 的 `PROXY_POOL`（配置页「代理配置」），每行一个代理；
  批量注册必须多 IP 轮换，单 IP 批量注册会被上游吊销。
- **动态住宅代理池**：配置页「启用动态代理池」，来源二选一——`api`（厂商提取 API 自动拉取，支持辣椒HTTP
  `http://api.lajiaohttp.com/api/extract_ip?regions=us&num=20&protocol=http&type=txt&cate=1&t=10`、
  Oxylabs、Webshare 及通用提取 API）或 `manual`（手动粘贴代理列表）；注册任务优先从动态池随机取 IP。
- **卡池支付**：配置页「卡池支付」启用后，在「卡池支付」页面导入卡片/PayPal 账号；
  驱动 `mock`（模拟，链接含 decline/timeout 分别模拟拒付/超时）或
  `stripe_protocol`（真实 Stripe 结账协议，需真实虚拟卡与匹配账单国家的出口 IP）。
- **提链（UPI）**：需平台提供 `EXTRACT_LINK_API_BASE` + `EXTRACT_LINK_CDK`，否则 UPI 保持禁用。

## 安全说明（必须阅读）

1. **默认只绑定 127.0.0.1**。对外访问请使用 `deploy/nginx.conf` 反代 + HTTPS，
   不要直接 `--host 0.0.0.0` 暴露公网。
2. 登录限速：同一 IP 15 分钟 5 次失败锁定。反代必须透传 `X-Real-IP`。
3. 凭据与运行数据存在 `data/`（已 gitignore）：`auth.json`（PBKDF2 哈希）、
   `secret_key`（session 签名）、`audit.log`（审计）、`compat/`（任务/卡池数据）。
4. 发布前请更换默认凭据；真实 API Key 不要写进 config/*.py 提交。
5. 系统部署见 `deploy/gpt-register-console.service`（systemd 加固模板），
   Docker 见 `docker-compose.yml`。

## 项目结构

```
config/     # 注册/代理/Codex/邮箱/卡池/风控 配置（可热更新）
core/       # 注册全流程、Codex OAuth、卡池数据层、支付执行器、邮箱/SMS、sentinel
webui/      # Flask 控制台（app.py 路由 / auth.py 认证 / config_editor 安全配置读写 / compat.py 兼容层）
sentinel/   # Node 反机器人 token 生成（sdk.js + runner）
web.py      # WebUI 入口（--init-credentials / 环境变量首启）
main.py     # CLI 批量注册入口
tests/      # 单元测试（test_card_pool.py）+ 部署自检（smoke_test.py）
deploy/     # systemd + nginx 部署模板
docs/       # 分析 / 部署 / 驱动 / 反爬 文档
scripts/    # 发布检查等辅助脚本
```

## 路线图

见 [ROADMAP.md](ROADMAP.md)。
