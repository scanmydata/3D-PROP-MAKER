import * as THREE from 'three';
export function createCamera(container) { const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.01, 100); camera.position.set(0, 0.25, 3.2); return camera; }
