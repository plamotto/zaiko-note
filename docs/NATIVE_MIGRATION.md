# 将来のネイティブ（SwiftUI）移行のための技術情報

Web 版のデータは、設定 → 「バックアップを作成」で出力される ZIP（[BACKUP_FORMAT.md](BACKUP_FORMAT.md)）を介して、商品・写真・履歴・設定をすべて引き継げます。
ネイティブ版ではこの ZIP を読み込むインポーターを実装してください。

## 1. 推奨マッピング（SwiftData の例）

| バックアップ | Swift 型 | 注意 |
|---|---|---|
| id（UUID 文字列） | `String`（または `UUID(uuidString:)`） | **ID は変換せずそのまま保持**（再統合・同期のため） |
| money 文字列 `"1234.5"` | `Decimal(string:locale: Locale(identifier: "en_US_POSIX"))` | `Double` は禁止。null は「価格未設定」 |
| 数量 | `Int` | |
| date `YYYY-MM-DD` | `String` のまま保持、または `DateComponents` | タイムゾーン変換しない（「その日」を表す） |
| datetime ISO8601 | `Date`（`ISO8601DateFormatter` + fractionalSeconds） | |
| tax `incl/excl` | `enum TaxMode: String { case incl, excl }` | |
| op.type | `enum OpType: String { case receive, consume, move, adjust, void }` | |
| alloc | `[LotAllocation]`（`lotId: String, qty: Int`） | |
| photos/*.jpg | ファイル保存（Application Support）＋ `@Attribute(.externalStorage)` | |

```swift
@Model final class Item {
  @Attribute(.unique) var id: String
  var name: String; var unit: String
  var categoryId: String?; var jan: String?
  var maker: String; var model: String; var spec: String
  var packSize: Int?; var packUnit: String
  var threshold: Int?; var urls: [String]; var memo: String
  var photoIds: [String]           // 先頭がメイン
  var archived: Bool; var archivedAt: Date?
  var createdAt: Date; var updatedAt: Date
}

@Model final class InventoryOp {
  @Attribute(.unique) var id: String
  var seq: Int; var order: Int
  var type: String; var itemId: String
  var date: String                  // YYYY-MM-DD
  var createdAt: Date
  var memo: String
  var corrects: String?; var correctionReason: String?
  // receive
  var lotId: String?; var locationId: String?; var detail: String?
  var packCount: Int?; var packSize: Int?; var packUnit: String?; var qty: Int?
  var amount: Decimal?; var tax: String?
  var purchaseDate: String?; var storedDate: String?; var supplier: String?; var url: String?
  // consume / move / adjust / void
  var allocJSON: Data?              // [{lotId, qty}]
  var fromLocationId: String?; var toLocationId: String?; var toDetail: String?
  var counted: Int?; var recordedDelta: Int?; var unitAmount: Decimal?
  var targetId: String?; var reason: String?
}
```

在庫数・ロット残数は保存せず、Web 版と同じく ops から再計算してください（Web 版 `src/core/ledger.js` の `replay()` が参照実装。約250行の純粋関数で、DOM・ブラウザ API に依存しません）。

## 2. インポート手順

1. ZIP を展開（`Compression` / `AppleArchive` 不可の場合は ZIPFoundation 等。STORE と DEFLATE に対応）。
2. `manifest.json` を読み、`format == "zaiko-pwa-backup"` かつ `formatVersion <= 対応最大` を確認。
3. `data.json` と各写真の SHA-256（`CryptoKit.SHA256`）を manifest と照合。
4. 参照整合性と `replay()` 相当の再計算で全商品がエラーにならないことを検証。
5. 1つのトランザクション（`ModelContext` の一括保存）で書き込む。失敗時は何も保存しない。
6. 取り込んだ `backupId` を記録（二重取り込み警告用）。

## 3. 検証用データ

- サンプルモードのデータをバックアップすると、すべての操作種別（FIFO・手動ロット・移動・税込/税抜混在・価格未設定・訂正・取り消し・過去日付・アーカイブ・複数写真）を含む ZIP が得られます。ネイティブ版インポーターの受け入れテストに使用してください。
- 期待値の例（サンプル投入直後）：「ニトリル手袋 M」在庫 540枚（倉庫A 450 / 厨房 90）、ロット残 70（税込 ¥9.90/枚）と 470（税抜 ¥8.80/枚）、在庫金額 税込 ¥693・税抜 ¥4,136、合計は算出不可。

## 4. 移行時の注意

- Web 版のデータは Safari のサイトデータとして保存されています。ネイティブ版から直接読むことはできないため、必ずバックアップ ZIP を経由してください（共有シート → 「ファイルに保存」→ ネイティブ版で読み込み）。
- 移行後しばらくは Web 版のデータを消さず、ネイティブ版で件数・在庫数・在庫金額が一致することを確認してください。
