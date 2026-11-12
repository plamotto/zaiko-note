// 画面間で共有する表示ロジック
import { h, icon, photoImg } from './dom.js';
import { valuation, packBreakdown, stockStatus, STATUS_LABEL, OP_LABEL } from '../core/ledger.js';
import { formatFrac, formatUnit, formatMoneyStr, TAX_LABEL } from '../core/money.js';
import { normalizeForSearch } from '../core/text.js';
import { formatDateJa } from '../core/util.js';

export const app = { repo: null, mode: 'main' };

export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

const nf = new Intl.NumberFormat('ja-JP');
export const fmtQty = (n) => nf.format(n);

export const DIV_COLORS = ['teal', 'amber', 'indigo', 'rose', 'slate'];
export function divColor(repo, locationId) {
  const loc = repo.locations.get(locationId);
  const div = loc?.divisionId ? repo.divisions.get(loc.divisionId) : null;
  return `var(--div-${div?.color || 'slate'})`;
}

/** 商品の表示用集計 */
export function itemView(repo, item) {
  const l = repo.ledger(item.id);
  if (!l.ok) return { ok: false, total: 0, status: 'out', byLoc: [], error: l.error };
  const status = stockStatus(l.total, item.threshold);
  const byLoc = [...l.byLocation].map(([locationId, qty]) => ({ locationId, qty })).sort((a, b) => b.qty - a.qty);
  const v = valuation(l.portions, l.lots);
  let unit = null;
  if (v.computable) unit = v.avg[v.totalTax];
  let lastDate = null;
  for (const lot of l.lots.values()) {
    if (lot.kind !== 'purchase') continue;
    const d = lot.purchaseDate || lot.date;
    if (!lastDate || d > lastDate) lastDate = d;
  }
  let lastActivity = item.updatedAt;
  for (const op of repo.itemOps(item.id)) if (op.createdAt > lastActivity) lastActivity = op.createdAt;
  return { ok: true, ledger: l, total: l.total, status, byLoc, valuation: v, unitPrice: unit, lastPurchase: lastDate, lastActivity };
}

export function packText(item, total) {
  const b = packBreakdown(total, item.packSize);
  if (!b) return null;
  const pu = item.packUnit || '箱';
  if (b.packs === 0) return null;
  return `${fmtQty(b.packs)}${pu}${b.rest ? `＋${fmtQty(b.rest)}${item.unit}` : ''}`;
}

export function statusBadge(status) {
  if (status === 'ok') return null;
  return h('span', { class: `badge ${status}` }, STATUS_LABEL[status]);
}

export function thumb(repo, item, cls = 'thumb') {
  const pid = item.photoIds?.[0];
  return h('div', { class: cls }, pid ? photoImg(repo, pid, 'thumb', '') : icon('box'));
}

export function locChip(repo, locationId, qty, unit) {
  const loc = repo.locations.get(locationId);
  return h('span', { class: 'loc' }, h('span', { class: 'dot', style: { background: divColor(repo, locationId) } }), loc?.name ?? '不明', qty != null ? h('b', { class: 'num' }, fmtQty(qty)) : null);
}

/** 検索文字列（商品＋カテゴリ＋場所名） */
export function searchText(repo, item, view) {
  const cat = repo.categories.get(item.categoryId)?.name || '';
  const locs = (view?.byLoc || []).map((b) => repo.locations.get(b.locationId)?.name || '').join(' ');
  return normalizeForSearch([item.name, item.maker, item.model, item.spec, item.jan, item.memo, cat, locs, item.unit].join(' '));
}

export function matchQuery(text, q) {
  const terms = normalizeForSearch(q).split(' ').filter(Boolean);
  return terms.every((t) => text.includes(t));
}

/** 評価額のタイル群（税込・税抜を分けて表示、算出不可を明示） */
export function moneyTiles(v) {
  const tile = (lbl, val, na) => h('div', { class: 'money-tile' }, h('div', { class: 'lbl' }, lbl), h('div', { class: 'val num' + (na ? ' na' : '') }, val));
  const tiles = [];
  for (const k of ['incl', 'excl']) {
    if (v.groups[k].qty) {
      tiles.push(tile(`在庫金額（${TAX_LABEL[k]}）`, formatFrac(v.groups[k].value)));
      tiles.push(tile(`平均単価（${TAX_LABEL[k]}）`, formatUnit(v.avg[k])));
    }
  }
  if (v.unknownQty) tiles.push(tile('価格未設定の数量', fmtQty(v.unknownQty)));
  const totalLbl = '在庫金額（合計）';
  if (!v.usedGroups.length && !v.unknownQty) tiles.push(tile(totalLbl, '—', true));
  else if (!v.computable) tiles.push(tile(totalLbl, '算出不可', true));
  return h('div', { class: 'money-grid' }, tiles);
}

export function computabilityNote(v) {
  if (v.computable || (!v.usedGroups.length && !v.unknownQty)) return null;
  const reasons = [];
  if (v.unknownQty) reasons.push(`価格未設定の在庫が${fmtQty(v.unknownQty)}点あります`);
  if (v.usedGroups.length > 1) reasons.push('税込と税抜の購入分が混在しています（税率換算は行いません）');
  return h('div', { class: 'footnote' }, `合計金額・全体の平均単価は算出不可：${reasons.join('、')}。`);
}

export const OP_ICON = { receive: 'inbox', consume: 'outbox', move: 'move', adjust: 'clipboard', void: 'ban' };

/** 操作1件の表示文言 */
export function describeOp(repo, op, effect) {
  const it = repo.items.get(op.itemId);
  const u = it?.unit || '';
  const L = (id) => repo.locationName(id);
  switch (op.type) {
    case 'receive': {
      const price = op.amount != null ? `${formatMoneyStr(op.amount)}（${TAX_LABEL[op.tax]}）` : '価格未設定';
      const packs = op.packSize > 1 ? `${op.packCount}${op.packUnit || '箱'}×${op.packSize}${u}` : '';
      return { title: `${OP_LABEL.receive}${op.corrects ? '（訂正）' : ''}`, sub: [L(op.locationId) + (op.detail ? `・${op.detail}` : ''), packs, price, op.supplier].filter(Boolean).join(' / '), qty: `+${fmtQty(op.qty)}`, sign: 'plus' };
    }
    case 'consume':
      return { title: `${OP_LABEL.consume}${op.corrects ? '（訂正）' : ''}`, sub: [L(op.locationId), op.alloc?.length ? 'ロット指定' : null, op.memo].filter(Boolean).join(' / '), qty: `−${fmtQty(op.qty)}`, sign: 'minus' };
    case 'move':
      return { title: `${OP_LABEL.move}${op.corrects ? '（訂正）' : ''}`, sub: `${L(op.fromLocationId)} → ${L(op.toLocationId)}${op.toDetail ? `・${op.toDetail}` : ''}`, qty: `⇄${fmtQty(op.qty)}`, sign: '' };
    case 'adjust': {
      const d = effect?.delta ?? op.recordedDelta ?? 0;
      return { title: `${OP_LABEL.adjust}${op.corrects ? '（訂正）' : ''}`, sub: `${L(op.locationId)}・実数 ${fmtQty(op.counted)}${u}${op.memo ? ` / ${op.memo}` : ''}`, qty: d === 0 ? '±0' : d > 0 ? `+${fmtQty(d)}` : `−${fmtQty(-d)}`, sign: d > 0 ? 'plus' : d < 0 ? 'minus' : '' };
    }
    case 'void': {
      const t = repo.ops.get(op.targetId);
      return { title: '取り消し', sub: `${t ? `${formatDateJa(t.date, { withYear: false })}の${OP_LABEL[t.type]}${t.type === 'void' ? '（取り消しの取り消し）' : ''}` : ''}${op.reason ? ` / ${op.reason}` : ''}`, qty: '', sign: '' };
    }
  }
  return { title: op.type, sub: '', qty: '' };
}

export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty-state' }, icon(iconName), h('h3', null, title), h('p', null, text), action || null);
}

export function topbar({ title, back, right, large = false, sub }) {
  const bar = h('header', { class: 'topbar' });
  if (large) {
    bar.appendChild(h('div', { class: 'title-row' }, h('h1', null, title), right || null));
    if (sub) bar.appendChild(h('div', { class: 'subtitle' }, sub));
  } else {
    bar.appendChild(
      h(
        'div',
        { class: 'title-row' },
        back ? h('button', { class: 'nav-back', onclick: () => (typeof back === 'function' ? back() : history.length > 1 ? history.back() : go('#/')) }, icon('chevL'), '戻る') : h('span', { class: 'nav-spacer' }),
        h('h2', null, title),
        right || h('span', { class: 'nav-spacer' })
      )
    );
  }
  return bar;
}
