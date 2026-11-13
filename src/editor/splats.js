import * as THREE from 'three';

/**
 * Gaussian splats in the editor scene. Uses @mkkellogg/gaussian-splats-3d (DropInViewer) when it
 * works with the installed three.js; otherwise the splat is shown as a coloured point cloud
 * (positions + SH DC colour), which is still fine for aligning and cropping.
 */
export async function loadSplat(url, filename, ext, buffer = null) {
  try {
    const GS = await import('@mkkellogg/gaussian-splats-3d');
    const viewer = new GS.DropInViewer({ gpuAcceleratedSort: false, sharedMemoryForWorkers: false, dynamicScene: true, showLoadingUI: false });
    const format = { ply: GS.SceneFormat.Ply, splat: GS.SceneFormat.Splat, ksplat: GS.SceneFormat.KSplat, spz: GS.SceneFormat.Spz }[ext];
    await viewer.addSplatScene(url, { format, splatAlphaRemovalThreshold: 5, showLoadingUI: false, progressiveLoad: false });
    viewer.name = filename.replace(/\.[^.]+$/, '');
    viewer.userData = { isSplat: true, source: url, format: ext };
    return viewer;
  } catch (err) {
    console.warn('Gaussian splat renderer unavailable, falling back to points:', err);
    if (ext !== 'ply') throw new Error(`Cannot display .${ext} splats: ${err.message}`);
    const { plyToObject } = await import('./loaders.js');
    const buf = buffer || await (await fetch(url)).arrayBuffer();
    const header = new TextDecoder().decode(buf.slice(0, 4096));
    const obj = plyToObject(buf, header);
    obj.name = `${filename.replace(/\.[^.]+$/, '')} (splat points)`;
    obj.userData.source = url;
    return obj;
  }
}

export function isSplat(o) { return !!o?.userData?.isSplat; }

export function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose?.();
    const mats = Array.isArray(child.material) ? child.material : [child.material].filter(Boolean);
    mats.forEach((m) => { Object.values(m).forEach((v) => v?.isTexture && v.dispose()); m.dispose(); });
  });
  object.dispose?.();
}

export const _three = THREE;
