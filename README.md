# Track & Props Studio

Photos, video (normal or 360°) or Google Street View → **3D race tracks and props**, edited in a
three.js editor in the browser (similar to [threejs.org/editor](https://threejs.org/editor/)) and exported as GLB/OBJ.

It brings together three projects:

| From | What it does here |
|---|---|
| **This repo (Track Props Generator)** | Procedural props (PVC banner, cones, tire wall, Armco, kerbs), now inside a full editor |
| **[360-street-view-extractor](https://github.com/douradonis/360-street-view-extractor)** | KML route → sample every N m → download 360° Street View panoramas → GPS EXIF → masks → perspective views (`server/pipeline/streetview.py`, `media.py`, `masks.py`) |
| **[Spirula Studio](https://github.com/harry7557558/spirula-studio)** | The 3D engine: SfM → Gaussian splat → textured mesh, with native 360° (equirectangular) camera support. Called as an external program (`server/pipeline/spirula.py`) |

**User manual (Greek):** [docs/MANUAL.md](docs/MANUAL.md) — also inside the app (the **?** button).

## What you can do

- **Start tab → ⚡ Everything for my route**: pick *Map / track* or *Objects / props*, press one button and the app
  uses every free source for the route at once (OpenStreetMap, road with real elevation, Street View → 3D, an
  optional LiDAR file), all in one map frame. Or answer two questions (what / from what) to use a single source.
- **Search with suggestions** (streets, places, addresses) as you type; the route and map view survive reloads.

- **Capture tab**: drop photos or videos (phone, drone, or 360° camera). Frames are picked from videos
  (sharpest frame per time slice), 360° images are detected automatically (2:1), and Spirula builds a
  textured mesh + Gaussian splat. The result opens in the editor when it's done.
- **Route & Street View tab**:
  - Draw a route like in Google Maps: click waypoints and it follows roads (OSRM), or use straight lines; search places; satellite or street map.
  - Or **import a KML** (Google Maps / My Maps / Google Earth). Export the route as KML.
  - **A · Procedural 3D track** (instant, no GPU): asphalt with markings, red/white kerbs on corners,
    run-off grass, Armco or concrete wall, start/finish line, real terrain elevation (Open-Meteo DEM).
  - **B · Street View → real 3D**: downloads 360° panoramas along the route (with GPS EXIF so Spirula
    gets metric scale), masks the car/blur at the bottom, optionally cuts perspective views
    for RealityScan/Metashape, then reconstructs with Spirula.
- **Capture → 1 photo → 3D**: monocular metric depth (MoGe, built into Spirula `geometry`) turns a single photo
  into a textured 3D relief (GLB) of what the camera saw. Runs locally on the GPU.
- **Capture → AI describe**: a vision LLM describes the photo(s) (in Greek or English), lists the objects with
  estimated real sizes, and builds matching procedural props (tyre walls, banners, kerbs, armco, tents, grandstands…).
- **Map data tab**:
  - **OpenStreetMap** around the route → buildings (real heights when tagged), trees, street lamps/signals,
    walls/fences/guard rails, roads — each building a separate, named prop.
  - **LiDAR → map / objects** (LAS, LAZ, PLY): bare-earth terrain mesh and/or every building (outline + roof
    height) and tree as a separate object. CPU only; coordinate system and units (m / ft) read from the file.
    OSM downloads go through the backend (disk cache, retries, mirrors).
- **Street View → "Separate props"**: the reconstructed street is cut into one object per OSM building.
- **Automatic map placement**: reconstructions from GPS-tagged images (Street View, most phones) are fitted to
  the GPS (similarity fit on the camera positions), so scans, the procedural track, OSM and LiDAR line up.
- **Align with LiDAR** (Jobs tab): `spirula lidar` snaps a reconstruction onto a laser scan, then retrains.
- **Props tab**: real-scale props; the PVC banner keeps its wrinkle presets and artwork upload.
- **Textures**: drop a whole PBR texture set (or its .zip) on an object; maps are sorted by file name
  (color, normal, roughness, metalness, AO, height, emissive, opacity, packed ARM). PNG/JPG/TGA/DDS.
  *Fit UVs (m)* gives buildings and walls real-scale tiling.
- **Export for game / sim**: OBJ+MTL or GLB plus all textures as **DDS** (DXT1/DXT5/RGBA, mipmaps) in one .zip.
- **Jobs tab**: progress, logs, cancel / re-run, load outputs into the scene, download files.
- **Editor**: select (click; click again for the exact part), gizmo move/rotate/scale (W/E/R, Q local/world),
  outliner, inspector (transform, material, texture), undo/redo, duplicate, primitives and lights,
  import GLB/GLTF/OBJ/FBX/STL/PLY/splat (drag & drop), export GLB/OBJ, save/open project.
  Clean-up tools for scans: crop box (keep/remove inside), simplify (meshoptimizer), level to ground,
  Z-up → Y-up, pivot to bottom, drop to ground.

## Install (Windows)

Needs **Node.js 20+** and **Python 3.10+**.

```bash
npm install
```

```bash
npm run setup
```

```bash
npm start
```

Open <http://localhost:5173>. `npm start` runs both the Python backend (port 8765) and the web app.

### Spirula Studio (for photo/video/Street View → 3D)

1. Download the build for your OS from <https://github.com/harry7557558/spirula-studio/releases> and unzip it.
2. In the app click **⚙ Settings** and paste the path to `spirula.exe` (or put it in `tools/spirula/`, or on `PATH`).

It runs on NVIDIA, AMD, Intel and Apple GPUs (Vulkan). Without it, the procedural track, props and the
editor still work, and Street View / capture jobs stop after preparing the images, so you can open the
`workspace/jobs/<id>/dataset` (or `views`) folder in another tool, or press **Re-run** once Spirula is set.

Extra Spirula flags can be added in `server/config.json` (`spirula_sfm_args`, `spirula_train_args`, `spirula_mesh_args`).

### AI assistant (optional)

Settings → AI assistant. Any OpenAI-compatible server works:

- **OpenRouter** (cloud): create a free account and key at openrouter.ai; the app lists only the free models and
  prefers ones that understand images (👁), falling back to the next free model when one is rate-limited.
- **LM Studio** (local, recommended for this kind of PC): install a vision model, start the server
  (Developer → Start server, port 1234), pick "LM Studio".
  - 16 GB RAM / integrated GPU: **Qwen3-VL 4B** (Q4_K_M, ~3.3 GB) — leaves memory for Spirula.
  - If the LLM runs only when nothing is reconstructing: **Gemma 4 E4B** (~5–7 GB), stronger.
- **Ollama** / **Strata** / other: pick the provider and set its URL. (Strata needs a discrete GPU.)

With a local model, Settings → Resources → "Local AI while reconstructing: wait" queues AI requests until the
GPU is free, so the LLM and Spirula don't fight over the same memory.

### Resources

Settings → Resources: which GPU Spirula uses (choose an external / second GPU by name), how many reconstructions
run at once (queued on one GPU), process priority (below normal / idle keeps the PC usable), CPU threads,
image sizes and splat budget (less RAM/VRAM). Presets: Balanced, "PC + local AI side by side", Max speed,
Low memory.

### LiDAR data for Greece

No open nationwide airborne LiDAR for mainland Greece was found (Nov 2026). Free options: site datasets on
OpenTopography (e.g. Santorini 2012, Corinth Canal point clouds), the 30 m Copernicus DEM, and your own phone/tablet
LiDAR scans (Polycam, Scaniverse… exported as LAS/PLY/E57).

### Optional

- AI masking of cars/people is installed by `npm run setup` (ultralytics YOLO11, CPU).
- Official Street View Static API source: put a Google Maps API key in Settings.

## Notes

- **Street View.** Google turned off the old search endpoint that the `streetview` Python package
  used (so the original 360-street-view-extractor scripts no longer find panoramas). This app uses its own small client
  (`server/pipeline/gsv.py`) for the endpoint Google Maps uses today. It's undocumented and can change; using the imagery
  is subject to Google's terms. The *Official Static API* source is the documented alternative (640 px views, needs a key).
- **Coordinates.** Procedural tracks are in meters around the first route point (x = east, y = up, z = south).
  Reconstructions are in Spirula's frame (metric when GPS is available); align them with the gizmo and *Level to ground*.
- Job data lives in `workspace/` (ignored by git).

## Layout

```
server/                FastAPI backend (Python)
  app.py               REST API: jobs, settings, KML
  jobs.py              background jobs, logs, progress
  ai.py                vision LLM client (OpenRouter free models / LM Studio / Ollama / Strata)
  resources.py         GPU queue, process priority, hardware info
  pipeline/            media.py (frames, 360), streetview.py + gsv.py, masks.py, spirula.py, colmap.py,
                       photo3d.py (1 photo → relief), georef.py (GPS placement), lidar.py, run.py
src/
  editor/              Editor (undo), Viewport, Outliner, Inspector, Menubar, loaders, ops, io, splats
  panels/              Capture, Route & Street View (Leaflet map), Map data (OSM, LiDAR), Props, Jobs, Settings
  track/               geo.js (KML, ENU, OSRM, elevation), trackBuilder.js
  generators/          banner.js, props.js, textures.js
scripts/               setup / start / run-server
```
