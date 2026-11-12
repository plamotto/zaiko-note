import { suite, test, eq, ok } from './harness.js';
import { replay, valuation, packBreakdown, stockStatus, activeOpIds } from '../src/core/ledger.js';
import { parseMoneyInput, toCents, fromCents, Frac, formatFrac, formatUnit, unitPrice } from '../src/core/money.js';
import { normalizeName, similarity, findDuplicates, isValidJan, janCheckDigit } from '../src/core/text.js';
import { parseCsv, toCsv } from '../src/core/csv.js';
import { zipSync, unzip, crc32 } from '../src/core/zip.js';
import { parseDateLoose } from '../src/core/util.js';

let seq = 0;
const R = (o) => {
  const s = ++seq;
  const qty = (o.packCount || 1) * (o.packSize || 1);
  return { id: 'r' + s, seq: s, order: s, type: 'receive', itemId: 'i', lotId: o.lotId || 'r' + s, packCount: o.packCount || 1, packSize: o.packSize || 1, qty, amount: o.amount ?? null, tax: o.amount != null ? o.tax || 'incl' : null, locationId: o.loc || 'A', detail: '', date: o.date, ...o.extra };
};
const C = (o) => {
  const s = ++seq;
  return { id: 'c' + s, seq: s, order: s, type: 'consume', itemId: 'i', locationId: o.loc || 'A', qty: o.qty, alloc: o.alloc || null, date: o.date };
};
const M = (o) => {
  const s = ++seq;
  return { id: 'm' + s, seq: s, order: s, type: 'move', itemId: 'i', fromLocationId: o.from, toLocationId: o.to, qty: o.qty, alloc: o.alloc || null, date: o.date };
};
const A = (o) => {
  const s = ++seq;
  return { id: 'a' + s, seq: s, order: s, type: 'adjust', itemId: 'i', locationId: o.loc || 'A', counted: o.counted, alloc: o.alloc || null, lotId: 'adj-a' + s, unitAmount: o.unitAmount ?? null, tax: o.tax ?? null, date: o.date };
};
const V = (target) => {
  const s = ++seq;
  return { id: 'v' + s, seq: s, order: s, type: 'void', itemId: 'i', targetId: target.id, date: '2025-01-31' };
};
const remaining = (r) => Object.fromEntries([...r.lots.values()].map((l) => [l.lotId, l.remaining]));

suite('金額計算', () => {
  test('金額入力の正規化', { input: '"3,000" / "¥1,234.5" / "０．２５" / "" / "-5" / "1.234"', expected: '"3000" / "1234.5" / "0.25" / null / エラー / エラー' }, () => {
    eq(parseMoneyInput('3,000'), '3000');
    eq(parseMoneyInput('¥1,234.5'), '1234.5');
    eq(parseMoneyInput('０．２５'), '0.25');
    eq(parseMoneyInput(''), null);
    let threw = 0;
    for (const bad of ['-5', '1.234', 'abc']) {
      try {
        parseMoneyInput(bad);
      } catch {
        threw++;
      }
    }
    eq(threw, 3);
  });
  test('銭単位の相互変換', { input: '"1234.5" → 銭 → 文字列', expected: '123450n → "1234.5"、"0.05" → 5n' }, () => {
    eq(toCents('1234.5'), 123450n);
    eq(fromCents(123450n), '1234.5');
    eq(toCents('0.05'), 5n);
    eq(fromCents(5n), '0.05');
  });
  test('単価計算（100個入り×3袋・3,000円）', { input: '金額3000円・数量300', expected: '単価 ¥10' }, () => {
    eq(formatUnit(unitPrice({ amount: '3000', qty: 300 })), '¥10');
  });
  test('割り切れない単価は有理数で保持し表示時のみ丸め', { input: '1000円 ÷ 3個', expected: '単価表示 ¥333.33、3個分の評価額は ¥1,000 ちょうど' }, () => {
    const u = unitPrice({ amount: '1000', qty: 3 });
    eq(formatUnit(u), '¥333.33');
    eq(formatFrac(Frac.mulInt(u, 3)), '¥1,000');
  });
});

suite('表記揺れ・重複判定・JAN', () => {
  test('全角半角・カナ・空白の正規化', { input: '"ﾆﾄﾘﾙ 手袋　Ｍ" と "ニトリル手袋M"', expected: '正規化後に一致' }, () => {
    eq(normalizeName('ﾆﾄﾘﾙ 手袋　Ｍ'), normalizeName('ニトリル手袋M'));
  });
  test('類似商品名の判定', { input: '"ニトリル手袋 M 粉なし" vs "ニトリル手袋 L 粉なし" / "コピー用紙"', expected: '前者は類似(≥0.6)、後者は非類似' }, () => {
    ok(similarity('ニトリル手袋 M 粉なし', 'ニトリル手袋 L 粉なし') >= 0.6);
    ok(similarity('ニトリル手袋 M 粉なし', 'コピー用紙') < 0.3);
  });
  test('重複候補の優先順位', { input: '候補 {name:"ﾆﾄﾘﾙ手袋M", jan:"4901234567894"}、既存: 同JAN別名 / 同名別JAN', expected: 'JAN一致が先頭、次に商品名一致' }, () => {
    const items = [
      { id: 'x', name: 'ニトリル手袋M', jan: null },
      { id: 'y', name: '全然違う名前', jan: '4901234567894' },
    ];
    const r = findDuplicates({ name: 'ﾆﾄﾘﾙ手袋M', jan: '4901234567894' }, items);
    eq(r.map((x) => [x.item.id, x.reason]), [
      ['y', 'jan'],
      ['x', 'name-exact'],
    ]);
  });
  test('JANチェックデジット', { input: '4901234567894 / 4901234567890 / 49012347', expected: '有効 / 無効 / 有効(JAN-8)' }, () => {
    eq(janCheckDigit('490123456789'), 4);
    ok(isValidJan('4901234567894'));
    ok(!isValidJan('4901234567890'));
    ok(isValidJan('49012347'));
  });
  test('日付の柔軟な解釈', { input: '"2025/3/5" "2025年3月5日" "2025-02-30"', expected: '"2025-03-05" "2025-03-05" null' }, () => {
    eq(parseDateLoose('2025/3/5'), '2025-03-05');
    eq(parseDateLoose('2025年3月5日'), '2025-03-05');
    eq(parseDateLoose('2025-02-30'), null);
  });
});

suite('台帳：FIFO・ロット・移動', () => {
  test('数量換算（100個入り×3袋）と箱換算参考表示', { input: '入庫 3袋×100個、使用35個', expected: '在庫265、参考 2袋＋65個' }, () => {
    const ops = [R({ date: '2025-01-01', packCount: 3, packSize: 100, amount: '3000' }), C({ date: '2025-01-02', qty: 35 })];
    const r = replay(ops);
    eq(r.total, 265);
    eq(packBreakdown(265, 100), { packs: 2, rest: 65 });
    eq(packBreakdown(265, 1), null);
  });
  test('FIFO：古い入庫分から減算', { input: '1/1 10個@100円, 1/5 10個@150円, 1/10 使用15', expected: 'ロット1残0、ロット2残5、評価額 ¥750' }, () => {
    const a = R({ date: '2025-01-01', packCount: 10, amount: '1000' });
    const b = R({ date: '2025-01-05', packCount: 10, amount: '1500' });
    const r = replay([a, b, C({ date: '2025-01-10', qty: 15 })]);
    eq(remaining(r), { [a.lotId]: 0, [b.lotId]: 5 });
    eq(formatFrac(valuation(r.portions, r.lots).total), '¥750');
  });
  test('手動ロット指定', { input: '上と同じ2ロット、使用4個をロット2から指定', expected: 'ロット1残10、ロット2残6' }, () => {
    const a = R({ date: '2025-01-01', packCount: 10, amount: '1000' });
    const b = R({ date: '2025-01-05', packCount: 10, amount: '1500' });
    const r = replay([a, b, C({ date: '2025-01-10', qty: 4, alloc: [{ lotId: b.lotId, qty: 4 }] })]);
    eq(remaining(r), { [a.lotId]: 10, [b.lotId]: 6 });
  });
  test('手動ロット指定の矛盾はエラー（黙って変更しない）', { input: '残4のロットから5個指定 / 合計不一致', expected: 'LOT_SHORT / ALLOC_SUM' }, () => {
    const a = R({ date: '2025-01-01', packCount: 4 });
    const b = R({ date: '2025-01-02', packCount: 4 });
    eq(replay([a, b, C({ date: '2025-01-03', qty: 5, alloc: [{ lotId: a.lotId, qty: 5 }] })]).error.code, 'LOT_SHORT');
    eq(replay([a, b, C({ date: '2025-01-03', qty: 5, alloc: [{ lotId: a.lotId, qty: 3 }] })]).error.code, 'ALLOC_SUM');
  });
  test('負数在庫の禁止', { input: '入庫5、使用6', expected: 'INSUFFICIENT（その時点の在庫5・必要6）' }, () => {
    const r = replay([R({ date: '2025-01-01', packCount: 5 }), C({ date: '2025-01-02', qty: 6 })]);
    eq(r.ok, false);
    eq([r.error.code, r.error.detail.available, r.error.detail.required], ['INSUFFICIENT', 5, 6]);
  });
  test('保管場所間の移動：合計不変・価格引き継ぎ', { input: 'A に 10個@1000円・10個@2000円(税抜)、A→B へ12移動', expected: '合計20不変、A=8、B=12、Bの評価額 ¥1,000+¥400=¥1,400 (税込/税抜は別)' }, () => {
    const a = R({ date: '2025-01-01', packCount: 10, amount: '1000', tax: 'incl' });
    const b = R({ date: '2025-01-02', packCount: 10, amount: '2000', tax: 'excl' });
    const r = replay([a, b, M({ date: '2025-01-03', from: 'A', to: 'B', qty: 12 })]);
    eq(r.total, 20);
    eq([r.byLocation.get('A'), r.byLocation.get('B')], [8, 12]);
    const vb = valuation(
      r.portions.filter((p) => p.locationId === 'B'),
      r.lots
    );
    eq([formatFrac(vb.groups.incl.value), formatFrac(vb.groups.excl.value)], ['¥1,000', '¥400']);
    eq(vb.computable, false, '税区分混在のため合算は算出不可');
  });
  test('移動元と移動先が同じはエラー', { input: 'A→A 移動', expected: 'SAME_LOCATION' }, () => {
    eq(replay([R({ date: '2025-01-01', packCount: 3 }), M({ date: '2025-01-02', from: 'A', to: 'A', qty: 1 })]).error.code, 'SAME_LOCATION');
  });
  test('移動先でもFIFOは元の入庫日順', { input: 'A:1/1ロット, A:1/2ロット → 全量Bへ、B で使用3', expected: '1/1ロットから減る' }, () => {
    const a = R({ date: '2025-01-01', packCount: 2 });
    const b = R({ date: '2025-01-02', packCount: 2 });
    const r = replay([a, b, M({ date: '2025-01-03', from: 'A', to: 'B', qty: 4 }), C({ date: '2025-01-04', loc: 'B', qty: 3 })]);
    eq(remaining(r), { [a.lotId]: 0, [b.lotId]: 1 });
  });
});

suite('台帳：棚卸し・訂正・過去日付', () => {
  test('棚卸し減少はFIFO', { input: '10個@100円・10個@200円、棚卸実数15', expected: '差分-5、ロット1から5減' }, () => {
    const a = R({ date: '2025-01-01', packCount: 10, amount: '1000' });
    const b = R({ date: '2025-01-02', packCount: 10, amount: '2000' });
    const adj = A({ date: '2025-01-03', counted: 15 });
    const r = replay([a, b, adj]);
    eq(r.effects.get(adj.id).delta, -5);
    eq(remaining(r), { [a.lotId]: 5, [b.lotId]: 10 });
  });
  test('棚卸し増加は価格未設定ロット（0円扱いしない）', { input: '5個@500円(税込)、棚卸実数8（単価不明）', expected: '差分+3、価格未設定3、評価額は算出不可、既知分 ¥500' }, () => {
    const a = R({ date: '2025-01-01', packCount: 5, amount: '500' });
    const adj = A({ date: '2025-01-03', counted: 8 });
    const r = replay([a, adj]);
    const v = valuation(r.portions, r.lots);
    eq([r.total, v.unknownQty, v.computable, v.total], [8, 3, false, null]);
    eq(formatFrac(v.groups.incl.value), '¥500');
  });
  test('棚卸し増加で単価指定あり', { input: '棚卸実数4（0から）、単価 ¥120.5 税抜', expected: '評価額 ¥482、平均単価 ¥120.5' }, () => {
    const adj = A({ date: '2025-01-03', counted: 4, unitAmount: '120.5', tax: 'excl' });
    const v = (() => {
      const r = replay([adj]);
      return valuation(r.portions, r.lots);
    })();
    eq(formatFrac(v.total), '¥482');
    eq(formatUnit(v.avg.excl), '¥120.50');
  });
  test('取り消し：元履歴を残し在庫から除外。取り消しの取り消しで復活', { input: '入庫10、使用4、使用4を取り消し、さらにその取り消しを取り消し', expected: '在庫 10 → 6 → 10 → 6' }, () => {
    const a = R({ date: '2025-01-01', packCount: 10 });
    const c = C({ date: '2025-01-02', qty: 4 });
    eq(replay([a, c]).total, 6);
    const v = V(c);
    eq(replay([a, c, v]).total, 10);
    const vv = V(v);
    eq(replay([a, c, v, vv]).total, 6);
    eq(activeOpIds([a, c, v, vv]).has(c.id), true);
  });
  test('訂正：同じ並び位置で内容を置き換え', { input: '1/1 入庫4（誤）→ 6 に訂正、1/2 使用5', expected: '訂正前は使用5で在庫不足、訂正後は在庫1。ロットIDは維持' }, () => {
    const a = R({ date: '2025-01-01', packCount: 4 });
    const c = C({ date: '2025-01-02', qty: 5 });
    eq(replay([a, c]).ok, false);
    const s = ++seq;
    const fix = { ...a, id: 'fix' + s, seq: s, order: a.order, packCount: 6, qty: 6, corrects: a.id };
    const r = replay([a, c, fix]);
    eq([r.ok, r.total], [true, 1]);
    eq([...r.lots.keys()], [a.lotId]);
  });
  test('過去日付の操作追加で再計算', { input: '1/1 入庫10@1000円, 1/10 入庫10@2000円, 1/20 使用5 の後に 1/5 使用8 を追加', expected: '1/20 の使用はロット1残2とロット2から3。残数 ロット1=0, ロット2=7' }, () => {
    const a = R({ date: '2025-01-01', packCount: 10, amount: '1000' });
    const b = R({ date: '2025-01-10', packCount: 10, amount: '2000' });
    const late = C({ date: '2025-01-20', qty: 5 });
    const back = C({ date: '2025-01-05', qty: 8 });
    const r = replay([a, b, late, back]);
    eq(remaining(r), { [a.lotId]: 0, [b.lotId]: 7 });
    eq(r.effects.get(late.id).taken, [
      { lotId: a.lotId, qty: 2 },
      { lotId: b.lotId, qty: 3 },
    ]);
  });
  test('過去日付の追加で後の手動ロット指定が矛盾 → エラー', { input: '1/1 ロットA 5個、1/10 使用 ロットA指定5、後から 1/5 使用2 を追加', expected: 'LOT_SHORT（1/10 の操作で検出、黙って変更しない）' }, () => {
    const a = R({ date: '2025-01-01', packCount: 5 });
    const b = R({ date: '2025-01-02', packCount: 5 });
    const manual = C({ date: '2025-01-10', qty: 5, alloc: [{ lotId: a.lotId, qty: 5 }] });
    const back = C({ date: '2025-01-05', qty: 2 });
    const r = replay([a, b, manual, back]);
    eq([r.ok, r.error.code, r.error.detail.opId], [false, 'LOT_SHORT', manual.id]);
  });
  test('同日の操作は確定順（order→seq）で再計算', { input: '同日に 使用3(order=1) と 入庫5(order=2)。入庫の order を先にすると成功', expected: '1件目は在庫不足、order入替後は在庫2' }, () => {
    const c = { id: 'sc', seq: 101, order: 101, type: 'consume', itemId: 'i', locationId: 'A', qty: 3, date: '2025-02-01' };
    const r1 = { id: 'sr', seq: 102, order: 102, type: 'receive', itemId: 'i', lotId: 'sr', packCount: 5, packSize: 1, qty: 5, amount: null, tax: null, locationId: 'A', date: '2025-02-01' };
    eq(replay([c, r1]).ok, false);
    eq(replay([c, { ...r1, order: 100 }]).total, 2);
  });
  test('税込・税抜の別集計と加重平均単価', { input: '税込 2パック×4本=¥858、税込 1パック×4本=¥398、使用2（FIFO）', expected: '残 6本@107.25 + 4本@99.5 = ¥1,041.50、加重平均 ¥104.15（税込）' }, () => {
    const a = R({ date: '2025-01-01', packCount: 2, packSize: 4, amount: '858', tax: 'incl' });
    const b = R({ date: '2025-01-05', packCount: 1, packSize: 4, amount: '398', tax: 'incl' });
    const r = replay([a, b, C({ date: '2025-01-06', qty: 2 })]);
    const v = valuation(r.portions, r.lots);
    eq(formatFrac(v.total, 2), '¥1,041.50');
    eq(formatUnit(v.avg.incl), '¥104.15');
    eq(v.totalTax, 'incl');
  });
  test('在庫状態の判定', { input: '(10,警告5) (5,5) (0,5) (0,なし) (3,なし)', expected: 'ok, low, out, zero, ok' }, () => {
    eq([stockStatus(10, 5), stockStatus(5, 5), stockStatus(0, 5), stockStatus(0, null), stockStatus(3, null)], ['ok', 'low', 'out', 'zero', 'ok']);
  });
});

suite('CSV・ZIP', () => {
  test('CSV往復（引用符・改行・カンマ・BOM）', { input: '["a,b", "改行\\nあり", "\\"q\\""]', expected: '同じ値に戻る、先頭にBOM' }, () => {
    const rows = [
      ['名前', 'メモ'],
      ['a,b', '改行\nあり'],
      ['"q"', ''],
    ];
    const s = toCsv(rows);
    ok(s.charCodeAt(0) === 0xfeff);
    eq(parseCsv(s), rows);
  });
  test('CSVインジェクション対策', { input: '"=SUM(A1)"', expected: "\"'=SUM(A1)\" として出力" }, () => {
    ok(toCsv([['=SUM(A1)']]).includes("'=SUM(A1)"));
  });
  test('ZIP作成・展開・CRC検証', { input: 'manifest.json + 日本語名ファイル + バイナリ', expected: '同一内容で展開、改ざんでCRCエラー' }, async () => {
    const bin = new Uint8Array([0, 1, 2, 250, 255]);
    const z = zipSync([
      { name: 'manifest.json', data: '{"a":1}' },
      { name: 'photos/写真.jpg', data: bin },
    ]);
    const m = await unzip(z);
    eq(new TextDecoder().decode(m.get('manifest.json')), '{"a":1}');
    eq([...m.get('photos/写真.jpg')], [...bin]);
    eq(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
    const bad = z.slice();
    bad[30 + 'manifest.json'.length + 2] ^= 0xff;
    let err = '';
    try {
      await unzip(bad);
    } catch (e) {
      err = e.message;
    }
    ok(/CRC/.test(err), 'CRCエラーを検出');
  });
});

import { decodeLine, renderEan13, decodeImageData } from '../src/scan/ean.js';

suite('JANバーコード読み取り（合成画像）', () => {
  test('EAN-13 の走査線デコード', { input: '4901234567894 をモジュール幅3pxで描画', expected: '4901234567894' }, () => {
    eq(decodeLine(renderEan13('4901234567894', 3)), '4901234567894');
  });
  test('左右反転（逆さま）・ノイズ・ぼけ・非整数倍率でも読める', { input: '4987654321018 を 2.3倍拡大＋ぼかし＋ノイズ、逆向き', expected: '4987654321018' }, () => {
    const base = renderEan13('4987654321018', 1);
    const scale = 2.3;
    const out = [];
    for (let x = 0; x < base.length * scale; x++) out.push(base[Math.floor(x / scale)]);
    const blur = out.map((v, i) => (out[i - 1] ?? v) * 0.25 + v * 0.5 + (out[i + 1] ?? v) * 0.25);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 40;
    const noisy = blur.map((v) => Math.max(0, Math.min(255, v + rnd())));
    eq(decodeLine(noisy), '4987654321018');
    eq(decodeLine([...noisy].reverse()), '4987654321018');
  });
  test('チェックデジット不一致や途切れたコードは読まない', { input: '右側40%が欠けたバーコード / 無地の行 / チェックデジット不正の 4987654321019 を描画', expected: 'すべて null（誤読しない）' }, () => {
    const good = renderEan13('4901234567894', 3);
    eq(decodeLine(good.slice(0, Math.floor(good.length * 0.6))), null);
    const flat = new Array(300).fill(200);
    eq(decodeLine(flat), null);
    // チェックデジットが誤ったコード（…9 は不正、正しくは …8）を描画しても読まない
    const bad = renderEan13('4987654321019', 3);
    eq(decodeLine(bad), null);
  });
  test('画像（RGBA）の複数行投票', { input: '高さ20pxの画像に描画', expected: 'コードと複数票' }, () => {
    const line = renderEan13('4512345678906', 2);
    const w = line.length, hgt = 20;
    const data = new Uint8ClampedArray(w * hgt * 4);
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; data[o] = data[o + 1] = data[o + 2] = line[x]; data[o + 3] = 255; }
    const r = decodeImageData({ width: w, height: hgt, data }, 5);
    eq(r.code, '4512345678906');
    ok(r.votes >= 2);
  });
});
