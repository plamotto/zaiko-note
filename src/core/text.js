// 表記揺れ正規化・類似判定・JANコード検証

/** 検索・比較用の正規化：NFKC（全角英数→半角、半角カナ→全角）、小文字化、カタカナ→ひらがな、空白・記号除去 */
export function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　・･\-‐－ー_\/／.,、。()（）\[\]【】「」『』"'`~!！?？:：;；]+/g, '')
    .replace(/[〜~]/g, '');
}

/** 検索用（長音は残す）。キーワードのスペース区切りAND検索に使う */
export function normalizeForSearch(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s) {
  const out = new Map();
  if (s.length < 2) {
    out.set(s, 1);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** Dice 係数（0..1） */
export function similarity(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x);
  const B = bigrams(y);
  let inter = 0;
  let total = 0;
  for (const [g, c] of A) {
    total += c;
    if (B.has(g)) inter += Math.min(c, B.get(g));
  }
  for (const c of B.values()) total += c;
  return (2 * inter) / total;
}

/**
 * 重複候補の判定
 * @returns {{reason:'jan'|'name-exact'|'name-similar', score:number}|null}
 */
export function duplicateReason(candidate, existing) {
  const j1 = normalizeJan(candidate.jan);
  const j2 = normalizeJan(existing.jan);
  if (j1 && j2 && j1 === j2) return { reason: 'jan', score: 1 };
  const n1 = normalizeName(candidate.name);
  const n2 = normalizeName(existing.name);
  if (!n1 || !n2) return null;
  if (n1 === n2) return { reason: 'name-exact', score: 1 };
  const sim = similarity(candidate.name, existing.name);
  const contains = (n1.length >= 3 && n2.includes(n1)) || (n2.length >= 3 && n1.includes(n2));
  if (sim >= 0.6 || contains) return { reason: 'name-similar', score: Math.max(sim, contains ? 0.7 : 0) };
  return null;
}

export function findDuplicates(candidate, items, { excludeId } = {}) {
  const out = [];
  for (const it of items) {
    if (it.id === excludeId) continue;
    const r = duplicateReason(candidate, it);
    if (r) out.push({ item: it, ...r });
  }
  const rank = { jan: 0, 'name-exact': 1, 'name-similar': 2 };
  return out.sort((a, b) => rank[a.reason] - rank[b.reason] || b.score - a.score);
}

export function normalizeJan(s) {
  if (s == null) return '';
  return String(s).normalize('NFKC').replace(/[\s\-]/g, '');
}

/** GTIN（JAN-8/JAN-13/UPC-A/GTIN-14）のチェックデジット検証 */
export function isValidJan(s) {
  const d = normalizeJan(s);
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(d)) return false;
  return janCheckDigit(d.slice(0, -1)) === Number(d.at(-1));
}

export function janCheckDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const n = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? n * 3 : n;
  }
  return (10 - (sum % 10)) % 10;
}

/** JAN として受け付けるか。チェックデジット不一致でも社内コード等として許容するが警告用に区別する */
export function janStatus(s) {
  const d = normalizeJan(s);
  if (!d) return 'empty';
  if (!/^\d+$/.test(d)) return 'invalid';
  return isValidJan(d) ? 'valid' : 'checksum';
}
