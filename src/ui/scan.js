// JANバーコードスキャン（カメラ）と手入力
import { h, icon, clear, openSheet, toast, notice } from './dom.js';
import { app, go, fmtQty, itemView, thumb, packText, statusBadge } from './views.js';
import { openOpSheet } from './ops.js';
import { decodeImageData } from '../scan/ean.js';
import { normalizeJan, janStatus } from '../core/text.js';

class Scanner {
  constructor(onCode) {
    this.onCode = onCode;
    this.stream = null;
    this.video = h('video', { playsinline: true, muted: true, autoplay: true });
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.canvas = document.createElement('canvas');
    this.running = false;
    this.last = null;
    this.detector = null;
  }
  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(location.protocol === 'http:' && location.hostname !== 'localhost' ? 'カメラを使うには HTTPS で開く必要があります（手入力は利用できます）' : 'この環境ではカメラを利用できません');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    if ('BarcodeDetector' in window) {
      try {
        const fmts = await window.BarcodeDetector.getSupportedFormats();
        if (fmts.includes('ean_13')) this.detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
      } catch {}
    }
    this.running = true;
    this.loop();
  }
  get track() {
    return this.stream?.getVideoTracks()[0];
  }
  torchSupported() {
    try {
      return !!this.track?.getCapabilities?.().torch;
    } catch {
      return false;
    }
  }
  async torch(on) {
    await this.track?.applyConstraints({ advanced: [{ torch: on }] });
  }
  stop() {
    this.running = false;
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.stream = null;
  }
  async loop() {
    while (this.running) {
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth) {
        let code = null;
        try {
          if (this.detector) {
            const r = await this.detector.detect(v);
            code = r.find((x) => /^\d{8,13}$/.test(x.rawValue))?.rawValue || null;
          }
          if (!code) code = this.decodeFrame();
        } catch (e) {
          console.warn(e);
        }
        if (code) {
          // 誤読防止：同じ値を2回連続で読めたら確定（BarcodeDetector は1回で確定）
          if (this.detector || this.last === code) {
            this.running = false;
            navigator.vibrate?.(60);
            this.onCode(code.length === 12 ? '0' + code : code);
            return;
          }
          this.last = code;
        }
      }
      await new Promise((r) => setTimeout(r, 90));
    }
  }
  decodeFrame() {
    const v = this.video;
    const W = v.videoWidth;
    const H = v.videoHeight;
    // 画面中央の帯（ガイド枠付近）を切り出し
    const cw = Math.round(W * 0.9);
    const ch = Math.round(H * 0.3);
    const scale = Math.min(1, 1280 / cw);
    this.canvas.width = Math.round(cw * scale);
    this.canvas.height = Math.round(ch * scale);
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, (W - cw) / 2, (H - ch) / 2, cw, ch, 0, 0, this.canvas.width, this.canvas.height);
    const r = decodeImageData(ctx.getImageData(0, 0, this.canvas.width, this.canvas.height), 17);
    return r?.code || null;
  }
}

function cameraStage(onCode) {
  let scanner = null;
  const stage = h('div', { class: 'scan-stage' });
  const idle = h(
    'div',
    { class: 'scan-idle' },
    icon('scan'),
    h('div', null, 'JANコード（バーコード）を枠内に横向きで写してください'),
    h('button', { class: 'btn primary', onclick: () => start() }, icon('camera'), 'カメラを起動')
  );
  stage.appendChild(idle);
  async function start() {
    clear(stage);
    scanner = new Scanner((code) => {
      stop();
      onCode(code);
    });
    stage.append(scanner.video, h('div', { class: 'scan-frame' }), h('div', { class: 'scan-line' }), h('div', { class: 'scan-hint' }, '読み取り中… 明るい場所で、10〜15cm離して'));
    try {
      await scanner.start();
      const tools = h('div', { class: 'scan-tools' });
      if (scanner.torchSupported()) {
        let on = false;
        tools.appendChild(h('button', { 'aria-label': 'ライト', onclick: async () => scanner.torch((on = !on)) }, icon('flash')));
      }
      tools.appendChild(h('button', { 'aria-label': 'カメラを停止', onclick: () => stop(true) }, icon('x')));
      stage.appendChild(tools);
    } catch (e) {
      stop(true);
      const msg = e.name === 'NotAllowedError' ? 'カメラの使用が許可されていません。iPhoneの「設定 → Safari → カメラ」または、ホーム画面アプリの場合はアプリ設定から許可してください。' : e.message;
      stage.appendChild(h('div', { class: 'scan-idle' }, icon('alert'), h('div', null, msg)));
    }
  }
  function stop(showIdle) {
    scanner?.stop();
    scanner = null;
    if (showIdle) {
      clear(stage);
      stage.appendChild(idle);
    }
  }
  return { el: stage, start, stop };
}

function manualEntry(onCode) {
  const input = h('input', { class: 'input num', inputmode: 'numeric', placeholder: 'JANコードを入力（8桁/13桁）', autocomplete: 'off', enterkeyhint: 'search' });
  const hint = h('div', { class: 'hint' });
  const go2 = () => {
    const c = normalizeJan(input.value);
    if (!c) return;
    if (!/^\d+$/.test(c)) {
      hint.textContent = '数字のみ入力してください';
      return;
    }
    onCode(c);
  };
  input.addEventListener('input', () => {
    const s = janStatus(input.value);
    hint.textContent = s === 'checksum' ? 'チェックデジットが一致しません（このまま検索もできます）' : s === 'valid' ? '✓ 有効なJANコード' : '';
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go2());
  return h('div', { class: 'field' }, h('div', { class: 'inline-row' }, input, h('button', { class: 'btn primary', onclick: go2 }, '検索')), hint);
}

export function scanScreen() {
  const repo = app.repo;
  const el = h('div', { class: 'view' });
  const result = h('div', { class: 'pad', style: { marginTop: '12px' } });
  const cam = cameraStage(show);
  function show(code) {
    clear(result);
    const hits = [...repo.items.values()].filter((i) => i.jan && normalizeJan(i.jan) === code);
    if (hits.length) {
      result.appendChild(h('div', { class: 'section-h', style: { padding: '0 4px 6px' } }, `${code} ・ 登録済み`));
      for (const it of hits) {
        const v = itemView(repo, it);
        result.appendChild(
          h(
            'div',
            { class: 'group', style: { margin: '0 0 10px', padding: '12px' } },
            h('button', { class: 'loc-card', style: { width: '100%', textAlign: 'left' }, onclick: () => go(`#/item/${it.id}`) }, thumb(repo, it), h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontWeight: 650 } }, it.name), h('div', { class: 'small muted' }, `在庫 ${fmtQty(v.total)}${it.unit}`, packText(it, v.total) ? `（${packText(it, v.total)}）` : '', ' ', it.archived ? '・アーカイブ済み' : ''), statusBadge(v.status)), icon('chevR', 'chev')),
            h('div', { class: 'actions4', style: { margin: '12px 0 0' } }, h('button', { class: 'action primary', onclick: () => openOpSheet('consume', it) }, icon('outbox'), '使用'), h('button', { class: 'action', onclick: () => openOpSheet('receive', it) }, icon('inbox'), '入庫'), h('button', { class: 'action', onclick: () => openOpSheet('move', it) }, icon('move'), '移動'), h('button', { class: 'action', onclick: () => openOpSheet('adjust', it) }, icon('clipboard'), '棚卸し'))
          )
        );
      }
    } else {
      result.appendChild(
        h(
          'div',
          { class: 'group', style: { margin: 0, padding: '16px' } },
          h('div', { class: 'small muted' }, 'JANコード'),
          h('div', { class: 'num', style: { fontSize: '22px', fontWeight: 700, letterSpacing: '0.04em' } }, code),
          h('p', { class: 'muted small' }, 'この商品はまだ登録されていません。JANコードを引き継いで新規登録できます。'),
          h('button', { class: 'btn primary block', onclick: () => go(`#/new?jan=${encodeURIComponent(code)}`) }, icon('plus'), 'この JAN で新規登録')
        )
      );
    }
    result.appendChild(h('button', { class: 'btn block', style: { marginTop: '10px' }, onclick: () => (clear(result), cam.start()) }, icon('scan'), '続けてスキャン'));
  }
  el.append(h('header', { class: 'topbar' }, h('div', { class: 'title-row' }, h('h1', null, 'スキャン'))), cam.el, h('div', { class: 'pad', style: { marginTop: '14px' } }, h('div', { class: 'section-h', style: { padding: '0 4px 6px' } }, '手入力'), manualEntry(show)), result);
  return { el, static: true, destroy: () => cam.stop() };
}

/** 商品フォームなどから：1回だけ読み取ってコードを返す */
export function scanOnce() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (c) => {
      if (done) return;
      done = true;
      cam.stop();
      sheet.close();
      resolve(c);
    };
    const cam = cameraStage((c) => finish(c));
    const sheet = openSheet({ title: 'JANコードを読み取り', body: h('div', null, cam.el, h('div', { style: { marginTop: '14px' } }, manualEntry((c) => finish(c)))), onClose: () => !done && ((done = true), cam.stop(), resolve(null)) });
    cam.el.style.margin = '0';
    cam.el.style.width = '100%';
    setTimeout(() => cam.start(), 350);
  });
}
