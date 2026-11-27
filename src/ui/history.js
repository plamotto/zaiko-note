// 履歴タブと履歴詳細（訂正・取り消し）
import { h, icon, clear, openSheet, toast, toastError, confirmDialog, seg } from './dom.js';
import { app, go, receiveBreakdown, describeOp, OP_ICON, fmtQty, topbar, emptyState, thumb, scopeBar, scopeLocs, opInScope } from './views.js';
import { openOpSheet } from './ops.js';
import { OP_LABEL, opOrder } from '../core/ledger.js';
import { formatDateJa, formatDateTime, today } from '../core/util.js';
import { formatMoneyStr, formatUnit, formatPerUnit, unitPrice, TAX_LABEL } from '../core/money.js';
import { normalizeForSearch } from '../core/text.js';

const STATE_LABEL = { active: '有効', voided: '取り消し済み', superseded: '訂正済み（旧内容）', inactive: '無効' };

export function openOpDetail(op) {
  const repo = app.repo;
  const item = repo.items.get(op.itemId);
  const st = repo.opStatuses(op.itemId).get(op.id) || { state: 'inactive' };
  const l = repo.ledger(op.itemId);
  const eff = l.ok ? l.effects.get(op.id) : null;
  const d = describeOp(repo, op, eff);
  const u = item?.unit || '';
  const rows = [
    ['種別', op.corrects ? `${OP_LABEL[op.type]}（訂正）` : OP_LABEL[op.type]],
    ['状態', STATE_LABEL[st.state]],
    [op.type === 'receive' ? '入庫日' : '操作日', formatDateJa(op.date)],
    ['記録日時', formatDateTime(op.createdAt)],
  ];
  if (op.type === 'receive') {
    rows.push(
      ['保管場所', repo.locationName(op.locationId) + (op.detail ? `・${op.detail}` : '')],
      ['購入数量', receiveBreakdown(op, u)],
      ['合計数量', `${fmtQty(op.qty)}${u}`],
      ['購入総額', op.amount != null ? `${formatMoneyStr(op.amount)}（${TAX_LABEL[op.tax]}）` : '価格未設定'],
      ['単価', op.amount != null ? `1${u}あたり ${formatPerUnit(unitPrice({ amount: op.amount, qty: op.qty }))}（${formatUnit(unitPrice({ amount: op.amount, qty: op.qty }))}）` : '—'],
      ['購入日', op.purchaseDate ? formatDateJa(op.purchaseDate) : '—'],
      ['保管日', op.storedDate ? formatDateJa(op.storedDate) : '—'],
      ['購入店', op.supplier || '—']
    );
  } else if (op.type === 'consume') rows.push(['保管場所', repo.locationName(op.locationId)], ['数量', `${fmtQty(op.qty)}${u}`]);
  else if (op.type === 'move') rows.push(['移動元', repo.locationName(op.fromLocationId)], ['移動先', repo.locationName(op.toLocationId) + (op.toDetail ? `・${op.toDetail}` : '')], ['数量', `${fmtQty(op.qty)}${u}`]);
  else if (op.type === 'adjust') {
    rows.push(['保管場所', repo.locationName(op.locationId)], ['実数', `${fmtQty(op.counted)}${u}`], ['差分', eff ? `${eff.delta > 0 ? '+' : ''}${eff.delta}（記録時 ${op.recordedDelta > 0 ? '+' : ''}${op.recordedDelta ?? '—'}）` : `記録時 ${op.recordedDelta ?? '—'}`]);
    if (op.unitAmount != null) rows.push(['増加分単価', `${formatMoneyStr(op.unitAmount)}（${TAX_LABEL[op.tax]}）`]);
  } else if (op.type === 'void') {
    const t = repo.ops.get(op.targetId);
    rows.push(['対象', t ? `${formatDateJa(t.date)} の${OP_LABEL[t.type]}` : '—'], ['理由', op.reason || '—']);
  }
  if (op.memo) rows.push(['メモ', op.memo]);
  if (op.correctionReason) rows.push(['訂正理由', op.correctionReason]);
  if (op.alloc?.length) rows.push(['ロット指定', '手動']);

  const lotLines = (eff?.taken || []).map((t) => {
    const lot = l.lots.get(t.lotId);
    return h('div', { class: 'cell' }, h('div', { class: 'grow' }, h('div', { class: 'label small' }, `${lot ? formatDateJa(lot.date) : ''} ${lot?.kind === 'adjust' ? '棚卸し増加分' : lot?.supplier || '購入分'}`), h('div', { class: 'desc' }, lot?.price ? `${formatUnit(unitPrice(lot.price))}/${u}（${TAX_LABEL[lot.price.tax]}）` : '価格未設定')), h('b', { class: 'num' }, `${fmtQty(t.qty)}${u}`));
  });

  const related = [];
  const by = st.by && repo.ops.get(st.by);
  if (by) related.push(h('button', { class: 'btn sm', onclick: () => (sheet.close(), setTimeout(() => openOpDetail(by), 200)) }, st.state === 'voided' ? '取り消し記録を見る' : '訂正後の内容を見る'));
  if (op.corrects && repo.ops.get(op.corrects)) related.push(h('button', { class: 'btn sm', onclick: () => (sheet.close(), setTimeout(() => openOpDetail(repo.ops.get(op.corrects)), 200)) }, '訂正前の内容を見る'));
  if (op.type === 'void' && repo.ops.get(op.targetId)) related.push(h('button', { class: 'btn sm', onclick: () => (sheet.close(), setTimeout(() => openOpDetail(repo.ops.get(op.targetId)), 200)) }, '取り消した履歴を見る'));

  const actions = [];
  if (st.state === 'active' && op.type !== 'void' && item) {
    actions.push(
      h('button', { class: 'btn', onclick: () => (sheet.close(), setTimeout(() => openOpSheet(op.type, item, { correct: op }), 200)) }, icon('edit'), '訂正'),
      h('button', {
        class: 'btn danger',
        onclick: async () => {
          const reason = await confirmDialog({ title: 'この履歴を取り消しますか？', message: '履歴は削除されず「取り消し済み」として残り、在庫は再計算されます。', ok: '取り消す', danger: true, input: { placeholder: '理由（任意）' } });
          if (reason === false) return;
          try {
            await repo.voidOp(op.id, reason || '');
            sheet.close();
            toast('取り消しました');
          } catch (e) {
            toastError(e);
          }
        },
      }, icon('ban'), '取り消し')
    );
  }
  if (st.state === 'active' && op.type === 'void') {
    actions.push(
      h('button', {
        class: 'btn',
        onclick: async () => {
          try {
            await repo.voidOp(op.id, '取り消しの取り消し');
            sheet.close();
            toast('取り消しを取り消し、元の履歴を有効に戻しました');
          } catch (e) {
            toastError(e);
          }
        },
      }, icon('undo'), '取り消しを取り消す（元に戻す）')
    );
  }

  const sheet = openSheet({
    title: d.title,
    subtitle: item?.name || '（削除された商品）',
    body: h(
      'div',
      { class: 'form' },
      h('div', { class: 'group', style: { margin: 0, padding: '12px 14px' } }, h('dl', { class: 'kv', style: { margin: 0 } }, rows.map(([k, v]) => [h('dt', null, k), h('dd', { class: 'num' }, v)]))),
      lotLines.length ? h('div', null, h('div', { class: 'section-h', style: { padding: '0 4px 6px' } }, op.type === 'move' ? '移動した購入分' : '減らした購入分'), h('div', { class: 'group', style: { margin: 0 } }, lotLines)) : null,
      related.length ? h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, related) : null,
      item ? h('button', { class: 'btn ghost', onclick: () => (sheet.close(), go(`#/item/${item.id}`)) }, '商品を開く', icon('chevR')) : null
    ),
    footer: actions.length ? h('div', { class: 'btn-row' }, actions) : null,
  });
}

export const histFilter = { type: 'all', q: '' };

export function historyScreen(params = {}) {
  const repo = app.repo;
  const el = h('div', { class: 'view' });
  const itemId = params.item || null;
  const typeSeg = seg(
    [
      ['all', 'すべて'],
      ['receive', '入庫'],
      ['consume', '使用'],
      ['move', '移動'],
      ['adjust', '棚卸'],
      ['fix', '訂正等'],
    ],
    histFilter.type,
    (v) => ((histFilter.type = v), update())
  );
  const q = h('input', { type: 'search', placeholder: '商品名で絞り込み', value: histFilter.q, autocomplete: 'off' });
  q.addEventListener('input', () => ((histFilter.q = q.value), update()));
  const listEl = h('div');
  const item = itemId ? repo.items.get(itemId) : null;
  let scopeHost = null;
  const bar = itemId
    ? topbar({ title: item ? `${item.name} の履歴` : '履歴', back: true })
    : h('header', { class: 'topbar' }, h('div', { class: 'title-row' }, h('h1', null, '履歴')), (scopeHost = h('div')), h('div', { class: 'search', style: { marginTop: '6px' } }, icon('search'), q));
  el.append(bar, h('div', { class: 'pad', style: { marginTop: '8px' } }, typeSeg), listEl);

  function update() {
    clear(listEl);
    if (scopeHost) {
      clear(scopeHost);
      const sb = scopeBar(repo);
      if (sb) scopeHost.appendChild(sb);
    }
    const locs = itemId ? null : scopeLocs(repo);
    const statusCache = new Map();
    const stOf = (op) => {
      if (!statusCache.has(op.itemId)) statusCache.set(op.itemId, repo.opStatuses(op.itemId));
      return statusCache.get(op.itemId).get(op.id)?.state;
    };
    const nq = normalizeForSearch(histFilter.q);
    let ops = [...repo.ops.values()].filter((op) => {
      if (itemId && op.itemId !== itemId) return false;
      if (locs && !opInScope(repo, op, locs)) return false;
      const t = histFilter.type;
      if (t === 'fix') {
        if (!(op.type === 'void' || op.corrects || stOf(op) !== 'active')) return false;
      } else if (t !== 'all' && op.type !== t) return false;
      if (nq && !itemId && !normalizeForSearch(repo.items.get(op.itemId)?.name || '').includes(nq)) return false;
      return true;
    });
    ops.sort((a, b) => -opOrder(a, b));
    if (!ops.length) {
      listEl.appendChild(emptyState('clock', '履歴がありません', '入庫・使用などの操作がここに記録されます。'));
      return;
    }
    const total = ops.length;
    ops = ops.slice(0, 500);
    let day = null;
    let group = null;
    for (const op of ops) {
      if (op.date !== day) {
        day = op.date;
        listEl.appendChild(h('div', { class: 'tl-day' }, formatDateJa(op.date)));
        group = h('div', { class: 'group' });
        listEl.appendChild(group);
      }
      const it = repo.items.get(op.itemId);
      const l = repo.ledger(op.itemId);
      const d = describeOp(repo, op, l.ok ? l.effects.get(op.id) : null);
      const s = stOf(op);
      const recDay = today(new Date(op.createdAt));
      const backdated = recDay > op.date && op.type !== 'void';
      group.appendChild(
        h(
          'button',
          { class: 'tl' + (s !== 'active' ? ' inactive' : ''), onclick: () => openOpDetail(op) },
          h('div', { class: `tl-ico ${op.type}` }, icon(OP_ICON[op.type])),
          h(
            'div',
            { class: 'tl-main' },
            h('div', { class: 'tl-title' }, itemId ? d.title : it?.name || '（削除済み）'),
            h('div', { class: 'tl-sub' }, itemId ? '' : `${d.title} ・ `, d.sub),
            s !== 'active' || backdated ? h('div', { style: { marginTop: '3px', display: 'flex', gap: '4px' } }, s === 'voided' ? h('span', { class: 'badge out' }, '取消済') : null, s === 'superseded' ? h('span', { class: 'badge low' }, '訂正済') : null, backdated ? h('span', { class: 'badge info' }, `後日記録 ${formatDateJa(recDay, { withYear: false })}`) : null) : null
          ),
          h('div', { class: `tl-qty num ${d.sign}` }, d.qty, d.qty ? h('div', { class: 'tiny faint', style: { fontWeight: 500 } }, it?.unit || '') : null)
        )
      );
    }
    if (total > ops.length) listEl.appendChild(h('div', { class: 'footnote' }, `最新500件を表示しています（全${fmtQty(total)}件）。すべての履歴は 設定 → CSV出力 から確認できます。`));
  }
  update();
  // 日付見出しをヘッダーの直下に固定（ヘッダーの高さは区分タブの有無で変わる）
  const fixTop = () => el.style.setProperty('--hist-top', `${Math.max(0, bar.getBoundingClientRect().height - 4)}px`);
  requestAnimationFrame(fixTop);
  return { el, update: () => (update(), requestAnimationFrame(fixTop)) };
}
