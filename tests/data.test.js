// IndexedDB を使う結合テスト（実ブラウザの IndexedDB で実行。テスト専用DB名を使い終了後に削除）
import { suite, test, eq, ok, rejects } from './harness.js';
import { Repo } from '../src/data/store.js';
import { writeTx } from '../src/data/db.js';
import { createBackup, parseBackup, restoreReplace, restoreMerge, planMerge } from '../src/data/backup.js';
import { planCsvImport, commitCsvImport, exportItemsCsv, exportPurchasesCsv } from '../src/data/csvio.js';
import { loadSampleData } from '../src/data/sample.js';
import { valuation } from '../src/core/ledger.js';
import { formatFrac } from '../src/core/money.js';
import { parseCsv } from '../src/core/csv.js';
import { zipSync, unzip } from '../src/core/zip.js';
import { addDays, today } from '../src/core/util.js';

let n = 0;
async function freshRepo() {
  const r = new Repo(`zaiko-test-${Date.now()}-${++n}`);
  await r.open();
  cleanup.push(r);
  return r;
}
export const cleanup = [];
const D = (k) => addDays(today(), -k);

async function base(repo) {
  const div = await repo.saveDivision({ name: '仕事用' });
  const A = await repo.saveLocation({ name: '倉庫A', divisionId: div.id });
  const B = await repo.saveLocation({ name: '厨房', divisionId: div.id });
  const cat = await repo.saveCategory({ name: '消耗品' });
  const item = await repo.saveItem({ name: 'ニトリル手袋 M', unit: '枚', categoryId: cat.id, jan: '4901234567894', packSize: 100, packUnit: '箱', threshold: 50 });
  return { A, B, cat, item, div };
}

const fakePhoto = async (emoji, hue, v) => {
  const data = new TextEncoder().encode(`PHOTO:${emoji}:${hue}:${v}`).buffer;
  return { data, thumb: new TextEncoder().encode(`THUMB:${emoji}`).buffer, type: 'image/jpeg', width: 10, height: 10 };
};

suite('商品管理（IndexedDB）', () => {
  test('商品登録：必須は商品名と単位のみ、在庫0で登録可', { input: '{name:"計量カップ", unit:"個"}', expected: '登録成功・在庫0・作成/更新日時あり。商品名なし・単位なしはエラー' }, async () => {
    const repo = await freshRepo();
    const it = await repo.saveItem({ name: '計量カップ', unit: '個' });
    eq(repo.ledger(it.id).total, 0);
    ok(it.createdAt && it.updatedAt);
    await rejects(() => repo.saveItem({ name: '', unit: '個' }), 'REQUIRED');
    await rejects(() => repo.saveItem({ name: 'x', unit: '' }), 'REQUIRED');
  });
  test('商品更新と写真の追加・並び替え・削除', { input: '写真3枚で登録 → 並びを[3,1]に変更し2枚目を削除', expected: 'photoIds=[3,1]、写真2の本体も削除、メインは3' }, async () => {
    const repo = await freshRepo();
    const p = await Promise.all([1, 2, 3].map((i) => fakePhoto('x', i, i)));
    p.forEach((x, i) => (x.id = 'p' + (i + 1)));
    const it = await repo.saveItem({ name: '写真テスト', unit: '個' }, { add: p });
    eq(it.photoIds, ['p1', 'p2', 'p3']);
    const up = await repo.saveItem({ ...it, photoIds: ['p3', 'p1'], name: '写真テスト改' }, { removeIds: ['p2'] });
    eq(up.photoIds, ['p3', 'p1']);
    eq(up.name, '写真テスト改');
    eq(await repo.getPhotoRecord('p2'), undefined);
    ok(await repo.getPhotoBlob('p3', 'main'));
    ok(up.updatedAt >= it.updatedAt);
  });
  test('入庫・使用と不正数量の拒否', { input: '3箱×100枚入庫、使用35、使用0、使用-1、使用1.5、未来日付', expected: '在庫265、不正値はすべてエラーで保存されない' }, async () => {
    const repo = await freshRepo();
    const { A, item } = await base(repo);
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 3, packSize: 100, amount: '3000', tax: 'incl', date: D(5) });
    await repo.addOp('consume', { itemId: item.id, locationId: A.id, qty: 35, date: D(4) });
    eq(repo.ledger(item.id).total, 265);
    const before = repo.ops.size;
    for (const q of [0, -1, 1.5, 'abc']) await rejects(() => repo.addOp('consume', { itemId: item.id, locationId: A.id, qty: q, date: D(1) }), 'INVALID_QTY');
    await rejects(() => repo.addOp('consume', { itemId: item.id, locationId: A.id, qty: 1, date: addDays(today(), 1) }), 'FUTURE_DATE');
    await rejects(() => repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 1, amount: '100', date: D(1) }), 'REQUIRED');
    eq(repo.ops.size, before);
  });
  test('在庫不足の使用は拒否され、DBに残らない', { input: '在庫10で使用11', expected: 'エラー「在庫が不足」、履歴件数不変' }, async () => {
    const repo = await freshRepo();
    const { A, item } = await base(repo);
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 10, packSize: 1, date: D(3) });
    const e = await rejects(() => repo.addOp('consume', { itemId: item.id, locationId: A.id, qty: 11, date: D(1) }), 'INSUFFICIENT');
    ok(/在庫が不足/.test(e.message));
    await repo.reload();
    eq(repo.ops.size, 1);
  });
  test('移動：合計不変・ロット価格引き継ぎ', { input: 'A に 10@¥1000、A→B 4移動', expected: 'A=6・B=4、合計10、Bの評価額¥400' }, async () => {
    const repo = await freshRepo();
    const { A, B, item } = await base(repo);
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 10, amount: '1000', tax: 'incl', date: D(3) });
    await repo.addOp('move', { itemId: item.id, fromLocationId: A.id, toLocationId: B.id, qty: 4, toDetail: '棚1', date: D(2) });
    const l = repo.ledger(item.id);
    eq([l.byLocation.get(A.id), l.byLocation.get(B.id), l.total], [6, 4, 10]);
    const vb = valuation(
      l.portions.filter((p) => p.locationId === B.id),
      l.lots
    );
    eq(formatFrac(vb.total), '¥400');
    eq(l.portions.find((p) => p.locationId === B.id).detail, '棚1');
  });
  test('棚卸し：差分を履歴に記録', { input: '在庫10 → 実数7、さらに実数9（単価未設定）', expected: 'recordedDelta -3 / +2、在庫9、価格未設定2' }, async () => {
    const repo = await freshRepo();
    const { A, item } = await base(repo);
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 10, amount: '1000', tax: 'excl', date: D(5) });
    const a1 = await repo.addOp('adjust', { itemId: item.id, locationId: A.id, counted: 7, date: D(3) });
    const a2 = await repo.addOp('adjust', { itemId: item.id, locationId: A.id, counted: 9, date: D(2) });
    eq([a1.recordedDelta, a2.recordedDelta], [-3, 2]);
    const l = repo.ledger(item.id);
    eq(l.total, 9);
    eq(valuation(l.portions, l.lots).unknownQty, 2);
  });
  test('履歴の訂正・取り消し（元履歴は削除しない）', { input: '入庫10、使用3 → 使用を5に訂正 → 訂正を取り消し', expected: '在庫 7 → 5 → 7、履歴は4件すべて保持' }, async () => {
    const repo = await freshRepo();
    const { A, item } = await base(repo);
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 10, date: D(5) });
    const c = await repo.addOp('consume', { itemId: item.id, locationId: A.id, qty: 3, date: D(3) });
    eq(repo.ledger(item.id).total, 7);
    const fix = await repo.correctOp(c.id, { locationId: A.id, qty: 5, date: D(3), correctionReason: '数え間違い' });
    eq(repo.ledger(item.id).total, 5);
    eq(fix.order, c.order);
    await rejects(() => repo.correctOp(c.id, { locationId: A.id, qty: 1, date: D(3) }), 'INACTIVE');
    await repo.voidOp(fix.id, '訂正ミス');
    eq(repo.ledger(item.id).total, 7);
    eq(repo.itemOps(item.id).length, 4);
  });
  test('入庫の取り消しで以降の使用が不足する場合は拒否', { input: '入庫5、使用4、入庫の取り消し', expected: 'エラー（以降の履歴に矛盾）、在庫1のまま' }, async () => {
    const repo = await freshRepo();
    const { A, item } = await base(repo);
    const r = await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 5, date: D(5) });
    await repo.addOp('consume', { itemId: item.id, locationId: A.id, qty: 4, date: D(3) });
    const e = await rejects(() => repo.voidOp(r.id), 'INSUFFICIENT');
    ok(/矛盾/.test(e.message));
    eq(repo.ledger(item.id).total, 1);
  });
  test('過去日付の追加で再計算・矛盾時は拒否', { input: '入庫10(5日前)、使用8(2日前)、過去(4日前)に使用3を追加', expected: '2日前の使用で不足 → 拒否。使用2なら成功し在庫0' }, async () => {
    const repo = await freshRepo();
    const { A, item } = await base(repo);
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 10, date: D(5) });
    await repo.addOp('consume', { itemId: item.id, locationId: A.id, qty: 8, date: D(2) });
    const e = await rejects(() => repo.addOp('consume', { itemId: item.id, locationId: A.id, qty: 3, date: D(4) }), 'INSUFFICIENT');
    ok(e.detail.affectsOther, '後続の操作が原因であることを示す');
    await repo.addOp('consume', { itemId: item.id, locationId: A.id, qty: 2, date: D(4) });
    eq(repo.ledger(item.id).total, 0);
  });
  test('完全削除は対象商品のみ（カテゴリ・場所・他商品は残る）', { input: '商品X・Y（同カテゴリ・同場所）でXを完全削除', expected: 'Xと写真・履歴のみ削除、Y・カテゴリ・場所は残る' }, async () => {
    const repo = await freshRepo();
    const { A, cat, item } = await base(repo);
    const ph = await fakePhoto('a', 1, 1);
    const y = await repo.saveItem({ name: 'Y', unit: '個', categoryId: cat.id }, { add: [ph] });
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 2, date: D(2) });
    await repo.addOp('receive', { itemId: y.id, locationId: A.id, packCount: 3, date: D(2) });
    const xPh = await fakePhoto('b', 1, 1);
    await repo.saveItem({ ...item, photoIds: undefined }, { add: [xPh] });
    await repo.deleteItemPermanently(item.id);
    await repo.reload();
    ok(!repo.items.has(item.id));
    ok(repo.items.has(y.id) && repo.categories.has(cat.id) && repo.locations.has(A.id));
    eq(repo.ledger(y.id).total, 3);
    eq([...repo.photos.values()].map((p) => p.itemId), [y.id]);
    eq([...repo.ops.values()].every((o) => o.itemId === y.id), true);
  });
  test('アーカイブ・解除で履歴保持', { input: '在庫ありの商品をアーカイブ→解除', expected: '在庫・履歴は変化なし' }, async () => {
    const repo = await freshRepo();
    const { A, item } = await base(repo);
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 2, date: D(2) });
    await repo.setArchived(item.id, true);
    eq([repo.items.get(item.id).archived, repo.ledger(item.id).total], [true, 2]);
    await repo.setArchived(item.id, false);
    eq([repo.items.get(item.id).archived, repo.itemOps(item.id).length], [false, 1]);
  });
  test('保管場所の名前変更でも紐づけ維持／在庫のある場所は削除不可', { input: '倉庫A→第1倉庫に改名、在庫ありで削除', expected: '在庫はそのまま、削除はエラー' }, async () => {
    const repo = await freshRepo();
    const { A, item, div } = await base(repo);
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 2, date: D(2) });
    await repo.saveLocation({ id: A.id, name: '第1倉庫', divisionId: div.id });
    eq(repo.locationName([...repo.ledger(item.id).byLocation.keys()][0]), '第1倉庫');
    await rejects(() => repo.deleteLocation(A.id), 'IN_USE');
  });
  test('カテゴリ削除で商品は未設定になる（商品は消えない）', { input: 'カテゴリ「消耗品」を削除', expected: '商品は残り categoryId=null' }, async () => {
    const repo = await freshRepo();
    const { cat, item } = await base(repo);
    await repo.deleteCategory(cat.id);
    eq(repo.items.get(item.id).categoryId, null);
  });
  test('同時に複数の在庫変更を投げても直列化され整合', { input: '在庫10に対し、使用3を同時に5件', expected: '3件成功・2件失敗、在庫1' }, async () => {
    const repo = await freshRepo();
    const { A, item } = await base(repo);
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 10, date: D(2) });
    const res = await Promise.allSettled([1, 2, 3, 4, 5].map(() => repo.addOp('consume', { itemId: item.id, locationId: A.id, qty: 3, date: D(1) })));
    eq(res.filter((r) => r.status === 'fulfilled').length, 3);
    eq(repo.ledger(item.id).total, 1);
  });
  test('トランザクション途中失敗で部分反映しない', { input: '正常レコード + keyPath欠落レコードを同一トランザクションで書き込み', expected: '例外、正常レコードも保存されない' }, async () => {
    const repo = await freshRepo();
    let threw = false;
    try {
      await writeTx(repo.db, { put: { categories: [{ id: 'ok1', name: 'OK' }, { name: 'IDなし' }] } });
    } catch {
      threw = true;
    }
    ok(threw);
    await repo.reload();
    ok(!repo.categories.has('ok1'));
  });
  test('バックアップリマインダー', { input: '未バックアップ / バックアップ直後 / 変更後8日', expected: 'due=true / false / true' }, async () => {
    const repo = await freshRepo();
    await base(repo);
    eq(repo.backupDue().due, true);
    await repo.markBackedUp(repo.state.revision);
    eq(repo.backupDue().due, false);
    await repo.saveCategory({ name: '追加' });
    eq(repo.backupDue().due, false, '7日未満');
    eq(repo.backupDue(new Date(Date.now() + 8 * 86400000)).due, true);
  });
});

suite('入れ物を後から設定したときの記録の換算', () => {
  test('「2ロール」を「2袋（24ロール）」に直す', { input: '入れ物なしで2ロール¥1,596(税抜)入庫・1ロール使用 → 1袋12ロールを設定 → 12倍に換算', expected: '入庫24ロール(2袋×12)、使用12、在庫12ロール、1ロール¥66.5、在庫金額¥798、換算記録が残る' }, async () => {
    const repo = await freshRepo();
    const { A, item } = await base(repo);
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 2, packSize: 1, amount: '1596', tax: 'excl', date: D(3) });
    await repo.addOp('consume', { itemId: item.id, locationId: A.id, qty: 1, date: D(2) });
    eq(repo.ledger(item.id).total, 1);
    await repo.saveItem({ ...repo.items.get(item.id), packSize: 12, packUnit: '袋' });
    await repo.scaleItemQuantities(item.id, 12, { packUnit: '袋' });
    const L = repo.ledger(item.id);
    eq(L.total, 12);
    const rc = repo.itemOps(item.id).find((o) => o.type === 'receive');
    eq([rc.packCount, rc.packSize, rc.qty, rc.packUnit, rc.amount], [2, 12, 24, '袋', '1596']);
    const v = valuation(L.portions, L.lots);
    eq(formatFrac(v.avg.excl, 2), '¥66.50');
    eq(formatFrac(v.groups.excl.value, 0), '¥798');
    eq(repo.items.get(item.id).unitHistory.length, 1);
    await rejects(() => repo.scaleItemQuantities(item.id, 1), 'INVALID');
  });
});

suite('CSV取り込み', () => {
  const header = '商品ID,商品名,単位,カテゴリ,JANコード,標準入数,入数単位,警告ライン,入庫数量,入数,金額,税区分,入庫日,保管場所,棚卸数量,棚卸場所,棚卸日';
  test('新規一括登録＋入庫（場所・カテゴリ自動作成）', { input: '2行：新規商品2件、1行目は入庫3箱×100/¥3000税込/倉庫B', expected: '商品2件追加、入庫履歴1件、倉庫Bと事務用品カテゴリを作成、在庫300' }, async () => {
    const repo = await freshRepo();
    await base(repo);
    const csv = `${header}\n,ゴミ袋45L,枚,事務用品,,10,袋,20,3,100,3000,税込,${D(3)},倉庫B,,,\n,ボールペン,本,事務用品,,,,,,,,,,,,,`;
    const plan = planCsvImport(repo, csv);
    eq(plan.ok, true, JSON.stringify(plan.errorRows?.map((r) => r.errors)));
    eq([plan.counts.new, plan.counts.receive, plan.newLocations.length, plan.newCategories.length], [2, 1, 1, 1]);
    await commitCsvImport(repo, plan);
    const bag = [...repo.items.values()].find((i) => i.name === 'ゴミ袋45L');
    eq(repo.ledger(bag.id).total, 300);
    eq(repo.items.size, 3);
  });
  test('JAN一致は既存商品へ入庫、類似名は選択必須', { input: 'JAN一致行（入庫5）＋「ニトリル手袋 L」（類似）', expected: 'JAN行は既存へ。類似行は選択待ちエラー → "new" 選択で取り込み可' }, async () => {
    const repo = await freshRepo();
    const { item } = await base(repo);
    const csv = `${header}\n,別名の手袋,枚,,4901234567894,,,,5,1,,,${D(1)},倉庫A,,,\n,ニトリル手袋 L,枚,,,,,,,,,,,,,,`;
    let plan = planCsvImport(repo, csv);
    eq(plan.rows[0].action, 'update');
    eq(plan.rows[0].autoMatched, 'jan');
    ok(plan.rows[1].needsChoice);
    eq(plan.ok, false);
    plan = planCsvImport(repo, csv, { [plan.rows[1].rowNo]: 'new' });
    eq(plan.ok, true);
    await commitCsvImport(repo, plan);
    eq(repo.ledger(item.id).total, 5);
    eq(repo.items.get(item.id).name, '別名の手袋', '商品名も更新される（空欄以外の列のみ更新）');
  });
  test('CSVの在庫数は棚卸し調整として記録（直接上書き禁止）', { input: '在庫10の既存商品に 棚卸数量=6', expected: 'adjust 履歴（差分-4）が追加され在庫6' }, async () => {
    const repo = await freshRepo();
    const { A, item } = await base(repo);
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 10, date: D(5) });
    const plan = planCsvImport(repo, `${header}\n${item.id},,,,,,,,,,,,,,6,倉庫A,${D(1)}`);
    eq(plan.ok, true);
    await commitCsvImport(repo, plan);
    const adj = [...repo.ops.values()].find((o) => o.type === 'adjust');
    eq([adj.recordedDelta, repo.ledger(item.id).total], [-4, 6]);
  });
  test('エラー行の表示と全件不採用', { input: '単位なし新規行・不正日付（2025/13/40）・金額のみ（税区分なし）・棚卸数量 -1', expected: 'エラー行が列挙され commit は拒否、DB不変' }, async () => {
    const repo = await freshRepo();
    const { item } = await base(repo);
    const csv = `${header}\n,単位なし商品,,,,,,,,,,,,,,,\n,日付不正,個,,,,,,1,1,,,2025/13/40,倉庫A,,,\n,税区分なし,個,,,,,,1,1,500,,${D(1)},倉庫A,,,\n${item.id},,,,,,,,,,,,,,-1,倉庫A,`;
    const plan = planCsvImport(repo, csv);
    eq(plan.errorRows.length, 4);
    const before = repo.items.size;
    await rejects(() => commitCsvImport(repo, plan), 'CSV_ERRORS');
    eq(repo.items.size, before);
  });
  test('CSV出力（商品・購入履歴）', { input: '入庫2件（税込・価格未設定）', expected: 'ヘッダー＋行、価格未設定の表記、BOM付き' }, async () => {
    const repo = await freshRepo();
    const { A, item } = await base(repo);
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 1, packSize: 100, amount: '1000', tax: 'incl', date: D(2) });
    await repo.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 1, packSize: 100, date: D(1) });
    const items = parseCsv(exportItemsCsv(repo));
    eq(items.length, 2);
    eq(items[1][13], '200');
    const p = parseCsv(exportPurchasesCsv(repo));
    eq(p.length, 3);
    eq(p[2][15], '価格未設定');
    eq(p[1][16], '10');
  });
});

suite('バックアップ・復元', () => {
  async function populated() {
    const repo = await freshRepo();
    await loadSampleData(repo, fakePhoto);
    return repo;
  }
  const summarize = (repo) => {
    const s = {};
    for (const it of [...repo.items.values()].sort((a, b) => a.id.localeCompare(b.id))) s[it.id + ':' + it.name] = repo.ledger(it.id).total;
    return JSON.stringify([repo.items.size, repo.ops.size, repo.photos.size, repo.locations.size, s]);
  };
  test('バックアップ作成 → 検証 → 全件置き換えで完全一致', { input: 'サンプル全データ（写真含む）', expected: '件数・在庫数・写真バイト列・ID・設定が一致' }, async () => {
    const src = await populated();
    await src.saveSettings({ theme: 'dark', viewMode: 'card' });
    const bk = await createBackup(src);
    const parsed = await parseBackup(bk.bytes);
    eq(parsed.ok, true, parsed.errors.join('\n'));
    eq(parsed.counts.items, src.items.size);
    const dst = await freshRepo();
    await restoreReplace(dst, parsed);
    await dst.reload();
    eq(summarize(dst), summarize(src));
    eq(dst.settings.theme, 'dark');
    const pid = [...src.photos.keys()][0];
    const a = new Uint8Array((await src.getPhotoRecord(pid)).data);
    const b = new Uint8Array((await dst.getPhotoRecord(pid)).data);
    eq([...a], [...b]);
    eq(dst.checkIntegrity(), []);
  });
  test('統合：同じバックアップの二重取り込みを防止', { input: '空DBに統合 → 同じファイルを再度統合', expected: '2回目は追加0件・既存と同一として扱い、件数不変' }, async () => {
    const src = await populated();
    const parsed = await parseBackup((await createBackup(src)).bytes);
    const dst = await freshRepo();
    await restoreMerge(dst, parsed);
    const first = summarize(dst);
    const plan2 = planMerge(dst, parsed);
    ok(plan2.alreadyImported);
    eq(Object.values(plan2.summary.add).reduce((a, b) => a + b, 0), 0);
    await restoreMerge(dst, parsed);
    eq(summarize(dst), first);
    eq(summarize(dst), summarize(src));
  });
  test('統合：既存データ＋別端末データ。同名の保管場所は対応付け、重複商品は報告', { input: '既存DB（倉庫A・手袋M）にサンプルを統合', expected: '倉庫Aは1件のまま、手袋Mは重複候補として報告、全商品の履歴が整合' }, async () => {
    const src = await populated();
    const parsed = await parseBackup((await createBackup(src)).bytes);
    const dst = await freshRepo();
    await base(dst);
    const plan = planMerge(dst, parsed);
    eq(plan.ok, true, plan.errors.join('\n'));
    ok(plan.dupCandidates.length >= 1);
    await restoreMerge(dst, parsed);
    eq([...dst.locations.values()].filter((l) => l.name === '倉庫A').length, 1);
    eq(dst.checkIntegrity(), []);
  });
  test('統合：重複候補をスキップする選択', { input: 'skipDuplicateItems=true', expected: 'JAN一致の商品とその履歴は取り込まれない' }, async () => {
    const src = await populated();
    const parsed = await parseBackup((await createBackup(src)).bytes);
    const dst = await freshRepo();
    const { item } = await base(dst);
    await dst.saveItem({ ...item, jan: [...src.items.values()].find((i) => i.name.startsWith('ニトリル手袋 M')).jan });
    await restoreMerge(dst, parsed, { skipDuplicateItems: true });
    eq([...dst.items.values()].filter((i) => i.name.startsWith('ニトリル手袋 M')).length, 1);
    eq(dst.checkIntegrity(), []);
  });
  test('破損ファイル・改ざんの検出', { input: 'data.json の1バイト改変（CRC再計算済）/ ZIPでないファイル', expected: 'ハッシュ不一致エラー / 読み込みエラー。DB不変' }, async () => {
    const src = await populated();
    const bk = await createBackup(src);
    const entries = await unzip(bk.bytes);
    const data = new TextDecoder().decode(entries.get('data.json')).replace('ニトリル', 'ニトリロ');
    const files = [...entries].map(([name, d]) => ({ name, data: name === 'data.json' ? data : d }));
    const p1 = await parseBackup(zipSync(files));
    eq(p1.ok, false);
    ok(p1.errors.some((e) => /ハッシュ/.test(e)));
    const p2 = await parseBackup(new TextEncoder().encode('not a zip'));
    eq(p2.ok, false);
    await rejects(() => restoreReplace(src, p1), 'INVALID_BACKUP');
  });
  test('統合で履歴矛盾が出る場合は全体を中止し既存データ保持', { input: '同一商品IDで両端末が在庫を使い切る履歴を統合', expected: 'MERGE_CONFLICT、既存データ不変' }, async () => {
    const a = await freshRepo();
    const { A, item } = await base(a);
    await a.addOp('receive', { itemId: item.id, locationId: A.id, packCount: 5, date: D(10) });
    const parsed = await parseBackup((await createBackup(a)).bytes);
    // 別端末：同じ商品・場所で使用5（バックアップからの続き）
    const b = await freshRepo();
    await restoreReplace(b, parsed);
    await b.addOp('consume', { itemId: item.id, locationId: A.id, qty: 5, date: D(5) });
    const pb = await parseBackup((await createBackup(b)).bytes);
    // 元端末でも使用3
    await a.addOp('consume', { itemId: item.id, locationId: A.id, qty: 3, date: D(4) });
    const before = summarize(a);
    await rejects(() => restoreMerge(a, pb), 'MERGE_CONFLICT');
    await a.reload();
    eq(summarize(a), before);
  });
});

suite('サンプルデータ', () => {
  test('サンプル投入と整合性', { input: 'loadSampleData()', expected: '16商品、整合性エラー0、手袋M在庫540（倉庫A450/厨房90）、洗剤は在庫切れ' }, async () => {
    const repo = await freshRepo();
    await loadSampleData(repo, fakePhoto);
    eq(repo.items.size, 16);
    eq(repo.checkIntegrity(), []);
    const by = (p) => [...repo.items.values()].find((i) => i.name.startsWith(p));
    const g = repo.ledger(by('ニトリル手袋 M').id);
    eq(g.total, 540);
    const locs = [...g.byLocation].map(([k, v]) => `${repo.locationName(k)}=${v}`).sort();
    eq(locs, ['倉庫A=450', '厨房=90']);
    eq(repo.ledger(by('食器用洗剤').id).total, 0);
    eq(repo.ledger(by('業務用ラップ').id).total, 4);
    eq(repo.ledger(by('竹串').id).total, 250);
    eq(valuation(repo.ledger(by('アルコール').id).portions, repo.ledger(by('アルコール').id).lots).computable, false);
    ok(by('トナー').archived);
  });
});
