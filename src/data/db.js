// IndexedDB の薄いラッパー。全ストアを1トランザクションで更新できるようにし、
// 途中失敗時はブラウザがトランザクション全体をロールバックする（部分反映を残さない）。

export const DB_VERSION = 1;
export const STORES = ['items', 'photos', 'photoBlobs', 'categories', 'locations', 'divisions', 'ops', 'meta'];

export function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (db.objectStoreNames.contains(s)) continue;
        const os = db.createObjectStore(s, { keyPath: s === 'meta' ? 'key' : 'id' });
        if (s === 'ops' || s === 'photos') os.createIndex('itemId', 'itemId');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('データベースが他のタブで使用中です。他のタブを閉じてください。'));
  });
}

export function getAll(db, store) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function getOne(db, store, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * 書き込みトランザクション。
 * @param {{clear?:string[], put?:Object<string,Array>, del?:Object<string,Array>}} w
 */
export function writeTx(db, w) {
  const names = new Set([...(w.clear || []), ...Object.keys(w.put || {}), ...Object.keys(w.del || {})]);
  if (!names.size) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction([...names], 'readwrite');
    } catch (e) {
      reject(e);
      return;
    }
    let failed = null;
    tx.oncomplete = () => resolve();
    tx.onerror = (ev) => {
      failed = failed || tx.error || ev.target?.error;
    };
    tx.onabort = () => reject(normalizeError(failed || tx.error || new Error('保存が中断されました')));
    try {
      for (const s of w.clear || []) tx.objectStore(s).clear();
      for (const [s, ids] of Object.entries(w.del || {})) for (const id of ids) tx.objectStore(s).delete(id);
      for (const [s, recs] of Object.entries(w.put || {})) for (const r of recs) tx.objectStore(s).put(r);
    } catch (e) {
      failed = e;
      try {
        tx.abort();
      } catch {}
    }
  });
}

export function normalizeError(e) {
  if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) {
    const err = new Error('端末の保存容量が不足しているため保存できませんでした。不要な写真を削除するか、端末の空き容量を確保してください。データは変更されていません。');
    err.code = 'QUOTA';
    return err;
  }
  return e instanceof Error ? e : new Error(String(e));
}

export function deleteDb(name) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => resolve();
  });
}
