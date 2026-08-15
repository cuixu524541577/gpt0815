# -*- coding: utf-8 -*-
"""
WebUI 启动入口。

用法：
    python web.py                               # 默认 http://127.0.0.1:5000，仅本地访问
    python web.py --port 8000                   # 换端口
    python web.py --host 0.0.0.0                # 允许局域网访问（敏感工具，自行评估）
    python web.py --init-credentials admin 密码  # 初始化登录凭据（无凭据时启动会提示）

环境变量（供 docker/无人值守首启）：
    ADMIN_USERNAME / ADMIN_PASSWORD             # 首次启动自动创建登录凭据

与 CLI（python main.py）完全平行，互不影响。
"""
import argparse
import logging
import os
import webbrowser
from pathlib import Path
from threading import Timer

from webui.app import create_app
from webui import auth


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )


def _startup_selfcheck() -> None:
    """启动自检：依赖/数据目录/凭据/Node，只告警不阻断。"""
    logger = logging.getLogger(__name__)
    issues = []

    # 核心依赖
    for mod, name in (("curl_cffi", "curl_cffi"), ("pyotp", "pyotp"),
                      ("flask", "flask"), ("requests", "requests"),
                      ("dotenv", "python-dotenv")):
        try:
            __import__(mod)
        except ImportError:
            issues.append(f"缺少依赖 {name}（pip install {name}）")

    # 数据目录可写
    from webui import auth
    try:
        auth.ensure_secret_key()
    except OSError as exc:
        issues.append(f"数据目录不可写: {exc}")

    # 凭据
    if not auth.credentials_configured():
        issues.append("尚未配置登录凭据（python web.py --init-credentials <用户名> <密码>）")

    # Node（sentinel 需要）
    import shutil as _sh
    if _sh.which("node") is None:
        issues.append("未检测到 Node.js（sentinel 反机器人不可用，注册会失败）")

    # sentinel 文件
    sentinel_dir = Path(__file__).resolve().parent / "sentinel"
    for f in ("sdk.js", "sentinel-runner.js"):
        if not (sentinel_dir / f).exists():
            issues.append(f"缺少 sentinel/{f}")

    if issues:
        logger.warning("启动自检发现 %d 项问题：", len(issues))
        for it in issues:
            logger.warning("  - %s", it)
    else:
        logger.info("启动自检通过（依赖/数据目录/凭据/Node 均正常）")


def _auto_init_credentials() -> None:
    """env 提供 ADMIN_USERNAME/ADMIN_PASSWORD 且尚未配置时，自动创建凭据。"""
    username = os.environ.get("ADMIN_USERNAME", "").strip()
    password = os.environ.get("ADMIN_PASSWORD", "")
    if username and password and not auth.credentials_configured():
        auth.set_credentials(username, password)
        logging.getLogger(__name__).info(
            f"已通过环境变量初始化登录凭据：{username}（请尽快修改）"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="GPT 注册 WebUI 控制台")
    parser.add_argument("--host", default="127.0.0.1", help="绑定地址，默认仅本地 127.0.0.1")
    parser.add_argument("--port", type=int, default=5000, help="端口，默认 5000")
    parser.add_argument("--no-browser", action="store_true", help="启动时不自动打开浏览器")
    parser.add_argument("--verbose", action="store_true", help="详细日志")
    parser.add_argument(
        "--init-credentials",
        nargs=2,
        metavar=("USERNAME", "PASSWORD"),
        help="初始化/覆盖登录凭据后退出",
    )
    args = parser.parse_args()

    _setup_logging(args.verbose)
    logger = logging.getLogger(__name__)

    if args.init_credentials:
        username, password = args.init_credentials
        if not username.strip():
            logger.error("用户名不能为空")
            raise SystemExit(1)
        if len(password) < 8:
            logger.error("密码至少 8 位")
            raise SystemExit(1)
        auth.set_credentials(username.strip(), password)
        logger.info(f"登录凭据已写入 data/auth.json：{username.strip()}")
        return

    _auto_init_credentials()

    _startup_selfcheck()

    # 重启后清理中断任务（running 遗留）并恢复未完成的注册队列，
    # 让"排队模式"跨进程重启依然生效，且不会出现卡死的 running 占位。
    try:
        from core.registration_service import reconcile_stale_jobs
        from core.registration_service import resume_pending_jobs
        cleaned = reconcile_stale_jobs()
        if cleaned:
            logger.info(f"已标记 {cleaned} 个进程中断任务为失败")
        resumed = resume_pending_jobs()
        if resumed:
            logger.info(f"已恢复 {resumed} 个排队注册任务")
    except Exception:
        logger.exception("启动时恢复注册队列失败")

    app = create_app()
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}"
    logger.info(f"WebUI 已启动：{url}")
    if args.host in ("0.0.0.0", "::"):
        logger.warning("已绑定到所有网卡，局域网内其他设备可访问。这是敏感工具，请确认网络环境可信。")
    if not auth.credentials_configured():
        logger.warning(
            "尚未配置登录凭据，请执行: python web.py --init-credentials <用户名> <密码>"
        )

    # 默认自动开浏览器（用 reloader 时只在主进程开）
    if not args.no_browser:
        Timer(1.0, lambda: webbrowser.open(url)).start()

    # debug=False：避免 reloader 双进程导致线程池/定时器重复
    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
