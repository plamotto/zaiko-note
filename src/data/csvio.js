// CSV 入出力。取り込みは「プレビュー（計画）→ ユーザー確認 → 一括コミット（全件成功 or 全件不採用）」。
// 在庫数の変更は直接上書きせず、入庫または棚卸し調整の履歴として記録する。

import { toCsv, parseCsv } from '../core/csv.js';
import { replay, valuation, stockStatus, STATUS_LABEL, opStatus, OP_LABEL } from '../core/ledger.js';
import { formatFrac, unitPrice, TAX_LABEL } from '../core/money.js';
import { findDuplicates, normalizeName, normalizeJan } from '../core/text.js';
import { uuid, nowIso, today, parseDateLoose, DomainError } from '../core/util.js';

export const IMPORT_COLUMNS = [
  ['id', '商品ID'],
  ['name', '商品名'],
  ['unit', '単位'],
  ['category', 'カテゴリ'],
  ['jan', 'JANコード'],
  ['maker', 'メーカー'],
  ['model', '型番'],
  ['spec', '規格'],
  ['packSize', '標準入数'],
  ['packUnit', '入数単位'],
  ['threshold', '警告ライン'],
  ['url', 'URL'],
  ['memo', 'メモ'],
  ['rcvCount', '入庫数量'],
  ['rcvPackSize', '入数'],
  ['rcvAmount', '金額'],
  ['rcvTax', '税区分'],
  ['rcvPurchaseDate', '購入日'],
  ['rcvDate', '入庫日'],
  ['rcvStoredDate', '保管日'],
  ['rcvLocation', '保管場所'],
  ['rcvDetail', '詳細位置'],
  ['rcvSupplier', '購入店'],
  ['rcvUrl', '購入URL'],
  ['adjCount', '棚卸数量'],
  ['adjLocation', '棚卸場所'],
  ['adjDate', '棚卸日'],
];

const ALIASES = {
  name: ['品名', '商品'],
  unit: ['基本数量単位', '数量単位'],
  jan: ['JAN', 'バーコード'],
  maker: ['ブランド', 'メーカー・ブランド'],
  model: ['品番', '型番・品番'],
  spec: ['サイズ', '規格・サイズ'],
  rcvSupplier: ['仕入先', '購入店・仕入先'],
  rcvAmount: ['購入総額', '購入金額'],
  rcvCount: ['購入数量'],
};

export function templateCsv() {
  return toCsv([
    IMPORT_COLUMNS.map((c) => c[1]),
    ['', 'ニトリル手袋 Mサイズ', '枚', '消耗品', '4901234567894', 'サンプル', 'NT-M', 'M', '100', '箱', '200', '', '', '3', '100', '3000', '税込', '2025/04/01', '2025/04/02', '', '倉庫A', '棚2・上段', 'ホームセンター', '', '', '', ''],
  ]);
}

function mapHeader(header) {
  const idx = {};
  header.forEach((h, i) => {
    const t = String(h).normalize('NFKC').trim();
    for (const [key, label] of IMPORT_COLUMNS) {
      if (t === label || (ALIASES[key] || []).includes(t)) idx[key] = i;
    }
  });
  return idx;
}

const unescapeCell = (v) => {
  const s = String(v ?? '').trim();
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
};

/**
 * 取り込み計画を作成（DB変更なし）
 * @param choices {rowNo: 'new' | 'existing:<itemId>' | 'skip'}
 */
export function planCsvImport(repo, text, choices = {}) {
  let rows;
  try {
    rows = parseCsv(text);
  } catch (e) {
    return { ok: false, fatal: e.message, rows: [] };
  }
  if (rows.length < 2) return { ok: false, fatal: 'データ行がありません', rows: [] };
  const idx = mapHeader(rows[0]);
  if (idx.name == null && idx.id == null) return { ok: false, fatal: '「商品名」または「商品ID」の列が必要です', rows: [] };

  const catByName = new Map([...repo.categories.values()].map((c) => [normalizeName(c.name), c.id]));
  const locByName = new Map([...repo.locations.values()].filter((l) => !l.archived).map((l) => [normalizeName(l.name), l.id]));
  const newCats = new Map();
  const newLocs = new Map();
  const resolveCat = (name) => {
    const k = normalizeName(name);
    if (catByName.has(k)) return catByName.get(k);
    if (!newCats.has(k)) newCats.set(k, { id: uuid(), name: name.trim(), sort: repo.categories.size + newCats.size, createdAt: nowIso(), updatedAt: nowIso() });
    return newCats.get(k).id;
  };
  const resolveLoc = (name) => {
    const k = normalizeName(name);
    if (locByName.has(k)) return locByName.get(k);
    if (!newLocs.has(k)) newLocs.set(k, { id: uuid(), name: name.trim(), divisionId: null, memo: '', sort: repo.locations.size + newLocs.size, archived: false, createdAt: nowIso(), updatedAt: nowIso() });
    return newLocs.get(k).id;
  };

  const existingItems = [...repo.items.values()];
  const pendingNew = []; // 同一CSV内で作成予定の商品
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const rowNo = r + 1;
    const cell = (k) => (idx[k] == null ? '' : unescapeCell(rows[r][idx[k]]));
    const row = { rowNo, errors: [], warnings: [], name: cell('name'), jan: normalizeJan(cell('jan')) };
    if (rows[r].every((c) => !String(c).trim())) continue;
    // 対象商品の決定
    const id = cell('id');
    let target = null; // {kind:'existing'|'pending', id}
    if (id) {
      if (repo.items.has(id)) target = { kind: 'existing', id };
      else row.errors.push(`商品ID ${id} が見つかりません`);
    } else if (!row.name) {
      row.errors.push('商品名が空です');
    } else {
      const choice = choices[rowNo];
      const pend = pendingNew.find((p) => (row.jan && p.jan === row.jan) || normalizeName(p.name) === normalizeName(row.name));
      const dups = findDuplicates({ name: row.name, jan: row.jan }, existingItems);
      row.candidates = dups.slice(0, 5).map((d) => ({ id: d.item.id, name: d.item.name, reason: d.reason }));
      if (choice === 'skip') row.action = 'skip';
      else if (choice === 'new') target = null;
      else if (choice?.startsWith('existing:')) {
        const eid = choice.slice(9);
        if (repo.items.has(eid)) target = { kind: 'existing', id: eid };
      } else if (pend) target = { kind: 'pending', id: pend.id };
      else if (dups.length && dups[0].reason !== 'name-similar') {
        target = { kind: 'existing', id: dups[0].item.id };
        row.autoMatched = dups[0].reason;
      } else if (dups.length) {
        row.needsChoice = true;
        row.warnings.push(`類似商品があります：${dups[0].item.name}（新規か既存かを選択してください）`);
      }
    }
    if (row.action === 'skip') {
      out.push(row);
      continue;
    }

    // 商品項目
    const patch = {};
    for (const k of ['name', 'unit', 'maker', 'model', 'spec', 'packUnit', 'memo']) if (cell(k)) patch[k] = cell(k);
    if (cell('jan')) patch.jan = row.jan;
    if (cell('category')) patch.categoryId = resolveCat(cell('category'));
    if (cell('packSize')) patch.packSize = cell('packSize');
    if (cell('threshold')) patch.threshold = cell('threshold');
    if (cell('url')) patch.urls = [cell('url')];

    let itemId;
    const extra = { catIds: new Set([...newCats.values()].map((c) => c.id)) };
    if (!target && !row.errors.length) {
      itemId = uuid();
      row.action = 'new';
      try {
        row.item = { id: itemId, ...repo.normalizeItemInput({ ...patch, photoIds: [] }, null, extra) };
        pendingNew.push({ id: itemId, name: row.item.name, jan: row.item.jan });
      } catch (e) {
        row.errors.push(e.message);
      }
    } else if (target) {
      itemId = target.id;
      row.action = target.kind === 'pending' ? 'pending' : 'update';
      row.targetName = target.kind === 'existing' ? repo.items.get(itemId).name : row.name;
      if (target.kind === 'existing' && Object.keys(patch).length) {
        const prev = repo.items.get(itemId);
        try {
          const merged = repo.normalizeItemInput({ ...prev, ...patch, urls: patch.urls ? [...new Set([...(prev.urls || []), ...patch.urls])] : prev.urls }, prev, extra);
          const changed = Object.keys(merged).filter((k) => JSON.stringify(merged[k]) !== JSON.stringify(prev[k]));
          if (changed.length) row.itemUpdate = { ...prev, ...merged };
          row.changedFields = changed;
        } catch (e) {
          row.errors.push(e.message);
        }
      }
    }

    // 入庫
    if (cell('rcvCount')) {
      const date = cell('rcvDate') ? parseDateLoose(cell('rcvDate')) : today();
      if (!date) row.errors.push('入庫日の形式が不正です');
      const pd = cell('rcvPurchaseDate') ? parseDateLoose(cell('rcvPurchaseDate')) : null;
      if (cell('rcvPurchaseDate') && !pd) row.errors.push('購入日の形式が不正です');
      const sd = cell('rcvStoredDate') ? parseDateLoose(cell('rcvStoredDate')) : date;
      if (cell('rcvStoredDate') && !sd) row.errors.push('保管日の形式が不正です');
      const taxRaw = cell('rcvTax');
      const tax = /込|incl/i.test(taxRaw) ? 'incl' : /抜|excl/i.test(taxRaw) ? 'excl' : null;
      if (cell('rcvAmount') && !tax) row.errors.push('金額がある場合は税区分（税込/税抜）が必要です');
      if (!cell('rcvLocation')) row.errors.push('入庫には保管場所が必要です');
      const itemPack = row.item?.packSize ?? repo.items.get(itemId)?.packSize ?? null;
      row.receive = {
        itemId,
        packCount: cell('rcvCount'),
        packSize: cell('rcvPackSize') || itemPack || 1,
        packUnit: row.item?.packUnit ?? repo.items.get(itemId)?.packUnit ?? '',
        amount: cell('rcvAmount') || null,
        tax,
        purchaseDate: pd,
        date,
        storedDate: sd,
        locationId: cell('rcvLocation') ? resolveLoc(cell('rcvLocation')) : null,
        detail: cell('rcvDetail'),
        supplier: cell('rcvSupplier'),
        url: cell('rcvUrl'),
        memo: 'CSV取り込み',
      };
    }
    // 棚卸し
    if (cell('adjCount')) {
      const date = cell('adjDate') ? parseDateLoose(cell('adjDate')) : today();
      if (!date) row.errors.push('棚卸日の形式が不正です');
      if (!cell('adjLocation')) row.errors.push('棚卸しには棚卸場所が必要です');
      row.adjust = { itemId, counted: cell('adjCount'), locationId: cell('adjLocation') ? resolveLoc(cell('adjLocation')) : null, date, memo: 'CSV取り込み（棚卸し調整）' };
    }
    if (row.needsChoice) row.errors.push('新規登録か既存商品かを選択してください');
    if (!row.action) row.action = 'error';
    if (row.action === 'update' && !row.itemUpdate && !row.receive && !row.adjust) row.warnings.push('変更点がありません');
    out.push(row);
  }

  // 操作を構築し、商品ごとに再生して検証
  const extra = {
    locIds: new Set([...newLocs.values()].map((l) => l.id)),
    itemIds: new Set(out.filter((r) => r.item).map((r) => r.item.id)),
  };
  let seq = 0;
  for (const op of repo.ops.values()) seq = Math.max(seq, op.seq);
  const ops = [];
  for (const row of out) {
    if (row.errors.length || row.action === 'skip') continue;
    for (const [type, input] of [
      ['receive', row.receive],
      ['adjust', row.adjust],
    ]) {
      if (!input) continue;
      try {
        const f = repo.buildOpFields(type, input, extra);
        const s = ++seq;
        const op = { id: uuid(), seq: s, order: s, createdAt: nowIso(), ...f };
        op.lotId = type === 'receive' ? op.id : 'adj-' + op.id;
        ops.push(op);
        (row.ops ||= []).push(op);
      } catch (e) {
        row.errors.push(e.message);
      }
    }
  }
  const byItem = new Map();
  for (const op of ops) {
    if (!byItem.has(op.itemId)) byItem.set(op.itemId, []);
    byItem.get(op.itemId).push(op);
  }
  for (const [itemId, list] of byItem) {
    const r = replay([...repo.itemOps(itemId), ...list]);
    if (!r.ok) {
      const row = out.find((x) => x.ops?.some((o) => o.id === r.error.detail.opId)) || out.find((x) => x.ops?.some((o) => o.itemId === itemId));
      row?.errors.push(repo.explainLedgerError(r.error, list.map((o) => o.id)).message);
    } else {
      for (const op of list) if (op.type === 'adjust') op.recordedDelta = r.effects.get(op.id)?.delta ?? 0;
    }
  }

  const errorRows = out.filter((r) => r.errors.length);
  return {
    ok: errorRows.length === 0,
    rows: out,
    errorRows,
    newCategories: [...newCats.values()],
    newLocations: [...newLocs.values()],
    counts: {
      new: out.filter((r) => r.action === 'new' && !r.errors.length).length,
      update: out.filter((r) => (r.action === 'update' || r.action === 'pending') && !r.errors.length).length,
      receive: out.filter((r) => r.receive && !r.errors.length).length,
      adjust: out.filter((r) => r.adjust && !r.errors.length).length,
      skip: out.filter((r) => r.action === 'skip').length,
      error: errorRows.length,
    },
  };
}

/** 計画を一括保存（エラー行が1つでもあれば保存しない） */
export async function commitCsvImport(repo, plan) {
  if (!plan.ok) throw new DomainError('CSV_ERRORS', 'エラー行があるため取り込めません。修正するか該当行をスキップしてください。');
  const now = nowIso();
  const items = [];
  const ops = [];
  for (const r of plan.rows) {
    if (r.action === 'skip') continue;
    if (r.item) items.push({ ...r.item, archived: false, archivedAt: null, createdAt: now, updatedAt: now });
    if (r.itemUpdate) items.push({ ...r.itemUpdate, updatedAt: now });
    if (r.ops) ops.push(...r.ops);
  }
  // コミット直前に再検証（計画後に他の変更が入った場合に備える）
  let maxSeq = 0;
  for (const op of repo.ops.values()) maxSeq = Math.max(maxSeq, op.seq);
  if (ops.length && Math.min(...ops.map((o) => o.seq)) <= maxSeq) throw new DomainError('STALE', 'プレビュー後にデータが変更されました。もう一度プレビューしてください。');
  await repo.commitBatch({ put: { categories: plan.newCategories, locations: plan.newLocations, items, ops } });
  return { items: items.length, ops: ops.length };
}

// ───────────── 出力 ─────────────
function valueCells(v) {
  const g = (k) => (v.groups[k].qty ? formatFrac(v.groups[k].value).replace('¥', '') : '');
  return [g('incl'), g('excl'), v.unknownQty || ''];
}

export function exportItemsCsv(repo) {
  const rows = [
    ['商品ID', '商品名', '単位', 'カテゴリ', 'JANコード', 'メーカー', '型番', '規格', '標準入数', '入数単位', '警告ライン', 'URL', 'メモ', '現在在庫', '在庫状態', '保管場所別在庫', '評価額(税込)', '評価額(税抜)', '価格未設定数', 'アーカイブ', '作成日時', '更新日時'],
  ];
  const items = [...repo.items.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  for (const it of items) {
    const l = repo.ledger(it.id);
    const total = l.ok ? l.total : '';
    const byLoc = l.ok ? [...l.byLocation].map(([id, q]) => `${repo.locationName(id)}:${q}`).join(' / ') : 'エラー';
    const v = l.ok ? valuation(l.portions, l.lots) : null;
    rows.push([
      it.id,
      it.name,
      it.unit,
      repo.categories.get(it.categoryId)?.name || '',
      it.jan || '',
      it.maker,
      it.model,
      it.spec,
      it.packSize ?? '',
      it.packUnit,
      it.threshold ?? '',
      (it.urls || []).join(' '),
      it.memo,
      total,
      l.ok ? STATUS_LABEL[stockStatus(l.total, it.threshold)] : '',
      byLoc,
      ...(v ? valueCells(v) : ['', '', '']),
      it.archived ? 'はい' : '',
      it.createdAt,
      it.updatedAt,
    ]);
  }
  return toCsv(rows);
}

export function exportPurchasesCsv(repo) {
  const rows = [['履歴ID', '商品ID', '商品名', '状態', '購入日', '入庫日', '保管日', '保管場所', '詳細位置', '購入数量', '入数', '入数単位', '合計数量', '単位', '金額', '税区分', '単価', '残数', '購入店・仕入先', '購入URL', 'メモ', '記録日時']];
  const ops = [...repo.ops.values()].filter((o) => o.type === 'receive').sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
  const STATE = { active: '有効', voided: '取り消し', superseded: '訂正済み（旧）', inactive: '無効' };
  for (const op of ops) {
    const it = repo.items.get(op.itemId);
    const st = repo.opStatuses(op.itemId).get(op.id)?.state;
    const l = repo.ledger(op.itemId);
    const lot = l.ok && st === 'active' ? l.lots.get(op.lotId) : null;
    rows.push([
      op.id,
      op.itemId,
      it?.name || '',
      STATE[st] || st,
      op.purchaseDate || '',
      op.date,
      op.storedDate || '',
      repo.locationName(op.locationId),
      op.detail,
      op.packCount,
      op.packSize,
      op.packUnit || '',
      op.qty,
      it?.unit || '',
      op.amount ?? '',
      op.amount != null ? TAX_LABEL[op.tax] : '価格未設定',
      op.amount != null ? formatFrac(unitPrice({ amount: op.amount, qty: op.qty }), 2).replace('¥', '') : '',
      lot ? lot.remaining : st === 'active' ? 0 : '',
      op.supplier,
      op.url,
      op.memo,
      op.createdAt,
    ]);
  }
  return toCsv(rows);
}

export function exportHistoryCsv(repo) {
  const rows = [['履歴ID', '操作日', '種別', '状態', '商品ID', '商品名', '数量', '単位', '保管場所', '移動先', '棚卸実数', '差分', '金額', '税区分', '対象履歴ID', 'メモ', '記録日時']];
  const STATE = { active: '有効', voided: '取り消し', superseded: '訂正済み（旧）', inactive: '無効' };
  const ops = [...repo.ops.values()].sort((a, b) => a.seq - b.seq);
  for (const op of ops) {
    const it = repo.items.get(op.itemId);
    const st = repo.opStatuses(op.itemId).get(op.id)?.state;
    rows.push([
      op.id,
      op.date,
      op.corrects ? `${OP_LABEL[op.type]}（訂正）` : OP_LABEL[op.type],
      STATE[st] || st,
      op.itemId,
      it?.name || '',
      op.qty ?? '',
      it?.unit || '',
      op.locationId ? repo.locationName(op.locationId) : op.fromLocationId ? repo.locationName(op.fromLocationId) : '',
      op.toLocationId ? repo.locationName(op.toLocationId) : '',
      op.counted ?? '',
      op.recordedDelta ?? '',
      op.amount ?? op.unitAmount ?? '',
      op.tax ? TAX_LABEL[op.tax] : '',
      op.targetId || op.corrects || '',
      op.memo || op.reason || '',
      op.createdAt,
    ]);
  }
  return toCsv(rows);
}
