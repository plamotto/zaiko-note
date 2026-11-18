// 在庫一覧（起動画面）
import { h, icon, clear, openSheet, photoImg } from './dom.js';
import { app, go, itemView, packText, statusBadge, thumb, locChip, searchText, matchQuery, fmtQty, emptyState, scopeLocs, inScope, scopeBar, alertCount } from './views.js';
import { openQuickActions, openOpSheet } from './ops.js';

// 絞り込み状態はセッション中保持（表示形式・並び順は設定に保存）
export const filters = { q: '', categoryId: null, locationId: null, divisionId: null, status: 'all', archived: false };

const SORTS = [
  ['updated', '最近の操作'],
  ['name', '商品名'],
  ['qty', '在庫数'],
  ['unitPrice', '単価'],
  ['purchaseDate', '購入日'],
  ['created', '登録日'],
];

function computeRows(repo) {
  const rows = [];
  const locs = scopeLocs(repo);
  for (const item of repo.items.values()) {
    if (!!item.archived !== filters.archived) continue;
    if (!inScope(repo, item, locs)) continue;
    if (filters.categoryId && (filters.categoryId === '__none' ? item.categoryId : item.categoryId !== filters.categoryId)) continue;
    const v = itemView(repo, item, locs);
    if (filters.locationId && !v.byLoc.some((b) => b.locationId === filters.locationId)) continue;
    if (filters.divisionId && !v.byLoc.some((b) => repo.locations.get(b.locationId)?.divisionId === filters.divisionId)) continue;
    if (filters.status === 'alert' && !(v.status === 'low' || v.status === 'out')) continue;
    if (filters.status === 'out' && v.status !== 'out') continue;
    if (filters.status === 'instock' && v.total === 0) continue;
    if (filters.q && !matchQuery(searchText(repo, item, v), filters.q)) continue;
    rows.push({ item, v });
  }
  const { sortKey, sortDir } = repo.settings;
  const dir = sortDir === 'asc' ? 1 : -1;
  const key = {
    name: (r) => r.item.name,
    qty: (r) => r.v.total,
    unitPrice: (r) => (r.v.unitPrice ? Number(r.v.unitPrice.n) / Number(r.v.unitPrice.d) : null),
    purchaseDate: (r) => r.v.lastPurchase,
    created: (r) => r.item.createdAt,
    updated: (r) => r.v.lastActivity || r.item.updatedAt,
  }[sortKey] || ((r) => r.v.lastActivity || r.item.updatedAt);
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x == null && y == null) return a.item.name.localeCompare(b.item.name, 'ja');
    if (x == null) return 1; // 値なし（算出不可など）は常に末尾
    if (y == null) return -1;
    if (typeof x === 'string') return x.localeCompare(y, 'ja') * dir || a.item.name.localeCompare(b.item.name, 'ja');
    return (x - y) * dir || a.item.name.localeCompare(b.item.name, 'ja');
  });
  return rows;
}

function listRow(repo, { item, v }) {
  const pack = packText(item, v.total);
  const locs = v.byLoc.slice(0, 3).map((b) => locChip(repo, b.locationId, v.byLoc.length > 1 ? b.qty : null));
  if (v.byLoc.length > 3) locs.push(h('span', { class: 'loc' }, `他${v.byLoc.length - 3}か所`));
  const det = v.byLoc.length === 1 ? v.ledger.portions.find((p) => p.locationId === v.byLoc[0].locationId && p.detail)?.detail : null;
  return h(
    'div',
    { class: 'row' },
    h(
      'button',
      { style: { display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0, textAlign: 'left' }, onclick: () => go(`#/item/${item.id}`), 'aria-label': `${item.name} の詳細` },
      thumb(repo, item),
      h(
        'div',
        { class: 'row-main' },
        h('div', { class: 'row-name' }, item.name),
        h('div', { class: 'row-sub' }, statusBadge(v.status), item.archived ? h('span', { class: 'badge arch' }, 'アーカイブ') : null, locs.length ? locs : h('span', { class: 'loc' }, '保管場所なし'), det ? h('span', { class: 'tiny faint' }, det) : null)
      )
    ),
    h(
      'button',
      { class: 'qty-btn', onclick: () => openQuickActions(item), 'aria-label': `${item.name} の在庫操作` },
      h('div', null, h('span', { class: `qty num ${v.status}` }, fmtQty(v.total)), h('span', { class: 'qty-unit' }, item.unit)),
      pack ? h('div', { class: 'qty-pack' }, pack) : null,
      v.allTotal !== v.total ? h('div', { class: 'qty-pack' }, `全体 ${fmtQty(v.allTotal)}`) : null
    )
  );
}

function card(repo, { item, v }) {
  const pid = item.photoIds?.[0];
  const loc = v.byLoc[0] ? repo.locations.get(v.byLoc[0].locationId)?.name + (v.byLoc.length > 1 ? ` 他${v.byLoc.length - 1}` : '') : '保管場所なし';
  const cover = h('div', { class: 'cover' }, pid ? photoImg(repo, pid, 'thumb', '') : icon('box'), statusBadge(v.status));
  return h(
    'div',
    { class: 'card' },
    h('button', { style: { textAlign: 'left', display: 'block', width: '100%' }, onclick: () => go(`#/item/${item.id}`) }, cover, h('div', { class: 'body' }, h('div', { class: 'name' }, item.name), h('div', { class: 'meta' }, loc))),
    h(
      'div',
      { class: 'foot' },
      h('div', null, h('span', { class: `qty num ${v.status}` }, fmtQty(v.total)), h('span', { class: 'qty-unit' }, item.unit)),
      h(
        'div',
        { class: 'stepper-mini' },
        h('button', { 'aria-label': '使用', onclick: () => openOpSheet('consume', item) }, icon('minus')),
        h('button', { class: 'plus', 'aria-label': '入庫', onclick: () => openOpSheet('receive', item) }, icon('plus'))
      )
    )
  );
}

function pickSheet(title, options, current, onPick) {
  const sheet = openSheet({
    title,
    body: h(
      'div',
      { class: 'group', style: { margin: 0 } },
      options.map(([val, label, desc]) =>
        h('button', {
          class: 'cell',
          onclick: () => {
            sheet.close();
            onPick(val);
          },
        }, h('div', { class: 'grow' }, h('div', { class: 'label' }, label), desc ? h('div', { class: 'desc' }, desc) : null), current === val ? icon('check', 'chev') : null)
      )
    ),
  });
}

export function inventoryScreen() {
  const repo = app.repo;
  const el = h('div', { class: 'view' });
  const searchInput = h('input', { type: 'search', placeholder: '商品名・JAN・メーカー・場所で検索', value: filters.q, enterkeyhint: 'search', autocomplete: 'off', 'aria-label': '検索' });
  const clearBtn = h('button', { class: 'clear', 'aria-label': '検索をクリア', onclick: () => ((searchInput.value = ''), (filters.q = ''), update(), searchInput.focus()) }, icon('x'));
  let t;
  searchInput.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      filters.q = searchInput.value;
      update();
    }, 120);
  });
  const viewBtn = h('button', { class: 'icon-btn', 'aria-label': '表示切替', onclick: () => repo.saveSettings({ viewMode: repo.settings.viewMode === 'card' ? 'list' : 'card' }) });
  const sortBtn = h('button', { class: 'icon-btn', 'aria-label': '並び替え', onclick: openSort }, icon('sort'));
  const sub = h('div', { class: 'subtitle' });
  const chips = h('div', { class: 'chips' });
  const scopeHost = h('div');
  const bar = h('header', { class: 'topbar' }, h('div', { class: 'title-row' }, h('h1', null, '在庫'), sortBtn, viewBtn), sub, scopeHost, h('div', { class: 'search', style: { marginTop: '8px' } }, icon('search'), searchInput, clearBtn), chips);
  const banners = h('div');
  const meta = h('div', { class: 'list-meta' });
  const listEl = h('div');
  el.append(bar, banners, meta, listEl);
  const fab = h('button', { class: 'fab', onclick: openAdd }, icon('plus'), '登録・入庫');
  el.appendChild(fab);

  function openSort() {
    const { sortKey, sortDir } = repo.settings;
    const sheet = openSheet({
      title: '並び替え',
      body: h(
        'div',
        { class: 'form' },
        h(
          'div',
          { class: 'group', style: { margin: 0 } },
          SORTS.map(([k, label]) =>
            h('button', {
              class: 'cell',
              onclick: async () => {
                sheet.close();
                const defDir = k === 'name' ? 'asc' : 'desc';
                await repo.saveSettings({ sortKey: k, sortDir: sortKey === k ? (sortDir === 'asc' ? 'desc' : 'asc') : defDir });
              },
            }, h('div', { class: 'grow label' }, label), sortKey === k ? h('span', { class: 'value' }, sortDir === 'asc' ? '昇順 ↑' : '降順 ↓') : null)
          )
        ),
        h('div', { class: 'footnote', style: { padding: '0 4px' } }, '選択中の項目をもう一度タップすると昇順・降順が切り替わります。単価は税区分が混在するなど算出できない商品を末尾に表示します。')
      ),
    });
  }

  function openAdd() {
    const sheet = openSheet({
      title: '登録・入庫',
      body: h(
        'div',
        { class: 'group', style: { margin: 0 } },
        h('button', { class: 'cell', onclick: () => (sheet.close(), go('#/new')) }, h('span', { class: 'lead accent' }, icon('plus')), h('div', { class: 'grow' }, h('div', { class: 'label' }, '新しい商品を登録'), h('div', { class: 'desc' }, 'まだ登録していない商品'))),
        h('button', { class: 'cell', onclick: () => (sheet.close(), setTimeout(openRestockPicker, 150)) }, h('span', { class: 'lead info' }, icon('inbox')), h('div', { class: 'grow' }, h('div', { class: 'label' }, '登録済みの商品を買い足す'), h('div', { class: 'desc' }, '商品を選んで入庫を記録'))),
        h('button', { class: 'cell', onclick: () => (sheet.close(), go('#/scan')) }, h('span', { class: 'lead' }, icon('scan')), h('div', { class: 'grow' }, h('div', { class: 'label' }, 'バーコードで探す'), h('div', { class: 'desc' }, 'JANコードを読み取り')))
      ),
    });
  }

  function update() {
    clear(scopeHost);
    const sb = scopeBar(repo);
    if (sb) scopeHost.appendChild(sb);
    const rows = computeRows(repo);
    const locs = scopeLocs(repo);
    const all = [...repo.items.values()].filter((i) => !i.archived && inScope(repo, i, locs));
    const alerts = alertCount(repo);
    if (locs && filters.locationId && !locs.has(filters.locationId)) filters.locationId = null;
    sub.textContent = `${fmtQty(all.length)}品目${alerts ? ` ・ 要補充 ${alerts}` : ''}`;
    clear(viewBtn).appendChild(icon(repo.settings.viewMode === 'card' ? 'list' : 'grid'));
    clearBtn.classList.toggle('hidden', !searchInput.value);
    // チップ
    clear(chips);
    const chip = (label, on, onclick, cls = '') => h('button', { class: `chip ${cls} ${on ? 'on' : ''}`, onclick }, label);
    chips.append(
      ...[
      chip(h('span', null, '要補充 ', h('span', { class: 'count' }, alerts)), filters.status === 'alert', () => ((filters.status = filters.status === 'alert' ? 'all' : 'alert'), update()), 'warn'),
      chip(filters.status === 'out' ? '在庫切れ' : filters.status === 'instock' ? '在庫あり' : '在庫状態', ['out', 'instock'].includes(filters.status), () =>
        pickSheet('在庫状態', [['all', 'すべて'], ['alert', '要補充（在庫少・在庫切れ）', '警告ラインを設定した商品のみ'], ['out', '在庫切れのみ'], ['instock', '在庫ありのみ']], filters.status, (v) => ((filters.status = v), update()))
      ),
      chip(filters.categoryId ? (filters.categoryId === '__none' ? 'カテゴリ未設定' : repo.categories.get(filters.categoryId)?.name || 'カテゴリ') : 'カテゴリ', !!filters.categoryId, () =>
        pickSheet('カテゴリ', [[null, 'すべて'], ...[...repo.categories.values()].sort((a, b) => a.sort - b.sort).map((c) => [c.id, c.name]), ['__none', '未設定']], filters.categoryId, (v) => ((filters.categoryId = v), update()))
      ),
      chip(filters.locationId ? repo.locations.get(filters.locationId)?.name || '場所' : '保管場所', !!filters.locationId, () =>
        pickSheet('保管場所', [[null, 'すべて'], ...[...repo.locations.values()].filter((l) => !l.archived && (!scopeLocs(repo) || scopeLocs(repo).has(l.id))).sort((a, b) => a.sort - b.sort).map((l) => [l.id, l.name, repo.divisions.get(l.divisionId)?.name])], filters.locationId, (v) => ((filters.locationId = v), update()))
      ),
      locs ? null : chip(filters.divisionId ? repo.divisions.get(filters.divisionId)?.name || '区分' : '管理区分', !!filters.divisionId, () =>
        pickSheet('管理区分', [[null, 'すべて'], ...[...repo.divisions.values()].sort((a, b) => a.sort - b.sort).map((d) => [d.id, d.name])], filters.divisionId, (v) => ((filters.divisionId = v), update()))
      ),
      chip(h('span', null, icon('archive'), 'アーカイブ'), filters.archived, () => ((filters.archived = !filters.archived), update()))
      ].filter(Boolean)
    );
    const anyFilter = filters.q || filters.categoryId || filters.locationId || filters.divisionId || filters.status !== 'all' || filters.archived;
    clear(meta);
    const sortLabel = SORTS.find((s) => s[0] === repo.settings.sortKey)?.[1] || '';
    meta.append(h('span', null, `${fmtQty(rows.length)}件${filters.archived ? '（アーカイブ）' : ''}`), anyFilter ? h('button', { class: 'btn ghost sm', onclick: reset }, '絞り込みを解除') : h('span', null, `${sortLabel}順 ${repo.settings.sortDir === 'asc' ? '↑' : '↓'}`));
    clear(listEl);
    if (!repo.items.size) {
      listEl.appendChild(emptyState('box', 'まだ商品がありません', '右下の「登録・入庫」から最初の商品を登録しましょう。設定 → サンプルデータで操作を試すこともできます。', h('button', { class: 'btn primary', onclick: () => go('#/new') }, icon('plus'), '商品を登録')));
      return;
    }
    if (!rows.length) {
      listEl.appendChild(emptyState('search', '該当する商品がありません', filters.q ? `「${filters.q}」に一致する商品が見つかりません。` : '絞り込み条件を変更してください。', h('button', { class: 'btn', onclick: reset }, '条件をリセット')));
      return;
    }
    const container = h('div', { class: repo.settings.viewMode === 'card' ? 'grid' : 'list' });
    const render = repo.settings.viewMode === 'card' ? card : listRow;
    // 大量件数でも初期表示を軽くするため段階描画
    const first = rows.slice(0, 60);
    for (const r of first) container.appendChild(render(repo, r));
    listEl.appendChild(container);
    if (rows.length > 60) {
      let i = 60;
      const more = () => {
        const end = Math.min(rows.length, i + 100);
        for (; i < end; i++) container.appendChild(render(repo, rows[i]));
        if (i < rows.length) (window.requestIdleCallback || ((f) => setTimeout(f, 16)))(more);
      };
      setTimeout(more, 50);
    }
  }
  function reset() {
    Object.assign(filters, { q: '', categoryId: null, locationId: null, divisionId: null, status: 'all', archived: false });
    searchInput.value = '';
    update();
  }
  update();
  return { el, update, banners };
}

/** 買い足し用：商品検索ピッカー */
export function openRestockPicker() {
  const repo = app.repo;
  const input = h('input', { type: 'search', placeholder: '商品名・JANで検索', autocomplete: 'off' });
  const list = h('div', { class: 'group', style: { margin: '10px 0 0' } });
  const render = () => {
    clear(list);
    const q = input.value;
    const items = [...repo.items.values()].filter((i) => !i.archived && (!q || matchQuery(searchText(repo, i, itemView(repo, i)), q))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 40);
    if (!items.length) list.appendChild(h('div', { class: 'cell muted' }, '該当する商品がありません'));
    for (const it of items) {
      const v = itemView(repo, it);
      list.appendChild(
        h('button', {
          class: 'cell',
          onclick: () => {
            sheet.close();
            setTimeout(() => openOpSheet('receive', it), 150);
          },
        }, thumb(repo, it, 'thumb'), h('div', { class: 'grow' }, h('div', { class: 'label' }, it.name), h('div', { class: 'desc' }, `在庫 ${fmtQty(v.total)}${it.unit}`)), icon('chevR', 'chev'))
      );
    }
  };
  input.addEventListener('input', render);
  const sheet = openSheet({ title: '買い足す商品を選択', body: h('div', null, h('div', { class: 'search' }, icon('search'), input), list) });
  render();
  setTimeout(() => input.focus(), 300);
}
