// DOM ヘルパー・アイコン・シート/ダイアログ/トースト

export function h(tag, props, ...children) {
  const el = tag === 'frag' ? document.createDocumentFragment() : document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'ref') v(el);
      else if (k in el && k !== 'list' && k !== 'form' && typeof v !== 'string') el[k] = v;
      else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ───── アイコン（24px・線画） ─────
const P = {
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  scan: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M8 8v8M11 8v8M14 8v8M17 8v8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevR: '<path d="m9 6 6 6-6 6"/>',
  chevL: '<path d="m15 6-6 6 6 6"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>',
  chevU: '<path d="m6 15 6-6 6 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
  sort: '<path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5"/>',
  filter: '<path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5Z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  archive: '<rect x="3" y="4" width="18" height="4.5" rx="1"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4"/>',
  unarchive: '<rect x="3" y="4" width="18" height="4.5" rx="1"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M12 17v-5M9.5 14.5 12 12l2.5 2.5"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  inbox: '<path d="M12 3v11M7.5 9.5 12 14l4.5-4.5"/><path d="M3 15v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/>',
  outbox: '<path d="M12 14V3M7.5 7.5 12 3l4.5 4.5"/><path d="M3 15v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/>',
  move: '<path d="M4 8h14M14.5 4.5 18 8l-3.5 3.5M20 16H6M9.5 12.5 6 16l3.5 3.5"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16.5" rx="2"/><path d="M9 4.5V3h6v1.5M8.5 13l2.5 2.5 4.5-5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  download: '<path d="M12 3v12M7 10.5l5 4.5 5-4.5M4 20h16"/>',
  upload: '<path d="M12 15V3M7 7.5 12 3l5 4.5M4 20h16"/>',
  alert: '<path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z"/><circle cx="8" cy="8" r="1.6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6L12 3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  flash: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7 14h10"/>',
  home: '<path d="M3 11 12 3l9 8"/><path d="M5 9.5V20h14V9.5"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 12.5h18"/>',
  warehouse: '<path d="M3 20V9l9-5 9 5v11"/><path d="M7 20v-7h10v7M7 16.5h10"/>',
  yen: '<path d="m6 4 6 8 6-8M12 12v8M7.5 13.5h9M7.5 17h9"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
};

export function icon(name, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = P[name] || P.box;
  return s;
}

// ───── トースト ─────
let toastWrap;
export function toast(message, { action, onAction, error = false, duration } = {}) {
  if (!toastWrap) {
    toastWrap = h('div', { class: 'toast-wrap', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastWrap);
  }
  clear(toastWrap);
  const el = h('div', { class: 'toast' + (error ? ' err' : '') }, h('div', { class: 'msg' }, message));
  let timer;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  if (action) {
    el.appendChild(
      h('button', {
        onclick: async () => {
          close();
          await onAction?.();
        },
      }, action)
    );
  } else {
    el.appendChild(h('button', { onclick: close, 'aria-label': '閉じる' }, icon('x')));
  }
  toastWrap.appendChild(el);
  timer = setTimeout(close, duration ?? (action ? 7000 : error ? 6000 : 2600));
  return close;
}

export function toastError(e) {
  console.error(e);
  toast(e?.message || String(e), { error: true });
}

// ───── ボトムシート ─────
const sheetStack = [];
export function openSheet({ title, subtitle, body, footer, onClose, wide }) {
  const scrim = h('div', { class: 'scrim' });
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const close = (result) => {
    panel.classList.remove('show');
    scrim.classList.remove('show');
    const i = sheetStack.indexOf(api);
    if (i >= 0) sheetStack.splice(i, 1);
    setTimeout(() => {
      panel.remove();
      scrim.remove();
      if (!sheetStack.length) document.body.style.overflow = '';
    }, 260);
    onClose?.(result);
  };
  const api = { close, panel };
  scrim.addEventListener('click', () => close());
  const head = h('div', { class: 'sheet-h' }, h('h3', null, title, subtitle ? h('div', { class: 'sub' }, subtitle) : null), h('button', { class: 'icon-btn', 'aria-label': '閉じる', onclick: () => close() }, icon('x')));
  const bodyEl = h('div', { class: 'sheet-b' });
  const footEl = h('div', { class: 'sheet-f' });
  panel.append(h('div', { class: 'grab' }), head, bodyEl);
  const setBody = (b) => {
    clear(bodyEl);
    append(bodyEl, [typeof b === 'function' ? b(api) : b]);
  };
  const setFooter = (f) => {
    clear(footEl);
    if (f) {
      append(footEl, [typeof f === 'function' ? f(api) : f]);
      panel.appendChild(footEl);
    } else footEl.remove();
  };
  api.setBody = setBody;
  api.setFooter = setFooter;
  api.body = bodyEl;
  setBody(body);
  setFooter(footer);
  document.body.append(scrim, panel);
  document.body.style.overflow = 'hidden';
  sheetStack.push(api);
  requestAnimationFrame(() => {
    scrim.classList.add('show');
    panel.classList.add('show');
  });
  // 下方向スワイプで閉じる（ヘッダー部分）
  let y0 = null;
  head.addEventListener('touchstart', (e) => (y0 = e.touches[0].clientY), { passive: true });
  head.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy > 0) panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  head.addEventListener('touchend', (e) => {
    const dy = (e.changedTouches[0]?.clientY ?? 0) - (y0 ?? 0);
    panel.style.transform = '';
    y0 = null;
    if (dy > 90) close();
  });
  return api;
}

export function closeAllSheets() {
  for (const s of [...sheetStack]) s.close();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetStack.length) sheetStack[sheetStack.length - 1].close();
});

// ───── 確認ダイアログ ─────
export function confirmDialog({ title, message, ok = 'OK', cancel = 'キャンセル', danger = false, input }) {
  return new Promise((resolve) => {
    const scrim = h('div', { class: 'scrim', style: { zIndex: 119 } });
    let inputEl = null;
    if (input) inputEl = h('input', { class: 'input', placeholder: input.placeholder || '', value: input.value || '', style: { marginBottom: '12px' } });
    const okBtn = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary') }, ok);
    const box = h(
      'div',
      { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
      h('h3', null, title),
      message ? h('p', null, message) : null,
      inputEl,
      h('div', { class: 'btn-row' }, cancel ? h('button', { class: 'btn', onclick: () => done(false) }, cancel) : null, okBtn)
    );
    const done = (v) => {
      box.classList.remove('show');
      scrim.classList.remove('show');
      setTimeout(() => {
        box.remove();
        scrim.remove();
      }, 200);
      resolve(v && inputEl ? inputEl.value : v);
    };
    okBtn.addEventListener('click', () => {
      if (input?.required && !inputEl.value.trim()) {
        inputEl.setAttribute('aria-invalid', 'true');
        inputEl.focus();
        return;
      }
      done(true);
    });
    if (input?.match) {
      okBtn.disabled = true;
      inputEl.addEventListener('input', () => (okBtn.disabled = inputEl.value.trim() !== input.match));
    }
    scrim.addEventListener('click', () => cancel && done(false));
    document.body.append(scrim, box);
    requestAnimationFrame(() => {
      scrim.classList.add('show');
      box.classList.add('show');
      inputEl?.focus();
    });
  });
}

export function alertDialog(title, message) {
  return confirmDialog({ title, message, cancel: null });
}

// ───── 写真URLキャッシュ ─────
const urlCache = new Map();
export function photoUrl(repo, photoId, kind = 'thumb') {
  const key = `${repo.dbName}|${photoId}|${kind}`;
  if (!urlCache.has(key)) {
    urlCache.set(
      key,
      repo.getPhotoBlob(photoId, kind).then((b) => (b ? URL.createObjectURL(b) : null))
    );
  }
  return urlCache.get(key);
}
export function forgetPhoto(repo, photoId) {
  for (const kind of ['thumb', 'main']) {
    const key = `${repo.dbName}|${photoId}|${kind}`;
    const p = urlCache.get(key);
    if (p) p.then((u) => u && URL.revokeObjectURL(u));
    urlCache.delete(key);
  }
}

/** 遅延読み込みの画像要素 */
export function photoImg(repo, photoId, kind = 'thumb', alt = '') {
  const img = h('img', { alt, decoding: 'async', loading: 'lazy' });
  photoUrl(repo, photoId, kind).then((u) => {
    if (u) img.src = u;
  });
  return img;
}

export function field(label, control, { required, hint, id } = {}) {
  return h('div', { class: 'field' }, h('label', { for: id }, h('span', null, label, required ? h('span', { class: 'req' }, ' *') : null)), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

export function seg(options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup' });
  const render = (v) => {
    clear(wrap);
    for (const [val, label] of options) {
      wrap.appendChild(
        h('button', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(v === val),
          class: v === val ? 'on' : '',
          onclick: () => {
            render(val);
            onChange(val);
          },
        }, label)
      );
    }
  };
  render(value);
  wrap.set = render;
  return wrap;
}

export function stepper(inputProps, { min = 0, step = 1 } = {}) {
  const input = h('input', { class: 'input num', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', ...inputProps });
  const bump = (d) => {
    const cur = parseInt(String(input.value).normalize('NFKC').replace(/,/g, ''), 10) || 0;
    input.value = Math.max(min, cur + d);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const wrap = h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': '減らす', onclick: () => bump(-step) }, icon('minus')), input, h('button', { type: 'button', 'aria-label': '増やす', onclick: () => bump(step) }, icon('plus')));
  wrap.input = input;
  return wrap;
}

export function notice(kind, iconName, ...content) {
  return h('div', { class: `notice ${kind}` }, icon(iconName), h('div', { class: 'grow' }, ...content));
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 4000);
}

/** iOS では共有シート（「ファイルに保存」）を優先。完了を確認できた場合 'shared' を返す */
export async function saveFile(blob, filename, { preferShare = true } = {}) {
  const file = new File([blob], filename, { type: blob.type });
  if (preferShare && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      // 共有に失敗した場合はダウンロードにフォールバック
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

export function pickFile(accept, { multiple = false, capture } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    if (multiple) input.multiple = true;
    if (capture) input.setAttribute('capture', capture);
    input.addEventListener('change', () => {
      resolve([...(input.files || [])]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}
