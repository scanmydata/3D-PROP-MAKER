import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

export function exportGLB(object, filename = 'track-prop.glb') {
  if (!object) throw new Error('No generated object is available to export.');
  const exporter = new GLTFExporter();
  exporter.parse(object, (result) => {
    const blob = result instanceof ArrayBuffer ? new Blob([result], { type: 'model/gltf-binary' }) : new Blob([JSON.stringify(result, null, 2)], { type: 'model/gltf+json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, (error) => { throw error; }, { binary: true, embedImages: true, onlyVisible: false, trs: true });
}
