# -*- coding: utf-8 -*-
"""部署自检：登录 → 全端点扫描 → 安全断言。退出码 0=通过。"""
import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

import json as _json
import tempfile
from pathlib import Path as _Path

from webui import auth as A
from webui.app import create_app

# 不污染真实凭据：备份并恢复 data/auth.json
_DATA_DIR = _Path(__file__).resolve().parent.parent / "data"
_AUTH_BACKUP = None
if (_DATA_DIR / "auth.json").exists():
    _AUTH_BACKUP = (_DATA_DIR / "auth.json").read_text(encoding="utf-8")
# 模拟全新部署（无凭据）：先删除既有凭据，验证"首次注册"流程
if (_DATA_DIR / "auth.json").exists():
    (_DATA_DIR / "auth.json").unlink()
app = create_app()
c = app.test_client()
failures = []

def check(name, cond, extra=""):
    print(("✓" if cond else "✗"), name, extra)
    if not cond:
        failures.append(name)

# 0. 首次注册（开源版首启：登录页创建管理员账号，无 Telegram 验证）
check("未配置时注册弱密码 400", c.post("/api/auth/register",
      json={"username": "firstadmin", "password": "short", "confirm_password": "short"}).status_code == 400)
check("未配置时注册密码不一致 400", c.post("/api/auth/register",
      json={"username": "firstadmin", "password": "FirstAdmin@123", "confirm_password": "Different@123"}).status_code == 400)
check("首次注册创建管理员 200", c.post("/api/auth/register",
      json={"username": "firstadmin", "password": "FirstAdmin@123", "confirm_password": "FirstAdmin@123"}).status_code == 200)
check("注册后自动登录", c.get("/api/auth/me").get_json().get("authenticated") is True)
check("凭据已配置后再次注册 403", c.post("/api/auth/register",
      json={"username": "hacker", "password": "HackerPass@123", "confirm_password": "HackerPass@123"}).status_code == 403)
check("Telegram 登录接口已移除 404", c.post("/api/auth/telegram/start").status_code == 404)
A.set_credentials("smoke", "SmokeTest@123456")
c.post("/api/auth/logout")  # 清掉注册流程的登录态，回到未登录状态

# 1. 认证
check("登录页 200", c.get("/login").status_code == 200)
check("未登录 API 401", c.get("/api/summary").status_code == 401)
check("错误密码 401", c.post("/api/auth/password/login",
      json={"username": "smoke", "password": "bad"}).status_code == 401)
check("正确登录 200", c.post("/api/auth/password/login",
      json={"username": "smoke", "password": "SmokeTest@123456"}).status_code == 200)

# 2. 静态资源
for a in ["/static/js/api.js", "/static/js/pages/register.js", "/static/css/app.css",
          "/static/i18n/en.json", "/static/i18n/zh_cn.json"]:
    check(f"静态 {a}", c.get(a).status_code == 200)

# 3. 核心端点
for ep in ["/api/summary", "/api/accounts?page=1&page_size=20", "/api/outlook?page=1&page_size=20",
           "/api/codex", "/api/jobs/defaults", "/api/jobs/logs",
           "/api/automation-tasks?page=1&per_page=10", "/api/api-otp-mail",
           "/api/sms/providers", "/api/upi/tasks?page=1&page_size=20",
           "/api/upi/settings", "/api/version", "/api/system/metrics",
           "/api/config", "/api/account-archive-categories", "/api/accounts/filters"]:
    check(f"GET {ep}", c.get(ep).status_code == 200)

# 4. 安全断言
d = c.get("/api/config").get_json()
secrets = [f for f in d if f.get("secret")]
check("secret 全部掩码", all(f["value"] in ("", "********") for f in secrets))
r = c.post("/api/config", json={"updates": {"SMS_API_KEY": "********", "OTP_MAX_WAIT": 120}})
d = r.get_json()
check("掩码值保存被忽略", "SMS_API_KEY" in d["ignored"] and "OTP_MAX_WAIT" in d["updated"])
c.post("/api/config", json={"updates": {"OTP_MAX_WAIT": 90}})

import base64, json
def b64(x): return base64.urlsafe_b64encode(x).rstrip(b'=').decode()
fake = b64(json.dumps({"alg": "none"}).encode()) + "." + b64(json.dumps({"email": "e@x.com"}).encode()) + ".FAKE"
check("UPI 伪造 JWT 拒绝(未配置=501)", c.post("/api/upi/tasks/manual",
      json={"access_token": fake}).status_code == 501)

r = c.post("/api/automation-tasks", json={"task_type": "codex_retry\";//", "scope": "selected",
      "identities": ["x@x.com"], "filters": {}, "workers": 1})
check("任务类型白名单", r.status_code == 400)

# ---- P4 安全断言 ----
# 4.1 CSV 公式注入转义
c.post("/api/accounts/import", json={"format": "txt",
      "text": "csv-evil@x.com:=cmd|'/c calc'!A0:+SUM(A1)+2:-2+3",
      "delimiter": ":", "fields": ["email", "password", "client_id", "refresh_token"], "overwrite": False})
r = c.post("/api/accounts/custom-export", json={"format": "csv", "fields": ["email", "password", "client_id", "refresh_token"],
      "delimiter": ",", "include_header": False, "scope": "selected", "identities": ["csv-evil@x.com"], "filters": {}})
body = r.get_data(as_text=True)
check("CSV 公式注入转义", "'=cmd|'/c calc'!A0" in body and "'+SUM(A1)+2" in body and "'-2+3" in body)
c.post("/api/accounts/delete-selected", json={"identities": ["csv-evil@x.com"]})

# 4.2 导入大小限制
r = c.post("/api/accounts/import", json={"format": "txt", "text": "x" * (6 * 1024 * 1024), "delimiter": ":", "fields": ["email"], "overwrite": False})
check("导入大小限制 413", r.status_code == 413)

# 4.4 凭据文件权限
import os, stat as _stat
try:
    ok_perm = _stat.S_IMODE(os.stat(_DATA_DIR / "auth.json").st_mode) == 0o600
    ok_perm = ok_perm and _stat.S_IMODE(os.stat(_DATA_DIR / "secret_key").st_mode) == 0o600
except OSError:
    ok_perm = False
check("凭据文件权限 600", ok_perm)

# 4.5 审计日志
from webui import auth as _auth2
audit = _auth2.list_audit()
check("登录审计记录", any(r_["event"] == "login_success" for r_ in audit))
r = c.get("/api/auth/audit")
check("审计查看端点", r.status_code == 200 and r.get_json()["ok"])

# 5. 限速
for _ in range(5):
    c.post("/api/auth/password/login", json={"username": "smoke", "password": "bad"})
r = c.post("/api/auth/password/login", json={"username": "smoke", "password": "SmokeTest@123456"})
check("5 次失败后锁定 429", r.status_code == 429)

# 6. 卡池支付（备份配置与数据，测完恢复）
import time as _time
import shutil as _shutil
_PROJ = _Path(__file__).resolve().parent.parent
_CP_CFG = _PROJ / "config" / "card_pool.py"
_CP_CFG_BACKUP = _CP_CFG.read_text(encoding="utf-8") if _CP_CFG.exists() else None
_CP_DIR = _PROJ / "data" / "card_pool"
_CP_DIR_BACKUP = None
if _CP_DIR.exists():
    _CP_DIR_BACKUP = _CP_DIR
    _CP_DIR_BACKUP = _shutil.copytree(_CP_DIR, _CP_DIR.with_name("card_pool_backup_tmp"))
_CP_PAID_KEY = _PROJ / "data" / "compat" / "card_pool_auto_paid.json"

def _cp_wait(job_id, timeout=15):
    deadline = _time.time() + timeout
    while _time.time() < deadline:
        r = c.get(f"/api/card-pool/jobs/{job_id}").get_json()
        if r.get("job", {}).get("status") in ("succeeded", "failed", "canceled"):
            return r["job"]
        _time.sleep(0.2)
    return None

try:
    # 6.0 未启用时：只读可查，写入拒绝
    check("卡池未启用写拒绝 501", c.post("/api/card-pool/cards",
          json={"card_number": "4242424242424242", "expires": "12/27", "cvv": "123"}).status_code == 501)
    check("卡池未启用列表可读", c.get("/api/card-pool/cards").status_code == 200)

    # 启用卡池（mock 驱动）
    from webui import config_editor as _ce
    _ce.update_config({"ENABLE_CARD_POOL": True, "CARD_POOL_DRIVER": "mock"})
    st = c.get("/api/card-pool/status").get_json()
    check("卡池启用状态", st.get("enabled") is True and st.get("settings", {}).get("driver") == "mock")

    # 6.1 卡片 CRUD + 脱敏
    r = c.post("/api/card-pool/cards",
               json={"card_number": "4242424242424242", "expires": "12/27", "cvv": "123", "billing_zip": "10001"})
    check("添加卡片 200", r.status_code == 200)
    card = r.get_json().get("card", {})
    check("卡号脱敏", "card_number" not in card and "cvv" not in card
          and card.get("card_number_masked") == "424242****4242")
    check("重复卡 400", c.post("/api/card-pool/cards",
          json={"card_number": "4242424242424242", "expires": "12/27", "cvv": "123"}).status_code == 400)
    check("Luhn 错误 400", c.post("/api/card-pool/cards",
          json={"card_number": "1234567890123456", "expires": "12/27", "cvv": "123"}).status_code == 400)
    imp = c.post("/api/card-pool/cards/import", json={"text": (
        "42424242424242418|12/27|123|20002\n"
        "5555555555554444,12/28,321\n"
        "# 注释\n"
        "1234567890123456,12/27,123\n"
    )}).get_json()
    check("批量导入 2 成功 1 失败", imp.get("imported") == 2 and len(imp.get("failed", [])) == 1)

    # 6.2 PayPal 池
    r = c.post("/api/card-pool/paypal", json={"phone": "+10000000001", "sms_api_url": "http://sms.local/get?key=k"})
    check("添加 PayPal 200", r.status_code == 200)
    check("PayPal 非法手机号 400", c.post("/api/card-pool/paypal",
          json={"phone": "10000000001"}).status_code == 400)
    imp = c.post("/api/card-pool/paypal/import", json={"text": "+10000000002|http://sms.local/get?key=k2\n+10000000003\n"})
    check("PayPal 批量导入 2", imp.get_json().get("imported") == 2)

    # 6.3 卡片状态流转
    card_id = card["id"]
    r = c.patch(f"/api/card-pool/cards/{card_id}", json={"status": "locked"})
    check("卡片锁定", r.status_code == 200 and r.get_json()["card"]["status"] == "locked")
    r = c.patch(f"/api/card-pool/cards/{card_id}", json={"status": "active"})
    check("卡片恢复", r.status_code == 200 and r.get_json()["card"]["status"] == "active")

    # 6.4 支付任务全链路（mock 驱动）
    r = c.post("/api/card-pool/jobs", json={"link": "https://checkout.stripe.com/pay/ok", "method": "card", "email": "smoke@test.local"})
    check("提交支付任务", r.status_code == 200 and r.get_json().get("job", {}).get("status") == "queued")
    job_id = r.get_json()["job"]["id"]
    job = _cp_wait(job_id)
    check("支付任务成功", job is not None and job["status"] == "succeeded")
    cards = c.get("/api/card-pool/cards").get_json()["items"]
    check("成功卡计数+1", any(x["success_count"] >= 1 for x in cards))

    # 6.5 拒付 → 自动报废 → 恢复后重试
    # 先锁定其他所有卡，保证拒付任务必然选中这张卡（挑选在同等使用次数下随机）
    cards_all = c.get("/api/card-pool/cards").get_json()["items"]
    for other in cards_all:
        c.patch(f"/api/card-pool/cards/{other['id']}", json={"status": "locked"})
    r = c.post("/api/card-pool/cards", json={"card_number": "42424242424242426", "expires": "12/27", "cvv": "321"})
    decline_card_id = r.get_json()["card"]["id"]
    r = c.post("/api/card-pool/jobs", json={"link": "https://checkout.stripe.com/pay/decline", "method": "card"})
    job = _cp_wait(r.get_json()["job"]["id"])
    check("拒付任务失败", job is not None and job["status"] == "failed" and "拒付" in (job.get("error") or ""))
    cards = c.get("/api/card-pool/cards").get_json()["items"]
    declined = next(x for x in cards if x["id"] == decline_card_id)
    check("拒付卡自动报废", declined["status"] == "scrapped")
    c.patch(f"/api/card-pool/cards/{decline_card_id}", json={"status": "active"})
    for other in cards_all:
        c.patch(f"/api/card-pool/cards/{other['id']}", json={"status": "active"})
    r = c.post("/api/card-pool/jobs", json={"link": "https://checkout.stripe.com/pay/ok", "method": "card"})
    job = _cp_wait(r.get_json()["job"]["id"])
    check("恢复后重试成功", job is not None and job["status"] == "succeeded")

    # 6.6 终态任务取消拒绝 + 重试接口
    r = c.post(f"/api/card-pool/jobs/{job['id']}/cancel")
    check("终态任务取消失败 400", r.status_code == 400)
    r = c.post(f"/api/card-pool/jobs/{job['id']}/retry")
    check("终态任务重试 400", r.status_code == 400)

    # 6.7 设置读写
    fields = c.get("/api/card-pool/settings").get_json()["fields"]
    check("设置字段齐全", any(f["key"] == "ENABLE_CARD_POOL" for f in fields)
          and any(f["key"] == "CARD_POOL_DRIVER" for f in fields))
    r = c.post("/api/card-pool/settings", json={"CARD_POOL_LEASE_SECONDS": 600})
    check("设置保存 200", r.status_code == 200)
    st = c.get("/api/card-pool/settings").get_json()
    check("设置回读生效", any(f["key"] == "CARD_POOL_LEASE_SECONDS" and f["value"] == 600 for f in st["fields"]))
    c.post("/api/card-pool/settings", json={"CARD_POOL_LEASE_SECONDS": 300})

    # 6.8 删除资产
    check("删除卡片", c.delete(f"/api/card-pool/cards/{decline_card_id}").status_code == 200)
    check("删除 PayPal", c.delete("/api/card-pool/paypal/1").status_code == 200)

    # 6.9 自动支付（提链成功 → 扫描 → 自动入队支付 → 幂等）
    import webui.compat as _compat
    from core import db as _db
    _ce.update_config({"CARD_POOL_AUTO_PAY": True, "CARD_POOL_PAY_METHOD": "card"})
    fake_accounts = [{
        "id": 999001, "email": "autopay-smoke@test.local",
        "extract_link_status": "success",
        "extract_link_long_url": "https://checkout.stripe.com/pay/auto-ok",
    }]
    _orig_list_accounts = _db.list_accounts
    _db.list_accounts = lambda limit=500, offset=0, **kw: (fake_accounts if offset == 0 else [])
    try:
        n = _compat.card_pool_auto_pay_scan()
        check("自动支付入队", n >= 1)
        auto_job = None
        deadline = _time.time() + 10
        while _time.time() < deadline:
            jobs = c.get("/api/card-pool/jobs").get_json()["items"]
            auto_job = next((j for j in jobs if j.get("email") == "autopay-smoke@test.local"), None)
            if auto_job and auto_job["status"] in ("succeeded", "failed"):
                break
            _time.sleep(0.2)
        check("自动支付成功", auto_job is not None and auto_job["status"] == "succeeded" and auto_job["source"] == "auto")
        n2 = _compat.card_pool_auto_pay_scan()
        check("自动支付幂等", n2 == 0)
    finally:
        _db.list_accounts = _orig_list_accounts
        _ce.update_config({"CARD_POOL_AUTO_PAY": False})
finally:
    # 恢复配置与数据
    if _CP_CFG_BACKUP is not None:
        _CP_CFG.write_text(_CP_CFG_BACKUP, encoding="utf-8")
    # 等待后台支付线程收尾，避免清理与写入竞态（最多 ~10 秒）
    for _ in range(50):
        try:
            jobs_left = c.get("/api/card-pool/jobs").get_json()["items"]
        except Exception:
            jobs_left = []
        if not any(j.get("status") in ("queued", "running") for j in jobs_left):
            break
        _time.sleep(0.2)
    if _CP_DIR_BACKUP is not None:
        for _ in range(5):
            try:
                if _CP_DIR.exists():
                    _shutil.rmtree(_CP_DIR)
                _shutil.move(str(_CP_DIR.with_name("card_pool_backup_tmp")), str(_CP_DIR))
                break
            except OSError:
                _time.sleep(0.3)
    elif _CP_DIR.exists():
        for _ in range(5):
            try:
                _shutil.rmtree(_CP_DIR)
                break
            except OSError:
                _time.sleep(0.3)
    _CP_PAID_KEY.unlink(missing_ok=True)

print()
# 恢复原凭据
if _AUTH_BACKUP is not None:
    (_DATA_DIR / "auth.json").write_text(_AUTH_BACKUP, encoding="utf-8")
else:
    (_DATA_DIR / "auth.json").unlink(missing_ok=True)

if failures:
    print(f"自检失败 {len(failures)} 项: {failures}")
    sys.exit(1)
print("=== 自检全部通过 ===")
