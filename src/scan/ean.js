// EAN-13 / EAN-8（JAN）バーコードの走査線デコーダ（依存なし）。
// iPhone Safari には BarcodeDetector API が無いため自前で実装。
// 1行分の輝度配列 → 二値化 → ラン長 → ガードパターン検出 → 各桁の幅比を最も近いパターンに照合 → チェックデジット検証。

import { isValidJan } from '../core/text.js';

// L コード（左半分・奇数パリティ）の幅 [スペース, バー, スペース, バー]
const L = ['3211', '2221', '2122', '1411', '1132', '1231', '1114', '1312', '1213', '3112'].map((s) => [...s].map(Number));
// G コード（偶数パリティ）は L の逆順
const G = L.map((w) => [...w].reverse());
// R コード（右半分）は幅としては L と同じ（色が反転）
const FIRST = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function matchDigit(w, table) {
  const sum = w[0] + w[1] + w[2] + w[3];
  const n = w.map((x) => (x * 7) / sum);
  let best = -1;
  let bestErr = Infinity;
  let second = Infinity;
  for (let d = 0; d < 10; d++) {
    const p = table[d];
    const e = (n[0] - p[0]) ** 2 + (n[1] - p[1]) ** 2 + (n[2] - p[2]) ** 2 + (n[3] - p[3]) ** 2;
    if (e < bestErr) {
      second = bestErr;
      bestErr = e;
      best = d;
    } else if (e < second) second = e;
  }
  return { d: best, err: bestErr, margin: second - bestErr };
}

function guardOk(runs, unit) {
  for (const r of runs) if (r < unit * 0.35 || r > unit * 2.2) return false;
  return true;
}

/** ラン長配列（先頭はバー）から EAN-13 を読む */
function tryEan13(runs, i) {
  if (i + 59 > runs.length) return null;
  const seg = runs.slice(i, i + 59);
  const total = seg.reduce((a, b) => a + b, 0);
  const unit = total / 95;
  if (!guardOk(seg.slice(0, 3), unit) || !guardOk(seg.slice(27, 32), unit) || !guardOk(seg.slice(56, 59), unit)) return null;
  // 前後に十分な余白（クワイエットゾーン）
  const before = runs[i - 1] ?? Infinity;
  const after = runs[i + 59] ?? Infinity;
  if (before < unit * 3 || after < unit * 3) return null;
  let parity = '';
  const digits = [];
  let errSum = 0;
  for (let k = 0; k < 6; k++) {
    const w = seg.slice(3 + k * 4, 7 + k * 4);
    const l = matchDigit(w, L);
    const g = matchDigit(w, G);
    const m = l.err <= g.err ? l : g;
    if (m.err > 0.9) return null;
    errSum += m.err;
    parity += l.err <= g.err ? 'L' : 'G';
    digits.push(m.d);
  }
  for (let k = 0; k < 6; k++) {
    const w = seg.slice(32 + k * 4, 36 + k * 4);
    const m = matchDigit(w, L);
    if (m.err > 0.9) return null;
    errSum += m.err;
    digits.push(m.d);
  }
  const first = FIRST.indexOf(parity);
  if (first < 0) return null;
  const code = String(first) + digits.join('');
  return isValidJan(code) ? { code, err: errSum } : null;
}

function tryEan8(runs, i) {
  if (i + 43 > runs.length) return null;
  const seg = runs.slice(i, i + 43);
  const total = seg.reduce((a, b) => a + b, 0);
  const unit = total / 67;
  if (!guardOk(seg.slice(0, 3), unit) || !guardOk(seg.slice(19, 24), unit) || !guardOk(seg.slice(40, 43), unit)) return null;
  const before = runs[i - 1] ?? Infinity;
  const after = runs[i + 43] ?? Infinity;
  if (before < unit * 3 || after < unit * 3) return null;
  const digits = [];
  for (let k = 0; k < 4; k++) {
    const m = matchDigit(seg.slice(3 + k * 4, 7 + k * 4), L);
    if (m.err > 0.9) return null;
    digits.push(m.d);
  }
  for (let k = 0; k < 4; k++) {
    const m = matchDigit(seg.slice(24 + k * 4, 28 + k * 4), L);
    if (m.err > 0.9) return null;
    digits.push(m.d);
  }
  const code = digits.join('');
  return isValidJan(code) ? { code, err: 0 } : null;
}

function runsFrom(lum, threshold) {
  // 先頭の明部（余白）を1つ目のランとし、以降 バー/スペース を交互に
  const runs = [];
  let dark = lum[0] < threshold;
  let len = 0;
  const firstDark = dark;
  for (let x = 0; x < lum.length; x++) {
    const d = lum[x] < threshold;
    if (d === dark) len++;
    else {
      runs.push(len);
      dark = d;
      len = 1;
    }
  }
  runs.push(len);
  return { runs, firstDark };
}

function decodeRuns(runs, firstDark) {
  // バーで始まる位置のみ候補（firstDark なら偶数番目がバー）
  const startParity = firstDark ? 0 : 1;
  for (let i = startParity; i < runs.length; i += 2) {
    const r = tryEan13(runs, i) || tryEan8(runs, i);
    if (r) return r.code;
  }
  return null;
}

/**
 * 1行分の輝度（0-255）からコードを読む
 * @param {Uint8Array|number[]} lum
 */
export function decodeLine(lum) {
  let min = 255;
  let max = 0;
  for (const v of lum) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 40) return null;
  // 軽い平滑化
  const s = new Float32Array(lum.length);
  for (let x = 0; x < lum.length; x++) s[x] = ((lum[x - 1] ?? lum[x]) + 2 * lum[x] + (lum[x + 1] ?? lum[x])) / 4;
  for (const f of [0.5, 0.42, 0.58, 0.35, 0.65]) {
    const t = min + (max - min) * f;
    const { runs, firstDark } = runsFrom(s, t);
    let code = decodeRuns(runs, firstDark);
    if (code) return code;
    // 上下逆さまのバーコード
    const rev = [...runs].reverse();
    const revFirstDark = runs.length % 2 === 1 ? firstDark : !firstDark;
    code = decodeRuns(rev, revFirstDark);
    if (code) return code;
  }
  return null;
}

/** RGBA ImageData の複数行を走査。複数行で同じ結果が出たものを返す */
export function decodeImageData(img, rows = 15) {
  const { width, height, data } = img;
  const votes = new Map();
  for (let r = 0; r < rows; r++) {
    const y = Math.floor(((r + 0.5) / rows) * height);
    const lum = new Uint8Array(width);
    let o = y * width * 4;
    for (let x = 0; x < width; x++, o += 4) lum[x] = (data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000;
    const c = decodeLine(lum);
    if (c) votes.set(c, (votes.get(c) || 0) + 1);
  }
  let best = null;
  let n = 0;
  for (const [c, v] of votes) if (v > n) (best = c), (n = v);
  return best ? { code: best, votes: n } : null;
}

// ───── テスト用：コード → 輝度配列（合成画像） ─────
export function renderEan13(code, module = 3, quiet = 12) {
  const d = [...code].map(Number);
  const bits = [];
  const put = (widths, startDark) => {
    let dark = startDark;
    for (const w of widths) {
      for (let i = 0; i < w; i++) bits.push(dark ? 1 : 0);
      dark = !dark;
    }
  };
  for (let i = 0; i < quiet; i++) bits.push(0);
  put([1, 1, 1], true);
  const par = FIRST[d[0]];
  for (let k = 0; k < 6; k++) put((par[k] === 'L' ? L : G)[d[1 + k]], false);
  put([1, 1, 1, 1, 1], false);
  for (let k = 0; k < 6; k++) put(L[d[7 + k]], true);
  put([1, 1, 1], true);
  for (let i = 0; i < quiet; i++) bits.push(0);
  const out = [];
  for (const b of bits) for (let i = 0; i < module; i++) out.push(b ? 40 : 220);
  return out;
}
