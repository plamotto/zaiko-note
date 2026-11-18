// 商品詳細・商品登録/編集
import { h, icon, clear, openSheet, toast, toastError, field, notice, confirmDialog, photoImg, photoUrl, forgetPhoto, pickFile, seg, janWebSearch } from './dom.js';
import { app, go, itemView, packText, statusBadge, fmtQty, moneyTiles, computabilityNote, describeOp, OP_ICON, topbar, divColor, emptyState } from './views.js';
import { openOpSheet } from './ops.js';
import { openOpDetail } from './history.js';
import { processImageFile } from './photo.js';
import { formatDateJa, formatDateTime, uuid } from '../core/util.js';
import { formatUnit, formatMoneyStr, unitPrice, TAX_LABEL } from '../core/money.js';
import { opOrder } from '../core/ledger.js';
import { findDuplicates, janStatus, normalizeJan } from '../core/text.js';

// ───────────── 商品詳細 ─────────────
export function itemDetailScreen(id) {
  const repo = app.repo;
  const el = h('div', { class: 'view' });
  let showEmptyLots = false;
  let slideIndex = 0;

  function update() {
    const item = repo.items.get(id);
    clear(el);
    if (!item) {
      el.append(topbar({ title: '商品', back: true }), emptyState('alert', '商品が見つかりません', '削除された可能性があります。', h('button', { class: 'btn', onclick: () => go('#/') }, '在庫一覧へ')));
      return;
    }
    const v = itemView(repo, item);
    const more = h('button', { class: 'icon-btn accent', 'aria-label': 'その他の操作', onclick: () => openMore(item, v) }, icon('more'));
    const edit = h('button', { class: 'icon-btn accent', 'aria-label': '編集', onclick: () => go(`#/item/${id}/edit`) }, icon('edit'));
    el.append(topbar({ title: '', back: () => (history.length > 1 ? history.back() : go('#/')), right: h('div', { style: { display: 'flex' } }, edit, more) }));

    // 写真
    if (item.photoIds.length) {
      const dots = h('div', { class: 'dots' }, item.photoIds.length > 1 ? item.photoIds.map((_, i) => h('i', { class: i === slideIndex ? 'on' : '' })) : null);
      const slides = h(
        'div',
        { class: 'slides' },
        item.photoIds.map((pid, i) => h('button', { class: 'slide', onclick: () => openPhoto(item, i), 'aria-label': `写真${i + 1}を拡大` }, photoImg(repo, pid, 'main', `${item.name} 写真${i + 1}`)))
      );
      slides.addEventListener('scroll', () => {
        const i = Math.round(slides.scrollLeft / slides.clientWidth);
        if (i !== slideIndex) {
          slideIndex = i;
          [...dots.children].forEach((d, j) => d.classList.toggle('on', j === i));
        }
      }, { passive: true });
      el.appendChild(h('div', { class: 'hero' }, slides, dots));
      requestAnimationFrame(() => (slides.scrollLeft = slideIndex * slides.clientWidth));
    }

    // 見出し
    const cat = repo.categories.get(item.categoryId)?.name;
    el.appendChild(
      h(
        'div',
        { class: 'detail-head' },
        h('h1', null, item.name),
        h('div', { class: 'meta' }, statusBadge(v.status), item.archived ? h('span', { class: 'badge arch' }, 'アーカイブ済み') : null, cat ? h('span', null, cat) : h('span', { class: 'faint' }, 'カテゴリ未設定'), item.maker ? h('span', null, item.maker) : null, item.model ? h('span', null, item.model) : null, item.spec ? h('span', null, item.spec) : null)
      )
    );
    if (!v.ok) {
      el.appendChild(h('div', { class: 'pad' }, notice('danger', 'alert', `在庫履歴に矛盾があります：${repo.explainLedgerError(v.error).message}`)));
    }

    // 在庫パネル
    const pack = packText(item, v.total);
    const maxQ = Math.max(1, ...v.byLoc.map((b) => b.qty));
    el.appendChild(
      h(
        'div',
        { class: 'stock-panel' },
        h('div', { class: 'small muted' }, '現在在庫'),
        h('div', { class: 'stock-big' }, h('span', { class: `qty num ${v.status}` }, fmtQty(v.total)), h('span', { class: 'qty-unit' }, item.unit)),
        pack ? h('div', { class: 'stock-ref' }, `参考：${pack}（1${item.packUnit || '箱'}${fmtQty(item.packSize)}${item.unit}換算・未開封数ではありません）`) : null,
        h('div', { class: 'stock-ref' }, item.threshold != null ? `警告ライン：${fmtQty(item.threshold)}${item.unit}以下で「在庫少」` : '警告ライン未設定（不足警告なし）'),
        v.byLoc.length
          ? h(
              'div',
              { class: 'loc-bars' },
              v.byLoc.map((b) => {
                const dets = [...new Set(v.ledger.portions.filter((p) => p.locationId === b.locationId && p.detail).map((p) => p.detail))];
                return h(
                  'button',
                  { class: 'loc-bar', style: { textAlign: 'left', width: '100%' }, onclick: () => go(`#/place/${b.locationId}`) },
                  h('div', { class: 'top' }, h('span', { class: 'nm' }, h('span', { class: 'dot', style: { width: '8px', height: '8px', borderRadius: '50%', background: divColor(repo, b.locationId), flex: 'none' } }), h('span', null, repo.locationName(b.locationId))), h('b', { class: 'num' }, `${fmtQty(b.qty)}${item.unit}`)),
                  h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(b.qty / maxQ) * 100}%`, background: divColor(repo, b.locationId) } })),
                  dets.length ? h('div', { class: 'det' }, dets.join(' / ')) : null
                );
              })
            )
          : null
      )
    );

    // 操作
    el.appendChild(
      h(
        'div',
        { class: 'actions4' },
        h('button', { class: 'action primary', onclick: () => openOpSheet('receive', item) }, icon('inbox'), '入庫'),
        h('button', { class: 'action', onclick: () => openOpSheet('consume', item) }, icon('outbox'), '使用'),
        h('button', { class: 'action', onclick: () => openOpSheet('move', item) }, icon('move'), '移動'),
        h('button', { class: 'action', onclick: () => openOpSheet('adjust', item) }, icon('clipboard'), '棚卸し')
      )
    );

    // 金額
    if (v.ok && (v.valuation.usedGroups.length || v.valuation.unknownQty)) {
      el.appendChild(h('div', { class: 'section' }, h('div', { class: 'section-h' }, '在庫金額'), h('div', { style: { margin: '0 12px' } }, moneyTiles(v.valuation)), computabilityNote(v.valuation)));
    }

    // ロット
    if (v.ok && v.ledger.lots.size) {
      const lots = [...v.ledger.lots.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.seq - a.seq));
      const shown = lots.filter((l) => showEmptyLots || l.remaining > 0);
      const emptyCount = lots.length - lots.filter((l) => l.remaining > 0).length;
      el.appendChild(
        h(
          'div',
          { class: 'section' },
          h('div', { class: 'section-h' }, h('span', null, '購入分（ロット）別の残数'), emptyCount ? h('button', { class: 'btn ghost sm', onclick: () => ((showEmptyLots = !showEmptyLots), update()) }, showEmptyLots ? '使い切りを隠す' : `使い切り ${emptyCount}件を表示`) : null),
          h(
            'div',
            { class: 'group' },
            shown.map((lot) => {
              const op = repo.ops.get(lot.opId);
              const locs = v.ledger.portions.filter((p) => p.lotId === lot.lotId).map((p) => `${repo.locationName(p.locationId)} ${fmtQty(p.qty)}`);
              const price = lot.price ? `${formatUnit(unitPrice(lot.price))}/${item.unit}・${TAX_LABEL[lot.price.tax]}` : '価格未設定';
              const packs = lot.kind === 'purchase' && lot.packSize > 1 ? `${lot.packCount}${op?.packUnit || '箱'}×${lot.packSize}` : `${fmtQty(lot.initialQty)}${item.unit}`;
              return h(
                'button',
                { class: 'lot' + (lot.remaining ? '' : ' empty'), style: { width: '100%', textAlign: 'left' }, onclick: () => op && openOpDetail(op) },
                h('div', { class: 'l1' }, `${formatDateJa(lot.date)} ${lot.kind === 'adjust' ? '棚卸し増加' : '入庫'}`),
                h('div', { class: 'r1 num' }, `${fmtQty(lot.remaining)} / ${fmtQty(lot.initialQty)}`),
                h('div', { class: 'l2' }, [lot.supplier, packs, lot.price ? `計 ${formatMoneyStr(lot.price.amount)}` : null].filter(Boolean).join(' ・ ')),
                h('div', { class: 'r2' }, price),
                locs.length ? h('div', { class: 'l2', style: { gridColumn: '1 / -1' } }, locs.join(' / ')) : null,
                h('div', { class: 'meter' }, h('i', { style: { width: `${(lot.remaining / lot.initialQty) * 100}%` } }))
              );
            })
          )
        )
      );
    }

    // 履歴（直近）
    const ops = [...repo.itemOps(id)].sort((a, b) => -opOrder(a, b)).slice(0, 8);
    const st = repo.opStatuses(id);
    el.appendChild(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-h' }, h('span', null, '最近の履歴'), h('button', { class: 'btn ghost sm', onclick: () => go(`#/history?item=${id}`) }, 'すべて表示')),
        ops.length
          ? h(
              'div',
              { class: 'group' },
              ops.map((op) => {
                const d = describeOp(repo, op, v.ok ? v.ledger.effects.get(op.id) : null);
                const s = st.get(op.id)?.state;
                return h(
                  'button',
                  { class: 'tl' + (s !== 'active' ? ' inactive' : ''), onclick: () => openOpDetail(op) },
                  h('div', { class: `tl-ico ${op.type}` }, icon(OP_ICON[op.type])),
                  h('div', { class: 'tl-main' }, h('div', { class: 'tl-title' }, d.title, s === 'voided' ? ' ・取消済' : s === 'superseded' ? ' ・訂正済' : ''), h('div', { class: 'tl-sub' }, `${formatDateJa(op.date, { withYear: false })} ・ ${d.sub}`)),
                  h('div', { class: `tl-qty num ${d.sign}` }, d.qty)
                );
              })
            )
          : h('div', { class: 'footnote' }, 'まだ履歴がありません。「入庫」から在庫を記録してください。')
      )
    );

    // 情報
    const rows = [
      ['単位', item.unit],
      ['JANコード', item.jan || '—'],
      ['標準入数', item.packSize ? `${fmtQty(item.packSize)}${item.unit}/${item.packUnit || '箱'}` : '—'],
      ['最終購入', v.lastPurchase ? formatDateJa(v.lastPurchase) : '—'],
      ['登録日時', formatDateTime(item.createdAt)],
      ['更新日時', formatDateTime(item.updatedAt)],
    ];
    el.appendChild(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-h' }, '商品情報'),
        h(
          'div',
          { class: 'group', style: { padding: '12px 14px' } },
          h('dl', { class: 'kv', style: { margin: 0 } }, rows.map(([k, val]) => [h('dt', null, k), h('dd', { class: 'num' }, val)])),
          item.urls?.length ? h('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' } }, item.urls.map((u) => h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: 'small', style: { overflowWrap: 'anywhere' } }, icon('link', 'inline'), ' ', u))) : null,
          item.memo ? h('p', { class: 'small', style: { margin: '10px 0 0', whiteSpace: 'pre-wrap' } }, item.memo) : null
        )
      )
    );
    el.querySelectorAll('svg.inline').forEach((s) => Object.assign(s.style, { width: '14px', height: '14px', verticalAlign: '-2px' }));
  }

  function openPhoto(item, i) {
    const img = photoImg(repo, item.photoIds[i], 'main', '');
    img.style.cssText = 'width:100%;border-radius:12px;display:block';
    openSheet({ title: `${item.name}`, subtitle: `写真 ${i + 1}/${item.photoIds.length}${i === 0 ? '（メイン）' : ''}`, body: img });
  }

  function openMore(item, v) {
    const sheet = openSheet({
      title: '商品の操作',
      subtitle: item.name,
      body: h(
        'div',
        { class: 'group', style: { margin: 0 } },
        h('button', { class: 'cell', onclick: () => (sheet.close(), go(`#/item/${id}/edit`)) }, h('span', { class: 'lead' }, icon('edit')), h('span', { class: 'grow label' }, '商品情報を編集')),
        h('button', { class: 'cell', onclick: () => (sheet.close(), go(`#/history?item=${id}`)) }, h('span', { class: 'lead' }, icon('clock')), h('span', { class: 'grow label' }, 'この商品の履歴')),
        item.archived
          ? h('button', { class: 'cell', onclick: async () => (sheet.close(), await repo.setArchived(id, false), toast('アーカイブを解除しました')) }, h('span', { class: 'lead accent' }, icon('unarchive')), h('span', { class: 'grow label' }, 'アーカイブを解除'))
          : h('button', { class: 'cell', onclick: () => (sheet.close(), archive(item, v)) }, h('span', { class: 'lead warn' }, icon('archive')), h('div', { class: 'grow' }, h('div', { class: 'label' }, 'アーカイブ'), h('div', { class: 'desc' }, '一覧から隠します。履歴は保持されます'))),
        h('button', { class: 'cell danger', onclick: () => (sheet.close(), destroy(item)) }, h('span', { class: 'lead danger' }, icon('trash')), h('div', { class: 'grow' }, h('div', { class: 'label' }, '完全に削除'), h('div', { class: 'desc' }, '写真・履歴も削除されます（元に戻せません）')))
      ),
    });
  }

  async function archive(item, v) {
    if (v.total > 0) {
      const ok = await confirmDialog({ title: '在庫が残っています', message: `「${item.name}」は在庫が${fmtQty(v.total)}${item.unit}残っています。\nアーカイブしても在庫・履歴は保持されますが、在庫一覧には表示されなくなります。`, ok: 'アーカイブする', danger: true });
      if (!ok) return;
    }
    try {
      await repo.setArchived(id, true);
      toast('アーカイブしました', { action: '元に戻す', onAction: () => repo.setArchived(id, false) });
    } catch (e) {
      toastError(e);
    }
  }

  async function destroy(item) {
    const n = repo.itemOps(id).length;
    const ok = await confirmDialog({
      title: '完全に削除しますか？',
      message: `「${item.name}」と、その写真${item.photoIds.length}枚・履歴${n}件を削除します。カテゴリや保管場所、他の商品は削除されません。\nこの操作は元に戻せません。確認のため「削除」と入力してください。`,
      ok: '完全に削除',
      danger: true,
      input: { placeholder: '削除', match: '削除' },
    });
    if (!ok) return;
    try {
      for (const pid of item.photoIds) forgetPhoto(repo, pid);
      await repo.deleteItemPermanently(id);
      toast('削除しました');
      go('#/');
    } catch (e) {
      toastError(e);
    }
  }

  update();
  return { el, update };
}

// ───────────── 商品登録・編集 ─────────────
const UNITS = ['個', '本', '枚', '袋', '箱', '巻', 'ロール', 'セット', 'パック', '組', 'kg', 'L', 'm'];

export function itemFormScreen(id, params = {}) {
  const repo = app.repo;
  const prev = id ? repo.items.get(id) : null;
  const el = h('div', { class: 'view' });
  if (id && !prev) {
    el.append(topbar({ title: '編集', back: true }), emptyState('alert', '商品が見つかりません', ''));
    return { el };
  }
  const dupIgnored = new Set();
  // 写真の作業状態
  const photos = (prev?.photoIds || []).map((pid) => ({ id: pid, existing: true }));
  const added = new Map(); // id -> processed
  const removed = [];
  let dirty = false;

  const nameEl = h('input', { class: 'input', placeholder: '例：ニトリル手袋 M 粉なし', value: prev?.name || params.name || '', autocomplete: 'off', enterkeyhint: 'next' });
  const unitEl = h('input', { class: 'input', placeholder: '例：個', value: prev?.unit || '', list: 'dl-units', style: { maxWidth: '140px' } });
  const unitChips = h('div', { class: 'chips', style: { padding: '2px 0 0', margin: 0 } });
  const renderUnitChips = () => {
    clear(unitChips);
    for (const u of UNITS) unitChips.appendChild(h('button', { type: 'button', class: 'chip' + (unitEl.value === u ? ' on' : ''), onclick: () => ((unitEl.value = u), renderUnitChips(), (dirty = true)) }, u));
  };
  unitEl.addEventListener('input', renderUnitChips);
  renderUnitChips();
  const catSel = h('select', { class: 'select' });
  const fillCats = (v) => {
    clear(catSel);
    catSel.append(h('option', { value: '' }, '未設定'), ...[...repo.categories.values()].sort((a, b) => a.sort - b.sort).map((c) => h('option', { value: c.id }, c.name)), h('option', { value: '__new' }, '＋ 新しいカテゴリ…'));
    catSel.value = v || '';
  };
  fillCats(prev?.categoryId);
  let lastCat = catSel.value;
  catSel.addEventListener('change', async () => {
    if (catSel.value !== '__new') return (lastCat = catSel.value);
    const name = await confirmDialog({ title: '新しいカテゴリ', ok: '追加', input: { placeholder: 'カテゴリ名', required: true } });
    if (!name) return (catSel.value = lastCat);
    try {
      const c = await repo.saveCategory({ name });
      fillCats(c.id);
      lastCat = c.id;
    } catch (e) {
      toastError(e);
      catSel.value = lastCat;
    }
  });
  const janEl = h('input', { class: 'input num', inputmode: 'numeric', placeholder: '13桁または8桁', value: prev?.jan || params.jan || '', autocomplete: 'off' });
  const janHint = h('div', { class: 'hint' });
  const thrEl = h('input', { class: 'input num', inputmode: 'numeric', placeholder: '未設定', value: prev?.threshold ?? '' });
  const makerEl = h('input', { class: 'input', value: prev?.maker || '', list: 'dl-makers' });
  const modelEl = h('input', { class: 'input', value: prev?.model || '' });
  const specEl = h('input', { class: 'input', placeholder: '例：Mサイズ / 30cm×100m', value: prev?.spec || '' });
  const packSizeEl = h('input', { class: 'input num', inputmode: 'numeric', placeholder: '例：100', value: prev?.packSize ?? '' });
  const packUnitEl = h('input', { class: 'input', placeholder: '例：箱', value: prev?.packUnit || '' });
  const urlsEl = h('textarea', { class: 'textarea', placeholder: 'https://…（1行に1つ）', inputmode: 'url' });
  urlsEl.value = (prev?.urls || []).join('\n');
  const memoEl = h('textarea', { class: 'textarea', placeholder: '保管のコツ、使い方など' });
  memoEl.value = prev?.memo || '';
  const errBox = h('div');
  const dupBox = h('div');
  const photoStrip = h('div', { class: 'photo-strip' });

  // ── 写真 ──
  async function addFiles(files) {
    for (const f of files) {
      try {
        const p = await processImageFile(f);
        const pid = uuid();
        added.set(pid, { ...p, id: pid });
        photos.push({ id: pid, url: URL.createObjectURL(new Blob([p.thumb], { type: 'image/jpeg' })) });
        dirty = true;
      } catch (e) {
        toastError(e);
      }
    }
    renderPhotos();
  }
  function renderPhotos() {
    clear(photoStrip);
    photos.forEach((p, i) => {
      const img = p.existing ? photoImg(repo, p.id, 'thumb', '') : h('img', { src: p.url, alt: '' });
      const mv = (d) => {
        const j = i + d;
        if (j < 0 || j >= photos.length) return;
        [photos[i], photos[j]] = [photos[j], photos[i]];
        dirty = true;
        renderPhotos();
      };
      photoStrip.appendChild(
        h(
          'div',
          { class: 'photo-tile' },
          img,
          i === 0 ? h('span', { class: 'main-tag' }, 'メイン') : null,
          h('button', {
            type: 'button',
            class: 'x',
            'aria-label': '写真を削除',
            onclick: () => {
              photos.splice(i, 1);
              if (p.existing) removed.push(p.id);
              else added.delete(p.id);
              dirty = true;
              renderPhotos();
            },
          }, icon('x')),
          photos.length > 1 ? h('div', { class: 'mv' }, i > 0 ? h('button', { type: 'button', 'aria-label': '前へ', onclick: () => mv(-1) }, icon('chevL')) : null, i < photos.length - 1 ? h('button', { type: 'button', 'aria-label': '後へ', onclick: () => mv(1) }, icon('chevR')) : null) : null
        )
      );
    });
    photoStrip.append(
      h('button', { type: 'button', class: 'photo-add', onclick: async () => addFiles(await pickFile('image/*', { capture: 'environment' })) }, icon('camera'), '撮影'),
      h('button', { type: 'button', class: 'photo-add', onclick: async () => addFiles(await pickFile('image/*', { multiple: true })) }, icon('image'), 'ライブラリ')
    );
  }
  renderPhotos();

  // ── 重複チェック ──
  function checkDup() {
    clear(dupBox);
    const name = nameEl.value.trim();
    const jan = normalizeJan(janEl.value);
    if (!name && !jan) return [];
    const dups = findDuplicates({ name, jan }, [...repo.items.values()], { excludeId: id }).filter((d) => !dupIgnored.has(d.item.id));
    if (!dups.length) return [];
    const label = { jan: 'JANコードが一致', 'name-exact': '同じ商品名', 'name-similar': '似た商品名' };
    dupBox.appendChild(
      h(
        'div',
        { class: 'notice warn', style: { flexDirection: 'column', gap: '8px' } },
        h('div', { style: { display: 'flex', gap: '8px' } }, icon('alert'), h('b', null, '登録済みの商品と重複している可能性があります')),
        dups.slice(0, 3).map((d) =>
          h(
            'div',
            { class: 'group', style: { margin: 0, width: '100%' } },
            h('div', { class: 'cell' }, h('div', { class: 'grow' }, h('div', { class: 'label text' }, d.item.name, d.item.archived ? '（アーカイブ）' : ''), h('div', { class: 'desc' }, `${label[d.reason]}・在庫 ${fmtQty(repo.ledger(d.item.id).total ?? 0)}${d.item.unit}`))),
            id
              ? null
              : h(
                  'div',
                  { class: 'btn-row', style: { padding: '0 10px 10px' } },
                  h('button', {
                    type: 'button',
                    class: 'btn primary sm',
                    onclick: () => {
                      dirty = false;
                      go(`#/item/${d.item.id}`);
                      setTimeout(() => openOpSheet('receive', repo.items.get(d.item.id)), 250);
                    },
                  }, 'この商品に入庫'),
                  h('button', { type: 'button', class: 'btn sm', onclick: () => (dupIgnored.add(d.item.id), checkDup()) }, '別商品として登録')
                )
          )
        )
      )
    );
    return dups;
  }
  function updateJanHint() {
    const s = janStatus(janEl.value);
    janHint.textContent = s === 'checksum' ? 'チェックデジットが一致しません（社内コード等ならそのまま登録できます）' : s === 'invalid' ? '数字のみ入力してください' : s === 'valid' ? '✓ 有効なJANコード' : 'バーコードを読み取るか手入力';
    janHint.style.color = s === 'valid' ? 'var(--accent-text)' : s === 'empty' ? '' : 'var(--warn)';
  }
  nameEl.addEventListener('blur', checkDup);
  janEl.addEventListener('input', () => {
    updateJanHint();
    if (normalizeJan(janEl.value).length >= 8) checkDup();
  });
  updateJanHint();
  for (const x of [nameEl, unitEl, catSel, janEl, thrEl, makerEl, modelEl, specEl, packSizeEl, packUnitEl, urlsEl, memoEl]) x.addEventListener('input', () => (dirty = true));

  const scanBtn = h('button', {
    type: 'button',
    class: 'btn sm',
    style: { minHeight: '48px' },
    onclick: async () => {
      const { scanOnce } = await import('./scan.js');
      const code = await scanOnce();
      if (code) {
        janEl.value = code;
        janEl.dispatchEvent(new Event('input'));
      }
    },
  }, icon('scan'), 'スキャン');

  const detailsOpen = !!(prev && (prev.maker || prev.model || prev.spec || prev.packSize || prev.urls?.length || prev.memo));
  const discBtn = h('button', { type: 'button', class: 'disclosure' + (detailsOpen ? ' open' : '') }, h('span', null, '詳細項目（メーカー・型番・入数・URL・メモ）'), icon('chevR'));
  const details = h(
    'div',
    { class: 'form' + (detailsOpen ? '' : ' hidden') },
    h('div', { class: 'row2' }, field('メーカー・ブランド', makerEl), field('型番・品番', modelEl)),
    field('規格・サイズ', specEl),
    h('div', { class: 'row2' }, field('標準入数', packSizeEl, { hint: `1箱・1袋あたりの${unitEl.value || '数量'}` }), field('入れ物の単位', packUnitEl)),
    field('よく使う商品URL', urlsEl),
    field('メモ', memoEl)
  );
  discBtn.addEventListener('click', () => {
    discBtn.classList.toggle('open');
    details.classList.toggle('hidden');
  });

  const saveBtn = h('button', { class: 'btn primary block' }, icon('check'), prev ? '保存' : '登録');
  const form = h(
    'div',
    { class: 'form pad', style: { paddingTop: '8px' } },
    h('datalist', { id: 'dl-units' }, UNITS.map((u) => h('option', { value: u }))),
    h('datalist', { id: 'dl-makers' }, [...new Set([...repo.items.values()].map((i) => i.maker).filter(Boolean))].map((m) => h('option', { value: m }))),
    errBox,
    field('写真', photoStrip, { hint: '先頭がメイン写真になります。写真なしでも登録できます。' }),
    field('商品名', nameEl, { required: true }),
    dupBox,
    field('基本数量単位', h('div', null, unitEl, unitChips), { required: true, hint: '在庫はこの単位（最小管理単位）で数えます' }),
    h('div', { class: 'row2' }, field('カテゴリ', catSel), field('警告ライン', thrEl, { hint: 'この数以下で「在庫少」' })),
    field('JANコード', h('div', { class: 'inline-row' }, janEl, scanBtn)),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: '-8px' } }, janHint, h('button', { type: 'button', class: 'btn ghost sm', style: { flex: 'none' }, onclick: () => (janEl.value.trim() ? janWebSearch(janEl.value) : toast('JANコードを入力してください')) }, icon('search'), 'ネットで調べる')),
    discBtn,
    details,
    h('div', { style: { marginTop: '8px' } }, saveBtn),
    prev ? null : h('div', { class: 'footnote', style: { padding: 0, textAlign: 'center' } }, '登録後、続けて最初の入庫を記録できます。在庫0のまま登録することもできます。')
  );

  const cancel = async () => {
    if (dirty && !(await confirmDialog({ title: '変更を破棄しますか？', message: '入力内容は保存されません。', ok: '破棄', danger: true }))) return;
    dirty = false;
    history.length > 1 ? history.back() : go(prev ? `#/item/${id}` : '#/');
  };
  el.append(topbar({ title: prev ? '商品を編集' : '新しい商品', back: cancel, right: h('button', { class: 'btn ghost sm', onclick: () => saveBtn.click() }, prev ? '保存' : '登録') }), form);

  saveBtn.addEventListener('click', async () => {
    clear(errBox);
    const dups = checkDup();
    if (!prev && dups.some((d) => d.reason !== 'name-similar')) {
      const ok = await confirmDialog({ title: '重複の可能性があります', message: `「${dups[0].item.name}」と${dups[0].reason === 'jan' ? 'JANコード' : '商品名'}が一致しています。\n同じ商品なら既存商品に入庫してください。別の商品として登録しますか？`, ok: '別商品として登録' });
      if (!ok) return;
    }
    saveBtn.disabled = true;
    try {
      const rec = await repo.saveItem(
        {
          id: prev?.id,
          name: nameEl.value,
          unit: unitEl.value,
          categoryId: catSel.value === '__new' ? null : catSel.value || null,
          jan: janEl.value,
          threshold: thrEl.value,
          maker: makerEl.value,
          model: modelEl.value,
          spec: specEl.value,
          packSize: packSizeEl.value,
          packUnit: packUnitEl.value,
          urls: urlsEl.value,
          memo: memoEl.value,
          photoIds: photos.map((p) => p.id),
        },
        { add: [...added.values()].filter((p) => photos.some((x) => x.id === p.id)), removeIds: removed }
      );
      for (const pid of removed) forgetPhoto(repo, pid);
      dirty = false;
      if (prev) {
        toast('保存しました');
        history.length > 1 ? history.back() : go(`#/item/${rec.id}`);
      } else {
        go(`#/item/${rec.id}`);
        const ok = await confirmDialog({ title: '登録しました', message: `「${rec.name}」を登録しました。続けて入庫（購入）を記録しますか？`, ok: '入庫を記録', cancel: 'あとで' });
        if (ok) openOpSheet('receive', repo.items.get(rec.id));
      }
    } catch (e) {
      errBox.appendChild(notice('danger', 'alert', e.message));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      saveBtn.disabled = false;
    }
  });

  if (!prev) setTimeout(() => !params.jan && nameEl.focus(), 350);
  if (params.jan) setTimeout(checkDup, 0);
  return { el, static: true, isDirty: () => dirty };
}
