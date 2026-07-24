# Track Props Generator

A production-oriented procedural Three.js web application for generating racing simulator track props at real-world meter scale.

## Current generator

- **Banners → PVC Banner**
  - 2.0 m × 1.30 m × 0.002 m dimensions
  - 120 × 80 vertex subdivisions
  - Procedural geometry wrinkles using seeded gradient noise, edge folding, gravity sag, wind deformation, and wrinkle clusters
  - Front-only uploaded PNG/JPG artwork
  - White PVC back material
  - GLB export with geometry, UVs, materials, textures, normals, and transforms

## Start locally

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal.

## Production build

```bash
npm run build
```

## Use

1. Select **Banners → PVC Banner** from the object library.
2. Adjust wrinkle, sag, wind, and seed sliders.
3. Click **Generate** or **Randomize** for a new mesh variation.
4. Upload a PNG/JPG if you want front-side advertising artwork.
5. Click **Export GLB** to download the generated asset.

## Notes

The code is modular so future generators such as Tire Wall, Armco Barrier, Cone, Flag, Tent, Tree, and Pit Building can be added under `src/generators` and wired into the object library.
