import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { loadSplat } from './splats.js';

const SH_C0 = 0.28209479177387814;

export const IMPORT_ACCEPT = '.glb,.gltf,.obj,.ply,.stl,.fbx,.splat,.ksplat,.spz';

/** Load a model from a URL (job output) or a File (user import). Returns an Object3D. */
export async function loadModel(source, { name, type } = {}) {
  const isFile = source instanceof File;
  const filename = isFile ? source.name : name || source.split('?')[0].split('/').pop();
  const ext = filename.split('.').pop().toLowerCase();
  const url = isFile ? URL.createObjectURL(source) : source;
  try {
    if (type === 'splat' || ['splat', 'ksplat', 'spz'].includes(ext)) {
      return await loadSplat(url, filename, ext);
    }
    let object;
    if (ext === 'glb' || ext === 'gltf') {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(url);
      object = gltf.scene;
    } else if (ext === 'obj') {
      object = await new OBJLoader().loadAsync(url);
    } else if (ext === 'fbx') {
      object = await new FBXLoader().loadAsync(url);
    } else if (ext === 'stl') {
      const geo = await new STLLoader().loadAsync(url);
      geo.computeVertexNormals();
      object = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xbfc5cc, roughness: 0.7 }));
    } else if (ext === 'ply') {
      const buffer = await (await fetch(url)).arrayBuffer();
      const header = new TextDecoder().decode(buffer.slice(0, 4096));
      if (/property\s+\w+\s+f_dc_0/.test(header) && type !== 'pointcloud') {
        return await loadSplat(url, filename, 'ply', buffer);
      }
      object = plyToObject(buffer, header);
    } else {
      throw new Error(`Unsupported format .${ext}`);
    }
    object.name = object.name || filename.replace(/\.[^.]+$/, '');
    object.userData.source = isFile ? filename : source;
    object.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return object;
  } finally {
    if (isFile && !['splat', 'ksplat', 'spz', 'ply'].includes(ext)) setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

/** PLY -> Mesh (if it has faces) or coloured Points. Splat PLYs fall back here as coloured points. */
export function plyToObject(buffer, header = '') {
  const loader = new PLYLoader();
  loader.setCustomPropertyNameMapping({ fdc: ['f_dc_0', 'f_dc_1', 'f_dc_2'] });
  const geo = loader.parse(buffer);
  if (!geo.getAttribute('color') && geo.getAttribute('fdc')) {
    const fdc = geo.getAttribute('fdc');
    const col = new Float32Array(fdc.count * 3);
    for (let i = 0; i < fdc.count * 3; i += 1) col[i] = THREE.MathUtils.clamp(0.5 + SH_C0 * fdc.array[i], 0, 1);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.deleteAttribute('fdc');
  }
  const hasColor = !!geo.getAttribute('color');
  const isMesh = geo.index && geo.index.count > 0;
  if (isMesh) {
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: hasColor, color: hasColor ? 0xffffff : 0xbfc5cc, roughness: 0.85 }));
  }
  geo.computeBoundingSphere();
  const r = geo.boundingSphere?.radius || 1;
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: Math.max(0.005, r / 800), vertexColors: hasColor, color: hasColor ? 0xffffff : 0xdddddd, sizeAttenuation: true }));
  pts.userData.pointCloud = true;
  if (header.includes('f_dc_0')) pts.name = 'Splat (point preview)';
  return pts;
}
