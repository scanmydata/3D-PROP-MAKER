import * as THREE from 'three';
import { makeProjector } from './geo.js';

/**
 * One shared map frame for the whole scene: local ENU meters (x = east, y = up, z = south)
 * around a lat/lon origin. The first geo-aware thing added (track, OSM, LiDAR, a georeferenced
 * reconstruction) fixes the origin; later ones are shifted into it so they all line up.
 */
export function sceneOrigin(editor) {
  if (editor.geoOrigin) return editor.geoOrigin;
  const o = editor.find((obj) => Array.isArray(obj.userData?.geo?.origin));
  if (o) editor.geoOrigin = o.userData.geo.origin;
  return editor.geoOrigin || null;
}

export function ensureOrigin(editor, fallback) {
  return sceneOrigin(editor) || (editor.geoOrigin = fallback);
}

/** Offset (in the scene frame) of a point given in another origin's frame. */
export function originOffset(editor, otherOrigin) {
  const origin = sceneOrigin(editor);
  if (!origin || !otherOrigin) return new THREE.Vector3();
  const p = makeProjector(origin)(otherOrigin, 0);
  return new THREE.Vector3(p.x, 0, p.z);
}

/** Matrix taking a backend georef's local coordinates into the scene's map frame. */
export function georefMatrix(editor, georef, frame = 'world') {
  ensureOrigin(editor, georef.origin);
  // Splats / meshes are in Spirula's training frame; sparse points and scans in the dataset frame.
  const m = new THREE.Matrix4().fromArray(frame === 'train' && georef.matrix_train ? georef.matrix_train : georef.matrix);
  const shift = originOffset(editor, georef.origin);
  return m.premultiply(new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z));
}

/** Apply a backend georef ({origin, matrix}) to a loaded object, in the scene's frame. */
export function applyGeoref(editor, object, georef, frame = 'world') {
  if (!georef?.matrix) return false;
  georefMatrix(editor, georef, frame).decompose(object.position, object.quaternion, object.scale);
  object.userData.geo = { origin: sceneOrigin(editor), georeferenced: true, fit_error_m: georef.rmse_m };
  return true;
}
