#!/bin/bash
# 发布前检查清单（P5）：逐项验证，全绿即可发布
set -u
cd "$(dirname "$0")/.."
FAIL=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; FAIL=1; }

echo "== 发布检查 =="

# 1. 测试凭据残留
if grep -q "test123456" data/auth.json 2>/dev/null; then
  bad "仍在使用测试凭据 test/test123456（发布前必须 --init-credentials 更换）"
else
  ok "凭据已更换（非测试密码）"
fi

# 2. 自检
echo "-- 运行 smoke_test --"
if python3 tests/smoke_test.py > /tmp/smoke.out 2>&1; then
  ok "smoke_test 通过"
else
  bad "smoke_test 失败（见 /tmp/smoke.out）"
fi

# 3. 权限
if [ "$(stat -c %a data 2>/dev/null || stat -f %Lp data 2>/dev/null)" = "700" ]; then
  ok "data/ 权限 700"
else
  bad "data/ 权限不是 700"
fi
for f in data/auth.json data/secret_key; do
  if [ -f "$f" ] && [ "$(stat -c %a $f 2>/dev/null || stat -f %Lp $f 2>/dev/null)" = "600" ]; then
    ok "$f 权限 600"
  elif [ -f "$f" ]; then
    bad "$f 权限不是 600"
  fi
done

# 4. 绑定地址检查（应为 127.0.0.1，只查实际执行配置不查帮助文本）
if grep -h "ExecStart" deploy/*.service 2>/dev/null | grep -v "127.0.0.1" | grep "0.0.0.0" > /dev/null; then
  bad "systemd 服务发现 0.0.0.0 绑定（不应直接暴露公网）"
else
  ok "无 0.0.0.0 直绑"
fi
if grep -h "ports:" -A 2 docker-compose.yml 2>/dev/null | grep "0.0.0.0:" > /dev/null; then
  bad "docker-compose 将端口暴露到 0.0.0.0（应为 127.0.0.1）"
else
  ok "docker 端口仅回环映射"
fi

echo
if [ $FAIL -eq 0 ]; then
  echo "== 全部通过，可以发布 =="
else
  echo "== 存在未通过项，修复后再发布 =="
fi
exit $FAIL
