import { el } from '../ui/dom.js';

/** Scene tree with selection, visibility toggles and expand/collapse. */
export class Outliner {
  constructor(editor, container) {
    this.editor = editor;
    this.container = container;
    this.expanded = new WeakSet();
    editor.on('sceneChanged', () => this.render());
    editor.on('selectionChanged', (obj) => {
      // Expand the path to a selection made in the viewport.
      for (let o = obj?.parent; o && o !== editor.scene; o = o.parent) this.expanded.add(o);
      this.render();
    });
    editor.on('objectChanged', () => this.renderSoon());
    this.render();
  }

  renderSoon() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.render(), 120);
  }

  render() {
    const { editor } = this;
    const rows = [];
    const walk = (obj, depth) => {
      obj.children.forEach((child) => {
        if (child.userData.noPick && child.parent?.userData.cropBox) return;
        rows.push(this.row(child, depth));
        if (this.expanded.has(child)) walk(child, depth + 1);
      });
    };
    walk(editor.scene, 0);
    this.container.replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty' }, 'Empty scene — import a model, build a track or run a capture job.')]));
  }

  row(obj, depth) {
    const { editor } = this;
    const hasKids = obj.children.length > 0 && !obj.userData.isSplat;
    const open = this.expanded.has(obj);
    const icon = obj.userData.isSplat ? '◍' : obj.isLight ? '☀' : obj.isPoints ? '⁘' : obj.isMesh ? '▣' : obj.isLine ? '〰' : '▤';
    const row = el('div', {
      class: `tree-row${editor.selected === obj ? ' selected' : ''}${obj.visible ? '' : ' hidden-obj'}`,
      style: `padding-left:${8 + depth * 14}px`,
      onclick: () => editor.select(obj),
      ondblclick: () => editor.viewport.focus(obj),
    },
    el('span', {
      class: 'twisty', onclick: (e) => {
        e.stopPropagation();
        if (open) this.expanded.delete(obj); else this.expanded.add(obj);
        this.render();
      },
    }, hasKids ? (open ? '▾' : '▸') : ''),
    el('span', { class: 'tree-icon' }, icon),
    el('span', { class: 'tree-name' }, obj.name || obj.type),
    el('button', {
      class: 'eye', title: 'Show / hide',
      onclick: (e) => {
        e.stopPropagation();
        editor.setValue(obj, 'Visibility', () => obj.visible, (v) => { obj.visible = v; editor.emit('sceneChanged'); }, !obj.visible);
      },
    }, obj.visible ? '👁' : '–'));
    return row;
  }
}
