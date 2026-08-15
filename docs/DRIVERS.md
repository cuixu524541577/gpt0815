# 浏览器驱动注册（P3.3）

协议链路（protocol）是默认且完整的注册方式。turb 内核还带了 4 种真实浏览器驱动，
用于协议被风控时的备用链路。**驱动切换在 WebUI 配置页"功能开关"分组**：

| 驱动 | 实现 | 依赖 | 适用 |
|---|---|---|---|
| `protocol`（默认） | 纯协议（curl_cffi 指纹） | 无 | 日常注册 |
| `roxy` | RoxyBrowser 指纹浏览器 API | 无本地依赖（远程服务） | 需要真实浏览器指纹时 |
| `browser_use` | Browser Use Cloud | 无本地依赖（云端 API key） | 云端浏览器 |
| `skyvern` | Skyvern 云 | 无本地依赖（云端 API key） | 云端自动化 |
| `cloak` | CloakBrowser + Selenium | `pip install cloakbrowser playwright`（可选） | 本地真实浏览器 |

## 配置项

### Codex 授权驱动（CODEX_OAUTH_DRIVER）
控制 Codex OAuth 阶段用什么驱动跑页面：
- `protocol`：纯协议（默认）
- `same_as_registration`：跟随 REGISTRATION_DRIVER
- `roxy` / `cloak` / `browser_use` / `skyvern`：指定浏览器驱动

### 注册驱动（REGISTRATION_DRIVER）
注册主流程驱动（protocol 为完整实现；浏览器驱动为备用链路）。

### 各驱动凭据（WebUI 配置页"浏览器驱动"分组）
- **RoxyBrowser**：ROXY_API_BASE（如 http://127.0.0.1:50100）+ ROXY_API_TOKEN
- **Browser Use**：BROWSER_USE_API_KEY（云端申请）
- **Skyvern**：SKYVERN_API_KEY（云端申请）
- **CloakBrowser**：安装 `cloakbrowser[geoip]` + `playwright` 后使用（playwright install 需下载浏览器）

## 安全说明

1. 密钥类字段（ROXY_API_TOKEN / BROWSER_USE_API_KEY / SKYVERN_API_KEY）在服务端掩码存储，
   浏览器端不可见明文
2. 浏览器驱动调用的是**远程/云端服务**——使用前确认服务商可信，密钥勿外泄
3. 驱动配置写错不会影响 protocol 链路（默认仍可用）
