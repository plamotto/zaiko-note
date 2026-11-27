# バックアップファイル形式仕様（zaiko-pwa-backup v1）

このドキュメントは、在庫ノートが出力するバックアップファイルの完全な仕様です。
将来のネイティブアプリ（SwiftUI 等）や別アプリが、この仕様だけを見てインポート処理を実装できることを目的とします。
特定のフレームワーク・データベースに依存しない、公開された形式（ZIP + JSON + JPEG）のみを使用しています。

## 1. ファイル全体

- 拡張子：`.zip`（ファイル名例：`zaiko-backup-20261113-0930.zip`）
- ZIP 形式：PKZIP（APPNOTE）準拠。書き出しは無圧縮（STORE）、ファイル名は UTF-8（汎用ビット11）。
  - 読み込み側は STORE と DEFLATE の両方に対応すること（手作業で再圧縮された場合に備える）。
  - ZIP64 は使用しない（全体 4GB 未満）。
- 構成：

| パス | 必須 | 内容 |
|---|---|---|
| `manifest.json` | ○ | 形式・バージョン・件数・ファイル一覧とハッシュ |
| `data.json` | ○ | 全レコード（UTF-8 JSON） |
| `README.txt` | − | 人間向けの説明 |
| `photos/{photoId}.jpg` | 写真がある場合 | 写真原本（長辺最大1600px の JPEG） |
| `photos/thumbs/{photoId}.jpg` | − | サムネイル（320px 正方形 JPEG）。無い場合は原本から再生成してよい |

## 2. manifest.json

```json
{
  "format": "zaiko-pwa-backup",
  "formatVersion": 1,
  "schemaVersion": 1,
  "backupId": "c1f3…-uuid",
  "exportedAt": "2026-11-13T00:30:12.345Z",
  "app": { "name": "在庫ノート", "version": "1.0.0" },
  "datasetId": "8a2e…-uuid",
  "revision": 128,
  "counts": { "divisions": 2, "categories": 6, "locations": 5, "items": 16, "photos": 20, "ops": 44 },
  "dataFile": { "path": "data.json", "bytes": 61234, "sha256": "hex…" },
  "files": [
    { "path": "photos/2b9e….jpg", "kind": "photo", "photoId": "2b9e…", "bytes": 88123, "sha256": "hex…" },
    { "path": "photos/thumbs/2b9e….jpg", "kind": "thumb", "photoId": "2b9e…", "bytes": 9123, "sha256": "hex…" }
  ]
}
```

| 項目 | 型 | 説明 |
|---|---|---|
| format | string | 固定値 `zaiko-pwa-backup`。異なる場合は取り込み不可 |
| formatVersion | integer | 形式バージョン。読み込み側は自分が対応する最大値以下のみ受け付ける |
| schemaVersion | integer | データ項目のバージョン（現在1） |
| backupId | UUID | バックアップごとに一意。二重取り込みの検出に使用 |
| exportedAt | ISO 8601 (UTC) | 作成日時 |
| datasetId | UUID | データセット（端末上のDB）の識別子 |
| revision | integer | 作成時点のデータ変更カウンタ |
| counts | object | 各配列の件数。data.json と一致しなければ破損とみなす |
| dataFile.sha256 | hex | data.json の SHA-256 |
| files[] | array | 写真ファイル一覧。kind は `photo` または `thumb` |

## 3. data.json

```json
{
  "divisions": [ … ],
  "categories": [ … ],
  "locations": [ … ],
  "items": [ … ],
  "photos": [ … ],
  "ops": [ … ],
  "settings": { … }
}
```

### 3.1 共通ルール

- **ID**：すべて文字列（現行は UUID v4）。レコード間参照はすべて ID で行う。名前の変更で参照は壊れない。
- **日時**（`createdAt` など、実際に操作した時刻）：ISO 8601、UTC（例 `2026-11-13T00:30:12.345Z`）。
- **日付**（`date` など、ユーザーが指定した日）：`YYYY-MM-DD`（端末のローカル日付。タイムゾーンなし）。
- **金額**：円単位の **10進文字列**、小数2桁まで（例 `"3000"`, `"1234.5"`, `"0.25"`）。浮動小数点数として扱わないこと（Swift では `Decimal`）。`null` は「価格未設定」で、0円ではない。
- **数量**：整数（商品の基本数量単位＝最小管理単位）。小数は使わない。
- 未知の項目は無視してよい（将来の拡張のため）。必須項目が欠けている場合はエラー。

### 3.2 divisions（管理区分）

| 項目 | 型 | 説明 |
|---|---|---|
| id | string | |
| name | string | 例：仕事用、家庭用 |
| color | string | `teal` `amber` `indigo` `rose` `slate` のいずれか（表示用） |
| sort | integer | 表示順 |
| createdAt / updatedAt | datetime | |

### 3.3 categories（カテゴリ）

| 項目 | 型 | 説明 |
|---|---|---|
| id, name, sort, createdAt, updatedAt | | divisions と同様（color なし） |

### 3.4 locations（保管場所）

| 項目 | 型 | 説明 |
|---|---|---|
| id | string | |
| name | string | 例：倉庫A |
| divisionId | string \| null | → divisions.id |
| memo | string | |
| sort | integer | |
| archived | boolean | true＝非表示（履歴で参照されているため削除せず残している） |
| createdAt / updatedAt | datetime | |

### 3.5 items（商品マスター）

| 項目 | 型 | 説明 |
|---|---|---|
| id | string | |
| name | string | 必須 |
| unit | string | 基本数量単位（必須）。例：枚、本 |
| categoryId | string \| null | → categories.id |
| jan | string \| null | 数字のみ（8/13桁が一般的。チェックデジット不一致も許容） |
| maker | string | メーカー・ブランド |
| model | string | 型番・品番 |
| spec | string | 規格・サイズ |
| packSize | integer \| null | 標準入数（1箱あたりの基本単位数） |
| packUnit | string | 入れ物の単位（箱・袋など） |
| threshold | integer \| null | 在庫不足の警告ライン（null＝警告なし） |
| urls | string[] | よく使う商品URL |
| memo | string | |
| photoIds | string[] | 写真の並び順。**先頭がメイン写真**。→ photos.id |
| archived | boolean | |
| archivedAt | datetime \| null | |
| unitHistory | array \| 省略可 | v1.2.1。記録の数をまとめて換算した履歴 `[{at, factor, unit}]`（入れ物を後から設定し「2」を「2袋＝24」に直した等）。換算は該当商品の全操作の数量を factor 倍し、購入総額は変えない |
| createdAt / updatedAt | datetime | |

※ 在庫数・ロット残数は**保存していません**。必ず ops から再計算します（§4）。

### 3.6 photos（写真メタ情報）

| 項目 | 型 | 説明 |
|---|---|---|
| id | string | |
| itemId | string | → items.id |
| type | string | MIME（通常 `image/jpeg`） |
| width / height | integer | 原本のピクセル数 |
| bytes | integer | 原本のバイト数 |
| createdAt | datetime | |

画像本体は `manifest.files[]` の `photoId` で対応付けます。

### 3.7 ops（在庫操作履歴）

すべての在庫変更は ops に**追記のみ**で記録されます（削除・上書きしない）。

共通項目：

| 項目 | 型 | 説明 |
|---|---|---|
| id | string | |
| seq | integer | 作成順の通し番号（データセット内で一意） |
| order | integer | 同じ日付内の並び順キー。通常は seq と同じ。訂正レコードは訂正元の order を引き継ぐ |
| type | string | `receive` 入庫 / `consume` 使用 / `move` 移動 / `adjust` 棚卸し / `void` 取り消し |
| itemId | string | → items.id |
| date | date | ユーザーが指定した操作日（入庫の場合は入庫日） |
| createdAt | datetime | 実際に記録した日時 |
| memo | string | |
| corrects | string \| 省略 | 訂正レコードの場合、訂正対象の ops.id |
| correctionReason | string \| 省略 | |

type 別の項目：

**receive（入庫）**

| 項目 | 型 | 説明 |
|---|---|---|
| lotId | string | ロット（購入分）ID。新規は自身の id。訂正時は元の lotId を引き継ぐ |
| locationId | string | → locations.id |
| detail | string | 詳細位置（例：棚2・上段） |
| packCount | integer ≥0 | 購入数量（入れ物の数）。バラのみの場合は 0 |
| packSize | integer ≥1 | 入数（入れ物1つあたりの基本単位数。バラは1） |
| packUnit | string | 入れ物の単位 |
| looseQty | integer ≥0 \| 省略 | 入れ物とは別のバラの数（v1.2 で追加。省略時は 0） |
| qty | integer | = packCount × packSize + looseQty（検証すること） |
| amount | money \| null | 購入総額 |
| tax | `incl` \| `excl` \| null | 税込 / 税抜。amount が null なら null |
| purchaseDate | date \| null | 購入日 |
| storedDate | date \| null | 保管日 |
| supplier | string | 購入店・仕入先 |
| url | string | 購入時の商品URL |

**consume（使用・出庫）**

| 項目 | 型 | 説明 |
|---|---|---|
| locationId | string | |
| qty | integer ≥1 | |
| alloc | `[{lotId, qty}]` \| null | 手動ロット指定。null は FIFO |

**move（保管場所間の移動）**

| 項目 | 型 | 説明 |
|---|---|---|
| fromLocationId / toLocationId | string | 異なること |
| toDetail | string | 移動先の詳細位置 |
| qty | integer ≥1 | |
| alloc | 同上 | |

**adjust（棚卸し）** — 「実際に数えた数量」を記録する

| 項目 | 型 | 説明 |
|---|---|---|
| locationId | string | |
| counted | integer ≥0 | 実数 |
| recordedDelta | integer | 記録時点の差分（参考値。再計算では使わない） |
| lotId | string | 増加分ロットの ID（`adj-` + 元の id。訂正時は引き継ぐ） |
| alloc | 同上 | 減少分の手動ロット指定 |
| unitAmount | money \| null | 増加分の単価（null＝価格未設定） |
| tax | `incl` \| `excl` \| null | |
| detail | string | 増加分の詳細位置 |

**void（取り消し）**

| 項目 | 型 | 説明 |
|---|---|---|
| targetId | string | 取り消す ops.id（void 自体を取り消すと元の操作が有効に戻る） |
| reason | string | |

### 3.8 settings

```json
{ "theme": "system", "viewMode": "list", "sortKey": "updated", "sortDir": "desc", "backupIntervalDays": 7, "lastTax": "incl" }
```

未知のキーは無視し、欠けているキーは既定値を使います。

## 4. 在庫の再計算アルゴリズム（必須）

在庫数・ロット残数・評価額は ops から次の手順で導出します。インポート側も同じ結果になるよう実装してください。

1. **有効判定**：ops を seq の降順に走査し、有効な `void` の `targetId`、有効な訂正レコードの `corrects` を「無効」にする。無効化された操作は他を無効化しない。
2. **並び順**：有効かつ `void` 以外の ops を `(date, order, seq)` の昇順に並べる。
3. **再生**：ロット残数を「(lotId, locationId) → 数量」で管理しながら順に適用する。
   - receive：ロットを作成（価格情報 = {amount, qty, tax}）し、locationId に qty を加える。
   - consume：locationId の在庫から qty を減らす。alloc があればその通りに、なければ FIFO。
   - move：from から減らし（alloc または FIFO）、減らしたロットごとに to へ同量を加える（ロットと価格を引き継ぐ）。
   - adjust：場所の現在数との差分 `counted − 現在数` を求め、負なら減らす（alloc または FIFO）、正なら lotId で価格情報 `{amount: unitAmount×差分, qty: 差分, tax}`（unitAmount が null なら価格未設定）のロットを作る。
   - **FIFO**：その場所にあるロットを、ロットの元の `(date, order, seq)` 昇順で減らす（移動後も元の入庫日順）。
4. **エラー**：在庫不足（負数）、指定ロットの不足・不在、alloc 合計と数量の不一致はエラー。黙って補正しないこと。
5. **評価額**：残数 × (amount / qty) を有理数で計算し、税込・税抜は別々に合計する。価格未設定は金額に含めず数量のみ数える。価格未設定がある、または税区分が混在する場合、合計額・全体平均単価は「算出不可」。

## 5. 取り込み（復元）の要件

- 取り込み前に：形式・バージョン、SHA-256、件数、参照整合性（§3 の → 参照）、§4 の再計算がエラーなく通ることを検証する。
- **全件置き換え**：既存データをすべて消して置き換える。1トランザクションで行い、失敗時は元データを保持する。
- **統合**：
  - ID が同じレコードは同一。内容が同じならスキップ、異なれば「既存優先」または「更新日時が新しい方を優先」。
  - ID が異なっても名前が同じ管理区分・カテゴリ・保管場所は既存に対応付ける（参照IDを付け替える）。
  - 商品は自動統合しない（JAN・商品名が一致する別IDの商品は重複候補として報告し、利用者が「取り込む／取り込まない」を選ぶ）。
  - ops は ID で和集合。同じ ID で内容が異なれば破損としてエラー。新しい ops の seq / order は既存の最大値以降に振り直し、相対順序と order の参照関係を保つ。
  - 統合後に影響を受ける全商品を §4 で再計算し、エラーがあれば全体を中止する。
  - 取り込んだ backupId を記録し、同じファイルの再取り込みを警告する（ID 一致により二重登録は起きない）。

## 6. バージョン互換性

- formatVersion を上げるのは、既存の項目の意味が変わる場合のみ。項目の追加は同じバージョン内で行い、読み込み側は未知項目を無視する。
- 新しいバージョンのアプリは、古い formatVersion を読み込めること。
