"""Job pipelines: media -> 3D, Street View route -> 3D, single photo -> relief, LiDAR alignment."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import config

from . import colmap, geo, georef, lidar, lidar_model, masks, media, photo3d, spirula, streetview


def _require_spirula() -> str:
    bin_ = config.spirula_path()
    if not bin_:
        raise RuntimeError("Spirula Studio executable not configured (see Settings).")
    return bin_


def _reconstruct(ctx, images_dir: Path, image_list: list[Path], equirect: bool, data_type: str, quality: str,
                 steps: int | None, mask_dir: Path | None, want_mesh: bool, want_splat: bool,
                 camera_model: str | None = None, origin=None, camera_height: float = 1.6) -> None:
    cfg = config.load()
    bin_ = config.spirula_path(cfg)
    if not bin_:
        ctx.log("Spirula Studio was not found, so the images are prepared but not reconstructed.")
        ctx.log("Install it (Settings -> Spirula path) and press 'Re-run' on this job, or open the")
        ctx.log(f"prepared dataset folder in Spirula Studio / RealityScan: {images_dir}")
        raise RuntimeError("Spirula Studio executable not configured (see Settings).")

    sfm_q, default_steps, tex = spirula.QUALITY_PRESETS.get(quality, spirula.QUALITY_PRESETS["standard"])
    workspace = ctx.dir / "dataset"
    ds_images = workspace / "images"
    # A re-run starts from a clean reconstruction (old images / models would otherwise mix in).
    for stale in (workspace / "sparse", workspace / "progress", ctx.dir / "train", ctx.dir / "mesh"):
        shutil.rmtree(stale, ignore_errors=True)
    if ds_images.resolve() != images_dir.resolve():
        shutil.rmtree(ds_images, ignore_errors=True)
        ds_images.mkdir(parents=True, exist_ok=True)
        for p in image_list:
            dst = ds_images / p.name
            if not dst.exists():
                try:
                    dst.hardlink_to(p)
                except Exception:  # noqa: BLE001
                    shutil.copy2(p, dst)
    ds_masks = None
    if mask_dir and any(mask_dir.iterdir()):
        ds_masks = workspace / "masks"
        if ds_masks.resolve() != mask_dir.resolve():
            shutil.copytree(mask_dir, ds_masks, dirs_exist_ok=True)

    ctx.stage("Structure from Motion (Spirula)", 0.40)
    model = camera_model or ("equirectangular" if equirect else "opencv")
    extra = list(cfg.get("spirula_sfm_args", []))
    if model == "pinhole":
        extra = ["--camera-mode", "single"] + extra  # synthetic views cut from panoramas share one intrinsic
    sparse = spirula.sfm(bin_, ds_images, workspace, ctx, model, data_type, sfm_q, ds_masks, extra)
    n = colmap.sparse_to_ply(sparse, ctx.dir / "sparse_points.ply")
    ctx.output(f"Sparse point cloud ({n} pts)", ctx.dir / "sparse_points.ply", "pointcloud")
    # GPS-tagged images (Street View, most phones) let us place the model on the map automatically.
    if georef.georeference(sparse, ds_images, ctx.dir / "georef.json", ctx, origin, camera_height):
        ctx.output("Map placement (GPS)", ctx.dir / "georef.json", "georef")

    if not (want_mesh or want_splat):
        return
    ctx.stage("Training Gaussian Splat (Spirula)", 0.55)
    run_dir = spirula.train(bin_, workspace, ctx.dir / "train", ctx, steps or default_steps, cfg.get("spirula_train_args", []))
    georef.add_train_frame(ctx.dir / "georef.json", run_dir)
    splat = spirula.latest_splat(run_dir)
    if splat:
        dst = ctx.dir / "splat.ply"
        shutil.copy2(splat, dst)
        ctx.output("Gaussian splat", dst, "splat")

    if want_mesh:
        ctx.stage("Extracting textured mesh (Spirula)", 0.88)
        for p in spirula.mesh(bin_, run_dir, ctx.dir / "mesh", ctx, tex, cfg.get("spirula_mesh_args", [])):
            ctx.output(f"Mesh ({p.suffix[1:].upper()})", p, "mesh")


def media_job(ctx) -> None:
    p = ctx.job.params
    uploads = sorted((ctx.dir / "uploads").iterdir())
    ctx.stage("Preparing images", 0.0)
    images_dir = ctx.dir / "dataset" / "images"
    image_list, auto_equirect = media.collect_images(uploads, images_dir, ctx, int(p.get("frames", 180)))
    camera = p.get("camera", "auto")
    equirect = auto_equirect if camera == "auto" else camera == "equirect"
    has_video = any(media.is_video(u) for u in uploads)
    ctx.log(f"{len(image_list)} images, {'360° equirectangular' if equirect else 'perspective'} camera")
    if len(image_list) < 3:
        raise RuntimeError("Need at least 3 overlapping images (or a video) to reconstruct 3D.")
    ctx.progress(0.2)

    mask_dir = ctx.dir / "dataset" / "masks"
    if p.get("mask_moving") or (equirect and p.get("mask_nadir", True)):
        ctx.stage("Masking", 0.25)
        masks.make_masks(image_list, mask_dir, ctx, nadir_fraction=0.12 if equirect and p.get("mask_nadir", True) else 0.0,
                         use_yolo=bool(p.get("mask_moving")))

    data_type = "video" if has_video else "individual"
    _reconstruct(ctx, images_dir, image_list, equirect, data_type, p.get("quality", "standard"), p.get("steps"),
                 mask_dir if mask_dir.exists() else None, p.get("output") in ("mesh", "both"), True)


def streetview_job(ctx) -> None:
    p = ctx.job.params
    route = [tuple(pt) for pt in p["route"]]
    (ctx.dir / "route.kml").write_text(geo.to_kml(route, ctx.job.title), encoding="utf-8")
    (ctx.dir / "route.json").write_text(json.dumps({"route": route}), encoding="utf-8")
    ctx.output("Route (KML)", ctx.dir / "route.kml", "route")

    source = p.get("source", "panorama")
    step = float(p.get("step_m", 8))
    ctx.stage(f"Downloading Street View ({source})", 0.02)
    raw = ctx.dir / "streetview"
    if source == "static":
        metas = streetview.fetch_static_views(route, raw, ctx, config.load().get("google_api_key", ""), step)
        equirect = False
    else:
        metas = streetview.fetch_panoramas(route, raw, ctx, step, int(p.get("zoom", 4)), int(p.get("min_year", 0) or 0))
        equirect = True
    (ctx.dir / "streetview.json").write_text(json.dumps(metas), encoding="utf-8")
    ctx.output(f"Street View images ({len(metas)})", ctx.dir / "streetview.json", "streetview")

    images = [raw / m["file"] for m in metas]
    camera_model = None
    if equirect and p.get("split_views", True):
        # Perspective cut-outs, as in the original extractor. Street View panoramas are ~10 m apart
        # with a blurred lower half; in testing SfM registered about twice as many images from 8
        # pinhole views per panorama (looking slightly up, away from the blur) as from the
        # equirectangular originals. The views also open directly in RealityScan / Metashape.
        heading = {m["file"]: m["heading"] for m in metas}
        ctx.stage("Splitting panoramas into perspective views", 0.35)
        images = media.split_equirect_folder(images, ctx.dir / "views", ctx, yaws=tuple(range(0, 360, 45)), pitch=5.0,
                                             fov=90.0, size=1200, heading_of=lambda f: heading[f.name])
        camera_model = "pinhole"
        for img in images:
            m = next(mm for mm in metas if img.name.startswith(Path(mm["file"]).stem))
            geo.write_exif_gps(img, m["lat"], m["lon"])
        equirect = False

    if p.get("reconstruct", True):
        mask_dir = ctx.dir / "dataset" / "masks"
        nadir = float(p.get("nadir_mask", 0.3)) if equirect else 0.0
        if nadir > 0 or p.get("mask_moving"):
            ctx.stage("Masking", 0.37)
            masks.make_masks(images, mask_dir, ctx, nadir_fraction=nadir,
                             use_yolo=bool(p.get("mask_moving")))
        _reconstruct(ctx, images[0].parent, images, equirect, "individual" if camera_model else "video",
                     p.get("quality", "standard"), p.get("steps"), mask_dir if mask_dir.exists() else None,
                     p.get("output", "both") in ("mesh", "both"), True, camera_model,
                     origin=route[0], camera_height=2.5)


def photo3d_job(ctx) -> None:
    """Each photo -> metric depth (MoGe via Spirula) -> textured relief GLB."""
    bin_ = _require_spirula()
    p = ctx.job.params
    photos = [f for f in sorted((ctx.dir / "uploads").iterdir()) if media.is_image(f)]
    if not photos:
        raise RuntimeError("Upload at least one photo (JPG/PNG).")
    for i, img in enumerate(photos):
        ctx.check()
        ctx.stage(f"Depth from photo {i + 1}/{len(photos)}", i / len(photos))
        out = photo3d.photo_to_relief(bin_, img, ctx.dir, ctx, float(p.get("max_depth") or 0), int(p.get("detail") or 320))
        ctx.output(f"3D from {img.name}", out, "mesh")


def pointcloud_job(ctx) -> None:
    """LiDAR scan (LAS/LAZ/PLY) -> any of: terrain map (GLB), buildings + trees (JSON -> props),
    the thinned point cloud (PLY). All share the job's georef (placement on the map)."""
    p = ctx.job.params
    clouds = sorted((ctx.dir / "clouds").iterdir())
    origin = tuple(p["origin"]) if p.get("origin") else None
    make = p.get("make", "points")  # points | map | objects | both
    want_map, want_obj = make in ("map", "both"), make in ("objects", "both")
    keep_points = make == "points" or bool(p.get("keep_points"))
    max_points = int(p.get("max_points", 3_000_000))
    read_cap = max(max_points, 12_000_000) if (want_map or want_obj) else max_points
    if len(clouds) > 1 and (want_map or want_obj):
        ctx.log("Several files: each becomes its own terrain / object set; they line up on the map.")
    info = None
    for n, src in enumerate(clouds):
        span = (n / len(clouds), (n + 1) / len(clouds))
        at = lambda f: span[0] + (span[1] - span[0]) * f  # noqa: E731
        ctx.stage(f"Reading {src.name}", at(0.0))
        # every file of the job shares the first file's shift + origin, so one georef places them all
        scan = lidar.load_local(src, int(p.get("epsg") or 0), origin, read_cap, ctx,
                                offset=info["offset"] if info else None)
        info = scan["info"]
        origin = tuple(info["origin"])
        stem = src.stem
        if want_map or want_obj:
            ctx.stage(f"Finding the ground in {src.name}", at(0.3))
            gm = lidar_model.ground_model(scan, lidar_model.auto_cell(scan, p.get("cell_m")), ctx)
            if want_map:
                ctx.stage(f"Building the terrain map from {src.name}", at(0.5))
                lidar_model.terrain(scan, gm, ctx.dir / f"{stem}_terrain.glb", ctx)
                ctx.output(f"Terrain map {src.name}", ctx.dir / f"{stem}_terrain.glb", "mesh")
            if want_obj:
                ctx.stage(f"Extracting buildings and trees from {src.name}", at(0.7))
                lidar_model.objects(scan, gm, ctx.dir / f"{stem}_objects.json", ctx,
                                    min_building_m2=float(p.get("min_building_m2", 15)))
                ctx.output(f"Buildings & trees {src.name}", ctx.dir / f"{stem}_objects.json", "objects")
        if keep_points:
            ctx.stage(f"Writing points of {src.name}", at(0.9))
            lidar.write_points(scan, ctx.dir / f"{stem}_local.ply", max_points)
            ctx.output(f"Point cloud {src.name}", ctx.dir / f"{stem}_local.ply", "pointcloud")
        lidar.save_info(info, ctx.dir / f"{stem}_local.json")
        del scan
    (ctx.dir / "georef.json").write_text(json.dumps(info), encoding="utf-8")
    ctx.output("Map placement (CRS)", ctx.dir / "georef.json", "georef")


def lidar_job(ctx, parent_dir: Path) -> None:
    """Align a finished reconstruction to a laser scan with `spirula lidar`, then retrain + mesh."""
    bin_ = _require_spirula()
    p = ctx.job.params
    dataset = parent_dir / "dataset"
    clouds = []
    epsg = int(p.get("epsg", 2100))
    info = None
    for src in sorted((ctx.dir / "clouds").iterdir()):
        if src.suffix.lower() == ".e57":
            clouds.append(src)  # Spirula reads E57 directly
            continue
        ctx.stage(f"Preparing {src.name}", 0.05)
        out = ctx.dir / f"{src.stem}_local.ply"
        info = lidar.to_local(src, out, epsg, tuple(p["origin"]) if p.get("origin") else None, 5_000_000, ctx)
        clouds.append(out)
    if not clouds:
        raise RuntimeError("Upload a scan: LAS, LAZ, PLY or E57.")
    ctx.stage("Aligning reconstruction to the scan (Spirula lidar)", 0.15)
    cmd = [bin_, "lidar", str(dataset)]
    for c in clouds:
        cmd += ["--cloud", str(c)]
    spirula.run(cmd, ctx, (0.15, 0.35))
    if info:
        (ctx.dir / "georef.json").write_text(json.dumps(info), encoding="utf-8")
        ctx.output("Map placement (CRS)", ctx.dir / "georef.json", "georef")
    sparse = next(iter(sorted(dataset.glob("sparse/*/points3D.*"))), None)
    if sparse:
        n = colmap.sparse_to_ply(sparse.parent, ctx.dir / "aligned_points.ply")
        ctx.output(f"Aligned points ({n})", ctx.dir / "aligned_points.ply", "pointcloud")
    if not p.get("retrain", True):
        return
    sfm_q, steps, tex = spirula.QUALITY_PRESETS.get(p.get("quality", "standard"), spirula.QUALITY_PRESETS["standard"])
    cfg = config.load()
    ctx.stage("Training Gaussian Splat with LiDAR depth (Spirula)", 0.35)
    run_dir = spirula.train(bin_, dataset, ctx.dir / "train", ctx, steps, cfg.get("spirula_train_args", []))
    georef.add_train_frame(ctx.dir / "georef.json", run_dir)
    splat = spirula.latest_splat(run_dir)
    if splat:
        shutil.copy2(splat, ctx.dir / "splat.ply")
        ctx.output("Gaussian splat (LiDAR-aligned)", ctx.dir / "splat.ply", "splat")
    ctx.stage("Extracting textured mesh (Spirula)", 0.88)
    for m in spirula.mesh(bin_, run_dir, ctx.dir / "mesh", ctx, tex, cfg.get("spirula_mesh_args", [])):
        ctx.output("Mesh (LiDAR-aligned)", m, "mesh")
