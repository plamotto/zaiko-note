// 在庫台帳エンジン（純粋関数）。
// すべての在庫数量・ロット残数は「操作履歴（ops）」を操作日順に再生（replay）して導出する。
// 保存されるのは履歴のみで、在庫数は常に履歴から再計算されるため、過去日付の追加・訂正・取り消し後も整合する。
//
// 並び順：date（ユーザー指定の操作日）→ order（同日内の確定順。訂正は元操作の order を引き継ぐ）→ seq（作成順の通し番号）
// 有効判定：void（取り消し）または corrects（訂正）により無効化された操作は再生しない。
//           取り消し・訂正自体も取り消せる（取り消すと元の操作が有効に戻る）。

import { DomainError, cmp, isPosInt, isNonNegInt } from './util.js';
import { Frac, toCents, fromCents, valueOf } from './money.js';

export const OP_LABEL = {
  receive: '入庫',
  consume: '使用',
  move: '移動',
  adjust: '棚卸し',
  void: '取り消し',
};

export function opOrder(a, b) {
  return cmp(a.date, b.date) || a.order - b.order || a.seq - b.seq;
}

/** 有効な操作IDの集合（取り消し・訂正の連鎖を解決） */
export function activeOpIds(ops) {
  const desc = [...ops].sort((a, b) => b.seq - a.seq);
  const killed = new Set();
  const active = new Set();
  for (const op of desc) {
    if (killed.has(op.id)) continue;
    active.add(op.id);
    if (op.type === 'void' && op.targetId) killed.add(op.targetId);
    if (op.corrects) killed.add(op.corrects);
  }
  return active;
}

/** 操作の状態：active / voided / superseded */
export function opStatus(ops) {
  const active = activeOpIds(ops);
  const map = new Map();
  const byId = new Map(ops.map((o) => [o.id, o]));
  for (const op of ops) {
    if (active.has(op.id)) map.set(op.id, { state: 'active' });
  }
  for (const op of ops) {
    if (!active.has(op.id)) continue;
    if (op.type === 'void' && byId.has(op.targetId)) map.set(op.targetId, { state: 'voided', by: op.id });
    if (op.corrects && byId.has(op.corrects)) map.set(op.corrects, { state: 'superseded', by: op.id });
  }
  for (const op of ops) if (!map.has(op.id)) map.set(op.id, { state: 'inactive' });
  return map;
}

function err(code, message, op, extra = {}) {
  return new DomainError(code, message, { opId: op.id, date: op.date, type: op.type, ...extra });
}

/**
 * 1商品分の履歴を再生する
 * @param {Array} ops その商品の全操作（void を含む）
 * @returns {{ok:true, lots:Map, portions:Array, effects:Map, total:number, byLocation:Map, opsActive:Set}|{ok:false,error:DomainError}}
 */
export function replay(ops) {
  const active = activeOpIds(ops);
  const seq = ops.filter((o) => active.has(o.id) && o.type !== 'void').sort(opOrder);
  const lots = new Map(); // lotId -> lot
  const portions = new Map(); // `${lotId}|${locationId}` -> portion
  const effects = new Map();

  const lotFifo = (p) => {
    const l = lots.get(p.lotId);
    return [l.date, l.order, l.seq];
  };
  const fifoCmp = (a, b) => {
    const x = lotFifo(a);
    const y = lotFifo(b);
    return cmp(x[0], y[0]) || x[1] - y[1] || x[2] - y[2];
  };
  const at = (loc) => [...portions.values()].filter((p) => p.locationId === loc && p.qty > 0).sort(fifoCmp);
  const sumAt = (loc) => at(loc).reduce((s, p) => s + p.qty, 0);

  const addPortion = (lotId, loc, qty, detail, op) => {
    const k = `${lotId}|${loc}`;
    const p = portions.get(k);
    if (p) {
      p.qty += qty;
      if (detail != null && detail !== '') p.detail = detail;
      p.lastOpId = op.id;
    } else portions.set(k, { lotId, locationId: loc, qty, detail: detail || '', lastOpId: op.id });
  };

  const take = (op, loc, qty, alloc) => {
    const avail = sumAt(loc);
    if (avail < qty) {
      throw err('INSUFFICIENT', '在庫が不足します', op, { locationId: loc, available: avail, required: qty });
    }
    const taken = [];
    if (Array.isArray(alloc) && alloc.length) {
      const merged = new Map();
      for (const a of alloc) {
        if (!isPosInt(a.qty)) throw err('INVALID_QTY', 'ロット指定の数量が不正です', op);
        merged.set(a.lotId, (merged.get(a.lotId) || 0) + a.qty);
      }
      let sum = 0;
      for (const [lotId, q] of merged) {
        const p = portions.get(`${lotId}|${loc}`);
        if (!p || p.qty <= 0) {
          throw err('LOT_MISSING', '指定した購入分がこの保管場所にありません', op, { lotId, locationId: loc, required: q, available: 0 });
        }
        if (p.qty < q) {
          throw err('LOT_SHORT', '指定した購入分の残数が不足します', op, { lotId, locationId: loc, required: q, available: p.qty });
        }
        sum += q;
      }
      if (sum !== qty) throw err('ALLOC_SUM', `ロット指定の合計(${sum})が数量(${qty})と一致しません`, op, { required: qty, allocated: sum });
      for (const [lotId, q] of merged) {
        portions.get(`${lotId}|${loc}`).qty -= q;
        taken.push({ lotId, qty: q });
      }
    } else {
      let rest = qty;
      for (const p of at(loc)) {
        if (rest === 0) break;
        const q = Math.min(p.qty, rest);
        p.qty -= q;
        rest -= q;
        taken.push({ lotId: p.lotId, qty: q });
      }
    }
    return taken;
  };

  for (const op of seq) {
    try {
      switch (op.type) {
        case 'receive': {
          if (!isPosInt(op.packCount) || !isPosInt(op.packSize) || op.qty !== op.packCount * op.packSize) {
            throw err('INVALID_QTY', '入庫数量が不正です', op);
          }
          if (lots.has(op.lotId)) throw err('DUP_LOT', 'ロットIDが重複しています', op);
          let price = null;
          if (op.amount != null) {
            toCents(op.amount);
            if (op.tax !== 'incl' && op.tax !== 'excl') throw err('INVALID_TAX', '税区分が不正です', op);
            price = { amount: op.amount, qty: op.qty, tax: op.tax };
          }
          lots.set(op.lotId, {
            lotId: op.lotId,
            kind: 'purchase',
            opId: op.id,
            date: op.date,
            order: op.order,
            seq: op.seq,
            initialQty: op.qty,
            packCount: op.packCount,
            packSize: op.packSize,
            price,
            purchaseDate: op.purchaseDate || null,
            supplier: op.supplier || '',
          });
          addPortion(op.lotId, op.locationId, op.qty, op.detail, op);
          effects.set(op.id, { added: [{ lotId: op.lotId, qty: op.qty, locationId: op.locationId }] });
          break;
        }
        case 'consume': {
          if (!isPosInt(op.qty)) throw err('INVALID_QTY', '使用数量は1以上の整数で指定してください', op);
          const taken = take(op, op.locationId, op.qty, op.alloc);
          effects.set(op.id, { taken });
          break;
        }
        case 'move': {
          if (!isPosInt(op.qty)) throw err('INVALID_QTY', '移動数量は1以上の整数で指定してください', op);
          if (op.fromLocationId === op.toLocationId) throw err('SAME_LOCATION', '移動元と移動先が同じです', op);
          const taken = take(op, op.fromLocationId, op.qty, op.alloc);
          for (const t of taken) addPortion(t.lotId, op.toLocationId, t.qty, op.toDetail, op);
          effects.set(op.id, { taken, movedTo: op.toLocationId });
          break;
        }
        case 'adjust': {
          if (!isNonNegInt(op.counted)) throw err('INVALID_QTY', '棚卸し数量は0以上の整数で指定してください', op);
          const current = sumAt(op.locationId);
          const delta = op.counted - current;
          if (delta < 0) {
            const taken = take(op, op.locationId, -delta, op.alloc);
            effects.set(op.id, { delta, before: current, taken });
          } else if (delta > 0) {
            if (op.alloc && op.alloc.length) {
              throw err('ALLOC_SUM', '在庫が増える棚卸しにロット指定はできません（以前の操作の変更により差分が変わりました）', op, { delta });
            }
            if (lots.has(op.lotId)) throw err('DUP_LOT', 'ロットIDが重複しています', op);
            let price = null;
            if (op.unitAmount != null) {
              price = { amount: fromCents(toCents(op.unitAmount) * BigInt(delta)), qty: delta, tax: op.tax };
            }
            lots.set(op.lotId, {
              lotId: op.lotId,
              kind: 'adjust',
              opId: op.id,
              date: op.date,
              order: op.order,
              seq: op.seq,
              initialQty: delta,
              packCount: delta,
              packSize: 1,
              price,
              purchaseDate: null,
              supplier: '',
            });
            addPortion(op.lotId, op.locationId, delta, op.detail, op);
            effects.set(op.id, { delta, before: current, added: [{ lotId: op.lotId, qty: delta, locationId: op.locationId }] });
          } else {
            if (op.alloc && op.alloc.length) {
              throw err('ALLOC_SUM', '差分が0になったためロット指定が適用できません', op, { delta });
            }
            effects.set(op.id, { delta: 0, before: current });
          }
          break;
        }
        default:
          throw err('UNKNOWN_TYPE', `未知の操作種別: ${op.type}`, op);
      }
    } catch (e) {
      if (e instanceof DomainError) return { ok: false, error: e };
      throw e;
    }
  }

  const live = [...portions.values()].filter((p) => p.qty > 0).sort(fifoCmp);
  const byLocation = new Map();
  let total = 0;
  for (const p of live) {
    total += p.qty;
    byLocation.set(p.locationId, (byLocation.get(p.locationId) || 0) + p.qty);
  }
  for (const l of lots.values()) l.remaining = 0;
  for (const p of live) lots.get(p.lotId).remaining += p.qty;
  return { ok: true, lots, portions: live, effects, total, byLocation, opsActive: active };
}

/**
 * 在庫評価額。税込・税抜は別集計、価格未設定分は金額に含めず数量のみ数える。
 * @param portions replay().portions（または特定場所に絞ったもの）
 */
export function valuation(portions, lots) {
  const groups = { incl: { qty: 0, value: Frac.zero() }, excl: { qty: 0, value: Frac.zero() } };
  let unknownQty = 0;
  for (const p of portions) {
    const lot = lots.get(p.lotId);
    if (!lot.price) {
      unknownQty += p.qty;
      continue;
    }
    const g = groups[lot.price.tax];
    g.qty += p.qty;
    g.value = Frac.add(g.value, valueOf(lot.price, p.qty));
  }
  const avg = {};
  for (const k of ['incl', 'excl']) avg[k] = groups[k].qty > 0 ? Frac.divInt(groups[k].value, groups[k].qty) : null;
  const usedGroups = ['incl', 'excl'].filter((k) => groups[k].qty > 0);
  // 全体の評価額・平均単価は「価格未設定なし」かつ「税区分が1種類」のときのみ算出可能
  const computable = unknownQty === 0 && usedGroups.length === 1;
  return {
    groups,
    avg,
    unknownQty,
    usedGroups,
    computable,
    total: computable ? groups[usedGroups[0]].value : null,
    totalTax: computable ? usedGroups[0] : null,
  };
}

/** 箱換算の参考表示。実際の未開封箱数とは異なる */
export function packBreakdown(qty, packSize) {
  if (!isPosInt(packSize) || packSize === 1) return null;
  return { packs: Math.floor(qty / packSize), rest: qty % packSize };
}

/** 在庫状態 */
export function stockStatus(total, threshold) {
  if (threshold == null) return total === 0 ? 'zero' : 'ok';
  if (total === 0) return 'out';
  if (total <= threshold) return 'low';
  return 'ok';
}

export const STATUS_LABEL = { ok: '在庫あり', low: '在庫少', out: '在庫切れ', zero: '在庫0' };
