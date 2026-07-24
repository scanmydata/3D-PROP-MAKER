import * as THREE from 'three';

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0f16);
  scene.fog = new THREE.Fog(0x0a0f16, 6, 18);
  const hemi = new THREE.HemisphereLight(0xbfd7ff, 0x202020, 1.6); scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 3.2); key.position.set(3, 4, 2); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); scene.add(key);
  const fill = new THREE.DirectionalLight(0xffd7aa, 0.8); fill.position.set(-4, 2, -3); scene.add(fill);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: 0x252a2f, roughness: 0.92, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.86; ground.receiveShadow = true; scene.add(ground);
  const grid = new THREE.GridHelper(20, 40, 0xffb020, 0x3d4652); grid.position.y = -0.855; scene.add(grid);
  return scene;
}
