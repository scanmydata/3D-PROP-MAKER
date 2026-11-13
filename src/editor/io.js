import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { loadModel } from './loaders.js';

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function exportable(objects) {
  // Splat viewers and crop boxes are editor-only and cannot go into GLB.
  return objects.filter((o) => !o.userData.isSplat && !o.userData.cropBox);
}

export function exportGLB(objects, filename) {
  const list = exportable(Array.isArray(objects) ? objects : [objects]);
  if (!list.length) throw new Error('Nothing exportable (splats are exported from the job outputs as .ply).');
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(list, (result) => {
      download(new Blob([result], { type: 'model/gltf-binary' }), filename);
      resolve();
    }, reject, { binary: true, embedImages: true, onlyVisible: true, trs: true, maxTextureSize: 8192 });
  });
}

export function exportOBJ(objects, filename) {
  const group = new THREE.Group();
  exportable(Array.isArray(objects) ? objects : [objects]).forEach((o) => group.add(o.clone()));
  download(new Blob([new OBJExporter().parse(group)], { type: 'text/plain' }), filename);
}

/** Project file = editable objects as three.js JSON + references to splats by URL. */
export function saveProject(editor) {
  const objects = [];
  const splats = [];
  editor.scene.children.forEach((o) => {
    if (o.userData.isSplat) {
      splats.push({ name: o.name, url: o.userData.source, format: o.userData.format, matrix: o.matrix.toArray() });
    } else objects.push(o.toJSON());
  });
  const cam = editor.viewport.camera;
  const project = {
    app: 'track-props-studio', version: 1,
    objects, splats,
    camera: { position: cam.position.toArray(), target: editor.viewport.orbit.target.toArray() },
  };
  download(new Blob([JSON.stringify(project)], { type: 'application/json' }), 'project.tps.json');
}

export async function loadProject(editor, file) {
  const project = JSON.parse(await file.text());
  if (project.app !== 'track-props-studio') throw new Error('Not a Track & Props Studio project.');
  editor.clear();
  const loader = new THREE.ObjectLoader();
  for (const json of project.objects) {
    const obj = await loader.parseAsync(json);
    editor.scene.add(obj);
  }
  for (const s of project.splats || []) {
    if (!s.url || s.url.startsWith('blob:')) continue;
    try {
      const obj = await loadModel(s.url, { name: `${s.name}.${s.format || 'ply'}`, type: 'splat' });
      new THREE.Matrix4().fromArray(s.matrix).decompose(obj.position, obj.quaternion, obj.scale);
      editor.scene.add(obj);
    } catch (e) { console.warn('splat not reloaded', e); }
  }
  if (project.camera) {
    editor.viewport.camera.position.fromArray(project.camera.position);
    editor.viewport.orbit.target.fromArray(project.camera.target);
  }
  editor.emit('sceneChanged');
}
