"""Drive the Spirula Studio CLI: images -> SfM -> 3D Gaussian Splat -> textured mesh.

Spirula Studio (https://github.com/harry7557558/spirula-studio) is a single GPU binary
(Vulkan: NVIDIA/AMD/Intel/Apple) with native equirectangular (360°) camera support:

    spirula sfm auto <images> -o <workspace> --camera-model equirectangular ...
    spirula train --data <workspace> --output-dir-prefix <dir> --disable-viewer true
    spirula mesh <run-dir> --format glb --color texture --output <dir>/mesh
"""
from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path

import config
import resources

_PCT = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%")
_STEP = re.compile(r"\bstep\s*[:=]?\s*(\d+)\s*/\s*(\d+)", re.I)

QUALITY_PRESETS = {
    # name: (sfm quality, train steps, mesh texture size)
    # SfM is minutes against training's tens of minutes, and on Street View cut-outs "high"
    # registered 4x more images than "medium" in testing, so every preset uses it.
    "preview": ("high", 7000, 2048),
    "standard": ("high", 15000, 4096),
    "high": ("high", 30000, 8192),
}


def run(cmd: list[str], ctx, span: tuple[float, float], cwd: Path | None = None) -> None:
    """Run a CLI stage, stream its output into the job log, map its % into the job progress span."""
    ctx.log("$ " + " ".join(f'"{c}"' if " " in c else c for c in cmd))
    with resources.gpu_slot(ctx):
        _run(cmd, ctx, span, cwd)


def resource_args(stage: str) -> list[str]:
    """Device / memory / thread flags from Settings -> Resources."""
    cfg = config.load()
    args: list[str] = []
    dev = str(cfg.get("gpu_device") or "auto").strip()
    if dev and dev != "auto":
        args += ["--device", dev]
    if stage == "sfm" and int(cfg.get("sfm_max_image_size") or 0) > 0:
        args += ["--max-image-size", str(int(cfg["sfm_max_image_size"]))]
    if stage == "train":
        if int(cfg.get("train_resolution_divisor") or 0) > 1:
            args += ["--train-resolution-divisor", str(int(cfg["train_resolution_divisor"]))]
        if int(cfg.get("max_splats") or 0) > 0:
            args += ["--cap-max", str(int(cfg["max_splats"]))]
    if int(cfg.get("cpu_threads") or 0) > 0:
        if stage == "mesh":
            args += ["--num-threads", str(int(cfg["cpu_threads"]))]
        elif stage == "sfm":
            args += ["--threads", str(int(cfg["cpu_threads"]))]
    return args


def _run(cmd: list[str], ctx, span: tuple[float, float], cwd: Path | None = None) -> None:
    lo, hi = span
    proc = subprocess.Popen(cmd, cwd=str(cwd) if cwd else None, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", bufsize=1,
                            creationflags=resources.creation_flags())
    ctx.process = proc
    last_log = 0.0
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            if ctx.cancel_event.is_set():
                proc.kill()
                break
            # progress bars redraw with \r; keep the last state of the line
            line = raw.rstrip("\n").split("\r")[-1]
            frac = None
            m = _STEP.search(line)
            if m and int(m.group(2)) > 0:
                frac = int(m.group(1)) / int(m.group(2))
            else:
                m = _PCT.search(line)
                if m:
                    frac = float(m.group(1)) / 100.0
            if frac is not None:
                ctx.progress(lo + (hi - lo) * min(1.0, frac))
            now = time.time()
            # throttle chatty progress output, but always keep non-progress lines
            if frac is None or now - last_log > 2.0:
                ctx.log(line)
                last_log = now
        proc.wait()
    finally:
        ctx.process = None
    ctx.check()
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[1:3])} exited with code {proc.returncode} - see the log above.")
    ctx.progress(hi)


def sfm(bin_: str, images: Path, workspace: Path, ctx, camera_model: str, data_type: str, quality: str,
        masks: Path | None, extra: list[str]) -> Path:
    cmd = [bin_, "sfm", "auto", str(images), "-o", str(workspace),
           "--quality", quality, "--data-type", data_type, "--camera-model", camera_model,
           "--metric-gps", "auto", "--progress-dir", str(workspace / "progress")]
    cmd += ["--masks", str(masks)] if masks else ["--no-masks"]
    cmd += resource_args("sfm")
    try:
        run(cmd + list(extra), ctx, (0.40, 0.55))
    except RuntimeError:
        # A partial reconstruction exits non-zero but still writes a usable model; keep going with it.
        if not list(workspace.glob("sparse/*/points3D.*")):
            raise
        ctx.log("SfM registered only part of the images (see RESULT above); continuing with the largest model.")
    sparse = workspace / "sparse" / "0"
    if not (sparse / "points3D.bin").exists() and not (sparse / "points3D.txt").exists():
        cands = sorted(workspace.glob("sparse/*/points3D.*"))
        if not cands:
            raise RuntimeError("SfM finished but produced no sparse model (too few overlapping images?).")
        sparse = cands[0].parent
    return sparse


def train(bin_: str, dataset: Path, out_prefix: Path, ctx, steps: int, extra: list[str]) -> Path:
    cmd = [bin_, "train", "--data", str(dataset), "--output-dir-prefix", str(out_prefix),
           "--output-dir-name", "run", "--disable-viewer", "1", "--keep-viewer-alive", "0",
           "--num-iterations", str(steps), "--steps-per-save", "-1"] + resource_args("train")
    run(cmd + list(extra), ctx, (0.55, 0.88))
    run_dir = out_prefix / "run"
    if not run_dir.exists():
        dirs = sorted([d for d in out_prefix.iterdir() if d.is_dir()], key=lambda d: d.stat().st_mtime)
        if not dirs:
            raise RuntimeError("Training finished but no run folder was written.")
        run_dir = dirs[-1]
    return run_dir


def latest_splat(run_dir: Path) -> Path | None:
    splats = sorted(run_dir.rglob("splat.ply"), key=lambda p: p.stat().st_mtime)
    return splats[-1] if splats else None


def mesh(bin_: str, run_dir: Path, out_dir: Path, ctx, texture_size: int, extra: list[str]) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    # PLY cannot carry a texture (Spirula skips that pair), so the textured mesh is GLB only.
    cmd = [bin_, "mesh", str(run_dir), "--format", "glb", "--color", "texture",
           "--texture-size", str(texture_size), "--output", str(out_dir / "mesh")] + resource_args("mesh")
    run(cmd + list(extra), ctx, (0.88, 0.99))
    found = sorted(out_dir.rglob("*.glb"))
    if not found:
        # Some builds write next to the run instead of --output.
        found = sorted(run_dir.rglob("*.glb"))
    return found


def version(bin_: str) -> str:
    try:
        r = subprocess.run([bin_, "--version"], capture_output=True, text=True, timeout=15,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return (r.stdout or r.stderr).strip().splitlines()[0] if (r.stdout or r.stderr) else "unknown"
    except Exception as exc:  # noqa: BLE001
        return f"error: {exc}"
