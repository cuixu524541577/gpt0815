# 反爬虫与注册节奏（ANTI-BOT）

> 实战教训（2026-08-15）：同一出口 IP 在几分钟内连续注册 3 个账号，
> 40 分钟后 3 个 token 全部被 OpenAI 吊销（401 token invalidated）。
> 单 IP 高频注册 = 必被风控。

## 一、OpenAI 风控的核心规则

1. **IP 是首要维度**：同一出口 IP 的注册频率是风控第一信号
2. **安全节奏**：单 IP 每天 2-3 个账号是保守安全线；超过即触发标记
3. **吊销特征**：注册成功时 token 有效，数十分钟到数小时后 401
   （"Your authentication token has been invalidated"）
4. **其他风控信号**：同指纹高频、同邮箱服务商批量、注册后立即做 OAuth 授权

## 二、本项目已实现的防护（全部默认生效）

| 防护 | 实现 | 状态 |
|---|---|---|
| 任务随机间隔 | 每任务开始前随机等待 20-60s（配置：REGISTER_TASK_DELAY_MIN/MAX） | ✅ 实测生效 |
| 设备标识随机 | oai-did / session / trace id 全部 uuid4 每会话新生成 | ✅ |
| 浏览器画像随机 | 7 套画像池（屏幕/硬件/UA/时区/语言）随机选，TLS 指纹与 UA 配套 | ✅ |
| 代理会话级轮换 | 每个 BrowserSession 从代理池随机 pick | ✅（池≥2 时生效） |
| 随机身份 | 生日 18-65 随机、英文名样本池随机 | ✅ |
| 指纹兼容 | curl_cffi 0.16 下 chrome124/safari18_0 可过 Cloudflare（chrome146 被 403） | ✅ |

## 三、批量注册的黄金配方（缺一不可）

```
多住宅 IP 代理池（N 个不同 IP）
    + 每 IP 每天 ≤ 2-3 个账号
    + 任务间隔 20-60s（或更长）
    + 随机指纹（已内置）
    + 分散时段（不要集中在凌晨批量跑）
```

**代理池格式**（配置页"代理池"，每行一个）：
```
http://user:pass@host1:port
socks5h://user:pass@host2:port
```

> 注意：socks5://（本地 DNS）会被污染环境卡死，必须 socks5h:// 或 http://。

## 四、被风控后的应对

1. **立即停止**同 IP 继续注册（剩余账号会连坐）
2. 检查账号：`/backend-api/me` 401 = 已吊销，删除或标记失败
3. **换 IP 再试**：吊销通常绑定 IP 维度，新 IP 后风控可能解除
4. 拉长间隔：被标记后建议 5-10 分钟/个 + 新 IP
5. 不要用同一邮箱服务商（如全部 iCloud 转发）批量注册——会形成关联

## 五、验证命令

```bash
# 检查账号 token 是否有效（200=有效，401=已吊销）
curl -x http://127.0.0.1:7897 -H "Authorization: Bearer <token>" \  # 示例：本机代理，按实际环境修改
  https://chatgpt.com/backend-api/me
```
