// バックアップ（ZIP + JSON + 写真）の作成・検証・復元。形式仕様は docs/BACKUP_FORMAT.md を参照。

import { zipSync, unzip } from '../core/zip.js';
import { replay } from '../core/ledger.js';
import { toCents } from '../core/money.js';
import { findDuplicates, normalizeName } from '../core/text.js';
import { uuid, nowIso, isValidDate, isPosInt, isNonNegInt, DomainError } from '../core/util.js';
import { SCHEMA_VERSION, DEFAULT_SETTINGS } from './store.js';
import { getAll } from './db.js';

export const BACKUP_FORMAT = 'zaiko-pwa-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const APP_VERSION = '1.2.0';

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extFor(type) {
  return { 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }[type] || 'jpg';
}

/** バックアップ ZIP を作成 */
export async function createBackup(repo) {
  // 作成中に変更が入らないよう、直列キューの中でスナップショットを取る
  return repo._serial(async () => {
    const snap = repo.snapshot();
    const blobs = new Map((await getAll(repo.db, 'photoBlobs')).map((r) => [r.id, r]));
    const files = [];
    const fileIndex = [];
    for (const p of snap.photos) {
      const b = blobs.get(p.id);
      if (!b) throw new Error(`写真データが見つかりません（${p.id}）。整合性チェックを実行してください。`);
      const main = new Uint8Array(b.data);
      const path = `photos/${p.id}.${extFor(p.type)}`;
      files.push({ name: path, data: main });
      fileIndex.push({ path, kind: 'photo', photoId: p.id, bytes: main.length, sha256: await sha256Hex(main) });
      if (b.thumb) {
        const th = new Uint8Array(b.thumb);
        const tpath = `photos/thumbs/${p.id}.jpg`;
        files.push({ name: tpath, data: th });
        fileIndex.push({ path: tpath, kind: 'thumb', photoId: p.id, bytes: th.length, sha256: await sha256Hex(th) });
      }
    }
    const data = {
      divisions: snap.divisions,
      categories: snap.categories,
      locations: snap.locations,
      items: snap.items,
      photos: snap.photos,
      ops: snap.ops,
      settings: snap.settings,
    };
    const dataBytes = enc.encode(JSON.stringify(data, null, 1));
    const backupId = uuid();
    const exportedAt = nowIso();
    const manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      backupId,
      exportedAt,
      app: { name: '在庫ノート', version: APP_VERSION },
      datasetId: repo.state.datasetId,
      revision: repo.state.revision,
      counts: {
        divisions: data.divisions.length,
        categories: data.categories.length,
        locations: data.locations.length,
        items: data.items.length,
        photos: data.photos.length,
        ops: data.ops.length,
      },
      dataFile: { path: 'data.json', bytes: dataBytes.length, sha256: await sha256Hex(dataBytes) },
      files: fileIndex,
    };
    const readme =
      '在庫ノート バックアップファイル\r\n' +
      `形式: ${BACKUP_FORMAT} v${BACKUP_FORMAT_VERSION}\r\n作成日時: ${exportedAt}\r\n` +
      'manifest.json … ファイル一覧・件数・ハッシュ\r\ndata.json … 全データ（JSON, UTF-8）\r\nphotos/ … 写真原本、photos/thumbs/ … サムネイル\r\n' +
      '詳細仕様はアプリ同梱の docs/BACKUP_FORMAT.md を参照してください。\r\n';
    const zip = zipSync([
      { name: 'manifest.json', data: JSON.stringify(manifest, null, 1) },
      { name: 'data.json', data: dataBytes },
      { name: 'README.txt', data: readme },
      ...files,
    ]);
    const stamp = exportedAt.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    return { bytes: zip, filename: `zaiko-backup-${stamp}.zip`, revision: repo.state.revision, manifest };
  });
}

// ───────────── 検証 ─────────────
const isStr = (v) => typeof v === 'string';
const isId = (v) => isStr(v) && v.length > 0 && v.length <= 100;
const isMoney = (v) => {
  if (v == null) return true;
  try {
    toCents(v);
    return true;
  } catch {
    return false;
  }
};

export function validateData(data) {
  const errors = [];
  const E = (m) => errors.length < 100 && errors.push(m);
  for (const k of ['divisions', 'categories', 'locations', 'items', 'photos', 'ops']) {
    if (!Array.isArray(data[k])) {
      E(`${k} が配列ではありません`);
      return errors;
    }
  }
  const ids = (arr, label) => {
    const s = new Set();
    for (const r of arr) {
      if (!r || !isId(r.id)) E(`${label}: IDが不正なレコードがあります`);
      else if (s.has(r.id)) E(`${label}: ID重複 ${r.id}`);
      else s.add(r.id);
    }
    return s;
  };
  const divIds = ids(data.divisions, '管理区分');
  const catIds = ids(data.categories, 'カテゴリ');
  const locIds = ids(data.locations, '保管場所');
  const itemIds = ids(data.items, '商品');
  const photoIds = ids(data.photos, '写真');
  const opIds = ids(data.ops, '履歴');
  for (const r of [...data.divisions, ...data.categories]) if (!isStr(r.name) || !r.name.trim()) E(`名前が空のレコードがあります (${r.id})`);
  for (const l of data.locations) {
    if (!isStr(l.name) || !l.name.trim()) E(`保管場所名が空です (${l.id})`);
    if (l.divisionId && !divIds.has(l.divisionId)) E(`保管場所 ${l.name} の管理区分参照が不正です`);
  }
  for (const it of data.items) {
    if (!isStr(it.name) || !it.name.trim()) E(`商品名が空です (${it.id})`);
    if (!isStr(it.unit) || !it.unit.trim()) E(`商品 ${it.name} の単位が空です`);
    if (it.categoryId && !catIds.has(it.categoryId)) E(`商品 ${it.name} のカテゴリ参照が不正です`);
    if (!Array.isArray(it.photoIds)) E(`商品 ${it.name} の photoIds が不正です`);
    else for (const p of it.photoIds) if (!photoIds.has(p)) E(`商品 ${it.name} の写真 ${p} が見つかりません`);
    if (it.packSize != null && !isPosInt(it.packSize)) E(`商品 ${it.name} の標準入数が不正です`);
    if (it.threshold != null && !isNonNegInt(it.threshold)) E(`商品 ${it.name} の警告ラインが不正です`);
  }
  for (const p of data.photos) if (!itemIds.has(p.itemId)) E(`写真 ${p.id} の商品参照が不正です`);
  const seqs = new Set();
  for (const op of data.ops) {
    const where = `履歴 ${op.id}`;
    if (!itemIds.has(op.itemId)) E(`${where}: 商品参照が不正です`);
    if (!isPosInt(op.seq) || !isPosInt(op.order)) E(`${where}: seq/order が不正です`);
    else if (seqs.has(op.seq)) E(`${where}: seq が重複しています`);
    else seqs.add(op.seq);
    if (!isValidDate(op.date)) E(`${where}: 日付が不正です`);
    if (!['receive', 'consume', 'move', 'adjust', 'void'].includes(op.type)) E(`${where}: 種別が不正です`);
    for (const k of ['locationId', 'fromLocationId', 'toLocationId']) if (op[k] != null && !locIds.has(op[k])) E(`${where}: 保管場所参照が不正です`);
    if (op.type === 'void' && !opIds.has(op.targetId)) E(`${where}: 取り消し対象が見つかりません`);
    if (op.corrects && !opIds.has(op.corrects)) E(`${where}: 訂正対象が見つかりません`);
    if (!isMoney(op.amount) || !isMoney(op.unitAmount)) E(`${where}: 金額形式が不正です`);
    for (const k of ['purchaseDate', 'storedDate']) if (op[k] != null && !isValidDate(op[k])) E(`${where}: ${k} が不正です`);
  }
  if (!errors.length) {
    const byItem = new Map();
    for (const op of data.ops) {
      if (!byItem.has(op.itemId)) byItem.set(op.itemId, []);
      byItem.get(op.itemId).push(op);
    }
    for (const [itemId, ops] of byItem) {
      const r = replay(ops);
      if (!r.ok) E(`商品 ${data.items.find((i) => i.id === itemId)?.name}: 在庫履歴に矛盾があります（${r.error.message}）`);
    }
  }
  return errors;
}

/** ZIP を読み込み、形式・ハッシュ・整合性を検証する（DBには書き込まない） */
export async function parseBackup(bytes) {
  const errors = [];
  const warnings = [];
  let entries;
  try {
    entries = await unzip(bytes);
  } catch (e) {
    return { ok: false, errors: [e.message], warnings };
  }
  const mBytes = entries.get('manifest.json');
  const dBytes = entries.get('data.json');
  if (!mBytes || !dBytes) return { ok: false, errors: ['manifest.json または data.json がありません。このアプリのバックアップファイルではない可能性があります。'], warnings };
  let manifest, data;
  try {
    manifest = JSON.parse(dec.decode(mBytes));
    data = JSON.parse(dec.decode(dBytes));
  } catch {
    return { ok: false, errors: ['JSONの解析に失敗しました（ファイル破損の可能性）'], warnings };
  }
  if (manifest.format !== BACKUP_FORMAT) return { ok: false, errors: [`形式が異なります: ${manifest.format}`], warnings };
  if (!(manifest.formatVersion >= 1 && manifest.formatVersion <= BACKUP_FORMAT_VERSION)) {
    return { ok: false, errors: [`未対応のバージョンです（v${manifest.formatVersion}）。アプリを更新してください。`], warnings };
  }
  const dh = await sha256Hex(dBytes);
  if (dh && manifest.dataFile?.sha256 && dh !== manifest.dataFile.sha256) errors.push('data.json のハッシュが一致しません（ファイル破損）');
  const blobs = new Map();
  for (const f of manifest.files || []) {
    const b = entries.get(f.path);
    if (!b) {
      errors.push(`ファイルが不足しています: ${f.path}`);
      continue;
    }
    const h = await sha256Hex(b);
    if (h && f.sha256 && h !== f.sha256) errors.push(`ハッシュ不一致: ${f.path}`);
    const rec = blobs.get(f.photoId) || { id: f.photoId };
    if (f.kind === 'thumb') rec.thumb = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    else rec.data = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    blobs.set(f.photoId, rec);
  }
  errors.push(...validateData(data));
  for (const p of data.photos || []) if (!blobs.get(p.id)?.data) errors.push(`写真本体がありません: ${p.id}`);
  for (const k of Object.keys(manifest.counts || {})) {
    if (Array.isArray(data[k]) && data[k].length !== manifest.counts[k]) errors.push(`${k} の件数が manifest と一致しません`);
  }
  const counts = {};
  for (const k of ['divisions', 'categories', 'locations', 'items', 'photos', 'ops']) counts[k] = data[k]?.length ?? 0;
  return { ok: errors.length === 0, errors, warnings, manifest, data, blobs, counts };
}

// ───────────── 復元：全件置き換え ─────────────
export async function restoreReplace(repo, parsed) {
  if (!parsed.ok) throw new DomainError('INVALID_BACKUP', '検証エラーのあるバックアップは復元できません');
  const d = parsed.data;
  const state = {
    ...repo.state,
    datasetId: parsed.manifest.datasetId || repo.state.datasetId,
    revision: repo.state.revision + 1,
    lastChangeAt: nowIso(),
    importedBackupIds: [...new Set([...(repo.state.importedBackupIds || []), parsed.manifest.backupId])],
  };
  const photoBlobs = d.photos.map((p) => ({ id: p.id, data: parsed.blobs.get(p.id).data, thumb: parsed.blobs.get(p.id).thumb || null }));
  await repo.commitBatch(
    {
      clear: ['items', 'photos', 'photoBlobs', 'categories', 'locations', 'divisions', 'ops'],
      put: {
        divisions: d.divisions,
        categories: d.categories,
        locations: d.locations,
        items: d.items,
        photos: d.photos,
        photoBlobs,
        ops: d.ops,
        meta: [
          { key: 'state', value: state },
          { key: 'settings', value: { ...DEFAULT_SETTINGS, ...(d.settings || {}) } },
        ],
      },
    },
    { bump: false }
  );
  return { mode: 'replace', counts: parsed.counts };
}

// ───────────── 復元：重複チェック付き統合 ─────────────
function sameRecord(a, b) {
  const norm = (r) => {
    const out = {};
    for (const k of Object.keys(r).sort()) out[k] = r[k];
    return JSON.stringify(out);
  };
  return norm(a) === norm(b);
}

/**
 * 統合計画を作る（DBは変更しない）
 * @param options.conflict 'keepExisting' | 'newer'  同一IDで内容が異なる商品・マスターの扱い
 * @param options.skipDuplicateItems 別IDだがJAN/商品名が一致する商品を取り込まない
 */
export function planMerge(repo, parsed, options = {}) {
  const conflictPolicy = options.conflict || 'keepExisting';
  const d = parsed.data;
  const errors = [];
  const summary = { add: {}, same: {}, conflict: {}, updated: {}, mappedByName: {}, skipped: {} };
  const inc = (k, t) => (summary[t][k] = (summary[t][k] || 0) + 1);
  const conflicts = [];
  const alreadyImported = (repo.state.importedBackupIds || []).includes(parsed.manifest.backupId);

  // マスター：ID一致 → 同一/競合、ID不一致でも名前一致 → 既存に対応付け
  const idMap = { divisions: new Map(), categories: new Map(), locations: new Map() };
  const put = { divisions: [], categories: [], locations: [], items: [], photos: [], photoBlobs: [], ops: [] };
  const del = { photos: [], photoBlobs: [] };
  const masters = [
    ['divisions', repo.divisions, '管理区分'],
    ['categories', repo.categories, 'カテゴリ'],
    ['locations', repo.locations, '保管場所'],
  ];
  for (const [key, local, label] of masters) {
    for (const rec0 of d[key]) {
      const rec = { ...rec0 };
      if (key === 'locations' && rec.divisionId) rec.divisionId = idMap.divisions.get(rec.divisionId) ?? rec.divisionId;
      const ex = local.get(rec.id);
      if (ex) {
        idMap[key].set(rec.id, rec.id);
        if (sameRecord(ex, rec)) inc(key, 'same');
        else if (conflictPolicy === 'newer' && (rec.updatedAt || '') > (ex.updatedAt || '')) {
          put[key].push(rec);
          inc(key, 'updated');
        } else {
          inc(key, 'conflict');
          conflicts.push(`${label}「${ex.name}」: 既存の内容を優先`);
        }
        continue;
      }
      const byName = [...local.values()].find((r) => !r.archived && normalizeName(r.name) === normalizeName(rec.name));
      if (byName) {
        idMap[key].set(rec.id, byName.id);
        inc(key, 'mappedByName');
        continue;
      }
      idMap[key].set(rec.id, rec.id);
      put[key].push(rec);
      inc(key, 'add');
    }
  }
  const mapLoc = (id) => (id == null ? id : idMap.locations.get(id) ?? id);

  // 商品
  const itemDecision = new Map(); // backupItemId -> 'add'|'same'|'keep'|'replace'|'skip'
  const dupCandidates = [];
  const localItems = [...repo.items.values()];
  for (const it0 of d.items) {
    const it = { ...it0, categoryId: it0.categoryId ? idMap.categories.get(it0.categoryId) ?? it0.categoryId : null };
    const ex = repo.items.get(it.id);
    if (ex) {
      if (sameRecord(ex, it)) {
        itemDecision.set(it.id, 'same');
        inc('items', 'same');
      } else if (conflictPolicy === 'newer' && (it.updatedAt || '') > (ex.updatedAt || '')) {
        itemDecision.set(it.id, 'replace');
        put.items.push(it);
        inc('items', 'updated');
      } else {
        itemDecision.set(it.id, 'keep');
        inc('items', 'conflict');
        conflicts.push(`商品「${ex.name}」: 既存の内容を優先（履歴は統合）`);
      }
      continue;
    }
    const dups = findDuplicates(it, localItems).filter((x) => x.reason !== 'name-similar');
    if (dups.length) {
      dupCandidates.push({ name: it.name, existing: dups[0].item.name, reason: dups[0].reason });
      if (options.skipDuplicateItems) {
        itemDecision.set(it.id, 'skip');
        inc('items', 'skipped');
        continue;
      }
    }
    itemDecision.set(it.id, 'add');
    put.items.push(it);
    inc('items', 'add');
  }

  // 写真：追加・置き換えた商品のもののみ
  for (const p of d.photos) {
    const dec = itemDecision.get(p.itemId);
    if (dec !== 'add' && dec !== 'replace') continue;
    if (repo.photos.has(p.id)) continue;
    put.photos.push(p);
    const b = parsed.blobs.get(p.id);
    put.photoBlobs.push({ id: p.id, data: b.data, thumb: b.thumb || null });
    inc('photos', 'add');
  }
  for (const it of put.items) {
    const ex = repo.items.get(it.id);
    if (!ex) continue;
    for (const pid of ex.photoIds) if (!it.photoIds.includes(pid)) del.photos.push(pid), del.photoBlobs.push(pid);
    for (const pid of it.photoIds) if (!repo.photos.has(pid) && !put.photos.some((p) => p.id === pid)) errors.push(`写真 ${pid} を取り込めません`);
  }

  // 履歴：IDで和集合。同じIDで内容が違うものはエラー（改ざん・破損）
  let maxSeq = 0;
  for (const op of repo.ops.values()) maxSeq = Math.max(maxSeq, op.seq);
  const seqMap = new Map();
  const incoming = [...d.ops].sort((a, b) => a.seq - b.seq);
  const newOps = [];
  for (const op of incoming) {
    if (itemDecision.get(op.itemId) === 'skip') continue;
    const ex = repo.ops.get(op.id);
    if (ex) {
      seqMap.set(op.seq, ex.seq);
      const cmpOp = { ...op, seq: ex.seq, order: ex.order, locationId: mapLoc(op.locationId), fromLocationId: mapLoc(op.fromLocationId), toLocationId: mapLoc(op.toLocationId) };
      for (const k of Object.keys(cmpOp)) if (cmpOp[k] === undefined) delete cmpOp[k];
      if (!sameRecord(ex, cmpOp)) errors.push(`同じIDで内容が異なる履歴があります（${op.id}）。統合できません。`);
      else inc('ops', 'same');
      continue;
    }
    seqMap.set(op.seq, ++maxSeq);
    newOps.push(op);
  }
  for (const op of newOps) {
    const rec = { ...op, seq: seqMap.get(op.seq), order: seqMap.get(op.order) ?? seqMap.get(op.seq) };
    for (const k of ['locationId', 'fromLocationId', 'toLocationId']) if (rec[k] != null) rec[k] = mapLoc(rec[k]);
    if (!repo.items.has(rec.itemId) && !put.items.some((i) => i.id === rec.itemId)) {
      errors.push(`履歴 ${rec.id} の商品が取り込まれません`);
      continue;
    }
    put.ops.push(rec);
    inc('ops', 'add');
  }

  // 統合後の全影響商品を再生して検証
  const affected = new Set(put.ops.map((o) => o.itemId));
  for (const itemId of affected) {
    const ops = [...repo.itemOps(itemId), ...put.ops.filter((o) => o.itemId === itemId)];
    const r = replay(ops);
    if (!r.ok) {
      const name = repo.items.get(itemId)?.name || d.items.find((i) => i.id === itemId)?.name;
      errors.push(`商品「${name}」: 統合すると在庫履歴に矛盾が生じます（${repo.explainLedgerError(r.error).message.replace(/\n/g, ' ')}）`);
    }
  }
  return { ok: errors.length === 0, errors, summary, conflicts, dupCandidates, alreadyImported, writes: { put, del } };
}

export async function restoreMerge(repo, parsed, options = {}) {
  if (!parsed.ok) throw new DomainError('INVALID_BACKUP', '検証エラーのあるバックアップは統合できません');
  const plan = planMerge(repo, parsed, options);
  if (!plan.ok) throw new DomainError('MERGE_CONFLICT', plan.errors.join('\n'));
  const state = {
    ...repo.state,
    revision: repo.state.revision + 1,
    lastChangeAt: nowIso(),
    importedBackupIds: [...new Set([...(repo.state.importedBackupIds || []), parsed.manifest.backupId])],
  };
  const put = { ...plan.writes.put, meta: [{ key: 'state', value: state }] };
  for (const k of Object.keys(put)) if (!put[k].length) delete put[k];
  const del = {};
  for (const k of Object.keys(plan.writes.del)) if (plan.writes.del[k].length) del[k] = plan.writes.del[k];
  await repo.commitBatch({ put, del }, { bump: false });
  return { mode: 'merge', plan };
}
