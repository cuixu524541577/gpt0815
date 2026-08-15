# 线上 0.1.48 控制台深度分析

> 分析基于：前端全量 JS（22 模块）、线上端点基准响应（ground truth）、
> turb-gpt-free-register 超集源码、前期安全审计结论。

## 一、功能全貌

### 1. 认证与账户体系
| 功能 | 实现机制 |
|---|---|
| 密码登录 | `/api/auth/password/login`，凭据存服务端（哈希），session 为签名 cookie |
| Telegram 登录 | 平台 OAuth 委托（bot.oai9.com），绑定 tg:5388265006 锁定 |
| server-link | URL 带 cid 首次绑定控制台到平台账号（cid 即凭据） |
| 凭据管理 | `/api/auth/credentials` 重置密码（需 Telegram 认证） |

### 2. 注册任务模块（register）
| 功能 | 实现机制 |
|---|---|
| 批量注册 | 任务队列 + 后台线程池（effective_workers 动态） |
| 多邮箱源 | outlook / buygptpuls 临时邮箱 / API 接码（多源兜底） |
| 实时日志 | `/api/jobs/logs` 聚合 + signature 增量拉取（2s 轮询） |
| 任务管理 | 停止/取消/恢复/清理/标记失败 |
| 运行配置 | 并发数、目标数、邮箱源、生日等 |

### 3. 账号资产模块（accounts）
| 功能 | 实现机制 |
|---|---|
| 账号列表 | 分页 + 多维筛选（q/codex 状态/2FA/归档） |
| 导入导出 | txt/json 导入、自定义导出、CPA/Sub2API 实时提取 |
| 复制 | 单值/整行复制（email/password/client_id/refresh_token/token） |
| 归档 | 分类 CRUD + 批量归档 |
| Codex 补跑 | 单账号/批量，后台线程 + 日志文件 |
| 测活 | 本地凭证直连模型试聊（gpt-5.5），结果持久化 |
| 权益查询 | trial_check（plan_check_service 队列） |
| 支付提链 | rt-extract（CPA/Sub2API 两格式） |

### 4. 自动化任务模块（automation-tasks）
| 功能 | 实现机制 |
|---|---|
| 5 种任务类型 | codex_retry / access_token_relogin / password_setup / twofa_setup / trial_check |
| 作用域 | selected（指定账号）/ filtered（按筛选） |
| 任务生命周期 | 排队 → 运行 → 完成/失败，可停止/重试/删除 |
| 进度 | 任务级 summary（今日完成/失败/运行中）+ 逐账号 items |

### 5. Codex 授权模块（codex）
| 功能 | 实现机制 |
|---|---|
| 凭证列表 | codex-*.json 目录扫描 + 导出状态 + 测活结果合并 |
| 授权补跑 | codex_retry_service（reserve/stop/线程管理） |
| 导出 | CPA / Sub2API / 批量备份，下载即标记导出 |
| 测活 | check-local 直连模型 API（并发 6、超时 60s） |
| Sub2API | 分组管理、上传中转 |

### 6. 邮箱池模块（email_pool）
| 功能 | 实现机制 |
|---|---|
| Outlook 池 | 导入（---- 分隔 4 段）、状态维护（可用/已用/失败）、批量操作 |
| API 接码邮箱 | 邮箱----api 地址，独立池子 + 状态 |
| 导出 | 全量导出（含 api_url） |
| 拆分 | 池子拆分统计 |

### 7. 支付链接提取模块（upi）
| 功能 | 实现机制 |
|---|---|
| 手动提链 | 提交 JWT access_token → 创建提取任务（SSE 事件流监听结果） |
| 扫码商管理 | 专属链接、余额、结算台账（ledger）、启停 |
| 任务管理 | submit/retry/reextract/cancel/日志 |
| 设置 | UPI_CARD（共享卡密）+ 待扫上限 + 领码数 |

### 8. 运行配置模块（config）
| 功能 | 实现机制 |
|---|---|
| 分类配置 | 功能开关/登录/注册/邮箱/代理/接码/CPA/Sub2API/中继推送/提链 |
| 热加载 | 行级改写 config/*.py + reload_all 立即生效 |
| 密钥掩码 | secret 字段服务端掩码 ********，保存时忽略掩码值 |
| SMS 管理 | 多平台（grizzly/hero）API Key、启停、余额查询（直连平台 API） |
| 接码策略 | 服务选择、价格、号码池 |
| 代理测试 | 连通性测试 + 出口国家检测 |
| 中继推送测试 | 自定义 API 推送示例数据 |

### 9. 系统能力
| 功能 | 实现机制 |
|---|---|
| 版本/更新 | GitHub release 检测 + Docker 镜像更新（deployment_updater） |
| 系统指标 | /proc 读取（CPU/内存/磁盘/cgroup）+ 并发建议 |
| i18n | zh_cn（2079 条）+ en，bootstrap 注入 + 动态语言包 |
| 新手指引 | 引导遮罩 + 步骤高亮 |
| 侧边栏指标 | CPU/内存/磁盘实时进度条 |

## 二、架构与数据流

```
浏览器（单页应用，22 JS 模块，2s-10s 轮询）
   │  fetch /api/*（X-GFR-Locale 头）
   ▼
Flask（webui/app.py + auth + config_editor）
   │
   ├── 认证层：签名 session + 限速 + 白名单
   ├── 任务层：ThreadPoolExecutor（注册/补跑/提链/测活各队列）
   ├── 数据层：JSON 文件（账号/邮箱池/任务）+ sqlite（扩展元数据）
   ├── 配置层：config/*.py 源码行级改写 + reload_all 热加载
   └── 外部集成：
       ├── OpenAI/ChatGPT API（协议注册 + sentinel 反机器人）
       ├── 邮箱服务（Outlook IMAP / 临时邮箱 API / API 接码）
       ├── SMS 平台（GrizzlySMS/HeroSMS handler_api 协议）
       ├── 提链平台（SSE 事件流，cdk 认证）
       └── GitHub（版本检查 + 更新拉取）
```

### 关键设计
1. **无 WebSocket/SSE 前端**：全部轮询（2s 日志、10s 指标、3s 任务）——简单可靠，负载可控
2. **配置即代码**：config/*.py 既是运行时配置又是持久化存储，热加载无重启
3. **多队列隔离**：注册/补跑/提链/测活各自线程池 + 信号量限流
4. **审计友好**：任务/补跑/提链都有独立日志文件可追踪

## 三、已知问题与优化机会（对照自建版与最佳实践）

### A. 安全（自建版已修，0.1.48 存在）
1. **登录无限速**（已修：15 分钟 5 次锁定）
2. **UPI JWT 只验格式不验签名**（已修：未配置提链服务时一律拒绝）
3. **账号数据零净化**：导入字段原样存储/导出 → CSV 公式注入（自建版同存，待修）
4. **server-link cid 即凭据**：需平台确认熵值与已绑定保护

### B. 健壮性
5. 任务异常需兜底：注册线程异常应自动重试/告警（部分已有）
6. 配置写盘无备份：改坏 config/*.py 无回滚 → 建议写前备份 .bak
7. 日志无轮转：长期运行日志膨胀 → 建议按大小/时间轮转
8. 数据库无备份机制 → 建议每日自动备份 + 保留 N 份

### C. 功能增强（turb 有、0.1.48 无）
9. 浏览器驱动注册链路（RoxyBrowser/CloakBrowser/Playwright）——协议被风控时可切换
10. 更多邮箱源（CF Worker/GPTMail/MailNest/CloudMail）——已融入自建版
11. 免接码注册路径（Agent Identity）——hyhang915 特性
12. 邮箱密码自动更换（mail_password_change）——已融入自建版

### D. 体验优化
13. 日志轮询 2s 恒定 → 页面不可见时暂停（已有 visibility 检测，可加）
14. 任务失败无通知 → 建议 Telegram Bot 通知（用户已有 Telegram 生态）
15. 指标页"不可用"态可更友好（本地开发环境无 /proc）
16. 导出文件命名可加时间戳（已有）
17. 大表虚拟滚动（万级账号分页性能）

### E. 工程化
18. 自动化测试：目前仅 smoke_test → 建议核心链路单测（注册参数构造/配置读写/限速）
19. CI 不可用（无远程仓库）→ 本地 pre-commit 钩子（语法+smoke）
20. 部署：systemd 模板已有 → 建议补 docker-compose 一键部署

## 四、结论

线上 0.1.48 是一个**功能完备、架构清晰**的注册自动化控制台：协议注册为核心、
多源素材为弹药、任务队列为骨架、日志审计为保障。自建版已继承其全部前端契约
与核心能力，并修复了 3 个安全问题。优化空间主要在：健壮性（备份/回滚/轮转）、
体验（通知/性能）、能力扩展（多驱动/多邮箱源——已部分融入）。
