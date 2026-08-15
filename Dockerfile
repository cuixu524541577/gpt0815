FROM python:3.12-slim

WORKDIR /app

# Node.js 18+（sentinel 反机器人必需——注册流程依赖它生成 turnstile/PoW token）
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# 核心依赖（协议注册必需）；浏览器驱动（selenium/playwright/cloakbrowser）
# 按需手动安装——Docker 里不需要它们，装反而拖慢构建且易失败
COPY requirements-core.txt .
RUN pip install --no-cache-dir -r requirements-core.txt

COPY . .

# 非 root 运行
RUN useradd -m -u 10001 console && chown -R console:console /app
USER console

EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/login', timeout=5)"

# 必须绑定 0.0.0.0：Docker 端口映射是转发到容器网卡 IP，
# 绑 127.0.0.1 会导致映射端口连接被拒（健康检查走容器内回环看不出来）
CMD ["python3", "web.py", "--host", "0.0.0.0", "--port", "5001", "--no-browser"]
