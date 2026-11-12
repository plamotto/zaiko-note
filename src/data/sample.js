// サンプルデータ。本番DBとは別のDB（zaiko-sample）にのみ投入する。
// すべて通常のリポジトリAPI（検証付き）を通して作るため、サンプル自体が台帳ロジックの結合テストを兼ねる。
//
// 検証観点の対応表は docs/SAMPLE_DATA.md を参照。

import { addDays, today } from '../core/util.js';
import { janCheckDigit } from '../core/text.js';

const jan = (body12) => body12 + janCheckDigit(body12);

/**
 * @param repo Repo（サンプル用DB）
 * @param makePhoto (emoji, hue, variant) => Promise<{data,thumb,type,width,height}>
 */
export async function loadSampleData(repo, makePhoto) {
  if (repo.items.size || repo.ops.size) throw new Error('サンプルDBが空ではありません');
  const d = (n) => addDays(today(), -n);

  const work = await repo.saveDivision({ name: '仕事用', color: 'teal' });
  const home = await repo.saveDivision({ name: '家庭用', color: 'amber' });
  const L = {};
  L.warehouse = await repo.saveLocation({ name: '倉庫A', divisionId: work.id, memo: '店舗裏の在庫置き場' });
  L.kitchen = await repo.saveLocation({ name: '厨房', divisionId: work.id });
  L.office = await repo.saveLocation({ name: '事務所', divisionId: work.id });
  L.pantry = await repo.saveLocation({ name: '自宅パントリー', divisionId: home.id });
  L.garage = await repo.saveLocation({ name: '自宅ガレージ', divisionId: home.id });
  const C = {};
  for (const [k, n] of [
    ['hygiene', '衛生用品'],
    ['kitchen', '厨房用品'],
    ['consumable', '消耗品'],
    ['office', '事務用品'],
    ['tools', '工具'],
    ['home', '家庭用品'],
  ])
    C[k] = await repo.saveCategory({ name: n });

  const photos = async (specs) => {
    const out = [];
    for (const [emoji, hue, v] of specs) out.push(await makePhoto(emoji, hue, v || 0));
    return out;
  };
  const item = async (input, photoSpecs = []) => {
    const add = await photos(photoSpecs);
    return repo.saveItem({ ...input }, { add });
  };
  const rcv = (itemId, o) => repo.addOp('receive', { itemId, packSize: 1, storedDate: o.date, ...o });
  const use = (itemId, o) => repo.addOp('consume', { itemId, ...o });
  const move = (itemId, o) => repo.addOp('move', { itemId, ...o });
  const adj = (itemId, o) => repo.addOp('adjust', { itemId, ...o });

  // 1. ニトリル手袋 M — 複数購入・価格差・税込/税抜混在・FIFO・移動・手動ロット・過去日付追加・箱換算
  const gloveM = await item(
    { name: 'ニトリル手袋 M 粉なし ブルー', unit: '枚', categoryId: C.hygiene.id, jan: jan('490123456789'), maker: 'ハンドガード', model: 'NG-100M', spec: 'Mサイズ', packSize: 100, packUnit: '箱', threshold: 200, urls: ['https://example.com/products/ng-100m'], memo: '厨房・清掃兼用' },
    [
      ['🧤', 205, 0],
      ['🧤', 215, 1],
      ['📦', 30, 2],
    ]
  );
  const g1 = await rcv(gloveM.id, { date: d(120), purchaseDate: d(122), packCount: 3, packSize: 100, packUnit: '箱', amount: '2970', tax: 'incl', supplier: 'モノタロウ', locationId: L.warehouse.id, detail: '棚2・上段' });
  const g2 = await rcv(gloveM.id, { date: d(60), purchaseDate: d(60), packCount: 5, packSize: 100, packUnit: '箱', amount: '4400', tax: 'excl', supplier: '業務用卸 マルナカ', locationId: L.warehouse.id, detail: '棚2・上段' });
  await move(gloveM.id, { date: d(55), fromLocationId: L.warehouse.id, toLocationId: L.kitchen.id, toDetail: 'シンク下', qty: 150 });
  await use(gloveM.id, { date: d(40), locationId: L.kitchen.id, qty: 120 });
  await move(gloveM.id, { date: d(30), fromLocationId: L.warehouse.id, toLocationId: L.kitchen.id, toDetail: 'シンク下', qty: 200 });
  await use(gloveM.id, { date: d(20), locationId: L.kitchen.id, qty: 30, alloc: [{ lotId: g2.lotId, qty: 30 }], memo: '新しい箱から開封（手動ロット指定）' });
  await use(gloveM.id, { date: d(10), locationId: L.kitchen.id, qty: 100 });
  await use(gloveM.id, { date: d(45), locationId: L.kitchen.id, qty: 10, memo: '記入漏れ分を後から追加（過去日付）' });

  // 2. ニトリル手袋 L — 類似名の重複判定
  const gloveL = await item({ name: 'ニトリル手袋 L 粉なし ブルー', unit: '枚', categoryId: C.hygiene.id, jan: jan('490123456790'), maker: 'ハンドガード', model: 'NG-100L', spec: 'Lサイズ', packSize: 100, packUnit: '箱', threshold: 100 }, [['🧤', 140, 0]]);
  await rcv(gloveL.id, { date: d(60), packCount: 2, packSize: 100, packUnit: '箱', amount: '2000', tax: 'incl', supplier: 'モノタロウ', locationId: L.warehouse.id, detail: '棚2・上段' });

  // 3. キッチンペーパー — ケース換算・在庫少
  const paper = await item({ name: 'キッチンペーパー 業務用', unit: 'ロール', categoryId: C.kitchen.id, jan: jan('498765432101'), maker: 'クリーンライフ', packSize: 12, packUnit: 'ケース', threshold: 12 }, [['🧻', 45, 0]]);
  await rcv(paper.id, { date: d(50), packCount: 2, packSize: 12, packUnit: 'ケース', amount: '3960', tax: 'incl', supplier: 'コストコ', locationId: L.kitchen.id, detail: '乾物棚 右' });
  await use(paper.id, { date: d(25), locationId: L.kitchen.id, qty: 9 });
  await use(paper.id, { date: d(5), locationId: L.kitchen.id, qty: 6 });

  // 4. 食器用洗剤 — 在庫切れ
  const soap = await item({ name: '食器用洗剤 詰め替え 2L', unit: '本', categoryId: C.kitchen.id, jan: jan('498765432118'), maker: 'クリーンライフ', spec: '2L', threshold: 2 }, [['🧴', 160, 0]]);
  await rcv(soap.id, { date: d(90), packCount: 3, amount: '1650', tax: 'incl', supplier: 'ドラッグストア', locationId: L.kitchen.id, detail: 'シンク下' });
  await use(soap.id, { date: d(60), locationId: L.kitchen.id, qty: 2 });
  await use(soap.id, { date: d(3), locationId: L.kitchen.id, qty: 1 });

  // 5. アルコール除菌スプレー — 棚卸しでの増加（価格未設定）→ 評価額「算出不可」
  const alcohol = await item({ name: 'アルコール除菌スプレー 500ml', unit: '本', categoryId: C.hygiene.id, jan: jan('498765432125'), spec: '500ml', threshold: 3 }, [['🧴', 190, 1]]);
  await adj(alcohol.id, { date: d(70), locationId: L.kitchen.id, counted: 4, detail: '入口横', memo: '棚卸しで見つかった分（購入時期不明）' });
  await rcv(alcohol.id, { date: d(15), packCount: 2, amount: '1078', tax: 'incl', supplier: 'ドラッグストア', locationId: L.kitchen.id, detail: '入口横' });
  await use(alcohol.id, { date: d(7), locationId: L.kitchen.id, qty: 1 });

  // 6. ゴミ袋 — JANなし・袋換算・在庫少・税抜
  const bag = await item({ name: 'ゴミ袋 45L 半透明', unit: '枚', categoryId: C.consumable.id, packSize: 10, packUnit: '袋', threshold: 20, memo: '厚手 0.025mm' }, [['🗑️', 100, 0]]);
  await rcv(bag.id, { date: d(80), packCount: 5, packSize: 10, packUnit: '袋', amount: '980', tax: 'excl', supplier: 'ホームセンター', locationId: L.warehouse.id, detail: '棚1・下段' });
  await use(bag.id, { date: d(30), locationId: L.warehouse.id, qty: 20 });
  await use(bag.id, { date: d(2), locationId: L.warehouse.id, qty: 18 });

  // 7. コピー用紙 — 包換算（2包＋300枚）・税抜
  const copy = await item({ name: 'コピー用紙 A4 高白色', unit: '枚', categoryId: C.office.id, jan: jan('456789012345'), maker: 'ペーパーワークス', spec: 'A4 / 64g', packSize: 500, packUnit: '包', threshold: 1000 }, [['📄', 220, 0], ['📦', 220, 1]]);
  await rcv(copy.id, { date: d(65), packCount: 5, packSize: 500, packUnit: '包', amount: '2480', tax: 'excl', supplier: 'アスクル', locationId: L.office.id, detail: 'キャビネット下' });
  await use(copy.id, { date: d(35), locationId: L.office.id, qty: 700 });
  await use(copy.id, { date: d(12), locationId: L.office.id, qty: 500 });

  // 8. ボールペン — JANなし・棚卸し減少（FIFO）
  const pen = await item({ name: 'ボールペン 黒 0.7mm', unit: '本', categoryId: C.office.id, spec: '0.7mm', threshold: 3 }, [['🖊️', 260, 0]]);
  await rcv(pen.id, { date: d(100), packCount: 10, amount: '1100', tax: 'incl', supplier: '文具店', locationId: L.office.id, detail: 'デスク引き出し' });
  await use(pen.id, { date: d(50), locationId: L.office.id, qty: 2 });
  await adj(pen.id, { date: d(14), locationId: L.office.id, counted: 7, memo: '月末棚卸し（1本不明）' });

  // 9. 単3電池 — 家庭用・異なる購入価格・FIFO・加重平均
  const bat = await item({ name: '単3形 アルカリ乾電池', unit: '本', categoryId: C.home.id, jan: jan('497654321098'), maker: 'パワーセル', packSize: 4, packUnit: 'パック', threshold: 4 }, [['🔋', 120, 0]]);
  await rcv(bat.id, { date: d(100), packCount: 2, packSize: 4, packUnit: 'パック', amount: '858', tax: 'incl', supplier: '家電量販店', locationId: L.pantry.id, detail: '引き出し2段目' });
  await rcv(bat.id, { date: d(30), packCount: 1, packSize: 4, packUnit: 'パック', amount: '398', tax: 'incl', supplier: '100円ショップ', locationId: L.pantry.id, detail: '引き出し2段目' });
  await use(bat.id, { date: d(8), locationId: L.pantry.id, qty: 6 });

  // 10. 結束バンド — 工具・家庭
  const tie = await item({ name: '結束バンド 200mm 黒', unit: '本', categoryId: C.tools.id, jan: jan('491234567012'), spec: '200×4.8mm', packSize: 100, packUnit: '袋', threshold: 20 }, [['🪢', 0, 0]]);
  await rcv(tie.id, { date: d(110), packCount: 1, packSize: 100, packUnit: '袋', amount: '540', tax: 'incl', supplier: 'ホームセンター', locationId: L.garage.id, detail: '工具棚 上段' });
  await use(tie.id, { date: d(40), locationId: L.garage.id, qty: 25 });

  // 11. ビットセット — 複数写真・備品
  const bits = await item({ name: '電動ドライバー用ビットセット 32本組', unit: 'セット', categoryId: C.tools.id, maker: 'ツールマスター', model: 'BS-32' }, [
    ['🪛', 30, 0],
    ['🧰', 10, 1],
    ['🔩', 50, 2],
  ]);
  await rcv(bits.id, { date: d(200), packCount: 1, amount: '2980', tax: 'incl', supplier: 'ネット通販', url: 'https://example.com/bs-32', locationId: L.garage.id, detail: '工具棚 中段' });

  // 12. 業務用ラップ — 入庫の訂正（4本→6本）
  const wrap = await item({ name: '業務用ラップ 30cm×100m', unit: '本', categoryId: C.kitchen.id, jan: jan('498765432132'), spec: '30cm×100m', threshold: 2 }, [['🎞️', 330, 0]]);
  const w1 = await rcv(wrap.id, { date: d(45), packCount: 4, amount: '3480', tax: 'incl', supplier: '業務用卸 マルナカ', locationId: L.kitchen.id, detail: '調理台下' });
  await repo.correctOp(w1.id, { date: d(45), packCount: 6, packSize: 1, amount: '5220', tax: 'incl', supplier: '業務用卸 マルナカ', locationId: L.kitchen.id, detail: '調理台下', storedDate: d(45), correctionReason: '納品書を確認し本数を訂正' });
  await use(wrap.id, { date: d(20), locationId: L.kitchen.id, qty: 2 });

  // 13. 竹串 — 誤操作の取り消し
  const skewer = await item({ name: '竹串 15cm', unit: '本', categoryId: C.kitchen.id, jan: jan('498765432149'), packSize: 100, packUnit: '袋', threshold: 50 }, [['🍢', 25, 0]]);
  await rcv(skewer.id, { date: d(40), packCount: 3, packSize: 100, packUnit: '袋', amount: '660', tax: 'incl', supplier: '業務用卸 マルナカ', locationId: L.kitchen.id, detail: '乾物棚 左' });
  await use(skewer.id, { date: d(18), locationId: L.kitchen.id, qty: 50 });
  const mistake = await use(skewer.id, { date: d(9), locationId: L.kitchen.id, qty: 100, memo: '入力ミス' });
  await repo.voidOp(mistake.id, '数量の入力ミス');

  // 14. 旧型トナー — アーカイブ（在庫あり）
  const toner = await item({ name: 'トナーカートリッジ TN-29J（旧型）', unit: '個', categoryId: C.office.id, jan: jan('497123456789'), model: 'TN-29J', memo: 'プリンター買い替えのため使用終了' }, [['🖨️', 0, 1]]);
  await rcv(toner.id, { date: d(300), packCount: 2, amount: '9800', tax: 'excl', supplier: 'アスクル', locationId: L.office.id, detail: '棚上' });
  await use(toner.id, { date: d(250), locationId: L.office.id, qty: 1 });
  await repo.setArchived(toner.id, true);

  // 15. マスキングテープ — 在庫0・警告ラインなし（警告対象外）
  const tape = await item({ name: 'マスキングテープ 15mm', unit: '個', categoryId: C.home.id, spec: '15mm×18m' }, [['🎨', 300, 0]]);
  await rcv(tape.id, { date: d(150), packCount: 2, amount: '396', tax: 'incl', supplier: '100円ショップ', locationId: L.pantry.id });
  await use(tape.id, { date: d(20), locationId: L.pantry.id, qty: 2 });

  // 16. 計量カップ — 写真なし・在庫0で登録のみ
  await repo.saveItem({ name: '計量カップ 1L', unit: '個', categoryId: C.kitchen.id, memo: '買い替え検討中（在庫0で登録）' });

  // 記録日時を自然に：通常の操作は「操作日に記録した」ことにし、過去日付で後から追加した操作だけ後日記録として残す。
  // （履歴の内容・順序は変更しない。サンプルDBでのみ実施）
  const fixed = [];
  for (const op of repo.ops.values()) {
    const memo = op.memo || '';
    let day = op.date;
    if (op.type === 'void') day = repo.ops.get(op.targetId)?.date || op.date;
    if (op.corrects) day = addDays(repo.ops.get(op.corrects).date, 1);
    if (/後から追加/.test(memo)) day = d(5);
    const t = new Date(`${day}T09:00:00`);
    t.setMinutes(t.getMinutes() + (op.seq % 480));
    fixed.push({ ...op, createdAt: t.toISOString() });
  }
  await repo.commitBatch({ put: { ops: fixed } });

  return { items: repo.items.size, ops: repo.ops.size };
}
