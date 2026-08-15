# 部署手册（GPT 注册控制台）

## 一、环境要求

- Python 3.10+（推荐 3.12）或 Docker
- Node.js（sentinel 反机器人必需，注册功能依赖）
- 可选：Selenium/Playwright（浏览器驱动注册链路）

## 二、快速部署（Docker 一键）

```bash
# 1. 准备环境变量（.env）
cat > .env <<'EOF'
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的强密码
TELEGRAM_BOT_TOKEN=    # 可选：Telegram 通知
TELEGRAM_CHAT_ID=      # 可选
EOF

# 2. 启动
docker compose up -d --build

# 3. 验证
docker compose ps                    # healthy
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5001/login   # 200
```

## 三、快速部署（裸机 systemd）

```bash
# 1. 依赖
pip install -r requirements.txt
# Node.js 需已安装（node --version 验证）

# 2. 初始化凭据（必做）
python3 web.py --init-credentials admin '你的强密码'

# 3. 启动自检
python3 web.py --port 5001   # 看"启动自检"输出，全绿或仅有提示

# 4. systemd 常驻（改 deploy/gpt-register-console.service 的路径/端口）
sudo cp deploy/gpt-register-console.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now gpt-register-console

# 5. 反代（可选，对外访问必需）
#   见 deploy/nginx.conf，务必透传 X-Real-IP（登录限速依赖）
```

## 四、对外暴露（安全要求）

1. **不要直接 --host 0.0.0.0** 暴露公网
2. 必须走 nginx 反代 + HTTPS（certbot），见 deploy/nginx.conf
3. nginx 必须透传 `X-Real-IP`（登录限速模块依赖它区分客户端）

## 五、日常运维

### 登录与审计
- 登录失败 5 次锁定 15 分钟（同 IP）
- 审计日志：`data/audit.log`（登录成功/失败/登出 + IP），WebUI 内 `/api/auth/audit`

### 备份与恢复
- **自动备份**：每天启动检查，24h 内自动备份到 `backups/backup-<时间戳>/`（保留 7 份，权限 700）
- **手动备份**：`python3 -c "from webui.maintenance import create_backup; print(create_backup(force=True))"`
- **恢复**：停服 → 用备份覆盖对应目录 → 起服。配置回滚：`data/config_backups/*.bak`

### 日志轮转
- 注册日志超 5MB 自动轮转（.1/.2 各保留一份），启动时执行

### 通知
- 配置 `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`（WebUI 配置页"通知"分组或 .env）
- 任务完成/失败自动推送

## 六、升级

```bash
git pull                       # 拉新代码
python3 tests/smoke_test.py    # 自检
# Docker：
docker compose up -d --build
# 裸机：
sudo systemctl restart gpt-register-console
```

升级前自动备份；升级后跑 smoke_test 确认。

## 七、故障排查

| 症状 | 检查 |
|---|---|
| 登录 403 | 未配置凭据 → `--init-credentials` |
| 登录 429 | 限速锁定 → 等 15 分钟 |
| 页面空白（macOS） | 端口被隔空播放占用 → 用 5001 |
| 注册失败"缺少 Node" | 安装 Node.js |
| 指标不可用（本地） | 正常现象，无 /proc |
| 任务失败无邮箱 | 配置邮箱源/导入邮箱池 |

## 八、发布检查清单（上线前逐项勾选）

- [ ] 移除测试凭据：`python3 web.py --init-credentials <正式账号> '<强密码>'`
- [ ] 强密码 ≥ 12 位混合字符
- [ ] 确认仅 127.0.0.1 绑定，nginx 反代 + HTTPS 就位
- [ ] nginx 透传 X-Real-IP
- [ ] 配置页核对：邮箱源/代理/接码/提链配置正确
- [ ] `python3 tests/smoke_test.py` 全绿
- [ ] 备份目录可写（backups/ 已自动创建）
- [ ] Telegram 通知已配置（可选但推荐）
- [ ] data/ 权限 700，凭据文件 600（自检会提示）
- [ ] 服务器防火墙仅开放 80/443（反代端口）
