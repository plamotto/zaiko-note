// 保管場所タブ・場所別在庫・マスター管理（保管場所／管理区分／カテゴリ）
import { h, icon, clear, openSheet, toast, toastError, field, confirmDialog, notice } from './dom.js';
import { app, go, fmtQty, topbar, emptyState, thumb, packText, statusBadge, DIV_COLORS, moneyTiles, computabilityNote, itemView, scopeBar } from './views.js';
import { valuation } from '../core/ledger.js';
import { openQuickActions } from './ops.js';

const DIV_ICON = (name) => (/家|自宅|ホーム/.test(name || '') ? 'home' : /仕事|業務|店|会社/.test(name || '') ? 'briefcase' : 'warehouse');

function locStats(repo) {
  const stats = new Map();
  for (const it of repo.items.values()) {
    const l = repo.ledger(it.id);
    if (!l.ok) continue;
    for (const [loc, q] of l.byLocation) {
      if (!stats.has(loc)) stats.set(loc, { items: 0, qty: 0 });
      const s = stats.get(loc);
      s.items++;
      s.qty += q;
    }
  }
  return stats;
}

export function placesScreen() {
  const repo = app.repo;
  const el = h('div', { class: 'view' });
  const body = h('div');
  const scopeHost = h('div');
  el.append(h('header', { class: 'topbar' }, h('div', { class: 'title-row' }, h('h1', null, '保管場所'), h('button', { class: 'btn ghost sm', onclick: () => go('#/manage/places') }, '編集')), scopeHost), body);
  function update() {
    clear(body);
    clear(scopeHost);
    const sb = scopeBar(repo);
    if (sb) scopeHost.appendChild(sb);
    const scope = repo.divisions.has(repo.settings.scope) ? repo.settings.scope : null;
    const stats = locStats(repo);
    const locs = [...repo.locations.values()].filter((l) => !l.archived).sort((a, b) => a.sort - b.sort);
    if (!locs.length) {
      body.appendChild(emptyState('pin', '保管場所がありません', '倉庫・棚・自宅など、物を置いている場所を登録しましょう。', h('button', { class: 'btn primary', onclick: () => editLocation() }, icon('plus'), '保管場所を追加')));
      return;
    }
    const groups = new Map();
    for (const l of locs) {
      const k = l.divisionId && repo.divisions.has(l.divisionId) ? l.divisionId : '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(l);
    }
    const order = [...[...repo.divisions.values()].sort((a, b) => a.sort - b.sort).map((d) => d.id), ''];
    for (const k of order) {
      if (!groups.has(k)) continue;
      if (scope && k !== scope) continue;
      const div = repo.divisions.get(k);
      const totalItems = groups.get(k).reduce((s, l) => s + (stats.get(l.id)?.items || 0), 0);
      body.appendChild(
        h(
          'div',
          { class: 'section' },
          h('div', { class: 'section-h' }, h('span', null, div?.name || '管理区分なし'), h('span', null, `${groups.get(k).length}か所`)),
          h(
            'div',
            { class: 'group' },
            groups.get(k).map((l) => {
              const s = stats.get(l.id) || { items: 0, qty: 0 };
              return h(
                'button',
                { class: 'cell', onclick: () => go(`#/place/${l.id}`) },
                h('div', { class: 'loc-icon', style: { background: `var(--div-${div?.color || 'slate'})` } }, icon(DIV_ICON(div?.name))),
                h('div', { class: 'grow' }, h('div', { class: 'label' }, l.name), h('div', { class: 'desc' }, s.items ? `${s.items}品目` : '在庫なし', l.memo ? ` ・ ${l.memo}` : '')),
                icon('chevR', 'chev')
              );
            })
          )
        )
      );
    }
    body.appendChild(h('div', { class: 'pad', style: { marginTop: '16px' } }, h('button', { class: 'btn block', onclick: () => editLocation() }, icon('plus'), '保管場所を追加')));
  }
  update();
  return { el, update };
}

export function placeDetailScreen(id) {
  const repo = app.repo;
  const el = h('div', { class: 'view' });
  function update() {
    clear(el);
    const loc = repo.locations.get(id);
    if (!loc) {
      el.append(topbar({ title: '保管場所', back: true }), emptyState('alert', '保管場所が見つかりません', ''));
      return;
    }
    const div = repo.divisions.get(loc.divisionId);
    el.append(topbar({ title: loc.name, back: true, right: h('button', { class: 'icon-btn accent', 'aria-label': '編集', onclick: () => editLocation(loc) }, icon('edit')) }));
    const rows = [];
    const allPortions = [];
    const lotsAll = new Map();
    for (const it of repo.items.values()) {
      const l = repo.ledger(it.id);
      if (!l.ok) continue;
      const q = l.byLocation.get(id);
      if (!q) continue;
      const ps = l.portions.filter((p) => p.locationId === id);
      for (const p of ps) {
        allPortions.push({ ...p, lotId: it.id + '|' + p.lotId });
        lotsAll.set(it.id + '|' + p.lotId, l.lots.get(p.lotId));
      }
      rows.push({ it, q, details: [...new Set(ps.map((p) => p.detail).filter(Boolean))] });
    }
    rows.sort((a, b) => a.it.name.localeCompare(b.it.name, 'ja'));
    el.appendChild(h('div', { class: 'pad small muted' }, `${div ? `管理区分：${div.name}` : '管理区分なし'}${loc.memo ? ` ・ ${loc.memo}` : ''}`));
    if (rows.length) {
      const v = valuation(allPortions, lotsAll);
      el.appendChild(h('div', { class: 'section' }, h('div', { class: 'section-h' }, 'この場所の在庫金額'), h('div', { style: { margin: '0 12px' } }, moneyTiles(v)), computabilityNote(v)));
    }
    el.appendChild(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-h' }, h('span', null, '置いている商品'), h('span', null, `${rows.length}品目`)),
        rows.length
          ? h(
              'div',
              { class: 'list' },
              rows.map(({ it, q, details }) => {
                const st = itemView(repo, it).status;
                return h(
                  'div',
                  { class: 'row' },
                  h('button', { style: { display: 'flex', gap: '12px', alignItems: 'center', flex: 1, minWidth: 0, textAlign: 'left' }, onclick: () => go(`#/item/${it.id}`) }, thumb(repo, it), h('div', { class: 'row-main' }, h('div', { class: 'row-name' }, it.name), h('div', { class: 'row-sub' }, statusBadge(st), details.length ? h('span', { class: 'tiny faint' }, details.join(' / ')) : null, it.archived ? h('span', { class: 'badge arch' }, 'アーカイブ') : null))),
                  h('button', { class: 'qty-btn', onclick: () => openQuickActions(it) }, h('div', null, h('span', { class: 'qty num' }, fmtQty(q)), h('span', { class: 'qty-unit' }, it.unit)), packText(it, q) ? h('div', { class: 'qty-pack' }, packText(it, q)) : null)
                );
              })
            )
          : h('div', { class: 'footnote' }, 'この場所には在庫がありません。')
      )
    );
  }
  update();
  return { el, update };
}

// ───── 編集シート ─────
export function editLocation(loc) {
  const repo = app.repo;
  const name = h('input', { class: 'input', value: loc?.name || '', placeholder: '例：倉庫A、自宅パントリー' });
  const divSel = h('select', { class: 'select' }, h('option', { value: '' }, '管理区分なし'), [...repo.divisions.values()].sort((a, b) => a.sort - b.sort).map((d) => h('option', { value: d.id }, d.name)));
  const scopeDiv = repo.divisions.has(repo.settings.scope) ? repo.settings.scope : null;
  divSel.value = loc?.divisionId || (!loc ? scopeDiv || (repo.divisions.size ? [...repo.divisions.values()][0].id : '') : '');
  const memo = h('input', { class: 'input', value: loc?.memo || '', placeholder: '任意' });
  const err = h('div');
  const save = h('button', { class: 'btn primary block' }, '保存');
  const del = loc ? h('button', { class: 'btn danger block', style: { marginTop: '8px' } }, icon('trash'), 'この保管場所を削除') : null;
  const sheet = openSheet({
    title: loc ? '保管場所を編集' : '保管場所を追加',
    body: h('div', { class: 'form' }, err, field('名前', name, { required: true, hint: '名前を変更しても、商品・履歴との紐づけは維持されます' }), field('管理区分', divSel, { hint: '仕事用・家庭用など。区分は 設定 → マスター管理 で追加できます' }), field('メモ', memo), del),
    footer: save,
  });
  save.addEventListener('click', async () => {
    try {
      await repo.saveLocation({ id: loc?.id, name: name.value, divisionId: divSel.value || null, memo: memo.value });
      sheet.close();
      toast('保存しました');
    } catch (e) {
      clear(err).appendChild(notice('danger', 'alert', e.message));
    }
  });
  del?.addEventListener('click', async () => {
    const use = repo.locationInUse(loc.id);
    if (use.stock > 0) return clear(err).appendChild(notice('danger', 'alert', `この場所には在庫が${fmtQty(use.stock)}点あります。他の場所へ移動してから削除してください。`));
    const ok = await confirmDialog({ title: '保管場所を削除', message: use.refs ? `履歴で${use.refs}件参照されているため、履歴保持のため「非表示」にします（選択肢に表示されなくなります）。` : `「${loc.name}」を削除します。`, ok: use.refs ? '非表示にする' : '削除', danger: true });
    if (!ok) return;
    try {
      const r = await repo.deleteLocation(loc.id);
      sheet.close();
      toast(r === 'archived' ? '非表示にしました' : '削除しました');
      if (location.hash.startsWith('#/place/')) go('#/places');
    } catch (e) {
      toastError(e);
    }
  });
  if (!loc) setTimeout(() => name.focus(), 300);
}

function editSimple(kind, rec) {
  const repo = app.repo;
  const label = kind === 'division' ? '管理区分' : 'カテゴリ';
  const name = h('input', { class: 'input', value: rec?.name || '' });
  let color = rec?.color || 'teal';
  const colors =
    kind === 'division'
      ? h(
          'div',
          { style: { display: 'flex', gap: '10px' } },
          DIV_COLORS.map((c) => {
            const b = h('button', { type: 'button', 'aria-label': c, style: { width: '40px', height: '40px', borderRadius: '20px', background: `var(--div-${c})`, outline: c === color ? '3px solid var(--text)' : 'none', outlineOffset: '2px' } });
            b.addEventListener('click', () => {
              color = c;
              [...colors.children].forEach((x) => (x.style.outline = 'none'));
              b.style.outline = '3px solid var(--text)';
            });
            return b;
          })
        )
      : null;
  const err = h('div');
  const save = h('button', { class: 'btn primary block' }, '保存');
  const del = rec ? h('button', { class: 'btn danger block', style: { marginTop: '8px' } }, icon('trash'), `この${label}を削除`) : null;
  const sheet = openSheet({ title: rec ? `${label}を編集` : `${label}を追加`, body: h('div', { class: 'form' }, err, field('名前', name, { required: true }), colors ? field('色', colors) : null, del), footer: save });
  save.addEventListener('click', async () => {
    try {
      if (kind === 'division') await repo.saveDivision({ id: rec?.id, name: name.value, color });
      else await repo.saveCategory({ id: rec?.id, name: name.value });
      sheet.close();
      toast('保存しました');
    } catch (e) {
      clear(err).appendChild(notice('danger', 'alert', e.message));
    }
  });
  del?.addEventListener('click', async () => {
    const n = kind === 'division' ? [...repo.locations.values()].filter((l) => l.divisionId === rec.id).length : [...repo.items.values()].filter((i) => i.categoryId === rec.id).length;
    const ok = await confirmDialog({ title: `${label}を削除`, message: `「${rec.name}」を削除します。${n ? `\n${kind === 'division' ? '保管場所' : '商品'}${n}件は「未設定」になります（${kind === 'division' ? '場所' : '商品'}自体は削除されません）。` : ''}`, ok: '削除', danger: true });
    if (!ok) return;
    try {
      if (kind === 'division') await repo.deleteDivision(rec.id);
      else await repo.deleteCategory(rec.id);
      sheet.close();
      toast('削除しました');
    } catch (e) {
      toastError(e);
    }
  });
  setTimeout(() => !rec && name.focus(), 300);
}

export function manageScreen(kind = 'places') {
  const repo = app.repo;
  const el = h('div', { class: 'view' });
  const body = h('div');
  el.append(topbar({ title: 'マスター管理', back: true }), body);
  function update() {
    clear(body);
    const cellOf = (label, desc, onclick, lead) => h('button', { class: 'cell', onclick }, lead || null, h('div', { class: 'grow' }, h('div', { class: 'label' }, label), desc ? h('div', { class: 'desc' }, desc) : null), icon('chevR', 'chev'));
    const counts = new Map();
    for (const it of repo.items.values()) counts.set(it.categoryId, (counts.get(it.categoryId) || 0) + 1);
    const stats = locStats(repo);
    body.append(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-h' }, '管理区分'),
        h('div', { class: 'group' }, [...repo.divisions.values()].sort((a, b) => a.sort - b.sort).map((d) => cellOf(d.name, `${[...repo.locations.values()].filter((l) => l.divisionId === d.id && !l.archived).length}か所`, () => editSimple('division', d), h('span', { class: 'lead', style: { background: `var(--div-${d.color})`, color: '#fff' } }, icon(DIV_ICON(d.name))))), h('button', { class: 'cell', onclick: () => editSimple('division') }, h('span', { class: 'lead accent' }, icon('plus')), h('span', { class: 'grow label', style: { color: 'var(--accent-text)' } }, '管理区分を追加'))),
        h('div', { class: 'footnote' }, '保管場所ごとに「仕事用」「家庭用」などの区分を設定できます。同じ商品が両方の区分にあっても商品は1件のまま管理されます。')
      ),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-h' }, '保管場所'),
        h('div', { class: 'group' }, [...repo.locations.values()].filter((l) => !l.archived).sort((a, b) => a.sort - b.sort).map((l) => cellOf(l.name, `${repo.divisions.get(l.divisionId)?.name || '区分なし'} ・ ${stats.get(l.id)?.items || 0}品目`, () => editLocation(l), h('span', { class: 'lead' }, icon('pin')))), h('button', { class: 'cell', onclick: () => editLocation() }, h('span', { class: 'lead accent' }, icon('plus')), h('span', { class: 'grow label', style: { color: 'var(--accent-text)' } }, '保管場所を追加')))
      ),
      (() => {
        const hidden = [...repo.locations.values()].filter((l) => l.archived);
        if (!hidden.length) return null;
        return h('div', { class: 'section' }, h('div', { class: 'section-h' }, '非表示の保管場所（履歴で使用中）'), h('div', { class: 'group' }, hidden.map((l) => h('button', { class: 'cell', onclick: async () => (await repo.saveLocation({ ...l }), toast('再表示しました')) }, h('div', { class: 'grow' }, h('div', { class: 'label' }, l.name), h('div', { class: 'desc' }, 'タップで再表示'))))));
      })(),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-h' }, 'カテゴリ'),
        h('div', { class: 'group' }, [...repo.categories.values()].sort((a, b) => a.sort - b.sort).map((c) => cellOf(c.name, `${counts.get(c.id) || 0}品目`, () => editSimple('category', c), h('span', { class: 'lead' }, icon('tag')))), h('button', { class: 'cell', onclick: () => editSimple('category') }, h('span', { class: 'lead accent' }, icon('plus')), h('span', { class: 'grow label', style: { color: 'var(--accent-text)' } }, 'カテゴリを追加')))
      )
    );
  }
  update();
  return { el, update };
}
