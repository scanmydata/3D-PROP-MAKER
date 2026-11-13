"""Runtime configuration. Values come from environment variables or server/config.json."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
CONFIG_FILE = ROOT / "config.json"

_DEFAULTS = {
    # Path to the Spirula Studio executable (spirula.exe). Download it from
    # https://github.com/harry7557558/spirula-studio/releases and point this at it,
    # or put it on PATH.
    "spirula_bin": "",
    # Where uploaded media, downloaded panoramas, datasets and results are stored.
    "work_dir": str(PROJECT_ROOT / "workspace"),
    # Optional Google Maps Platform key, only for the "official" Street View Static API source.
    "google_api_key": "",
    # Extra args appended to each Spirula stage (escape hatch for expert flags).
    "spirula_sfm_args": [],
    "spirula_train_args": [],
    "spirula_mesh_args": [],

    # ---- AI assistant (any OpenAI-compatible chat API) ----
    "ai_enabled": False,
    "ai_provider": "openrouter",  # openrouter | lmstudio | ollama | strata | custom
    "ai_base_url": "",  # empty = the provider's default
    "ai_api_key": "",  # OpenRouter key (free account); local servers need none
    "ai_model": "",  # empty = pick the first free vision model (OpenRouter) / loaded model (local)
    "ai_language": "Greek",
    "ai_local_during_gpu": "wait",  # wait | allow: a local model shares the GPU/RAM with Spirula

    # ---- resources ----
    "gpu_device": "auto",  # Spirula --device: auto, an index, or part of the GPU's name (e.g. an eGPU)
    "max_gpu_jobs": 1,  # Spirula stages running at once; 1 on a single GPU
    "process_priority": "below_normal",  # normal | below_normal | idle (keeps the PC usable)
    "cpu_threads": 0,  # 0 = all; caps meshing / OpenCV threads
    "sfm_max_image_size": 0,  # 0 = Spirula's default (3200); lower saves RAM/VRAM
    "train_resolution_divisor": 0,  # 2 = train on half-size images (less VRAM, faster)
    "max_splats": 1000000,  # Spirula --cap-max
    "frames_max_side": 3840,  # longest side of frames taken from videos
}

AI_PROVIDERS = {
    "openrouter": {"label": "OpenRouter (cloud, free models)", "base_url": "https://openrouter.ai/api/v1", "local": False},
    "lmstudio": {"label": "LM Studio (local)", "base_url": "http://127.0.0.1:1234/v1", "local": True},
    "ollama": {"label": "Ollama (local)", "base_url": "http://127.0.0.1:11434/v1", "local": True},
    "strata": {"label": "Strata (local)", "base_url": "http://127.0.0.1:8000/v1", "local": True},
    "custom": {"label": "Other OpenAI-compatible server", "base_url": "http://127.0.0.1:8080/v1", "local": True},
}

SECRET_KEYS = {"ai_api_key", "google_api_key"}


def load() -> dict:
    cfg = dict(_DEFAULTS)
    if CONFIG_FILE.exists():
        try:
            cfg.update(json.loads(CONFIG_FILE.read_text(encoding="utf-8")))
        except Exception as exc:  # noqa: BLE001
            print(f"[config] could not read {CONFIG_FILE}: {exc}")
    env_map = {
        "SPIRULA_BIN": "spirula_bin",
        "WORK_DIR": "work_dir",
        "GOOGLE_API_KEY": "google_api_key",
        "OPENROUTER_API_KEY": "ai_api_key",
    }
    for env, key in env_map.items():
        if os.environ.get(env):
            cfg[key] = os.environ[env]
    return cfg


def save(updates: dict) -> dict:
    current = {}
    if CONFIG_FILE.exists():
        try:
            current = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            current = {}
    current.update({k: v for k, v in updates.items() if k in _DEFAULTS})
    current = {k: v for k, v in current.items() if not (k in SECRET_KEYS and v == "")}
    CONFIG_FILE.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return load()


def spirula_path(cfg: dict | None = None) -> str | None:
    cfg = cfg or load()
    candidate = cfg.get("spirula_bin") or ""
    if candidate and Path(candidate).is_file():
        return str(Path(candidate))
    for name in ("spirula", "spirula.exe"):
        found = shutil.which(name)
        if found:
            return found
    # Common local install location next to the project.
    for p in (PROJECT_ROOT / "tools" / "spirula" / "spirula.exe", PROJECT_ROOT / "tools" / "spirula" / "spirula"):
        if p.is_file():
            return str(p)
    return None


def work_dir(cfg: dict | None = None) -> Path:
    cfg = cfg or load()
    p = Path(cfg["work_dir"])
    p.mkdir(parents=True, exist_ok=True)
    return p


def public(cfg: dict | None = None) -> dict:
    """Settings safe to send to the browser (secrets reduced to 'is set')."""
    cfg = cfg or load()
    out = {k: v for k, v in cfg.items() if k not in SECRET_KEYS}
    for k in SECRET_KEYS:
        out[f"{k}_set"] = bool(cfg.get(k))
    return out
