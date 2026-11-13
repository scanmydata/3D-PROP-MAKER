import * as THREE from 'three';

/**
 * Editor state: the user scene, the selection and an undo/redo history.
 * UI parts listen with editor.on('sceneChanged' | 'selectionChanged' | 'objectChanged' | 'historyChanged').
 */
export class Editor extends EventTarget {
  constructor() {
    super();
    this.scene = new THREE.Scene();
    this.scene.name = 'Scene';
    this.selected = null;
    this.undos = [];
    this.redos = [];
    this.viewport = null; // set by Viewport
  }

  on(type, fn) { this.addEventListener(type, (e) => fn(e.detail)); }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // ---- history -------------------------------------------------------
  execute(cmd) {
    cmd.do();
    this.undos.push(cmd);
    if (this.undos.length > 200) this.undos.shift();
    this.redos = [];
    this.emit('historyChanged');
  }

  undo() {
    const cmd = this.undos.pop();
    if (!cmd) return;
    cmd.undo();
    this.redos.push(cmd);
    this.emit('historyChanged');
  }

  redo() {
    const cmd = this.redos.pop();
    if (!cmd) return;
    cmd.do();
    this.undos.push(cmd);
    this.emit('historyChanged');
  }

  // ---- objects -------------------------------------------------------
  addObject(object, parent = this.scene, { select = true } = {}) {
    const editor = this;
    this.execute({
      name: `Add ${object.name || object.type}`,
      do() { parent.add(object); editor.emit('sceneChanged'); if (select) editor.select(object); },
      undo() { parent.remove(object); if (editor.selected === object) editor.select(null); editor.emit('sceneChanged'); },
    });
    return object;
  }

  removeObject(object) {
    if (!object || object === this.scene || !object.parent) return;
    const editor = this;
    const parent = object.parent;
    const index = parent.children.indexOf(object);
    this.execute({
      name: `Delete ${object.name}`,
      do() { parent.remove(object); if (editor.selected === object) editor.select(null); editor.emit('sceneChanged'); },
      undo() {
        parent.children.splice(index, 0, object);
        object.parent = parent;
        editor.emit('sceneChanged');
        editor.select(object);
      },
    });
  }

  duplicate(object) {
    if (!object || object.userData.isSplat) return null;
    const copy = object.clone();
    copy.name = `${object.name || object.type} copy`;
    copy.position.x += 1;
    return this.addObject(copy, object.parent || this.scene);
  }

  /** Records a transform change made interactively (gizmo) so it can be undone. */
  recordTransform(object, before) {
    const after = snapshot(object);
    if (sameSnapshot(before, after)) return;
    const editor = this;
    this.execute({
      name: 'Transform',
      do() { applySnapshot(object, after); editor.emit('objectChanged', object); },
      undo() { applySnapshot(object, before); editor.emit('objectChanged', object); },
    });
  }

  /** Generic undoable property change: set(value) is called with the new/old value. */
  setValue(object, label, get, set, value) {
    const old = get();
    if (old === value) return;
    const editor = this;
    this.execute({
      name: label,
      do() { set(value); editor.emit('objectChanged', object); },
      undo() { set(old); editor.emit('objectChanged', object); },
    });
  }

  /** Replace a mesh's geometry (simplify / crop / bake) as one undo step. */
  replaceGeometry(mesh, geometry, label) {
    const old = mesh.geometry;
    const editor = this;
    this.execute({
      name: label,
      do() { mesh.geometry = geometry; editor.emit('objectChanged', mesh); editor.emit('sceneChanged'); },
      undo() { mesh.geometry = old; editor.emit('objectChanged', mesh); editor.emit('sceneChanged'); },
    });
  }

  select(object) {
    if (this.selected === object) return;
    this.selected = object;
    this.emit('selectionChanged', object);
  }

  clear() {
    [...this.scene.children].forEach((c) => this.scene.remove(c));
    this.undos = []; this.redos = [];
    this.select(null);
    this.emit('sceneChanged');
    this.emit('historyChanged');
  }

  find(fn) {
    let found = null;
    this.scene.traverse((o) => { if (!found && fn(o)) found = o; });
    return found;
  }
}

export function snapshot(o) {
  return { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() };
}
export function applySnapshot(o, s) {
  o.position.copy(s.p); o.quaternion.copy(s.q); o.scale.copy(s.s); o.updateMatrixWorld(true);
}
function sameSnapshot(a, b) {
  return a.p.equals(b.p) && a.q.equals(b.q) && a.s.equals(b.s);
}
