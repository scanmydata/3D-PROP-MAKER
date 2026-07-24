import * as THREE from 'three';

function makeProceduralNormalTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const data = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const fiber = Math.sin(x * 0.65) * 7 + Math.sin((x + y) * 0.18) * 4;
      data.data[i] = 128 + fiber; data.data[i + 1] = 128 + fiber * 0.35; data.data[i + 2] = 255; data.data[i + 3] = 255;
    }
  }
  ctx.putImageData(data, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(8, 5);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

export function createBannerMaterials(frontTexture = null) {
  const normalMap = makeProceduralNormalTexture();
  const shared = { roughness: 0.82, metalness: 0, normalMap, normalScale: new THREE.Vector2(0.035, 0.035) };
  const front = new THREE.MeshStandardMaterial({ ...shared, map: frontTexture, color: frontTexture ? 0xffffff : 0xf6f2e8, side: THREE.FrontSide });
  const back = new THREE.MeshStandardMaterial({ ...shared, color: 0xffffff, side: THREE.BackSide });
  return { front, back };
}

export function textureFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(png|jpe?g)$/i.test(file.type)) {
      reject(new Error('Please upload a PNG or JPG image.'));
      return;
    }
    const url = URL.createObjectURL(file);
    new THREE.TextureLoader().load(url, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;
      texture.anisotropy = 8;
      URL.revokeObjectURL(url);
      resolve(texture);
    }, undefined, (error) => { URL.revokeObjectURL(url); reject(error); });
  });
}
