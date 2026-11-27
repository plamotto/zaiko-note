// 在庫操作シート：入庫・使用・移動・棚卸し（新規／訂正）
import { h, icon, openSheet, toast, toastError, field, seg, stepper, notice, confirmDialog, clear } from './dom.js';
import { app, fmtQty, packText, itemView, go, divColor, scopeLocs } from './views.js';
import { today, formatDateJa, parseIntStrict } from '../core/util.js';
import { parseMoneyInput, unitPrice, formatUnit, formatPerUnit, formatMoneyStr, formatFrac, Frac, toCents, TAX_LABEL } from '../core/money.js';
import { OP_LABEL, replay } from '../core/ledger.js';

const TITLES = { receive: '入庫', consume: '使用', move: '移動', adjust: '棚卸し' };

/** 新しい保管場所を名前と管理区分を指定して追加（区分は表示中のタブを初期値にする） */
export function promptNewLocation(repo) {
  return new Promise((resolve) => {
    let done = false;
    const name = h('input', { class: 'input', placeholder: '例：押入れ、車のトランク' });
    const divs = [...repo.divisions.values()].sort((a, b) => a.sort - b.sort);
    const scope = repo.divisions.has(repo.settings.scope) ? repo.settings.scope : divs[0]?.id || '';
    const divSel = h('select', { class: 'select' }, h('option', { value: '' }, '管理区分なし'), divs.map((d) => h('option', { value: d.id }, d.name)));
    divSel.value = scope;
    const err = h('div');
    const save = h('button', { class: 'btn primary block' }, '追加');
    const sheet = openSheet({
      title: '新しい保管場所',
      body: h('div', { class: 'form' }, err, field('場所の名前', name, { required: true }), divs.length ? field('管理区分', divSel, { hint: '仕事用・プライベートなど。あとから 保管場所タブ → 場所 → 編集 で変更できます' }) : null),
      footer: save,
      onClose: () => !done && resolve(null),
    });
    save.addEventListener('click', async () => {
      try {
        const loc = await repo.saveLocation({ name: name.value, divisionId: divSel.value || null });
        done = true;
        sheet.close();
        toast(`保管場所「${loc.name}」を追加しました${loc.divisionId ? `（${repo.divisions.get(loc.divisionId)?.name}）` : ''}`);
        resolve(loc);
      } catch (e) {
        clear(err).appendChild(notice('danger', 'alert', e.message));
      }
    });
    setTimeout(() => name.focus(), 300);
  });
}

export function locationSelect(repo, { value, stock, exclude, allowNew = true, scoped = true, placeholder = '保管場所を選択', onChange }) {
  const sel = h('select', { class: 'select' });
  const fill = (v) => {
    clear(sel);
    sel.appendChild(h('option', { value: '' }, placeholder));
    const groups = new Map();
    // 仕事用・プライベートなどのタブを選んでいるときは、その区分の場所だけを候補にする
    const sl = scoped ? scopeLocs(repo) : null;
    for (const loc of [...repo.locations.values()].sort((a, b) => a.sort - b.sort)) {
      if (loc.archived && loc.id !== v) continue;
      if (sl && !sl.has(loc.id) && loc.id !== v) continue;
      if (exclude && exclude === loc.id) continue;
      if (stock && !stock.has(loc.id)) continue;
      const key = loc.divisionId || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(loc);
    }
    const scope = repo.settings.scope;
    const ordered = [...groups].sort((a, b) => (b[0] === scope) - (a[0] === scope));
    for (const [divId, locs] of ordered) {
      const og = h('optgroup', { label: repo.divisions.get(divId)?.name || '区分なし' });
      for (const l of locs) og.appendChild(h('option', { value: l.id }, stock ? `${l.name}（在庫 ${fmtQty(stock.get(l.id))}）` : l.name));
      sel.appendChild(og);
    }
    if (allowNew) sel.appendChild(h('option', { value: '__new' }, '＋ 新しい保管場所を追加…'));
    sel.value = v || '';
  };
  fill(value);
  let last = value || '';
  sel.addEventListener('change', async () => {
    if (sel.value === '__new') {
      const loc = await promptNewLocation(repo);
      if (loc) {
        fill(loc.id);
        last = loc.id;
      } else sel.value = last;
    } else last = sel.value;
    onChange?.(sel.value);
  });
  sel.refill = fill;
  return sel;
}

/** 在庫のある保管場所をボタンで選ぶ（片手操作向け）。場所が多い場合はセレクトにフォールバック */
export function locationPicker(repo, { value, stock, unit, onChange, placeholder }) {
  let ids = [...stock.keys()].filter((id) => repo.locations.has(id));
  const sl = scopeLocs(repo);
  if (sl && ids.some((id) => sl.has(id)) && !(value && !sl.has(value))) ids = ids.filter((id) => sl.has(id));
  if (ids.length > 8) {
    const sel = locationSelect(repo, { value, stock, allowNew: false, placeholder, onChange });
    return { el: sel, get value() { return sel.value; } };
  }
  let cur = value && stock.has(value) ? value : ids.length === 1 ? ids[0] : '';
  const wrap = h('div', { class: 'loc-pick', role: 'radiogroup' });
  const render = () => {
    clear(wrap);
    if (!ids.length) wrap.appendChild(h('div', { class: 'hint' }, '在庫のある保管場所がありません'));
    for (const id of ids) {
      wrap.appendChild(
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(id === cur), class: id === cur ? 'on' : '', onclick: () => { cur = id; render(); onChange?.(id); } },
          h('span', { class: 'n' }, h('i', { style: { background: divColor(repo, id) } }), repo.locationName(id)),
          h('span', { class: 'q num' }, `在庫 ${fmtQty(stock.get(id))}${unit || ''}`))
      );
    }
  };
  render();
  return { el: wrap, get value() { return cur; } };
}

function dateInput(value) {
  return h('input', { class: 'input', type: 'date', value: value || '', max: today() });
}

function moneyInput(value, placeholder = '例：3,000') {
  return h('input', { class: 'input num', inputmode: 'decimal', autocomplete: 'off', placeholder, value: value ?? '' });
}

function datalist(id, values) {
  return h('datalist', { id }, [...new Set(values.filter(Boolean))].slice(0, 30).map((v) => h('option', { value: v })));
}

/** ロット（購入分）手動指定エディタ */
function allocEditor(repo, item, ledger, getLoc, getQty, initial) {
  const wrap = h('div');
  const inputs = new Map();
  const render = () => {
    clear(wrap);
    inputs.clear();
    if (!ledger.ok) return;
    const loc = getLoc();
    const portions = ledger.portions.filter((p) => p.locationId === loc);
    if (!loc) {
      wrap.appendChild(h('div', { class: 'hint' }, '先に保管場所を選択してください'));
      return;
    }
    if (!portions.length) {
      wrap.appendChild(h('div', { class: 'hint' }, 'この場所に在庫がありません'));
      return;
    }
    for (const p of portions) {
      const lot = ledger.lots.get(p.lotId);
      const price = lot.price ? `${formatUnit(unitPrice(lot.price))}/${item.unit}（${TAX_LABEL[lot.price.tax]}）` : '価格未設定';
      const init = initial?.find((a) => a.lotId === p.lotId)?.qty ?? '';
      const inp = h('input', { class: 'input num', inputmode: 'numeric', placeholder: '0', value: init });
      inputs.set(p.lotId, inp);
      wrap.appendChild(
        h(
          'div',
          { class: 'alloc-row' },
          h('div', null, h('div', { class: 'l1' }, `${formatDateJa(lot.date)} ${lot.kind === 'adjust' ? '棚卸し増加分' : lot.supplier || '購入分'}`), h('div', { class: 'l2' }, `残 ${fmtQty(p.qty)}${item.unit} ・ ${price}`)),
          inp
        )
      );
    }
    wrap.appendChild(h('div', { class: 'hint', style: { marginTop: '6px' } }, '使う購入分と数量を入力してください。合計が数量と一致する必要があります。'));
  };
  render();
  return {
    el: wrap,
    render,
    get() {
      const out = [];
      for (const [lotId, inp] of inputs) {
        const n = parseIntStrict(inp.value || '0');
        if (n == null || n < 0) throw new Error('ロット指定の数量は0以上の整数で入力してください');
        if (n > 0) out.push({ lotId, qty: n });
      }
      const sum = out.reduce((s, a) => s + a.qty, 0);
      const q = getQty();
      if (sum !== q) throw new Error(`ロット指定の合計（${sum}）が数量（${q}）と一致しません`);
      return out;
    },
  };
}

function disclosure(label, content, open = false) {
  const btn = h('button', { type: 'button', class: 'disclosure' + (open ? ' open' : '') }, h('span', null, label), icon('chevR'));
  const box = h('div', { class: 'form' + (open ? '' : ' hidden'), style: { gap: '14px' } }, content);
  btn.addEventListener('click', () => {
    btn.classList.toggle('open');
    box.classList.toggle('hidden');
  });
  return h('div', null, btn, box);
}

/**
 * 操作シートを開く
 * @param type 'receive'|'consume'|'move'|'adjust'
 * @param item 商品
 * @param opts.correct 訂正対象の操作
 * @param opts.locationId 初期場所
 */
export function openOpSheet(type, item, opts = {}) {
  const repo = app.repo;
  const correct = opts.correct || null;
  const p = correct || {};
  const view = itemView(repo, item);
  // 訂正時は「対象の操作が無かった場合」の在庫を基準に表示する
  const ledger = correct ? replay(repo.itemOps(item.id).filter((o) => o.id !== correct.id)) : view.ledger || { ok: false };
  const stock = ledger.ok ? ledger.byLocation : new Map();
  const unit = item.unit;
  const title = correct ? `${TITLES[type]}の訂正` : TITLES[type];
  const sub = item.name;
  const errBox = h('div');
  const showErr = (msg) => {
    clear(errBox);
    if (msg) {
      errBox.appendChild(notice('danger', 'alert', msg));
      errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };
  let collect; // () => input
  const form = h('div', { class: 'form' });
  const curLine = h('div', { class: 'calc' }, h('span', null, '現在の在庫'), h('b', { class: 'num' }, `${fmtQty(view.total)}${unit}`, packText(item, view.total) ? h('span', { class: 'small' }, `（${packText(item, view.total)}）`) : null));

  // 共通：日付・メモ
  const dateEl = dateInput(p.date || today());
  const memoEl = h('input', { class: 'input', placeholder: '任意', value: p.memo || '' });
  const reasonEl = h('input', { class: 'input', placeholder: '例：数量の入力ミス', value: '' });

  if (type === 'receive') {
    const hasPack = (item.packSize || 0) > 1 || (p.packSize || 0) > 1;
    let mode = hasPack ? 'pack' : 'unit';
    const lastRcv = [...repo.itemOps(item.id)].filter((o) => o.type === 'receive').sort((a, b) => b.seq - a.seq)[0];
    const sl = scopeLocs(repo);
    const lastInScope = [...repo.itemOps(item.id)].filter((o) => o.type === 'receive' && (!sl || sl.has(o.locationId))).sort((a, b) => b.seq - a.seq)[0];
    const locSel = locationSelect(repo, { value: p.locationId || opts.locationId || lastInScope?.locationId || (sl ? '' : lastRcv?.locationId) || '' });
    const detailEl = h('input', { class: 'input', placeholder: '例：棚2・上段', value: p.detail ?? (lastRcv?.locationId === locSel.value ? lastRcv.detail : '') ?? '', list: 'dl-detail' });
    const packCount = stepper({ value: p.packCount ?? 1 }, { min: 0 });
    const looseCount = stepper({ value: p.looseQty ?? 0 }, { min: 0 });
    const packSize = h('input', { class: 'input num', inputmode: 'numeric', value: p.packSize ?? item.packSize ?? 1 });
    const packUnit = h('input', { class: 'input', value: p.packUnit ?? item.packUnit ?? '箱', placeholder: '箱' });
    const unitCount = stepper({ value: p.packSize === 1 ? p.qty : 1 }, { min: 1 });
    const amountEl = moneyInput(p.amount ?? '');
    let tax = p.tax || repo.settings.lastTax || 'incl';
    const taxSeg = seg(
      [
        ['incl', '税込'],
        ['excl', '税抜'],
      ],
      tax,
      (v) => {
        tax = v;
        calc();
      }
    );
    const purchaseEl = dateInput(p.purchaseDate ?? '');
    const storedEl = dateInput(p.storedDate ?? today());
    const supplierEl = h('input', { class: 'input', placeholder: '例：モノタロウ', value: p.supplier || '', list: 'dl-supplier' });
    const urlEl = h('input', { class: 'input', type: 'url', inputmode: 'url', placeholder: 'https://', value: p.url || '' });
    const calcEl = h('div', { class: 'calc price-calc' });
    const packBox = h('div', { class: 'form' });
    const unitBox = h('div', { class: 'form' });
    const n = (el) => parseIntStrict(el.value) || 0;
    const qtyNow = () => {
      if (mode === 'pack') return n(packCount.input) * n(packSize) + n(looseCount.input);
      return n(unitCount.input);
    };
    const calc = () => {
      clear(calcEl);
      const q = qtyNow();
      const pu = packUnit.value.trim() || '箱';
      const breakdown = mode === 'pack' ? `${n(packCount.input)}${pu}×${n(packSize)}${n(looseCount.input) ? ` ＋ バラ${n(looseCount.input)}` : ''}` : '';
      calcEl.append(h('div', { class: 'pc-row' }, h('span', null, '合計'), h('b', { class: 'num' }, `${fmtQty(q)}${unit}`, breakdown ? h('span', { class: 'small' }, `（${breakdown}）`) : null)));
      let a = null;
      try {
        a = parseMoneyInput(amountEl.value);
      } catch {
        calcEl.append(h('div', { class: 'pc-row' }, '金額の形式が不正です'));
        return;
      }
      if (a == null || q <= 0) {
        calcEl.append(h('div', { class: 'pc-row small' }, '購入総額を入れると、1' + unit + 'あたりの単価を自動計算します'));
        return;
      }
      const up = unitPrice({ amount: a, qty: q });
      calcEl.append(h('div', { class: 'pc-main' }, h('span', null, `1${unit}あたり`), h('b', { class: 'num' }, formatPerUnit(up)), h('span', { class: 'small' }, `（${TAX_LABEL[tax]}）`)));
      const sub = [];
      if (formatPerUnit(up).startsWith('約')) sub.push(`正確には ${formatUnit(up)}`);
      if (mode === 'pack' && n(packSize) > 1) sub.push(`1${pu}（${n(packSize)}${unit}）あたり ${formatPerUnit(Frac.mulInt(up, n(packSize)))}`);
      if (sub.length) calcEl.append(h('div', { class: 'pc-row small' }, sub.join(' ・ ')));
    };
    packBox.append(
      h('div', { class: 'row2' }, field(`入れ物の数`, packCount), field('入れ物の単位', packUnit)),
      field(`1${'つ'}あたりの入数（${unit}）`, packSize, { hint: `例：1袋50${unit}入りなら 50` }),
      field(`バラ（${unit}）`, looseCount, { hint: '入れ物とは別に、ばらで買った数があれば' })
    );
    unitBox.append(field(`数量（${unit}）`, unitCount));
    const modeSeg = seg(
      [
        ['pack', `${item.packUnit || '箱・袋'}単位で入力`],
        ['unit', `${unit}で入力`],
      ],
      mode,
      (v) => {
        mode = v;
        packBox.classList.toggle('hidden', v !== 'pack');
        unitBox.classList.toggle('hidden', v !== 'unit');
        calc();
      }
    );
    if (mode !== 'pack') packBox.classList.add('hidden');
    else unitBox.classList.add('hidden');
    for (const el of [packCount.input, packSize, packUnit, looseCount.input, unitCount.input, amountEl]) el.addEventListener('input', calc);
    calc();
    const sameAsDate = h('button', { type: 'button', class: 'btn sm', onclick: () => (purchaseEl.value = dateEl.value) }, '入庫日と同じ');
    const suppliers = [...repo.ops.values()].filter((o) => o.type === 'receive').map((o) => o.supplier);
    const details = [...repo.ops.values()].filter((o) => o.itemId === item.id).map((o) => o.detail || o.toDetail);
    form.append(
      datalist('dl-supplier', suppliers),
      datalist('dl-detail', details),
      field('保管場所', locSel, { required: true }),
      field('詳細位置', detailEl),
      modeSeg,
      packBox,
      unitBox,
      h('div', { class: 'row2', style: { alignItems: 'end' } }, field('購入総額（円）', amountEl, { hint: '空欄なら「価格未設定」' }), field('税区分', taxSeg)),
      calcEl,
      h('div', { class: 'row2' }, field('入庫日', dateEl, { required: true }), field('保管日', storedEl)),
      disclosure('購入日・購入店・URL・メモ', [field('購入日', h('div', { class: 'inline-row' }, purchaseEl, sameAsDate)), field('購入店・仕入先', supplierEl), field('購入時の商品URL', urlEl), field('メモ', memoEl)], !!(p.supplier || p.url || p.memo || p.purchaseDate))
    );
    collect = () => {
      const q = qtyNow();
      return {
        locationId: locSel.value,
        detail: detailEl.value,
        packCount: mode === 'pack' ? packCount.input.value : q,
        packSize: mode === 'pack' ? packSize.value : 1,
        looseQty: mode === 'pack' ? looseCount.input.value : 0,
        packUnit: mode === 'pack' ? packUnit.value : '',
        amount: amountEl.value,
        tax: amountEl.value.trim() ? tax : null,
        purchaseDate: purchaseEl.value || null,
        date: dateEl.value,
        storedDate: storedEl.value || null,
        supplier: supplierEl.value,
        url: urlEl.value,
        memo: memoEl.value,
      };
    };
  }

  if (type === 'consume' || type === 'move') {
    const isMove = type === 'move';
    const fromVal = (isMove ? p.fromLocationId : p.locationId) || opts.locationId || (stock.size === 1 ? [...stock.keys()][0] : '');
    const stockForSel = stock;
    let allocMode = p.alloc?.length ? 'manual' : 'fifo';
    const qty = stepper({ value: p.qty ?? 1 }, { min: 1 });
    const fromSel = locationPicker(repo, { value: fromVal, stock: stockForSel, unit, placeholder: isMove ? '移動元を選択' : '使用する場所を選択', onChange: () => alloc.render() });
    const alloc = allocEditor(repo, item, ledger, () => fromSel.value, () => parseIntStrict(qty.input.value) || 0, p.alloc);
    const allocBox = h('div', { class: allocMode === 'manual' ? '' : 'hidden' }, alloc.el);
    const allBtn = h('button', {
      type: 'button',
      class: 'btn sm',
      onclick: () => {
        const n = stock.get(fromSel.value);
        if (n) {
          qty.input.value = n;
          qty.input.dispatchEvent(new Event('input'));
        }
      },
    }, 'この場所の全数');
    form.append(
      curLine,
      field(isMove ? '移動元' : '保管場所', fromSel.el, { required: true }),
      field(`数量（${unit}）`, qty, { required: true }),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '-6px' } }, allBtn)
    );
    let toSel, toDetail;
    if (isMove) {
      toSel = locationSelect(repo, { value: p.toLocationId || '', scoped: false, placeholder: '移動先を選択' });
      toDetail = h('input', { class: 'input', placeholder: '例：シンク下', value: p.toDetail || '' });
      form.append(field('移動先', toSel, { required: true }), field('移動先の詳細位置', toDetail));
    }
    form.append(
      field(
        '使う購入分',
        seg(
          [
            ['fifo', '古い順（自動）'],
            ['manual', '手動で指定'],
          ],
          allocMode,
          (v) => {
            allocMode = v;
            allocBox.classList.toggle('hidden', v !== 'manual');
            alloc.render();
          }
        ),
        { hint: '通常は古い入庫分から自動で減らします（FIFO）' }
      ),
      allocBox,
      field('操作日', dateEl, { required: true, hint: '過去の日付も指定できます。後の履歴は自動で再計算されます。' }),
      field('メモ', memoEl)
    );
    collect = () => {
      const q = parseIntStrict(qty.input.value);
      const out = { qty: q, date: dateEl.value, memo: memoEl.value, alloc: allocMode === 'manual' ? alloc.get() : null };
      if (isMove) Object.assign(out, { fromLocationId: fromSel.value, toLocationId: toSel.value, toDetail: toDetail.value });
      else out.locationId = fromSel.value;
      return out;
    };
  }

  if (type === 'adjust') {
    let allocMode = p.alloc?.length ? 'manual' : 'fifo';
    const locSel = locationSelect(repo, { value: p.locationId || opts.locationId || (stock.size === 1 ? [...stock.keys()][0] : ''), onChange: () => sync(true) });
    const counted = stepper({ value: p.counted ?? '' }, { min: 0 });
    const deltaEl = h('div', { class: 'calc' });
    const unitAmountEl = moneyInput(p.unitAmount ?? '', '不明なら空欄');
    let tax = p.tax || 'incl';
    const incBox = h(
      'div',
      { class: 'form hidden' },
      h('div', { class: 'row2', style: { alignItems: 'end' } }, field(`増加分の単価（円/${unit}）`, unitAmountEl), field(
        '税区分',
        seg(
          [
            ['incl', '税込'],
            ['excl', '税抜'],
          ],
          tax,
          (v) => (tax = v)
        )
      )),
      h('div', { class: 'hint' }, '増加分は購入とは区別した「棚卸し調整」として記録されます。単価が不明なら空欄のままにしてください（0円としては扱いません）。')
    );
    const alloc = allocEditor(repo, item, ledger, () => locSel.value, () => Math.max(0, (stock.get(locSel.value) || 0) - (parseIntStrict(counted.input.value) ?? 0)), p.alloc);
    const allocBox = h('div', { class: allocMode === 'manual' ? '' : 'hidden' }, alloc.el);
    const decBox = h(
      'div',
      { class: 'form hidden' },
      field(
        '減らす購入分',
        seg(
          [
            ['fifo', '古い順（自動）'],
            ['manual', '手動で指定'],
          ],
          allocMode,
          (v) => {
            allocMode = v;
            allocBox.classList.toggle('hidden', v !== 'manual');
            alloc.render();
          }
        )
      ),
      allocBox
    );
    const detailEl = h('input', { class: 'input', placeholder: '増加分の詳細位置（任意）', value: p.detail || '' });
    const sync = (locChanged) => {
      const cur = stock.get(locSel.value) || 0;
      if (locChanged && !correct) counted.input.value = locSel.value ? cur : '';
      const c = parseIntStrict(counted.input.value);
      clear(deltaEl);
      if (!locSel.value || c == null) {
        deltaEl.append(h('span', null, '場所を選んで実際の数量を入力してください'));
        incBox.classList.add('hidden');
        decBox.classList.add('hidden');
        return;
      }
      const d = c - cur;
      deltaEl.append(h('span', null, `システム上 ${fmtQty(cur)}${unit} → 実数 ${fmtQty(c)}${unit}`), h('b', { class: 'num' }, d === 0 ? '差分なし' : d > 0 ? `+${fmtQty(d)}` : `−${fmtQty(-d)}`));
      incBox.classList.toggle('hidden', d <= 0);
      decBox.classList.toggle('hidden', d >= 0);
      alloc.render();
    };
    counted.input.addEventListener('input', () => sync(false));
    form.append(field('保管場所', locSel, { required: true }), field(`実際の数量（${unit}）`, counted, { required: true }), deltaEl, decBox, incBox, field('棚卸し日', dateEl, { required: true }), disclosure('詳細位置・メモ', [field('詳細位置', detailEl), field('メモ', memoEl)]));
    sync(!p.counted && p.counted !== 0);
    collect = () => {
      const c = parseIntStrict(counted.input.value);
      const cur = stock.get(locSel.value) || 0;
      return {
        locationId: locSel.value,
        counted: counted.input.value,
        alloc: c != null && c < cur && allocMode === 'manual' ? alloc.get() : null,
        unitAmount: c != null && c > cur ? unitAmountEl.value : null,
        tax: c != null && c > cur && unitAmountEl.value.trim() ? tax : null,
        detail: detailEl.value,
        date: dateEl.value,
        memo: memoEl.value,
      };
    };
  }

  if (correct) {
    form.prepend(notice('info', 'info', `元の履歴（${formatDateJa(correct.date)}・${OP_LABEL[correct.type]}）は削除されず「訂正済み」として残ります。在庫は操作日順に再計算されます。`));
    form.append(field('訂正理由', reasonEl));
  }
  form.prepend(errBox);

  const submit = h('button', { class: 'btn primary block' }, icon('check'), correct ? '訂正を保存' : `${TITLES[type]}を記録`);
  const sheet = openSheet({ title, subtitle: sub, body: form, footer: submit });
  submit.addEventListener('click', async () => {
    showErr(null);
    let input;
    try {
      input = { itemId: item.id, ...collect() };
    } catch (e) {
      showErr(e.message);
      return;
    }
    submit.disabled = true;
    try {
      let op;
      if (correct) op = await repo.correctOp(correct.id, { ...input, correctionReason: reasonEl.value });
      else op = await repo.addOp(type, input);
      if (type === 'receive' && input.tax) repo.saveSettings({ lastTax: input.tax }).catch(() => {});
      sheet.close(op);
      const after = repo.ledger(item.id).total;
      const msg = correct ? `訂正しました（在庫 ${fmtQty(after)}${unit}）` : `${TITLES[type]}を記録しました（在庫 ${fmtQty(after)}${unit}）`;
      toast(msg, {
        action: '取り消し',
        onAction: async () => {
          try {
            await repo.voidOp(op.id, '直後の取り消し');
            toast('取り消しました（履歴に記録されています）');
          } catch (e) {
            toastError(e);
          }
        },
      });
      opts.onDone?.(op);
    } catch (e) {
      showErr(e.message);
    } finally {
      submit.disabled = false;
    }
  });
  return sheet;
}

/** 操作選択シート（一覧の数量タップ・スキャン結果から） */
export function openQuickActions(item) {
  const repo = app.repo;
  const v = itemView(repo, item);
  const b = (type, ic, label, primary) =>
    h('button', {
      class: 'action' + (primary ? ' primary' : ''),
      onclick: () => {
        sheet.close();
        setTimeout(() => openOpSheet(type, item), 120);
      },
    }, icon(ic), label);
  const sheet = openSheet({
    title: item.name,
    subtitle: `在庫 ${fmtQty(v.total)}${item.unit}${packText(item, v.total) ? `（${packText(item, v.total)}）` : ''}`,
    body: h(
      'div',
      null,
      h('div', { class: 'actions4', style: { margin: '4px 0 12px' } }, b('consume', 'outbox', '使用', true), b('receive', 'inbox', '入庫'), b('move', 'move', '移動'), b('adjust', 'clipboard', '棚卸し')),
      h('button', {
        class: 'btn block',
        onclick: () => {
          sheet.close();
          go(`#/item/${item.id}`);
        },
      }, '商品の詳細を見る', icon('chevR'))
    ),
  });
}
