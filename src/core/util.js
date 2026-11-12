// 汎用ユーティリティ（ID・日付・数量の検証）。フレームワーク非依存。

export function uuid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class DomainError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.detail = detail;
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** ローカル日付 YYYY-MM-DD */
export function today(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return today(dt);
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d && y >= 1900 && y <= 2999;
}

/** 「2024/3/5」「2024-03-05」「２０２４年３月５日」などを YYYY-MM-DD に正規化。不正なら null */
export function parseDateLoose(input) {
  if (input == null) return null;
  const s = String(input).normalize('NFKC').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?$/);
  if (!m) return null;
  const out = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  return isValidDate(out) ? out : null;
}

export function formatDateJa(s, { withYear = true } = {}) {
  if (!s) return '—';
  const [y, m, d] = s.split('-').map(Number);
  const wd = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return withYear ? `${y}/${m}/${d}(${wd})` : `${m}/${d}(${wd})`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

/** 正の整数（数量）として解釈。全角数字・カンマ可。失敗時 null */
export function parseIntStrict(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isSafeInteger(input) ? input : null;
  const s = String(input).normalize('NFKC').replace(/,/g, '').trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export function isPosInt(n) {
  return Number.isSafeInteger(n) && n > 0;
}
export function isNonNegInt(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

export function nowIso() {
  return new Date().toISOString();
}

export function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 安定比較キー */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
