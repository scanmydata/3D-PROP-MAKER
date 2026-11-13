/** Tiny DOM helper: el('div', {class, onclick, ...}, children...) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k === 'html') node.innerHTML = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function field(label, input, hint) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), input, hint ? el('small', { class: 'hint' }, hint) : null);
}

export function select(options, value, onchange) {
  return el('select', { onchange: (e) => onchange?.(e.target.value) },
    ...options.map(([v, label]) => el('option', { value: v, selected: String(v) === String(value) }, label)));
}

export function numberInput(value, { step = 0.01, min, max, onchange } = {}) {
  return el('input', { type: 'number', value: String(value), step: String(step), min, max, onchange: (e) => onchange?.(Number(e.target.value)) });
}

export function checkbox(label, checked, onchange) {
  return el('label', { class: 'check' }, el('input', { type: 'checkbox', checked, onchange: (e) => onchange?.(e.target.checked) }), el('span', {}, label));
}

let toastTimer;
export function toast(message, kind = 'info') {
  let t = document.getElementById('toast');
  if (!t) { t = el('div', { id: 'toast' }); document.body.append(t); }
  t.className = `toast ${kind} show`;
  t.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'error' ? 7000 : 3500);
}

export function pickFiles({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, multiple });
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
