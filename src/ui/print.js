// 在庫一覧表の印刷（在庫一覧で選んだ商品）
import { h, icon, clear, toast } from './dom.js';
import { app, go, itemView, packText, fmtQty, latestUnitPrice, scopeLocs, topbar, emptyState } from './views.js';
import { formatFrac, TAX_LABEL } from '../core/money.js';
import { Frac } from '../core/money.js';
import { STATUS_LABEL } from '../core/ledger.js';
import { formatDateJa, today } from '../core/util.js';

/** 印刷対象（在庫一覧の選択モードで決める） */
export const printSelection = { ids: [] };

const COLS = [
  ['place', '保管場所', true],
  ['pack', '箱換算', true],
  ['unitPrice', '単価（最新）', true],
  ['value', '在庫金額', true],
  ['jan', 'JANコード', false],
  ['status', '在庫状態', false],
  ['count', '実数記入欄', false],
];

const opts = { title: '在庫一覧表', cols: Object.fromEntries(COLS.map(([k, , on]) => [k, on])) };

export function printScreen() {
  const repo = app.repo;
  const el = h('div', { class: 'view print-view' });
  const items = printSelection.ids.map((id) => repo.items.get(id)).filter(Boolean);
  el.appendChild(topbar({ title: '印刷プレビュー', back: () => go('#/') }));
  if (!items.length) {
    el.appendChild(emptyState('file', '印刷する商品が選ばれていません', '在庫一覧の「選択」から印刷したい商品を選んでください。', h('button', { class: 'btn primary', onclick: () => go('#/') }, '在庫一覧へ')));
    return { el };
  }
  const locs = scopeLocs(repo);
  const scopeName = locs ? repo.divisions.get(repo.settings.scope)?.name : null;

  const titleEl = h('input', { class: 'input', value: opts.title });
  titleEl.addEventListener('input', () => ((opts.title = titleEl.value), render()));
  const colBox = h(
    'div',
    { class: 'print-cols' },
    COLS.map(([k, label]) => {
      const cb = h('input', { type: 'checkbox', checked: opts.cols[k] });
      cb.addEventListener('change', () => ((opts.cols[k] = cb.checked), render()));
      return h('label', { class: 'print-col' }, cb, h('span', null, label));
    })
  );
  const printBtn = h('button', {
    class: 'btn primary block',
    onclick: () => {
      try {
        window.print();
      } catch {
        toast('この環境では印刷画面を開けませんでした。共有ボタン →「プリント」をお試しください', { error: true });
      }
    },
  }, icon('file'), '印刷する');
  el.appendChild(
    h(
      'div',
      { class: 'pad form print-controls', style: { marginTop: '8px' } },
      h('div', { class: 'field' }, h('label', null, '表題'), titleEl),
      h('div', { class: 'field' }, h('label', null, '表示する項目'), colBox),
      printBtn,
      h('div', { class: 'hint' }, `${items.length}品目${scopeName ? `・「${scopeName}」の保管場所にある数量で集計` : ''}。iPhoneでは印刷画面からプリンターを選ぶか、PDFとして共有・保存できます。`)
    )
  );
  const sheet = h('div', { class: 'print-sheet' });
  el.appendChild(sheet);

  function render() {
    clear(sheet);
    const c = opts.cols;
    const head = ['No.', '商品名', c.place && '保管場所', '数量', c.pack && '箱換算', c.unitPrice && '単価', c.value && '在庫金額', c.jan && 'JAN', c.status && '状態', c.count && '実数'].filter(Boolean);
    const totals = { incl: Frac.zero(), excl: Frac.zero(), unknown: 0 };
    const rows = items.map((it, i) => {
      const v = itemView(repo, it, locs);
      const up = latestUnitPrice(repo, it);
      const val = v.ok ? v.valuation : null;
      if (val) {
        for (const k of ['incl', 'excl']) if (val.groups[k].qty) totals[k] = Frac.add(totals[k], val.groups[k].value);
        totals.unknown += val.unknownQty;
      }
      const valueText = !val || (!val.usedGroups.length && !val.unknownQty) ? '—' : val.computable ? `${formatFrac(val.total)}（${TAX_LABEL[val.totalTax]}）` : [...val.usedGroups.map((k) => `${formatFrac(val.groups[k].value)}（${TAX_LABEL[k]}）`), val.unknownQty ? `価格未設定${val.unknownQty}` : null].filter(Boolean).join(' / ');
      const places = v.byLoc
        .map((b) => {
          const dets = [...new Set(v.ledger.portions.filter((p) => p.locationId === b.locationId && p.detail).map((p) => p.detail))];
          return `${repo.locationName(b.locationId)}${dets.length ? `（${dets.join('・')}）` : ''}${v.byLoc.length > 1 ? ` ${fmtQty(b.qty)}` : ''}`;
        })
        .join('\n');
      return h(
        'tr',
        null,
        h('td', { class: 'n' }, i + 1),
        h('td', null, h('div', { class: 'nm' }, it.name), it.spec || it.model ? h('div', { class: 'sub' }, [it.maker, it.model, it.spec].filter(Boolean).join(' ')) : null),
        c.place ? h('td', { class: 'pl' }, places || '—') : null,
        h('td', { class: 'q' }, `${fmtQty(v.total)}${it.unit}`),
        c.pack ? h('td', { class: 'q' }, packText(it, v.total) || '') : null,
        c.unitPrice ? h('td', { class: 'q' }, up ? `${up.text.replace(/^1\S+ /, '')}（${TAX_LABEL[up.tax]}）` : '—') : null,
        c.value ? h('td', { class: 'q' }, valueText) : null,
        c.jan ? h('td', { class: 'q' }, it.jan || '') : null,
        c.status ? h('td', null, STATUS_LABEL[v.status]) : null,
        c.count ? h('td', { class: 'box' }) : null
      );
    });
    const totalText = [totals.incl.n ? `税込 ${formatFrac(totals.incl)}` : null, totals.excl.n ? `税抜 ${formatFrac(totals.excl)}` : null, totals.unknown ? `価格未設定 ${fmtQty(totals.unknown)}点` : null].filter(Boolean).join(' ／ ');
    sheet.append(
      h('div', { class: 'ps-head' }, h('h1', null, opts.title || '在庫一覧表'), h('div', { class: 'ps-meta' }, `${formatDateJa(today())} 現在${scopeName ? ` ・ ${scopeName}` : ''} ・ ${items.length}品目`)),
      h('table', { class: 'ps-table' }, h('thead', null, h('tr', null, head.map((x) => h('th', null, x)))), h('tbody', null, rows)),
      c.value && totalText ? h('div', { class: 'ps-total' }, `在庫金額合計：${totalText}（税込・税抜は別々に合計しています）`) : null
    );
  }
  render();
  return { el, static: true };
}
