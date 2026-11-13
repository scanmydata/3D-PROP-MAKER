"""Track & Props Studio - backend API.

Run:  npm run server   (uvicorn app:app --app-dir server --port 8765)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ai  # noqa: E402
import config  # noqa: E402
import resources  # noqa: E402
from jobs import JobManager  # noqa: E402
from pipeline import geo, masks, run, spirula  # noqa: E402

app = FastAPI(title="Track & Props Studio API")
manager = JobManager(config.work_dir())

PIPELINES = {"media": run.media_job, "streetview": run.streetview_job, "photo3d": run.photo3d_job,
             "pointcloud": run.pointcloud_job}


@app.get("/api/health")
def health():
    cfg = config.load()
    bin_ = config.spirula_path(cfg)
    return {
        "ok": True,
        "spirula": bin_,
        "spirula_version": spirula.version(bin_) if bin_ else None,
        "yolo": masks.yolo_available(),
        "google_api_key": bool(cfg.get("google_api_key")),
        "ai_enabled": bool(cfg.get("ai_enabled")),
        "ai_provider": cfg.get("ai_provider"),
        "work_dir": str(config.work_dir(cfg)),
        **resources.status(),
    }


@app.get("/api/settings")
def get_settings():
    return {**config.public(), "ai_providers": config.AI_PROVIDERS}


@app.post("/api/settings")
def set_settings(updates: dict):
    updates = {k: v for k, v in updates.items() if v is not None}
    if updates.get("spirula_bin") and not Path(updates["spirula_bin"]).is_file():
        raise HTTPException(400, f"File not found: {updates['spirula_bin']}")
    if "ai_provider" in updates and updates["ai_provider"] not in config.AI_PROVIDERS:
        raise HTTPException(400, "Unknown AI provider")
    config.save(updates)
    return get_settings()


@app.get("/api/resources")
def get_resources():
    return {**resources.status(), **resources.memory(), "gpus": resources.list_gpus()}


# ---------------- AI assistant ----------------

@app.get("/api/ai/models")
def ai_models(provider: str | None = None):
    try:
        return ai.list_models(provider=provider)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not list models: {exc}") from exc


@app.post("/api/ai/test")
def ai_test():
    try:
        return ai.test()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@app.post("/api/ai/describe")
def ai_describe(files: list[UploadFile] = File(...), prompt: str = Form("")):
    images = [f.file.read() for f in files]
    try:
        return ai.describe_images(images, prompt)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


async def _save_uploads(ctx, files: list[UploadFile], sub: str = "uploads") -> None:
    up = ctx.dir / sub
    up.mkdir(exist_ok=True)
    for f in files:
        name = Path(f.filename or "file").name
        with open(up / name, "wb") as out:
            while chunk := await f.read(1 << 20):
                out.write(chunk)


@app.post("/api/jobs/photo3d")
async def create_photo3d_job(files: list[UploadFile] = File(...), title: str = Form("Photo → 3D"),
                             max_depth: float = Form(0.0), detail: int = Form(320)):
    job, ctx = manager.create("photo3d", title, {"max_depth": max_depth, "detail": detail, "files": [f.filename for f in files]})
    await _save_uploads(ctx, files)
    manager.start(ctx, run.photo3d_job)
    return job.public()


def _origin(lat: float | None, lon: float | None):
    return [lat, lon] if lat is not None and lon is not None else None


@app.post("/api/jobs/pointcloud")
async def create_pointcloud_job(files: list[UploadFile] = File(...), epsg: int = Form(0), max_points: int = Form(3_000_000),
                                origin_lat: float | None = Form(None), origin_lon: float | None = Form(None),
                                make: str = Form("points"), keep_points: bool = Form(False),
                                cell_m: float | None = Form(None), min_building_m2: float = Form(15)):
    if make not in ("points", "map", "objects", "both"):
        raise HTTPException(400, "make must be points, map, objects or both")
    what = {"points": "points", "map": "map", "objects": "objects", "both": "map + objects"}[make]
    job, ctx = manager.create("pointcloud", f"LiDAR {what} · {files[0].filename}",
                              {"epsg": epsg, "max_points": max_points, "origin": _origin(origin_lat, origin_lon),
                               "make": make, "keep_points": keep_points, "cell_m": cell_m,
                               "min_building_m2": min_building_m2})
    await _save_uploads(ctx, files, "clouds")
    manager.start(ctx, run.pointcloud_job)
    return job.public()


class OsmQuery(BaseModel):
    query: str = Field(..., max_length=20000)


@app.post("/api/osm")
def osm_query(req: OsmQuery):
    import osm_proxy

    if not req.query.lstrip().startswith("[out:json]"):
        raise HTTPException(400, "Overpass JSON queries only")
    try:
        return osm_proxy.query(req.query)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc


@app.get("/api/lidar/sources")
def lidar_sources():
    from pipeline import lidar

    return lidar.GREEK_SOURCES


@app.post("/api/jobs/{job_id}/lidar")
async def create_lidar_job(job_id: str, files: list[UploadFile] = File(...), retrain: bool = Form(True),
                           epsg: int = Form(2100), origin_lat: float | None = Form(None), origin_lon: float | None = Form(None)):
    parent = _job(job_id)
    if not (Path(parent.dir) / "dataset" / "sparse").exists():
        raise HTTPException(400, "That job has no reconstruction to align yet.")
    origin = _origin(origin_lat, origin_lon) or (parent.params.get("route") or [None])[0]
    job, ctx = manager.create("lidar", f"LiDAR align · {parent.title}", {"parent": job_id, "retrain": retrain, "epsg": epsg,
                                                                        "origin": origin,
                                                                        "quality": parent.params.get("quality", "standard")})
    await _save_uploads(ctx, files, "clouds")
    manager.start(ctx, lambda c: run.lidar_job(c, Path(parent.dir)))
    return job.public()


@app.post("/api/jobs/media")
async def create_media_job(
    files: list[UploadFile] = File(...),
    title: str = Form("Capture"),
    mode: str = Form("prop"),  # prop | track
    camera: str = Form("auto"),  # auto | perspective | equirect
    quality: str = Form("standard"),
    output: str = Form("both"),  # mesh | splat | both
    frames: int = Form(180),
    mask_moving: bool = Form(True),
    mask_nadir: bool = Form(True),
):
    params = dict(mode=mode, camera=camera, quality=quality, output=output, frames=frames,
                  mask_moving=mask_moving, mask_nadir=mask_nadir, files=[f.filename for f in files])
    job, ctx = manager.create("media", title, params)
    await _save_uploads(ctx, files)
    manager.start(ctx, run.media_job)
    return job.public()


class StreetViewRequest(BaseModel):
    title: str = "Street View route"
    route: list[list[float]] = Field(..., description="[[lat, lon], ...]")
    source: str = "panorama"  # panorama | static
    step_m: float = 8.0
    zoom: int = 4
    min_year: int = 0
    split_views: bool = True  # SfM on perspective views (more robust for Street View)
    reconstruct: bool = True
    quality: str = "standard"
    output: str = "both"
    mask_moving: bool = True
    nadir_mask: float = Field(0.3, ge=0, le=0.6, description="Fraction of the panorama's bottom to ignore (car / blur)")
    mode: str = "track"
    target: str = "track"  # track | props (split by OSM buildings in the editor)


@app.post("/api/jobs/streetview")
def create_streetview_job(req: StreetViewRequest):
    if len(req.route) < 2:
        raise HTTPException(400, "The route needs at least two points.")
    length = geo.route_length([tuple(p) for p in req.route])
    if length / max(req.step_m, 1) > 3000:
        raise HTTPException(400, f"Route is {length / 1000:.1f} km - too many samples. Increase the step or split the route.")
    job, ctx = manager.create("streetview", req.title, req.model_dump())
    manager.start(ctx, run.streetview_job)
    return job.public()


@app.post("/api/kml/parse")
async def parse_kml(file: UploadFile = File(...)):
    try:
        pts = geo.parse_kml(await file.read())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Invalid KML: {exc}") from exc
    return {"route": pts, "length_m": geo.route_length(pts) if len(pts) > 1 else 0}


@app.get("/api/jobs")
def list_jobs():
    return manager.list()


def _job(job_id: str):
    job = manager.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "No such job")
    return job


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, log: int = 300):
    return _job(job_id).public(log_tail=log)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    _job(job_id)
    manager.cancel(job_id)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/rerun")
def rerun_job(job_id: str):
    job = _job(job_id)
    if job.status in ("running", "queued"):
        raise HTTPException(409, "Job is still running")
    from jobs import JobContext

    ctx = JobContext(manager, job)
    manager.contexts[job_id] = ctx
    job.status, job.error, job.progress = "queued", "", 0.0
    ctx.log("---- re-run ----")
    if job.kind == "lidar":
        parent_dir = Path(manager.jobs[job.params["parent"]].dir)
        manager.start(ctx, lambda c: run.lidar_job(c, parent_dir))
    else:
        manager.start(ctx, PIPELINES[job.kind])
    return job.public()


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    job = _job(job_id)
    if job.status in ("running", "queued"):
        raise HTTPException(409, "Cancel the job before deleting it.")
    manager.delete(job_id)
    return {"ok": True}


@app.get("/api/jobs/{job_id}/files/{path:path}")
def job_file(job_id: str, path: str):
    job = _job(job_id)
    base = Path(job.dir).resolve()
    target = (base / path).resolve()
    if base not in target.parents and target != base:
        raise HTTPException(403, "Outside job folder")
    if not target.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(target)


@app.get("/api/jobs/{job_id}/log", response_class=PlainTextResponse)
def job_log(job_id: str):
    return "\n".join(_job(job_id).log)


@app.get("/api/jobs/{job_id}/streetview")
def job_streetview(job_id: str):
    job = _job(job_id)
    f = Path(job.dir) / "streetview.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else []
