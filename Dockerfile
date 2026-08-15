FROM python:3.12-slim

WORKDIR /app

# 核心依赖（浏览器驱动可选，不装不影响协议注册）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 非 root 运行
RUN useradd -m -u 10001 console && chown -R console:console /app
USER console

EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/login', timeout=5)"

CMD ["python3", "web.py", "--host", "127.0.0.1", "--port", "5001", "--no-browser"]
