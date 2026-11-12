// 金額計算。浮動小数点を使わず、BigInt の「銭（1/100円）」整数と有理数で計算する。
// 保存形式：円単位の10進文字列（小数2桁まで）例 "3000", "1234.5", "0.25"

import { DomainError } from './util.js';

/** 入力文字列 → 正規化された金額文字列。空なら null。不正なら DomainError */
export function parseMoneyInput(input) {
  if (input == null) return null;
  let s = String(input).normalize('NFKC').replace(/[,\s¥円]/g, '').replace(/^\\/, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new DomainError('INVALID_MONEY', `金額「${input}」を解釈できません（0以上、小数2桁まで）`);
  }
  const c = toCents(s);
  if (c > 10n ** 13n) throw new DomainError('INVALID_MONEY', '金額が大きすぎます');
  return fromCents(c);
}

export function toCents(str) {
  if (typeof str !== 'string' || !/^\d+(\.\d{1,2})?$/.test(str)) throw new DomainError('INVALID_MONEY', `不正な金額形式: ${str}`);
  const [i, f = ''] = str.split('.');
  return BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
}

export function fromCents(c) {
  const neg = c < 0n;
  if (neg) c = -c;
  const i = c / 100n;
  const f = c % 100n;
  let s = i.toString();
  if (f !== 0n) s += '.' + f.toString().padStart(2, '0').replace(/0$/, '');
  return (neg ? '-' : '') + s;
}

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

/** 有理数（銭単位） */
export const Frac = {
  zero: () => ({ n: 0n, d: 1n }),
  of(n, d = 1n) {
    n = BigInt(n);
    d = BigInt(d);
    if (d === 0n) throw new Error('division by zero');
    if (d < 0n) (n = -n), (d = -d);
    const g = gcd(n, d);
    return { n: n / g, d: d / g };
  },
  add(a, b) {
    return Frac.of(a.n * b.d + b.n * a.d, a.d * b.d);
  },
  mulInt(a, k) {
    return Frac.of(a.n * BigInt(k), a.d);
  },
  divInt(a, k) {
    return Frac.of(a.n, a.d * BigInt(k));
  },
  /** 四捨五入して銭単位の BigInt に */
  roundCents(a) {
    // 四捨五入（正の値前提）
    const q = a.n / a.d;
    const r = a.n % a.d;
    return r * 2n >= a.d ? q + 1n : q;
  },
  /** 四捨五入して円単位 BigInt */
  roundYen(a) {
    return Frac.roundCents(Frac.of(a.n, a.d * 100n));
  },
  isZero: (a) => a.n === 0n,
};

/** lot の価格情報 {amount: "3000", qty: 300, tax} から q 個分の金額（有理数・銭） */
export function valueOf(price, q) {
  return Frac.of(toCents(price.amount) * BigInt(q), BigInt(price.qty));
}

/** 単価（銭の有理数） */
export function unitPrice(price) {
  return Frac.of(toCents(price.amount), BigInt(price.qty));
}

const yenFmt = new Intl.NumberFormat('ja-JP');

/** 有理数（銭）→ 表示用文字列。decimals: 小数桁 (0 or 2) */
export function formatFrac(frac, decimals = 0) {
  if (decimals === 0) return '¥' + yenFmt.format(Frac.roundYen(frac));
  const c = Frac.roundCents(frac);
  const i = c / 100n;
  const f = (c % 100n).toString().padStart(2, '0');
  return '¥' + yenFmt.format(i) + (f === '00' ? '' : '.' + f);
}

/** 単価表示：整数円なら整数、そうでなければ小数2桁（端数は四捨五入。表示のみ） */
export function formatUnit(frac) {
  return formatFrac(frac, 2);
}

export function formatMoneyStr(s) {
  if (s == null) return '価格未設定';
  return formatFrac(Frac.of(toCents(s)), 2);
}

export const TAX_LABEL = { incl: '税込', excl: '税抜' };
