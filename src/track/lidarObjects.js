import * as THREE from 'three';
import { makeTree } from './osm.js';

const roofMat = new THREE.MeshStandardMaterial({ color: 0x8a8580, roughness: 0.9, name: 'lidar_roof' });
const wallMat = new THREE.MeshStandardMaterial({ color: 0xd9d2c5, roughness: 0.85, name: 'lidar_wall' });

/**
 * Buildings + trees found in a LiDAR scan (backend lidar_model.objects) -> editor props.
 * `matrix` takes the scan-local coordinates (x east, y north, z up) into the scene frame.
 * Each building is its own mesh with its pivot at the bottom-centre and an OSM-style
 * footprint, so it also works with "Split by buildings" and the texture tools.
 */
export function buildLidarObjects(data, matrix, label = 'LiDAR') {
  const toScene = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(matrix);
  const root = new THREE.Group();
  root.name = `${label} · objects`;
  const bGroup = new THREE.Group(); bGroup.name = `${label} · buildings`;
  const tGroup = new THREE.Group(); tGroup.name = `${label} · trees`;

  for (const b of data.buildings || []) {
    const pts = b.outline.map(([x, y]) => toScene(x, y, b.base));
    const base = pts[0].y;
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    // shape space (east, north) relative to the centroid, like OSM buildings
    let shape = pts.map((p) => new THREE.Vector2(p.x - c.x, -(p.z - c.z)));
    if (THREE.ShapeUtils.isClockWise(shape)) shape = shape.reverse();
    const geo = new THREE.ExtrudeGeometry(new THREE.Shape(shape), { depth: Math.max(1, b.height), bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, [roofMat, wallMat]);
    mesh.position.set(c.x, base, c.z);
    mesh.name = b.name;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData = { lidar: { height_m: b.height, eave_m: b.eave_height, area_m2: b.area_m2 }, footprint: shape.map((p) => [p.x, -p.y]), height: b.height };
    bGroup.add(mesh);
  }
  for (const [k, t] of (data.trees || []).entries()) {
    const tree = makeTree(Math.max(2, t.height));
    const crown = tree.children[1];
    crown.scale.x = crown.scale.z = t.radius; // crown width from the scan
    tree.position.copy(toScene(t.x, t.y, t.base));
    tree.name = `Tree ${k + 1} (${t.height.toFixed(1)} m)`;
    tree.userData = { lidar: { height_m: t.height, crown_radius_m: t.radius } };
    tGroup.add(tree);
  }
  if (bGroup.children.length) root.add(bGroup);
  if (tGroup.children.length) root.add(tGroup);
  return { root, buildings: bGroup.children.length, trees: tGroup.children.length };
}
