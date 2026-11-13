"""Sharing one PC between Spirula (GPU), a local LLM and the user.

* GPU gate: at most `max_gpu_jobs` Spirula stages run at once; extra jobs wait their turn.
* A local LLM can be told to wait while a Spirula stage holds the GPU (`ai_local_during_gpu`).
* Spirula runs at a lower process priority so the desktop (and the editor) stay responsive.
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
from contextlib import contextmanager

import config

_cond = threading.Condition()
_active = 0
_waiting = 0


def gpu_busy() -> bool:
    return _active > 0


def status() -> dict:
    return {"gpu_active": _active, "gpu_waiting": _waiting}


@contextmanager
def gpu_slot(ctx=None):
    """Hold one GPU slot for the duration of a Spirula stage."""
    global _active, _waiting
    limit = max(1, int(config.load().get("max_gpu_jobs", 1) or 1))
    with _cond:
        if _active >= limit:
            _waiting += 1
            if ctx:
                ctx.log(f"Waiting for the GPU ({_active} reconstruction stage(s) running)…")
            try:
                while _active >= limit:
                    if ctx and ctx.cancel_event.is_set():
                        ctx.check()
                    _cond.wait(timeout=2.0)
                    limit = max(1, int(config.load().get("max_gpu_jobs", 1) or 1))
            finally:
                _waiting -= 1
        _active += 1
    try:
        yield
    finally:
        with _cond:
            _active -= 1
            _cond.notify_all()


def wait_for_gpu_idle(timeout: float = 3600.0) -> bool:
    """Used before local-LLM calls when the user prefers the LLM to wait for Spirula."""
    end = time.time() + timeout
    with _cond:
        while _active > 0:
            left = end - time.time()
            if left <= 0:
                return False
            _cond.wait(timeout=min(5.0, left))
    return True


def creation_flags() -> int:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if os.name == "nt":
        prio = config.load().get("process_priority", "below_normal")
        flags |= {"idle": 0x00000040, "below_normal": 0x00004000}.get(prio, 0)
    return flags


def cpu_threads() -> int:
    n = int(config.load().get("cpu_threads", 0) or 0)
    return n if n > 0 else (os.cpu_count() or 4)


def list_gpus() -> list[str]:
    """Display adapters Windows knows about (names usable as Spirula --device filters)."""
    if os.name != "nt":
        return []
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              "(Get-CimInstance Win32_VideoController).Name"],
                             capture_output=True, text=True, timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return [l.strip() for l in out.stdout.splitlines() if l.strip()]
    except Exception:  # noqa: BLE001
        return []


def memory() -> dict:
    """Total / free physical memory in GB (Windows), for the resource panel."""
    if os.name != "nt":
        return {}
    import ctypes

    class MS(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong), ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]

    m = MS()
    m.dwLength = ctypes.sizeof(MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return {"total_gb": round(m.ullTotalPhys / 2**30, 1), "free_gb": round(m.ullAvailPhys / 2**30, 1), "cpu_threads": os.cpu_count()}
