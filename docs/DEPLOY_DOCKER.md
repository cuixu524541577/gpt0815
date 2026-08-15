# Docker 部署手册（海外服务器）

中国大陆 IP 无法直连 OpenAI/接码平台，请将本控制台部署到**海外 VPS**（美/日/新等），
并配置海外代理供注册任务使用。

## 服务器要求

- 海外 VPS（OpenAI 可达），至少 2C4G（推荐 4C8G）
- Docker + Docker Compose（`docker --version` / `docker compose version` 确认）
- 域名（可选，建议配 HTTPS）

## 部署步骤

```bash
# 1. 上传项目（git clone 或 scp）
git clone <仓库地址> gpt-register-console && cd gpt-register-console

# 2. 准备环境变量（真实凭据，勿提交 git）
cp .env.production.example .env
vim .env            # 填 ADMIN_PASSWORD（强密码）、代理、接码等

# 3. 准备数据目录与邮箱素材文件
mkdir -p data codex_accounts backups 注册日志
touch 用于注册的邮箱.txt 注册成功的邮箱.txt 注册成功的token.txt

# 3.5 关键一步：目录权限给容器内用户（uid 10001）
# 容器以非 root 运行，挂载目录必须是 10001 可写，否则启动即崩溃重启
chown -R 10001:10001 data codex_accounts backups 注册日志 config \
  用于注册的邮箱.txt 注册成功的邮箱.txt 注册成功的token.txt

# 4. 构建并启动
docker compose up -d --build

# 5. 查看状态
docker compose ps            # healthy = 正常
docker compose logs -f console
```

## 访问方式

compose 默认公网映射 `"5001:5001"`，容器内绑定 `0.0.0.0`（Docker 端口映射转发到容器
网卡 IP，应用必须绑 0.0.0.0 才能被访问；绑 127.0.0.1 会表现为「容器 healthy 但本机
curl 也 000」）。两种访问：

**方式 A（简单，仅测试）**：浏览器访问 `http://服务器IP:5001`
（注意：控制台有登录保护，但仍建议尽快配 HTTPS）。

**方式 B（推荐）**：nginx 反代 + HTTPS
```bash
apt install nginx certbot python3-certbot-nginx
cp deploy/nginx.conf /etc/nginx/sites-available/console
# 修改 server_name 为你的域名，然后：
certbot --nginx -d console.example.com
systemctl reload nginx
```

## 首次登录

浏览器打开后，登录页会显示「创建管理员账号」——用 .env 里设置的凭据登录
（或首次访问时注册式创建）。

## 关键目录（数据持久化）

| 目录/文件 | 内容 | 备份建议 |
|---|---|---|
| `data/` | 账号库、任务队列、审计、卡池、**邮箱池/成功账号/注册任务状态 DB**（v0.1.49+ 起都在这，容器重建不丢） | 每日备份（容器内有自动备份） |
| `codex_accounts/` | Codex 授权凭证 | 必须备份 |
| `注册日志/` | 注册任务日志 | 可选 |
| `backups/` | 自动备份 | 定期转存 |
| `config/` | 配置（配置页修改写回） | 可选 |
| `用于注册的邮箱.txt` 等根目录 .txt | 邮箱素材输入文件（手动维护，已挂载持久化） | 可选 |

## 升级

```bash
git pull                    # 拉新代码
docker compose up -d --build
```

> v0.1.49+ 起状态 DB（邮箱池/成功账号/注册任务）迁到 `data/` 持久化目录。
> 升级后首次启动会自动把旧版留在根目录的 DB 迁入 data/；**旧容器层里的数据
> 无法找回**——如果升级后邮箱池为空，把邮箱重新写进 `用于注册的邮箱.txt`（或
> WebUI 邮箱池导入），下次注册自动导入。升级后排队中的任务会在启动时自动恢复。

## 中国大陆 IP 相关配置

- **代理**：.env 里配置 `PROXY_POOL`（或动态住宅代理池），注册任务全部走代理
- **辣椒 HTTP 网关**：`PROXY_POOL=http://账号-参数:密码@us.lajiaohttp.net:2000`
- **辣椒提取 API**：需先把**服务器公网 IP** 加入辣椒后台白名单
- **接码**：SMS_API_KEY 等按接码平台配置页填写

## 常见问题

- 容器起不来：`docker compose logs console` 看错误；多为 .env 语法或端口占用
- 容器 healthy 但 `curl 127.0.0.1:5001` 返回 000：应用在容器里只绑了 127.0.0.1
  （健康检查走容器内回环所以显示正常）。重新 `docker compose up -d --build` 用带
  `--host 0.0.0.0` 的新镜像即可
- 健康检查一直 starting：`docker inspect gpt-register-console` 看状态
- 配置页保存不生效：config/ 卷挂载权限问题（`chown -R 10001:10001 config data`）
- 账号全部被吊销：单 IP 批量注册导致——必须配置多代理池轮换（见 docs/ANTI-BOT.md）
