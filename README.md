# Track Props Generator

A production-oriented procedural Three.js web application for generating racing simulator track props at real-world meter scale.

## What is included now

- **Banners → PVC Banner**
  - 2.0 m × 1.30 m × 0.002 m dimensions
  - 120 × 80 vertex subdivisions
  - Procedural geometry wrinkles using seeded gradient noise, edge folding, gravity sag, wind deformation, and wrinkle clusters
  - Front-only uploaded PNG/JPG artwork
  - White PVC back material
  - GLB export with geometry, UVs, materials, textures, normals, and transforms

## Easy install / Άμεση εγκατάσταση

### 1. Install Node.js

Install **Node.js 18 or newer** from <https://nodejs.org/>.

Check that it works:

```bash
node -v
npm -v
```

### 2. Install project dependencies

From the project folder run:

```bash
npm install
```

This downloads Vite and the latest Three.js package declared in `package.json`.

### 3. Start the application

```bash
npm run dev
```

Open the local URL shown by Vite, usually:

```text
http://localhost:5173
```

## Production build

```bash
npm run build
```

The optimized files will be generated in `dist/`.

## Simple use guide / Γρήγορη χρήση

1. Open the app with `npm run dev`.
2. In the left **Object Library**, keep **Banners → PVC Banner** selected.
3. In the right panel, click one of the easy presets:
   - **Clean** for a lightly wrinkled banner
   - **Track Used** for a normal used racing-track banner
   - **Stormy** for stronger folds and wind deformation
4. Optional: adjust the sliders under **Fine Tune Wrinkles**.
5. Optional: click the upload box and select a PNG/JPG logo or advertising image.
6. Click **Generate** for the current settings, or **Randomize Seed** for a new variation.
7. Click **Export GLB** to download the model.

## UI layout

- **Left panel:** Object Library, Quick Start, and placeholders for future generators.
- **Center:** Interactive Three.js viewport with OrbitControls.
- **Right panel:** Step-by-step controls: create preset, fine tune, add artwork, export.

## Future generators

The code is modular so future generators such as Tire Wall, Armco Barrier, Cone, Flag, Tent, Tree, and Pit Building can be added under `src/generators` and wired into the object library.
