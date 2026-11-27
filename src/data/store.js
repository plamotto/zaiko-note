// リポジトリ層：IndexedDB 上のデータをメモリにキャッシュし、すべての変更を検証してから1トランザクションで保存する。
// 在庫数は保存せず、操作履歴から ledger.replay() で毎回導出する（キャッシュは商品単位）。

import { openDb, getAll, getOne, writeTx, normalizeError, deleteDb } from './db.js';
import { replay, activeOpIds, opStatus, OP_LABEL } from '../core/ledger.js';
import { parseMoneyInput, toCents, fromCents } from '../core/money.js';
import { normalizeJan, normalizeName } from '../core/text.js';
import { DomainError, uuid, nowIso, today, isValidDate, isPosInt, isNonNegInt, formatDateJa, clone } from '../core/util.js';

export const SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS = {
  theme: 'system', // system | light | dark
  viewMode: 'list', // list | card
  sortKey: 'updated', // name | qty | unitPrice | purchaseDate | created | updated
  sortDir: 'desc',
  backupIntervalDays: 7,
};

export class Repo {
  constructor(dbName) {
    this.dbName = dbName;
    this.db = null;
    this.items = new Map();
    this.photos = new Map(); // メタ情報のみ（画像本体は photoBlobs）
    this.categories = new Map();
    this.locations = new Map();
    this.divisions = new Map();
    this.ops = new Map();
    this.opsByItem = new Map();
    this.state = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this._ledger = new Map();
    this._listeners = new Set();
    this._queue = Promise.resolve();
  }

  // ───────────── 起動・購読 ─────────────
  async open() {
    this.db = await openDb(this.dbName);
    await this.reload();
    return this;
  }

  async reload() {
    const [items, photos, categories, locations, divisions, ops, meta] = await Promise.all(
      ['items', 'photos', 'categories', 'locations', 'divisions', 'ops', 'meta'].map((s) => getAll(this.db, s))
    );
    this.items = new Map(items.map((r) => [r.id, r]));
    this.photos = new Map(photos.map((r) => [r.id, r]));
    this.categories = new Map(categories.map((r) => [r.id, r]));
    this.locations = new Map(locations.map((r) => [r.id, r]));
    this.divisions = new Map(divisions.map((r) => [r.id, r]));
    this.ops = new Map(ops.map((r) => [r.id, r]));
    const m = new Map(meta.map((r) => [r.key, r.value]));
    this.settings = { ...DEFAULT_SETTINGS, ...(m.get('settings') || {}) };
    this.state = m.get('state') || null;
    if (!this.state) {
      this.state = { datasetId: uuid(), schemaVersion: SCHEMA_VERSION, revision: 0, lastBackupAt: null, lastBackupRevision: null, importedBackupIds: [], createdAt: nowIso() };
      await writeTx(this.db, { put: { meta: [{ key: 'state', value: this.state }] } });
    }
    this._reindex();
    this._emit();
  }

  close() {
    this.db?.close();
  }

  async destroy() {
    this.close();
    await deleteDb(this.dbName);
  }

  _reindex() {
    this.opsByItem = new Map();
    for (const op of this.ops.values()) {
      if (!this.opsByItem.has(op.itemId)) this.opsByItem.set(op.itemId, []);
      this.opsByItem.get(op.itemId).push(op);
    }
    this._ledger.clear();
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  _emit(info) {
    for (const fn of this._listeners) {
      try {
        fn(info);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** 変更を直列化して実行（複数の在庫変更を安全に処理） */
  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  /** 保存（1トランザクション）。成功後にメモリへ反映 */
  async _commit(w, { bump = true } = {}) {
    const put = { ...(w.put || {}) };
    let nextState = this.state;
    if (bump) {
      nextState = { ...this.state, revision: this.state.revision + 1, lastChangeAt: nowIso() };
      put.meta = [...(put.meta || []), { key: 'state', value: nextState }];
    }
    try {
      await writeTx(this.db, { ...w, put });
    } catch (e) {
      throw normalizeError(e);
    }
    // メモリ反映
    for (const s of w.clear || []) this._mapFor(s)?.clear();
    for (const [s, ids] of Object.entries(w.del || {})) {
      const m = this._mapFor(s);
      if (m) for (const id of ids) m.delete(id);
    }
    for (const [s, recs] of Object.entries(put)) {
      if (s === 'meta') {
        for (const r of recs) {
          if (r.key === 'state') this.state = r.value;
          if (r.key === 'settings') this.settings = { ...DEFAULT_SETTINGS, ...r.value };
        }
        continue;
      }
      const m = this._mapFor(s);
      if (m) for (const r of recs) m.set(r.id, r);
    }
    this._reindex();
    this._emit({ bump });
  }

  _mapFor(s) {
    return { items: this.items, photos: this.photos, categories: this.categories, locations: this.locations, divisions: this.divisions, ops: this.ops }[s];
  }

  // ───────────── 参照 ─────────────
  ledger(itemId) {
    if (!this._ledger.has(itemId)) this._ledger.set(itemId, replay(this.opsByItem.get(itemId) || []));
    return this._ledger.get(itemId);
  }

  itemOps(itemId) {
    return this.opsByItem.get(itemId) || [];
  }

  opStatuses(itemId) {
    return opStatus(this.itemOps(itemId));
  }

  /** 現在有効な（取り消し・訂正されていない）操作か */
  isOpActive(opId) {
    const op = this.ops.get(opId);
    if (!op) return false;
    return activeOpIds(this.itemOps(op.itemId)).has(opId);
  }

  async getPhotoBlob(photoId, kind = 'thumb') {
    const rec = await getOne(this.db, 'photoBlobs', photoId);
    if (!rec) return null;
    const meta = this.photos.get(photoId);
    return new Blob([kind === 'thumb' ? rec.thumb || rec.data : rec.data], { type: meta?.type || 'image/jpeg' });
  }

  async getPhotoRecord(photoId) {
    return getOne(this.db, 'photoBlobs', photoId);
  }

  locationName(id) {
    return this.locations.get(id)?.name ?? '（不明な場所）';
  }

  // ───────────── 設定 ─────────────
  async saveSettings(patch) {
    const next = { ...this.settings, ...patch };
    await this._commit({ put: { meta: [{ key: 'settings', value: next }] } }, { bump: false });
  }

  /** 保存成功を確認した後にのみ呼ぶ */
  async markBackedUp(revision, at = nowIso()) {
    const st = { ...this.state, lastBackupAt: at, lastBackupRevision: revision };
    await this._commit({ put: { meta: [{ key: 'state', value: st }] } }, { bump: false });
  }

  backupDue(now = new Date()) {
    const s = this.state;
    const hasData = this.items.size > 0 || this.ops.size > 0;
    if (!hasData) return { due: false };
    if (s.lastBackupRevision != null && s.lastBackupRevision >= s.revision) return { due: false, reason: 'unchanged' };
    if (!s.lastBackupAt) return { due: true, reason: 'never' };
    const days = (now - new Date(s.lastBackupAt)) / 86400000;
    return { due: days >= this.settings.backupIntervalDays, days: Math.floor(days) };
  }

  // ───────────── マスター（カテゴリ・管理区分・保管場所） ─────────────
  _checkName(map, name, id, label) {
    const n = String(name ?? '').trim();
    if (!n) throw new DomainError('REQUIRED', `${label}名を入力してください`);
    if (n.length > 60) throw new DomainError('TOO_LONG', `${label}名は60文字以内にしてください`);
    for (const r of map.values()) if (r.id !== id && !r.archived && normalizeName(r.name) === normalizeName(n)) throw new DomainError('DUP_NAME', `同じ名前の${label}「${r.name}」があります`);
    return n;
  }

  saveCategory(input) {
    return this._serial(async () => {
      const name = this._checkName(this.categories, input.name, input.id, 'カテゴリ');
      const prev = input.id ? this.categories.get(input.id) : null;
      const rec = { id: prev?.id || uuid(), name, sort: prev?.sort ?? this.categories.size, createdAt: prev?.createdAt || nowIso(), updatedAt: nowIso() };
      await this._commit({ put: { categories: [rec] } });
      return rec;
    });
  }

  /** カテゴリ削除：商品自体は削除せず「未設定」にする */
  deleteCategory(id) {
    return this._serial(async () => {
      const affected = [...this.items.values()].filter((i) => i.categoryId === id).map((i) => ({ ...i, categoryId: null, updatedAt: nowIso() }));
      await this._commit({ del: { categories: [id] }, put: { items: affected } });
      return affected.length;
    });
  }

  saveDivision(input) {
    return this._serial(async () => {
      const name = this._checkName(this.divisions, input.name, input.id, '管理区分');
      const prev = input.id ? this.divisions.get(input.id) : null;
      const rec = { id: prev?.id || uuid(), name, color: input.color || prev?.color || 'teal', sort: prev?.sort ?? this.divisions.size, createdAt: prev?.createdAt || nowIso(), updatedAt: nowIso() };
      await this._commit({ put: { divisions: [rec] } });
      return rec;
    });
  }

  deleteDivision(id) {
    return this._serial(async () => {
      const affected = [...this.locations.values()].filter((l) => l.divisionId === id).map((l) => ({ ...l, divisionId: null, updatedAt: nowIso() }));
      await this._commit({ del: { divisions: [id] }, put: { locations: affected } });
      return affected.length;
    });
  }

  saveLocation(input) {
    return this._serial(async () => {
      const name = this._checkName(this.locations, input.name, input.id, '保管場所');
      if (input.divisionId && !this.divisions.has(input.divisionId)) throw new DomainError('REF', '管理区分が見つかりません');
      const prev = input.id ? this.locations.get(input.id) : null;
      const rec = {
        id: prev?.id || uuid(),
        name,
        divisionId: input.divisionId || null,
        memo: String(input.memo ?? prev?.memo ?? '').trim(),
        sort: prev?.sort ?? this.locations.size,
        archived: false,
        createdAt: prev?.createdAt || nowIso(),
        updatedAt: nowIso(),
      };
      await this._commit({ put: { locations: [rec] } });
      return rec;
    });
  }

  locationInUse(id) {
    let stock = 0;
    for (const it of this.items.keys()) {
      const l = this.ledger(it);
      if (l.ok) stock += l.byLocation.get(id) || 0;
    }
    let refs = 0;
    for (const op of this.ops.values()) if (op.locationId === id || op.fromLocationId === id || op.toLocationId === id) refs++;
    return { stock, refs };
  }

  /** 在庫がある場所は削除不可。履歴で参照されている場所は非表示（アーカイブ）にして履歴を保持 */
  deleteLocation(id) {
    return this._serial(async () => {
      const { stock, refs } = this.locationInUse(id);
      if (stock > 0) throw new DomainError('IN_USE', `この保管場所には在庫が${stock}点あります。移動してから削除してください。`);
      if (refs > 0) {
        const rec = { ...this.locations.get(id), archived: true, updatedAt: nowIso() };
        await this._commit({ put: { locations: [rec] } });
        return 'archived';
      }
      await this._commit({ del: { locations: [id] } });
      return 'deleted';
    });
  }

  // ───────────── 商品 ─────────────
  normalizeItemInput(input, prev, extra = {}) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new DomainError('REQUIRED', '商品名を入力してください');
    if (name.length > 200) throw new DomainError('TOO_LONG', '商品名は200文字以内にしてください');
    const unit = String(input.unit ?? '').trim();
    if (!unit) throw new DomainError('REQUIRED', '基本数量単位を入力してください（例：個、枚、本）');
    if (unit.length > 10) throw new DomainError('TOO_LONG', '単位は10文字以内にしてください');
    const optInt = (v, label, min = 1) => {
      if (v === '' || v == null) return null;
      const n = typeof v === 'number' ? v : Number(String(v).normalize('NFKC').replace(/,/g, ''));
      if (!Number.isSafeInteger(n) || n < min) throw new DomainError('INVALID', `${label}は${min}以上の整数で入力してください`);
      return n;
    };
    const categoryId = input.categoryId || null;
    if (categoryId && !this.categories.has(categoryId) && !extra.catIds?.has(categoryId)) throw new DomainError('REF', 'カテゴリが見つかりません');
    const jan = normalizeJan(input.jan);
    if (jan && !/^\d{1,14}$/.test(jan)) throw new DomainError('INVALID', 'JANコードは数字のみ（14桁以内）で入力してください');
    const urls = (Array.isArray(input.urls) ? input.urls : String(input.urls ?? '').split(/\n/))
      .map((u) => String(u).trim())
      .filter(Boolean);
    const photoIds = input.photoIds ?? prev?.photoIds ?? [];
    return {
      name,
      unit,
      categoryId,
      jan: jan || null,
      maker: String(input.maker ?? '').trim(),
      model: String(input.model ?? '').trim(),
      spec: String(input.spec ?? '').trim(),
      packSize: optInt(input.packSize, '標準入数', 1),
      packUnit: String(input.packUnit ?? '').trim(),
      threshold: optInt(input.threshold, '警告ライン', 0),
      urls,
      memo: String(input.memo ?? '').trim(),
      photoIds,
    };
  }

  /**
   * 商品の作成・更新（写真の追加・削除・並び替えを同一トランザクションで）
   * @param {object} input 商品項目（id があれば更新）
   * @param {{add?:Array<{id?:string,data:ArrayBuffer,thumb:ArrayBuffer,type:string,width:number,height:number}>, removeIds?:string[]}} photoChanges
   *        input.photoIds に最終的な並び（先頭がメイン）を指定。追加分は add の id を含める。
   */
  saveItem(input, photoChanges = {}) {
    return this._serial(async () => {
      const prev = input.id ? this.items.get(input.id) : null;
      if (input.id && !prev) throw new DomainError('NOT_FOUND', '商品が見つかりません');
      const add = (photoChanges.add || []).map((p) => ({ ...p, id: p.id || uuid() }));
      const removeIds = photoChanges.removeIds || [];
      const data = this.normalizeItemInput(input, prev);
      const id = prev?.id || input.newId || uuid();
      const known = new Set([...(prev?.photoIds || []), ...add.map((p) => p.id)]);
      if (!input.photoIds) data.photoIds = [...(prev?.photoIds || []).filter((x) => !removeIds.includes(x)), ...add.map((p) => p.id)];
      for (const pid of data.photoIds) if (!known.has(pid) || removeIds.includes(pid)) throw new DomainError('REF', '写真の指定が不正です');
      const now = nowIso();
      const rec = {
        id,
        ...data,
        archived: prev?.archived ?? false,
        archivedAt: prev?.archivedAt ?? null,
        unitHistory: prev?.unitHistory,
        createdAt: prev?.createdAt || now,
        updatedAt: now,
      };
      const photoMeta = add.map((p) => ({ id: p.id, itemId: id, type: p.type || 'image/jpeg', width: p.width || 0, height: p.height || 0, bytes: p.data.byteLength, createdAt: now }));
      const photoBlobs = add.map((p) => ({ id: p.id, data: p.data, thumb: p.thumb }));
      await this._commit({
        put: { items: [rec], photos: photoMeta, photoBlobs },
        del: removeIds.length ? { photos: removeIds, photoBlobs: removeIds } : undefined,
      });
      return rec;
    });
  }

  setArchived(itemId, archived) {
    return this._serial(async () => {
      const it = this.items.get(itemId);
      if (!it) throw new DomainError('NOT_FOUND', '商品が見つかりません');
      const rec = { ...it, archived, archivedAt: archived ? nowIso() : null, updatedAt: nowIso() };
      await this._commit({ put: { items: [rec] } });
      return rec;
    });
  }

  /**
   * 記録の数をまとめて換算（例：入れ物を後から設定し、これまでの「2」を「2袋＝24ロール」に直す）。
   * この商品のすべての操作（訂正前の記録を含む）の数量を factor 倍する。購入総額は変えないので1個あたりの単価は 1/factor になる。
   * 入庫は「packCount 個の入れ物（1つ packSize×factor）」として記録し直す。棚卸しの単価（1個あたり）は 1/factor にし、1円未満は四捨五入（銭単位）。
   * 換算の記録は item.unitHistory に残す。
   */
  scaleItemQuantities(itemId, factor, { packUnit } = {}) {
    return this._serial(async () => {
      const it = this.items.get(itemId);
      if (!it) throw new DomainError('NOT_FOUND', '商品が見つかりません');
      if (!isPosInt(factor) || factor < 2 || factor > 100000) throw new DomainError('INVALID', '倍率は2以上の整数で指定してください');
      const f = factor;
      const mulAlloc = (a) => (Array.isArray(a) ? a.map((x) => ({ ...x, qty: x.qty * f })) : a);
      const ops = this.itemOps(itemId).map((o) => {
        const n = { ...o };
        if (o.type === 'receive') {
          n.packSize = o.packSize * f;
          n.looseQty = (o.looseQty ?? 0) * f;
          n.qty = o.qty * f;
          if (packUnit && o.packSize === 1 && !o.looseQty) n.packUnit = packUnit;
        } else if (o.type === 'consume' || o.type === 'move') {
          n.qty = o.qty * f;
          n.alloc = mulAlloc(o.alloc);
        } else if (o.type === 'adjust') {
          n.counted = o.counted * f;
          n.alloc = mulAlloc(o.alloc);
          if (o.unitAmount != null) {
            const c = toCents(o.unitAmount);
            n.unitAmount = fromCents((c * 2n + BigInt(f)) / (BigInt(f) * 2n));
          }
        }
        return n;
      });
      // 換算後も再計算できることを確認
      const r = replay(ops);
      if (!r.ok) throw new DomainError('INVALID', '換算後の再計算に失敗しました：' + r.error.message);
      const now = nowIso();
      const rec = { ...it, unitHistory: [...(it.unitHistory || []), { at: now, factor: f, unit: it.unit }], updatedAt: now };
      await this._commit({ put: { items: [rec], ops } });
      return { ops: ops.length };
    });
  }

  /** 完全削除：対象商品・その写真・その履歴のみを削除。カテゴリ・保管場所・他商品には触れない */
  deleteItemPermanently(itemId) {
    return this._serial(async () => {
      const it = this.items.get(itemId);
      if (!it) throw new DomainError('NOT_FOUND', '商品が見つかりません');
      const photoIds = [...this.photos.values()].filter((p) => p.itemId === itemId).map((p) => p.id);
      const opIds = this.itemOps(itemId).map((o) => o.id);
      await this._commit({ del: { items: [itemId], photos: photoIds, photoBlobs: photoIds, ops: opIds } });
      return { photos: photoIds.length, ops: opIds.length };
    });
  }

  // ───────────── 在庫操作 ─────────────
  _nextSeq() {
    let max = 0;
    for (const op of this.ops.values()) if (op.seq > max) max = op.seq;
    return max + 1;
  }

  _checkDate(v, label, { required = true } = {}) {
    if (v == null || v === '') {
      if (required) throw new DomainError('REQUIRED', `${label}を入力してください`);
      return null;
    }
    if (!isValidDate(v)) throw new DomainError('INVALID_DATE', `${label}が不正です`);
    if (v > today()) throw new DomainError('FUTURE_DATE', `${label}に未来の日付は指定できません`);
    return v;
  }

  _checkLoc(id, label = '保管場所', extra = {}) {
    if (!id || !(this.locations.has(id) || extra.locIds?.has(id))) throw new DomainError('REF', `${label}を選択してください`);
    return id;
  }

  _qty(v, label, { allowZero = false } = {}) {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').normalize('NFKC').replace(/,/g, ''));
    if (allowZero ? !isNonNegInt(n) : !isPosInt(n)) throw new DomainError('INVALID_QTY', `${label}は${allowZero ? '0' : '1'}以上の整数で入力してください`);
    if (n > 1e9) throw new DomainError('INVALID_QTY', `${label}が大きすぎます`);
    return n;
  }

  _alloc(alloc) {
    if (!alloc || !alloc.length) return null;
    return alloc.filter((a) => a.qty > 0).map((a) => ({ lotId: String(a.lotId), qty: this._qty(a.qty, 'ロット指定数量') }));
  }

  /** 入力から操作レコード（id/seq 以外）を作る。型ごとに検証 */
  buildOpFields(type, input, extra = {}) {
    if (!this.items.has(input.itemId) && !extra.itemIds?.has(input.itemId)) throw new DomainError('NOT_FOUND', '商品が見つかりません');
    const base = { itemId: input.itemId, type, date: this._checkDate(input.date, type === 'receive' ? '入庫日' : '操作日'), memo: String(input.memo ?? '').trim() };
    switch (type) {
      case 'receive': {
        const packCount = this._qty(input.packCount, '購入数量', { allowZero: true });
        const packSize = this._qty(input.packSize ?? 1, '入数');
        const looseQty = input.looseQty == null || input.looseQty === '' ? 0 : this._qty(input.looseQty, 'バラの数量', { allowZero: true });
        const qty = packCount * packSize + looseQty;
        if (qty < 1) throw new DomainError('INVALID_QTY', '数量を入力してください（1以上）');
        if (!Number.isSafeInteger(qty) || qty > 1e9) throw new DomainError('INVALID_QTY', '合計数量が大きすぎます');
        const amount = parseMoneyInput(input.amount);
        let tax = null;
        if (amount != null) {
          if (input.tax !== 'incl' && input.tax !== 'excl') throw new DomainError('REQUIRED', '税込・税抜を選択してください');
          tax = input.tax;
        }
        return {
          ...base,
          locationId: this._checkLoc(input.locationId, '保管場所', extra),
          detail: String(input.detail ?? '').trim(),
          packCount,
          packSize,
          looseQty,
          packUnit: String(input.packUnit ?? '').trim(),
          qty,
          amount,
          tax,
          purchaseDate: this._checkDate(input.purchaseDate, '購入日', { required: false }),
          storedDate: this._checkDate(input.storedDate, '保管日', { required: false }),
          supplier: String(input.supplier ?? '').trim(),
          url: String(input.url ?? '').trim(),
        };
      }
      case 'consume':
        return { ...base, locationId: this._checkLoc(input.locationId, '保管場所', extra), qty: this._qty(input.qty, '使用数量'), alloc: this._alloc(input.alloc) };
      case 'move': {
        const from = this._checkLoc(input.fromLocationId, '移動元', extra);
        const to = this._checkLoc(input.toLocationId, '移動先', extra);
        if (from === to) throw new DomainError('SAME_LOCATION', '移動元と移動先が同じです');
        return { ...base, fromLocationId: from, toLocationId: to, toDetail: String(input.toDetail ?? '').trim(), qty: this._qty(input.qty, '移動数量'), alloc: this._alloc(input.alloc) };
      }
      case 'adjust': {
        const unitAmount = parseMoneyInput(input.unitAmount);
        let tax = null;
        if (unitAmount != null) {
          if (input.tax !== 'incl' && input.tax !== 'excl') throw new DomainError('REQUIRED', '税込・税抜を選択してください');
          tax = input.tax;
        }
        return {
          ...base,
          locationId: this._checkLoc(input.locationId, '保管場所', extra),
          counted: this._qty(input.counted, '実数', { allowZero: true }),
          detail: String(input.detail ?? '').trim(),
          alloc: this._alloc(input.alloc),
          unitAmount,
          tax,
          reason: String(input.reason ?? '').trim(),
        };
      }
      default:
        throw new DomainError('UNKNOWN_TYPE', '不明な操作です');
    }
  }

  /** 履歴再生で矛盾がないか検証。矛盾があれば分かりやすい DomainError を投げる */
  _validateItemOps(itemId, ops, newOpIds = []) {
    const r = replay(ops);
    if (!r.ok) throw this.explainLedgerError(r.error, newOpIds);
    return r;
  }

  explainLedgerError(e, newOpIds = []) {
    const d = e.detail || {};
    const when = d.date ? formatDateJa(d.date) : '';
    const what = OP_LABEL[d.type] || '操作';
    const loc = d.locationId ? this.locationName(d.locationId) : '';
    let msg;
    switch (e.code) {
      case 'INSUFFICIENT':
        msg = `${when}の${what}で在庫が不足します（${loc}：その時点の在庫 ${d.available} / 必要 ${d.required}）`;
        break;
      case 'LOT_MISSING':
        msg = `${when}の${what}で指定された購入分が${loc}にありません`;
        break;
      case 'LOT_SHORT':
        msg = `${when}の${what}で指定された購入分の残数が足りません（残 ${d.available} / 指定 ${d.required}）`;
        break;
      default:
        msg = `${when}の${what}：${e.message}`;
    }
    const isOther = d.opId && !newOpIds.includes(d.opId);
    const out = new DomainError(e.code, isOther ? `この変更を行うと、以降の履歴に矛盾が生じます。\n${msg}\n日付や数量を見直すか、該当する操作を先に訂正してください。` : msg, { ...d, affectsOther: isOther });
    return out;
  }

  /** 新しい操作を追加（入庫・使用・移動・棚卸し） */
  addOp(type, input) {
    return this._serial(async () => {
      const fields = this.buildOpFields(type, input);
      const seq = this._nextSeq();
      const op = { id: uuid(), seq, order: seq, createdAt: nowIso(), ...fields };
      if (type === 'receive') op.lotId = op.id;
      if (type === 'adjust') op.lotId = 'adj-' + op.id;
      const r = this._validateItemOps(op.itemId, [...this.itemOps(op.itemId), op], [op.id]);
      if (type === 'adjust') op.recordedDelta = r.effects.get(op.id)?.delta ?? 0;
      await this._commit({ put: { ops: [op] } });
      return op;
    });
  }

  /** 取り消し（元の履歴は削除しない） */
  voidOp(targetId, reason = '') {
    return this._serial(async () => {
      const target = this.ops.get(targetId);
      if (!target) throw new DomainError('NOT_FOUND', '履歴が見つかりません');
      if (!this.isOpActive(targetId)) throw new DomainError('INACTIVE', 'この履歴は既に取り消し・訂正されています');
      const seq = this._nextSeq();
      const op = { id: uuid(), seq, order: seq, createdAt: nowIso(), itemId: target.itemId, type: 'void', date: today(), targetId, reason: String(reason || '').trim(), memo: '' };
      this._validateItemOps(target.itemId, [...this.itemOps(target.itemId), op], [op.id, targetId]);
      await this._commit({ put: { ops: [op] } });
      return op;
    });
  }

  /** 訂正：元の操作を無効化し、同じ並び位置に訂正内容を記録する */
  correctOp(targetId, input) {
    return this._serial(async () => {
      const target = this.ops.get(targetId);
      if (!target) throw new DomainError('NOT_FOUND', '履歴が見つかりません');
      if (target.type === 'void') throw new DomainError('INVALID', '取り消し記録は訂正できません（取り消しの取り消しを行ってください）');
      if (!this.isOpActive(targetId)) throw new DomainError('INACTIVE', 'この履歴は既に取り消し・訂正されています。最新の内容を訂正してください。');
      const fields = this.buildOpFields(target.type, { ...input, itemId: target.itemId });
      const seq = this._nextSeq();
      const op = { id: uuid(), seq, order: target.order, createdAt: nowIso(), ...fields, corrects: targetId, correctionReason: String(input.correctionReason ?? '').trim() };
      if (target.lotId) op.lotId = target.lotId;
      const r = this._validateItemOps(target.itemId, [...this.itemOps(target.itemId), op], [op.id, targetId]);
      if (op.type === 'adjust') op.recordedDelta = r.effects.get(op.id)?.delta ?? 0;
      await this._commit({ put: { ops: [op] } });
      return op;
    });
  }

  /** 複数レコードの一括コミット（CSV取り込み・サンプル投入・復元で使用）。呼び出し側で検証済みであること */
  commitBatch(w, opts) {
    return this._serial(() => this._commit(w, opts));
  }

  /** 全商品の履歴が再生可能か検証（整合性チェック） */
  checkIntegrity() {
    const problems = [];
    for (const it of this.items.values()) {
      const r = this.ledger(it.id);
      if (!r.ok) problems.push({ itemId: it.id, name: it.name, error: this.explainLedgerError(r.error).message });
      for (const pid of it.photoIds) if (!this.photos.has(pid)) problems.push({ itemId: it.id, name: it.name, error: '写真データが見つかりません' });
      if (it.categoryId && !this.categories.has(it.categoryId)) problems.push({ itemId: it.id, name: it.name, error: 'カテゴリ参照が不正です' });
    }
    for (const op of this.ops.values()) {
      if (!this.items.has(op.itemId)) problems.push({ opId: op.id, error: '存在しない商品の履歴があります' });
      for (const k of ['locationId', 'fromLocationId', 'toLocationId']) if (op[k] && !this.locations.has(op[k])) problems.push({ opId: op.id, error: '存在しない保管場所を参照しています' });
    }
    return problems;
  }

  /** 商品の在庫概要（一覧表示用） */
  summary(itemId) {
    const it = this.items.get(itemId);
    const l = this.ledger(itemId);
    if (!l.ok) return { ok: false, total: 0, byLocation: new Map(), error: l.error };
    return { ok: true, total: l.total, byLocation: l.byLocation };
  }

  /** 全データのスナップショット（バックアップ用、写真本体は別取得） */
  snapshot() {
    return {
      divisions: [...this.divisions.values()].map(clone),
      categories: [...this.categories.values()].map(clone),
      locations: [...this.locations.values()].map(clone),
      items: [...this.items.values()].map(clone),
      photos: [...this.photos.values()].map(clone),
      ops: [...this.ops.values()].sort((a, b) => a.seq - b.seq).map(clone),
      settings: clone(this.settings),
    };
  }
}
