# -*- coding: utf-8 -*-
"""重启后恢复注册队列：pending/queued 任务重新提交到线程池。"""
from core import registration_service as svc


def test_resume_pending_jobs_submits_pending_and_queued(monkeypatch):
    jobs = [
        {"id": 1, "status": "pending", "log_file": "j1.log"},
        {"id": 2, "status": "queued", "log_file": "j2.log"},
        {"id": 3, "status": "success", "log_file": "j3.log"},
        {"id": 4, "status": "cancelled", "log_file": "j4.log"},
        {"id": 5, "status": "failed", "log_file": "j5.log"},
    ]
    monkeypatch.setattr(svc.db, "list_jobs", lambda limit=1000: jobs)
    monkeypatch.setattr(svc, "_run_one_job", lambda *a, **k: None)
    submitted = []

    class _FakeExecutor:
        def submit(self, fn, job_id, log_file):
            submitted.append((job_id, log_file))
            return object()

    monkeypatch.setattr(svc, "get_executor", lambda max_workers=None: _FakeExecutor())

    n = svc.resume_pending_jobs()
    assert n == 2
    assert sorted(job_id for job_id, _ in submitted) == [1, 2]
    assert dict(submitted)[1] == "j1.log"


def test_resume_pending_jobs_empty_queue(monkeypatch):
    monkeypatch.setattr(svc.db, "list_jobs", lambda limit=1000: [])
    monkeypatch.setattr(svc, "get_executor", lambda max_workers=None: object())
    assert svc.resume_pending_jobs() == 0


def test_reconcile_stale_running_jobs(monkeypatch):
    """启动时 running 遗留任务标记失败；未注册成功的邮箱退回可用池。"""
    jobs = [
        {"id": 1, "status": "running", "email": "a@outlook.jp"},
        {"id": 2, "status": "running", "email": "b@outlook.jp"},
        {"id": 3, "status": "success", "email": "c@outlook.jp"},
        {"id": 4, "status": "pending", "email": ""},
    ]
    monkeypatch.setattr(svc.db, "list_jobs", lambda limit=1000: jobs)
    updated = {}

    def fake_update_job(job_id, **kw):
        updated[job_id] = kw

    monkeypatch.setattr(svc.db, "update_job", fake_update_job)
    monkeypatch.setattr(svc.db, "_load_accounts", lambda: [{"email": "a@outlook.jp"}])
    released = []
    # release_account 在函数内通过 core.outlook_client 导入，这里直接打桩 outlook_client
    import core.outlook_client as oc
    monkeypatch.setattr(oc, "release_account", lambda email, status="available", note=None: released.append((email, status)))

    n = svc.reconcile_stale_jobs()
    assert n == 2
    assert updated[1]["status"] == "failed" and "中断" in updated[1]["error"]
    assert updated[2]["status"] == "failed"
    assert 3 not in updated and 4 not in updated
    assert released == [("b@outlook.jp", "available")]
