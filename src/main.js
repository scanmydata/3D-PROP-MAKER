import './styles.css';
import { createScene } from './scene.js';
import { createCamera } from './camera.js';
import { createRenderer } from './renderer.js';
import { createControls } from './controls.js';
import { exportGLB } from './exporter.js';
import { textureFromFile } from './materials.js';
import { createPVCBanner } from './generators/banner.js';
import * as THREE from 'three';

const app = document.querySelector('#app');
let scene; let camera; let renderer; let controls; let currentBanner; let currentTexture; let ui;

function disposeObject(object) {
  object?.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    const mats = Array.isArray(child.material) ? child.material : [child.material].filter(Boolean);
    mats.forEach((mat) => { if (mat.map && mat.map !== currentTexture) mat.map.dispose(); if (mat.normalMap) mat.normalMap.dispose(); mat.dispose(); });
  });
}

function generate(settings) {
  try {
    if (currentBanner) { scene.remove(currentBanner); disposeObject(currentBanner); }
    currentBanner = createPVCBanner({ ...settings, texture: currentTexture });
    currentBanner.position.y = 0;
    scene.add(currentBanner);
    ui.setStatus(`Generated PVC Banner — seed ${currentBanner.userData.seed}, real scale in meters.`);
  } catch (error) { ui.setStatus(`Generation error: ${error.message}`); console.error(error); }
}

async function loadTexture(file, settings) {
  try {
    currentTexture = await textureFromFile(file);
    generate(settings);
    ui.setStatus(`Texture loaded: ${file.name}. Front side updated; back side remains white PVC.`);
  } catch (error) { ui.setStatus(error.message || 'Texture upload failed.'); console.error(error); }
}

function init() {
  ui = createUI(app, { onGenerate: generate, onRandomize: generate, onExport: () => { try { exportGLB(currentBanner, `pvc-banner-${currentBanner?.userData?.seed || 'asset'}.glb`); ui.setStatus('GLB export started.'); } catch (error) { ui.setStatus(`Export error: ${error.message}`); } }, onTexture: loadTexture });
  scene = createScene(); camera = createCamera(ui.viewport); renderer = createRenderer(ui.viewport); controls = createControls(camera, renderer.domElement);
  const resize = () => { const { clientWidth, clientHeight } = ui.viewport; camera.aspect = clientWidth / clientHeight; camera.updateProjectionMatrix(); renderer.setSize(clientWidth, clientHeight); };
  window.addEventListener('resize', resize);
  generate(ui.getSettings());
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
}

THREE.Cache.enabled = true;
init();
