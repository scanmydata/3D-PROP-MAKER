"""Background job manager: one worker thread per job, state persisted as job.json."""
from __future__ import annotations

import json
import threading
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

MAX_LOG_LINES = 4000


class Cancelled(Exception):
    pass


@dataclass
class Job:
    id: str
    kind: str
    title: str
    dir: str
    params: dict = field(default_factory=dict)
    status: str = "queued"  # queued | running | done | failed | cancelled
    stage: str = ""
    progress: float = 0.0
    error: str = ""
    outputs: list = field(default_factory=list)  # [{label, path, type}]
    created: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)
    log: list = field(default_factory=list)

    def public(self, log_tail: int = 200) -> dict:
        d = asdict(self)
        d["log"] = self.log[-log_tail:]
        d.pop("dir", None)
        return d


class JobContext:
    """Handed to pipeline functions so they can report progress and honour cancel."""

    def __init__(self, manager: "JobManager", job: Job):
        self._m = manager
        self.job = job
        self.dir = Path(job.dir)
        self.cancel_event = threading.Event()
        self.process = None  # running subprocess, killed on cancel

    def log(self, line: str) -> None:
        line = line.rstrip()
        if not line:
            return
        stamp = time.strftime("%H:%M:%S")
        self.job.log.append(f"[{stamp}] {line}")
        if len(self.job.log) > MAX_LOG_LINES:
            del self.job.log[: len(self.job.log) - MAX_LOG_LINES]
        self._m.touch(self.job)

    def stage(self, name: str, progress: float | None = None) -> None:
        self.job.stage = name
        if progress is not None:
            self.job.progress = max(0.0, min(1.0, progress))
        self.log(f"== {name}")

    def progress(self, value: float) -> None:
        self.job.progress = max(0.0, min(1.0, value))
        self._m.touch(self.job)

    def output(self, label: str, path: Path, type_: str) -> None:
        rel = Path(path).resolve().relative_to(self.dir.resolve()).as_posix()
        self.job.outputs = [o for o in self.job.outputs if o["path"] != rel]
        self.job.outputs.append({"label": label, "path": rel, "type": type_})
        self._m.touch(self.job, persist=True)

    def check(self) -> None:
        if self.cancel_event.is_set():
            raise Cancelled()


class JobManager:
    def __init__(self, root: Path):
        self.root = root / "jobs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, Job] = {}
        self.contexts: dict[str, JobContext] = {}
        self.lock = threading.Lock()
        self._load_existing()

    def _load_existing(self) -> None:
        for f in sorted(self.root.glob("*/job.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                job = Job(**data)
                if job.status in ("queued", "running"):
                    job.status = "failed"
                    job.error = "Server restarted while the job was running."
                self.jobs[job.id] = job
            except Exception as exc:  # noqa: BLE001
                print(f"[jobs] skipping {f}: {exc}")

    def persist(self, job: Job) -> None:
        path = Path(job.dir) / "job.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(job), indent=1), encoding="utf-8")
        tmp.replace(path)

    def touch(self, job: Job, persist: bool = False) -> None:
        job.updated = time.time()
        if persist:
            self.persist(job)

    def create(self, kind: str, title: str, params: dict) -> tuple[Job, JobContext]:
        job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        d = self.root / job_id
        d.mkdir(parents=True)
        job = Job(id=job_id, kind=kind, title=title, dir=str(d), params=params)
        ctx = JobContext(self, job)
        with self.lock:
            self.jobs[job_id] = job
            self.contexts[job_id] = ctx
        self.persist(job)
        return job, ctx

    def start(self, ctx: JobContext, fn: Callable[[JobContext], None]) -> None:
        def run() -> None:
            job = ctx.job
            job.status = "running"
            self.persist(job)
            try:
                fn(ctx)
                job.status = "done"
                job.progress = 1.0
                job.stage = "Done"
                ctx.log("Job finished.")
            except Cancelled:
                job.status = "cancelled"
                ctx.log("Job cancelled.")
            except Exception as exc:  # noqa: BLE001
                job.status = "failed"
                job.error = str(exc)
                ctx.log(f"ERROR: {exc}")
                if not isinstance(exc, RuntimeError):  # RuntimeErrors are our own, user-facing messages
                    for line in traceback.format_exc().splitlines()[-8:]:
                        ctx.log(line)
            finally:
                self.persist(job)

        threading.Thread(target=run, name=f"job-{ctx.job.id}", daemon=True).start()

    def cancel(self, job_id: str) -> bool:
        ctx = self.contexts.get(job_id)
        if not ctx:
            return False
        ctx.cancel_event.set()
        proc = ctx.process
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        return True

    def delete(self, job_id: str) -> bool:
        import shutil

        job = self.jobs.get(job_id)
        if not job:
            return False
        self.cancel(job_id)
        with self.lock:
            self.jobs.pop(job_id, None)
            self.contexts.pop(job_id, None)
        shutil.rmtree(job.dir, ignore_errors=True)
        return True

    def list(self) -> list[dict]:
        return [j.public(log_tail=0) for j in sorted(self.jobs.values(), key=lambda j: j.created, reverse=True)]
