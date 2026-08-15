# -*- coding: utf-8 -*-
"""
Flask 本地控制台。

复用现有后端：
    core.db                     —— 账号 / 邮箱池 / 任务的文件持久化与查询
    core.registration_service   —— 线程池批量注册 + 任务日志
    webui.config_editor         —— 安全读写 config/*.py

所有接口返回 JSON；前端是单文件 templates/index.html（原生 JS + fetch）。
默认绑定 127.0.0.1，仅本地访问。
"""
import json
import logging
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request

from core import db
from core import registration_service as svc
from webui import config_editor
from webui import auth

logger = logging.getLogger(__name__)

# 正在补跑 Codex 的邮箱集合（进程内防重复触发）
_codex_retrying: set[str] = set()

_LOG_DIR = Path(__file__).resolve().parent.parent / "注册日志"


def _codex_retry_log_path(email: str) -> Path:
    safe = email.replace("/", "_").replace("\\", "_").replace(":", "_")
    return _LOG_DIR / f"codex-retry-{safe}.log"


_I18N_CACHE: dict | None = None


def _i18n_bootstrap() -> str:
    """加载 zh_cn 语言目录并序列化为前端 bootstrap（带缓存）。"""
    global _I18N_CACHE
    if _I18N_CACHE is None:
        p = Path(__file__).resolve().parent / "static" / "i18n" / "zh_cn.json"
        try:
            _I18N_CACHE = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _I18N_CACHE = {"locale": "zh_cn", "version": "0", "catalog": {}}
    return json.dumps(_I18N_CACHE, ensure_ascii=False)


def _json_body():
    """解析 JSON body；非 dict（字符串/数字/数组/null）一律视为空，避免下游 .get() 崩溃。"""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def create_app() -> Flask:
    app = Flask(__name__, template_folder="templates")

    # ----------------------------------------------------------
    # 认证（口令登录 + 签名 session + 限速）
    # ----------------------------------------------------------
    app.secret_key = auth.ensure_secret_key()
    app.permanent_session_lifetime = __import__("datetime").timedelta(days=7)
    auth.register_auth_routes(app)
    auth.auth_middleware(app)

    # 0.1.48 API 兼容层（系统/任务扩展/账号扩展/SMS/自动化任务/UPI 等）
    from webui.compat import register_compat_routes
    register_compat_routes(app)

    # ----------------------------------------------------------
    # 全局异常兜底：所有错误统一返回 JSON（不泄露堆栈）
    # ----------------------------------------------------------
    @app.errorhandler(400)
    def _err_400(exc):
        return jsonify({"ok": False, "error": "请求参数错误", "detail": str(exc)[:200]}), 400

    @app.errorhandler(404)
    def _err_404(exc):
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": "接口不存在", "error_code": "not_found"}), 404
        return exc

    @app.errorhandler(405)
    def _err_405(exc):
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": "方法不允许", "error_code": "method_not_allowed"}), 405
        return exc

    @app.errorhandler(413)
    def _err_413(exc):
        return jsonify({"ok": False, "error": "请求体过大", "error_code": "payload_too_large"}), 413

    @app.errorhandler(500)
    def _err_500(exc):
        logger.exception("未处理异常: %s", request.path)
        return jsonify({"ok": False, "error": "服务器内部错误", "error_code": "internal_error"}), 500

    # 请求体大小限制（防 DoS）
    app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024

    # 启动维护：数据备份 + 日志轮转（后台线程，不阻塞启动；全局只启动一次）
    import threading as _mt
    from webui import maintenance as _maintenance

    if not getattr(app, "_maintenance_started", False):
        app._maintenance_started = True

        def _run_maintenance():
            try:
                summary = _maintenance.run_maintenance()
                logger.info("[维护] %s", summary)
            except Exception:
                logger.exception("[维护] 异常")

        _mt.Thread(target=_run_maintenance, name="maintenance", daemon=True).start()

    # ----------------------------------------------------------
    # 页面
    # ----------------------------------------------------------
    @app.get("/")
    def index():
        return render_template("index.html", i18n_bootstrap=_i18n_bootstrap())

    @app.get("/login")
    def login_page():
        return render_template(
            "login.html",
            i18n_bootstrap=_i18n_bootstrap(),
            credentials_configured=auth.credentials_configured(),
        )

    # ----------------------------------------------------------
    # 统计概览
    # ----------------------------------------------------------
    @app.get("/api/summary")
    def api_summary():
        pool = db.outlook_pool_summary()
        domain_pool = db.domain_email_pool_summary()
        otp_rows = []
        try:
            from webui.compat import _load
            otp_rows = _load("api_otp_mail", []) or []
        except Exception:
            pass
        outlook_pool = {
            "total": pool.get("total", 0),
            "available": pool.get("available", 0),
            "used": pool.get("used", 0),
            "failed": pool.get("failed", 0),
            "copy_bytes": 0,
        }
        api_otp_mail_pool = {
            "total": len(otp_rows),
            "available": len(otp_rows),
            "used": 0,
            "failed": 0,
            "copy_bytes": 0,
        }
        return jsonify({
            "accounts": db.count_accounts(),
            "outlook_total": pool.get("total", 0),
            "outlook_available": pool.get("available", 0),
            "outlook_used": pool.get("used", 0),
            "outlook_failed": pool.get("failed", 0),
            "outlook_pool": outlook_pool,
            "api_otp_mail_pool": api_otp_mail_pool,
            "domain_total": domain_pool.get("total", 0),
            "domain_available": domain_pool.get("available", 0),
            "domain_used": domain_pool.get("used", 0),
            "domain_failed": domain_pool.get("failed", 0),
        })

    # ----------------------------------------------------------
    # 已注册账号
    # ----------------------------------------------------------
    @app.get("/api/accounts")
    def api_accounts():
        # 0.1.48 契约：items + pagination + features，支持 q/codex/twofa/archive 过滤
        from webui.compat import _decorate_account_row, _accounts_meta, _accounts_features
        page = request.args.get("page", default=1, type=int)
        page_size = request.args.get("page_size", default=20, type=int)
        q = (request.args.get("q") or "").strip().lower()
        codex = (request.args.get("codex") or "").strip()
        twofa = (request.args.get("twofa") or "").strip()
        archive = (request.args.get("archive") or "").strip()
        meta = _accounts_meta()
        rows = db.list_accounts(limit=100000)
        if q:
            rows = [r for r in rows if q in str(r.get("email", "")).lower()]
        if codex:
            rows = [r for r in rows if (r.get("codex_status") or "") == codex]
        if twofa == "yes":
            rows = [r for r in rows if r.get("totp_secret")]
        elif twofa == "no":
            rows = [r for r in rows if not r.get("totp_secret")]
        if archive == "unarchived":
            rows = [r for r in rows if not meta.get(r.get("email", "") or "", {}).get("archive_category_id")]
        elif archive and archive != "all" and str(archive).isdigit():
            rows = [r for r in rows if meta.get(r.get("email", "") or "", {}).get("archive_category_id") == int(archive)]
        total = len(rows)
        items = [_decorate_account_row(r, meta.get(r.get("email", ""))) for r in rows[(page - 1) * page_size: page * page_size]]
        return jsonify({
            "accounts": items,
            "items": items,
            "total": total,
            "features": _accounts_features(),
            "pagination": {
                "page": page, "page_size": page_size,
                "pages": max(1, (total + page_size - 1) // page_size),
                "total": total, "has_next": page * page_size < total,
                "has_prev": page > 1,
            },
        })

    # ----------------------------------------------------------
    # 邮箱池
    # ----------------------------------------------------------
    @app.get("/api/outlook")
    def api_outlook():
        # 0.1.48 契约：items + pagination + summary，支持 q/status/分页
        status = request.args.get("status") or None
        q = (request.args.get("q") or "").strip().lower()
        page = request.args.get("page", default=1, type=int)
        page_size = request.args.get("page_size", default=20, type=int)
        rows = db.list_outlook_pool(status=status, limit=100000)
        if q:
            rows = [r for r in rows if q in str(r.get("email", "")).lower()]
        total = len(rows)
        items = rows[(page - 1) * page_size: page * page_size]
        pool = db.outlook_pool_summary()
        summary = {
            "total": pool.get("total", 0),
            "available": pool.get("available", 0),
            "used": pool.get("used", 0),
            "failed": pool.get("failed", 0),
            "copy_bytes": 0,
        }
        return jsonify({
            "failure_limit": 3,
            "items": items,
            "summary": summary,
            "pagination": {
                "page": page, "page_size": page_size,
                "pages": max(1, (total + page_size - 1) // page_size),
                "total": total, "has_next": page * page_size < total,
                "has_prev": page > 1,
            },
        })

    @app.post("/api/outlook/import")
    def api_outlook_import():
        """
        粘贴文本导入邮箱素材。
        每行格式：email----password----clientId----refreshToken
        分隔符兼容 ---- 与 ====（外购素材两种都见过）。
        """
        data = _json_body()
        text = data.get("text") or ""
        from webui.compat import _check_import_size
        size_err = _check_import_size(str(text))
        if size_err:
            return jsonify({"ok": False, "error": size_err, "error_code": "import_too_large"}), 413
        records = []
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("----") if "----" in line else line.split("====")
            parts = [p.strip() for p in parts]
            if len(parts) < 4:
                continue
            records.append({
                "email": parts[0],
                "password": parts[1],
                "client_id": parts[2],
                "refresh_token": parts[3],
            })
        if not records:
            return jsonify({"ok": False, "error": "未解析到有效邮箱行（需 4 段，---- 或 ==== 分隔）"}), 400
        inserted, skipped = db.import_outlook_accounts(records)
        return jsonify({"ok": True, "inserted": inserted, "skipped": skipped, "parsed": len(records)})

    @app.post("/api/outlook/status")
    def api_outlook_status():
        """手动改邮箱状态：body {email, status, note?}。status ∈ available/used/failed。"""
        data = _json_body()
        email = (data.get("email") or "").strip()
        status = (data.get("status") or "").strip()
        if not email or status not in ("available", "used", "failed"):
            return jsonify({"ok": False, "error": "email 或 status 非法"}), 400
        db.release_outlook(email, status=status, note=data.get("note"))
        return jsonify({"ok": True})

    @app.post("/api/outlook/delete")
    def api_outlook_delete():
        """从邮箱池彻底删除一个邮箱：body {email}。"""
        data = _json_body()
        email = (data.get("email") or "").strip()
        if not email:
            return jsonify({"ok": False, "error": "email 为空"}), 400
        deleted = db.delete_outlook(email)
        return jsonify({"ok": True, "deleted": deleted})

    # ----------------------------------------------------------
    # 域名邮箱池（Cloudflare 域名邮箱模式）
    # ----------------------------------------------------------
    @app.get("/api/domain-pool")
    def api_domain_pool():
        status = request.args.get("status") or None
        limit = request.args.get("limit", default=500, type=int)
        return jsonify(db.list_domain_email_pool(status=status, limit=limit))

    @app.post("/api/domain-pool/status")
    def api_domain_pool_status():
        data = _json_body()
        email = (data.get("email") or "").strip()
        status = (data.get("status") or "").strip()
        if not email or status not in ("available", "used", "failed"):
            return jsonify({"ok": False, "error": "email 或 status 非法"}), 400
        db.release_domain_email(email, status=status, note=data.get("note"))
        return jsonify({"ok": True})

    @app.post("/api/domain-pool/delete")
    def api_domain_pool_delete():
        data = _json_body()
        email = (data.get("email") or "").strip()
        if not email:
            return jsonify({"ok": False, "error": "email 为空"}), 400
        deleted = db.delete_domain_email(email)
        return jsonify({"ok": True, "deleted": deleted})

    # ----------------------------------------------------------
    # Codex 授权账号（CPA 兼容凭证）
    # ----------------------------------------------------------
    @app.get("/api/codex")
    def api_codex_list():
        from webui.compat import enrich_codex_rows
        rows = enrich_codex_rows(db.list_codex_accounts())
        return jsonify({
            "summary": db.codex_accounts_summary(),
            "accounts": rows,
        })

    @app.get("/api/codex/download/<path:filename>")
    def api_codex_download(filename: str):
        """
        下载一个 CPA 兼容的 codex-*.json 文件，下载即标记为已导出（计数+1）。
        前端通过浏览器原生下载触发（a 标签 / window.location）。
        """
        try:
            content, fname = db.read_codex_credential(filename)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 404
        db.mark_codex_exported(fname)
        return Response(
            content,
            mimetype="application/json",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    @app.post("/api/codex/download-bulk")
    def api_codex_download_bulk():
        """
        批量下载选中的 codex 凭证，打包到一个 JSON 文件里。

        Body: {"filenames": ["codex-xxx.json", ...]}
        响应：聚合 JSON（attachment 触发浏览器下载），结构：
            {
              "exported_at": "...",
              "count": N,
              "credentials": [{"filename": "...", "data": {...原始凭证内容...}}, ...],
              "errors": [...]   // 仅当部分失败时出现
            }
        注意：聚合格式**不能直接被 CPA 读**，CPA 是按单文件加载 auths/ 目录的。
              本接口主要用途是备份 / 跨机迁移 / 二次处理。
        每个成功的凭证会自动标记 mark_exported（计数+1）。
        """
        import json as _json
        from datetime import datetime as _dt

        data = _json_body()
        filenames = data.get("filenames") or []
        if not isinstance(filenames, list) or not filenames:
            return jsonify({"ok": False, "error": "filenames 必须是非空数组"}), 400
        if len(filenames) > 1000:
            return jsonify({"ok": False, "error": "单次最多 1000 个"}), 400

        bundle = []
        errors = []
        for fname in filenames:
            if not isinstance(fname, str):
                errors.append({"filename": str(fname), "error": "非字符串"})
                continue
            try:
                content, real_fname = db.read_codex_credential(fname)
                parsed = _json.loads(content)
                bundle.append({"filename": real_fname, "data": parsed})
                db.mark_codex_exported(real_fname)
            except Exception as exc:
                errors.append({"filename": fname, "error": f"{type(exc).__name__}: {exc}"})

        now = _dt.now()
        result = {
            "exported_at": now.isoformat(timespec="seconds"),
            "count": len(bundle),
            "credentials": bundle,
        }
        if errors:
            result["errors"] = errors

        dl_name = f"codex-bulk-{now.strftime('%Y%m%d-%H%M%S')}.json"
        return Response(
            _json.dumps(result, ensure_ascii=False, indent=2),
            mimetype="application/json",
            headers={"Content-Disposition": f'attachment; filename="{dl_name}"'},
        )

    @app.post("/api/codex/reset-export")
    def api_codex_reset_export():
        """清掉某个 codex 凭证的导出状态（重新标为未导出）。body {filename}。"""
        data = _json_body()
        fname = (data.get("filename") or "").strip()
        if not fname:
            return jsonify({"ok": False, "error": "filename 为空"}), 400
        try:
            db.reset_codex_exported(fname)
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True})

    @app.post("/api/codex/retry")
    def api_codex_retry():
        """
        手动补跑某账号的 Codex 授权。Body {email}。

        立即返回，实际跑在后台守护线程里（要 ~1-2 分钟收邮件+接码）。
        前端轮询 /api/accounts 看 codex_status 变化即可。
        防重复触发：补跑过程中再次调用同邮箱会被拒。
        """
        import threading
        data = _json_body()
        email = (data.get("email") or "").strip()
        if not email:
            return jsonify({"ok": False, "error": "email 为空"}), 400

        # 校验账号存在
        acc = db.get_account_by_email(email)
        if acc is None:
            return jsonify({"ok": False, "error": f"账号不存在: {email}"}), 404

        # 防重复触发：内存级标记，进程内同邮箱并发 retry 直接拒
        if email in _codex_retrying:
            return jsonify({"ok": False, "error": "该账号正在补跑中，请稍候"}), 409
        _codex_retrying.add(email)

        # 立即把状态标为 retrying，前端能立刻看到
        db.update_account_codex_status(email, "retrying", None)

        log_path = _codex_retry_log_path(email)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        # 清空旧日志（每次补跑重新写）
        log_path.write_text("", encoding="utf-8")

        def _bg_retry():
            import logging as _logging
            from core.codex_oauth import run_codex_oauth

            # 给本线程挂一个写到补跑日志文件的 handler
            thread_name = threading.current_thread().name
            fh = _logging.FileHandler(str(log_path), encoding="utf-8")
            fh.setLevel(_logging.DEBUG)
            fh.setFormatter(_logging.Formatter(
                "%(asctime)s [%(levelname)s] %(message)s",
                datefmt="%H:%M:%S",
            ))
            fh.addFilter(lambda r: r.threadName == thread_name)
            _logging.getLogger().addHandler(fh)
            try:
                result = run_codex_oauth(email)
                result_status = result.get("status", "failed")
                if result.get("ok"):
                    db.update_account_codex_status(email, "success", None)
                    logger.info(f"[Codex 补跑] {email} 成功")
                elif result_status == "deactivated":
                    db.update_account_codex_status(email, "deactivated", result.get("message"))
                    logger.warning(f"[Codex 补跑] {email} 账号已废: {result.get('message')}")
                else:
                    db.update_account_codex_status(
                        email, result_status,
                        result.get("message"),
                    )
                    logger.warning(f"[Codex 补跑] {email} 失败: {result.get('message')}")
            except Exception as exc:
                db.update_account_codex_status(email, "failed", f"{type(exc).__name__}: {exc}")
                logger.exception(f"[Codex 补跑] {email} 异常")
            finally:
                fh.close()
                _logging.getLogger().removeHandler(fh)
                _codex_retrying.discard(email)

        threading.Thread(target=_bg_retry, name=f"codex-retry-{email}", daemon=True).start()
        return jsonify({"ok": True, "message": "已在后台开始补跑，~1-2 分钟后刷新查看"})

    @app.get("/api/codex/retry-log")
    def api_codex_retry_log():
        """读取某邮箱最近一次补跑的日志。?email=xxx"""
        email = (request.args.get("email") or "").strip()
        if not email:
            return jsonify({"ok": False, "error": "email 为空"}), 400
        p = _codex_retry_log_path(email)
        if not p.exists():
            return jsonify({"ok": True, "log": "", "running": False})
        max_bytes = 50_000
        size = p.stat().st_size
        with p.open("rb") as f:
            if size > max_bytes:
                f.seek(max(0, size - max_bytes))
            content = f.read().decode("utf-8", errors="replace")
        return jsonify({
            "ok": True,
            "log": content,
            "running": email in _codex_retrying,
        })

    # ----------------------------------------------------------
    # 注册任务
    # ----------------------------------------------------------
    @app.get("/api/jobs")
    def api_jobs():
        # 0.1.48 契约：items + pagination + status_counts + all_total + batches
        page = request.args.get("page", default=1, type=int)
        page_size = request.args.get("page_size", default=10, type=int)
        q = (request.args.get("q") or "").strip().lower()
        status = (request.args.get("status") or "").strip()
        rows = db.list_jobs(limit=100000)
        if q:
            rows = [r for r in rows if q in str(r.get("email", "")).lower() or q in str(r.get("id", "")) or q in str(r.get("error_message", "")).lower()]
        if status:
            rows = [r for r in rows if (r.get("status") or "") == status]
        total = len(rows)
        status_counts: dict = {}
        for r in rows:
            st = r.get("status") or "unknown"
            status_counts[st] = status_counts.get(st, 0) + 1
        items = rows[(page - 1) * page_size: page * page_size]
        return jsonify({
            "items": items,
            "pagination": {
                "page": page, "page_size": page_size,
                "pages": max(1, (total + page_size - 1) // page_size),
                "total": total, "has_next": page * page_size < total,
                "has_prev": page > 1,
            },
            "status_counts": status_counts,
            "all_total": len(db.list_jobs(limit=100000)),
            "batches": [],
        })

    @app.post("/api/jobs")
    def api_jobs_create():
        """启动批量注册：body {count, workers}。"""
        data = _json_body()
        try:
            count = int(data.get("count", 1))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "count 非法"}), 400
        if count < 1 or count > 200:
            return jsonify({"ok": False, "error": "count 需在 1~200 之间"}), 400

        # workers 控制线程池并发上限（首次提交时生效）
        workers = data.get("workers")
        if workers:
            try:
                svc.get_executor(max_workers=int(workers))
            except (TypeError, ValueError):
                pass

        # 提交前先确认池里有足够可用邮箱，给前端一个温和提示（不阻断）
        from config import EMAIL_SOURCE
        if EMAIL_SOURCE == "cloudflare_domain":
            pool = db.domain_email_pool_summary()
            warning = ""
            if pool.get("available", 0) < count:
                warning = f"域名邮箱池仅 {pool.get('available', 0)} 个可用，少于任务数 {count}，不足的会自动生成"
        else:
            pool = db.outlook_pool_summary()
            warning = ""
            if pool.get("available", 0) < count:
                warning = f"可用邮箱仅 {pool.get('available', 0)} 个，少于任务数 {count}，不足的会失败"
        jobs = svc.submit_registration(count=count)
        return jsonify({"ok": True, "submitted": len(jobs), "jobs": jobs, "warning": warning})

    @app.post("/api/jobs/cancel-pending")
    def api_jobs_cancel_pending():
        """取消所有还在排队（status=pending）的任务。已在 running 的不动。"""
        cancelled = svc.cancel_pending_jobs()
        return jsonify({"ok": True, "cancelled": cancelled})

    @app.get("/api/jobs/<int:job_id>/log")
    def api_job_log(job_id: int):
        job = db.get_job(job_id)
        if not job:
            return jsonify({"ok": False, "error": "任务不存在"}), 404
        return jsonify({
            "ok": True,
            "job": job,
            "log": svc.read_job_log(job_id),
        })

    # ----------------------------------------------------------
    # 配置读写
    # ----------------------------------------------------------
    @app.get("/api/config")
    def api_config_get():
        return jsonify(config_editor.get_config())

    @app.post("/api/config")
    def api_config_set():
        data = _json_body()
        updates = data.get("updates") if isinstance(data.get("updates"), dict) else data
        if not isinstance(updates, dict) or not updates:
            return jsonify({"ok": False, "error": "无更新内容"}), 400
        try:
            result = config_editor.update_config(updates)
        except ValueError as exc:
            # 参数校验失败（如 int 越界）→ 400，给前端可读错误
            return jsonify({"ok": False, "error": str(exc)}), 400
        except Exception as exc:
            logger.exception("配置写入失败")
            return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500

        # 写盘成功后立即热加载所有 config 子模块，让运行时代码看到新值。
        reload_ok = True
        reload_err = ""
        try:
            import config as _config_pkg
            _config_pkg.reload_all()
        except Exception as exc:
            reload_ok = False
            reload_err = f"{type(exc).__name__}: {exc}"
            logger.exception("配置热加载失败")

        return jsonify({
            "ok": True,
            "updated": result["updated"],
            "ignored": result["ignored"],
            "reloaded": reload_ok,
            "note": (
                "✅ 已保存并热加载，新值立即生效"
                if reload_ok
                else f"⚠️ 已写入文件但热加载失败（{reload_err}），需重启 Web 服务才能生效"
            ),
        })

    return app
