// 設定：表示・バックアップ/復元・CSV・マスター・サンプル・整合性
import { h, icon, clear, openSheet, toast, toastError, field, seg, notice, confirmDialog, saveFile, pickFile, alertDialog } from './dom.js';
import { app, go, fmtQty, topbar } from './views.js';
import { createBackup, parseBackup, planMerge, restoreReplace, restoreMerge, APP_VERSION, BACKUP_FORMAT_VERSION } from '../data/backup.js';
import { exportItemsCsv, exportPurchasesCsv, exportHistoryCsv, planCsvImport, commitCsvImport, templateCsv } from '../data/csvio.js';
import { decodeCsvBytes } from '../core/csv.js';
import { formatDateTime, today } from '../core/util.js';

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  try {
    localStorage.setItem('zaiko.theme', theme);
  } catch {}
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0e100f' : '#f4f3ef');
}

// ───── バックアップ ─────
export async function runBackup() {
  const repo = app.repo;
  try {
    const bk = await createBackup(repo);
    const blob = new Blob([bk.bytes], { type: 'application/zip' });
    const r = await saveFile(blob, bk.filename);
    if (r === 'cancelled') return toast('バックアップの保存をキャンセルしました（最終バックアップ日時は更新していません）');
    let confirmed = r === 'shared';
    if (r === 'downloaded') {
      confirmed = await confirmDialog({ title: 'ファイルを保存できましたか？', message: `「${bk.filename}」（${(blob.size / 1024 / 1024).toFixed(1)}MB）\n保存できたことを確認してから「保存できた」を押してください。最終バックアップ日時を更新します。`, ok: '保存できた', cancel: 'できなかった' });
    }
    if (confirmed) {
      await repo.markBackedUp(bk.revision);
      toast(`バックアップしました（商品${bk.manifest.counts.items}・履歴${bk.manifest.counts.ops}・写真${bk.manifest.counts.photos}）`);
    } else toast('最終バックアップ日時は更新していません');
  } catch (e) {
    toastError(e);
  }
}

async function runRestore() {
  const repo = app.repo;
  const [file] = await pickFile('.zip,application/zip');
  if (!file) return;
  let parsed;
  try {
    parsed = await parseBackup(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    return toastError(e);
  }
  const body = h('div', { class: 'form' });
  const footer = h('div');
  const sheet = openSheet({ title: 'バックアップから復元', subtitle: file.name, body, footer });
  const m = parsed.manifest;
  if (m) body.appendChild(h('div', { class: 'group', style: { margin: 0, padding: '12px 14px' } }, h('dl', { class: 'kv', style: { margin: 0 } }, [['作成日時', formatDateTime(m.exportedAt)], ['形式', `${m.format} v${m.formatVersion}`], ['アプリ', `${m.app?.name || ''} ${m.app?.version || ''}`]].map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))));
  if (parsed.counts) {
    const c = parsed.counts;
    body.appendChild(h('div', { class: 'stat-row' }, [['商品', c.items], ['履歴', c.ops], ['写真', c.photos], ['保管場所', c.locations], ['カテゴリ', c.categories], ['管理区分', c.divisions]].map(([k, v]) => h('div', { class: 'stat' }, h('div', { class: 'v num' }, fmtQty(v)), h('div', { class: 'k' }, k)))));
  }
  if (!parsed.ok) {
    body.appendChild(notice('danger', 'alert', h('b', null, '検証エラーのため復元できません'), h('div', { class: 'small' }, parsed.errors.slice(0, 20).join('\n'))));
    footer.appendChild(h('button', { class: 'btn block', onclick: () => sheet.close() }, '閉じる'));
    return;
  }
  body.appendChild(notice('accent', 'shield', '整合性チェック：OK（ファイルのハッシュ・参照関係・在庫履歴の再計算に問題はありません）'));
  let mode = 'merge';
  let conflict = 'keepExisting';
  let skipDup = false;
  const planBox = h('div');
  const renderPlan = () => {
    clear(planBox);
    if (mode === 'replace') {
      planBox.appendChild(notice('warn', 'alert', `現在のデータ（商品${repo.items.size}件・履歴${repo.ops.size}件）はすべて置き換えられます。\n実行前に現在のデータをバックアップすることをおすすめします。`));
      planBox.appendChild(h('button', { class: 'btn block sm', style: { marginTop: '8px' }, onclick: runBackup }, icon('download'), '現在のデータをバックアップ'));
      return;
    }
    const plan = planMerge(repo, parsed, { conflict, skipDuplicateItems: skipDup });
    const s = plan.summary;
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    if (plan.alreadyImported) planBox.appendChild(notice('info', 'info', 'このバックアップは以前に取り込み済みです。同じレコードは二重に取り込まれません。'));
    planBox.appendChild(h('div', { class: 'stat-row', style: { margin: '8px 0' } }, [['追加', sum(s.add)], ['同一（スキップ）', sum(s.same)], ['競合', sum(s.conflict)], ['更新', sum(s.updated)], ['名前で対応付け', sum(s.mappedByName)]].map(([k, v]) => h('div', { class: 'stat' }, h('div', { class: 'v num' }, v), h('div', { class: 'k' }, k)))));
    const detail = Object.entries(s.add).map(([k, v]) => `${{ items: '商品', ops: '履歴', photos: '写真', locations: '保管場所', categories: 'カテゴリ', divisions: '管理区分' }[k]} +${v}`);
    if (detail.length) planBox.appendChild(h('div', { class: 'small muted' }, '追加内訳：', detail.join('、')));
    if (plan.conflicts.length) planBox.appendChild(h('details', null, h('summary', { class: 'small' }, `競合 ${plan.conflicts.length}件`), h('div', { class: 'small muted', style: { whiteSpace: 'pre-line' } }, plan.conflicts.join('\n'))));
    if (plan.dupCandidates.length) planBox.appendChild(notice('warn', 'alert', `既存と重複の可能性がある商品 ${plan.dupCandidates.length}件（自動統合はしません）`, h('div', { class: 'small' }, plan.dupCandidates.slice(0, 8).map((d) => `${d.name} ⇔ ${d.existing}`).join('\n'))));
    if (!plan.ok) planBox.appendChild(notice('danger', 'alert', h('b', null, '統合できません'), h('div', { class: 'small' }, plan.errors.slice(0, 10).join('\n'))));
    go2.disabled = !plan.ok;
  };
  const go2 = h('button', { class: 'btn primary block' }, '復元を実行');
  body.append(
    field(
      '復元方法',
      seg(
        [
          ['merge', '重複チェック付き統合'],
          ['replace', '全件置き換え'],
        ],
        mode,
        (v) => ((mode = v), (go2.disabled = false), (optBox.style.display = v === 'merge' ? '' : 'none'), renderPlan())
      )
    )
  );
  const optBox = h(
    'div',
    { class: 'form' },
    field(
      '同じIDで内容が異なる場合',
      seg(
        [
          ['keepExisting', '既存を優先'],
          ['newer', '新しい更新日時を優先'],
        ],
        conflict,
        (v) => ((conflict = v), renderPlan())
      )
    ),
    h('label', { class: 'cell', style: { padding: '4px 0' } }, h('input', { type: 'checkbox', style: { width: '22px', height: '22px' }, onchange: (e) => ((skipDup = e.target.checked), renderPlan()) }), h('span', { class: 'grow small' }, 'JAN・商品名が一致する別IDの商品は取り込まない'))
  );
  body.append(optBox, planBox);
  footer.appendChild(go2);
  renderPlan();
  go2.addEventListener('click', async () => {
    if (mode === 'replace') {
      const ok = await confirmDialog({ title: '全件置き換え', message: '現在のデータを削除してバックアップの内容に置き換えます。確認のため「置き換え」と入力してください。', ok: '置き換える', danger: true, input: { placeholder: '置き換え', match: '置き換え' } });
      if (!ok) return;
    }
    go2.disabled = true;
    try {
      if (mode === 'replace') await restoreReplace(repo, parsed);
      else await restoreMerge(repo, parsed, { conflict, skipDuplicateItems: skipDup });
      const problems = repo.checkIntegrity();
      sheet.close();
      if (problems.length) alertDialog('復元後の整合性チェックで問題が見つかりました', problems.slice(0, 10).map((p) => `${p.name || ''} ${p.error}`).join('\n'));
      else toast('復元しました（整合性チェック OK）');
      applyTheme(repo.settings.theme);
    } catch (e) {
      go2.disabled = false;
      toastError(new Error(`${e.message}\n既存のデータは変更されていません。`));
    }
  });
}

// ───── CSV ─────
async function exportCsv(kind) {
  const repo = app.repo;
  const map = { items: [exportItemsCsv, '商品一覧'], purchases: [exportPurchasesCsv, '購入履歴'], history: [exportHistoryCsv, '全履歴'], template: [templateCsv, '取り込みテンプレート'] };
  const [fn, label] = map[kind];
  const text = kind === 'template' ? fn() : fn(repo);
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const r = await saveFile(blob, `zaiko-${label}-${today()}.csv`);
  if (r !== 'cancelled') toast(`${label}CSVを出力しました`);
}

async function importCsv() {
  const repo = app.repo;
  const [file] = await pickFile('.csv,text/csv');
  if (!file) return;
  const text = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
  const choices = {};
  const body = h('div', { class: 'form' });
  const btn = h('button', { class: 'btn primary block' }, '取り込む');
  const sheet = openSheet({ title: 'CSV取り込みプレビュー', subtitle: file.name, body, footer: btn });
  let plan;
  const render = () => {
    plan = planCsvImport(repo, text, choices);
    clear(body);
    if (plan.fatal) {
      body.appendChild(notice('danger', 'alert', plan.fatal));
      btn.disabled = true;
      return;
    }
    const c = plan.counts;
    body.appendChild(h('div', { class: 'stat-row' }, [['新規', c.new], ['既存更新', c.update], ['入庫', c.receive], ['棚卸し', c.adjust], ['スキップ', c.skip], ['エラー', c.error]].map(([k, v]) => h('div', { class: 'stat', style: k === 'エラー' && v ? { background: 'var(--danger-soft)', color: 'var(--danger)' } : null }, h('div', { class: 'v num' }, v), h('div', { class: 'k' }, k)))));
    if (plan.newLocations.length || plan.newCategories.length) body.appendChild(notice('info', 'info', `新しく作成：${[...plan.newLocations.map((l) => `場所「${l.name}」`), ...plan.newCategories.map((x) => `カテゴリ「${x.name}」`)].join('、')}`));
    body.appendChild(h('div', { class: 'small muted' }, '在庫数の列（棚卸数量）は直接上書きせず「棚卸し調整」の履歴として記録します。空欄のセルは既存の値を変更しません。'));
    const table = h('table', { class: 'preview-table' }, h('thead', null, h('tr', null, h('th', null, '行'), h('th', null, '商品 / 処理'), h('th', null, '内容'))));
    const tb = h('tbody');
    for (const r of plan.rows) {
      const actLabel = { new: '新規登録', update: `既存「${r.targetName}」に適用`, pending: '同じCSV内の新規商品に適用', skip: 'スキップ', error: '—' }[r.action];
      let control = null;
      if (r.candidates?.length || r.errors.length) {
        const sel = h('select', { class: 'select', style: { minHeight: '36px', fontSize: '14px', marginTop: '4px' } }, h('option', { value: '' }, '自動判定'), h('option', { value: 'new' }, '新規商品として登録'), (r.candidates || []).map((cd) => h('option', { value: `existing:${cd.id}` }, `既存「${cd.name}」に適用`)), h('option', { value: 'skip' }, 'この行をスキップ'));
        sel.value = choices[r.rowNo] || '';
        sel.addEventListener('change', () => {
          if (sel.value) choices[r.rowNo] = sel.value;
          else delete choices[r.rowNo];
          render();
        });
        control = sel;
      }
      const content = [];
      if (r.changedFields?.length) content.push(`更新：${r.changedFields.join(', ')}`);
      if (r.receive) content.push(`入庫 ${r.receive.packCount}×${r.receive.packSize}`);
      if (r.adjust) content.push(`棚卸し 実数${r.adjust.counted}`);
      tb.appendChild(h('tr', { class: r.errors.length ? 'err' : '' }, h('td', { class: 'num' }, r.rowNo), h('td', null, h('div', { style: { fontWeight: 600 } }, r.name || r.targetName || ''), h('div', { class: 'tiny muted' }, actLabel), control), h('td', null, content.join(' / '), r.errors.map((e) => h('div', { style: { color: 'var(--danger)' } }, e)), r.warnings.map((w) => h('div', { style: { color: 'var(--warn)' } }, w)))));
    }
    table.appendChild(tb);
    body.appendChild(h('div', { style: { overflowX: 'auto' } }, table));
    btn.disabled = !plan.ok || plan.rows.every((r) => r.action === 'skip');
    btn.textContent = plan.ok ? '取り込む' : `エラー ${plan.counts.error}行を解消してください`;
  };
  render();
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await commitCsvImport(repo, plan);
      sheet.close();
      toast(`取り込みました（商品${r.items}件・履歴${r.ops}件）`);
    } catch (e) {
      toastError(e);
      render();
    }
  });
}

// ───── 画面 ─────
export function settingsScreen() {
  const repo = app.repo;
  const el = h('div', { class: 'view' });
  const body = h('div');
  el.append(h('header', { class: 'topbar' }, h('div', { class: 'title-row' }, h('h1', null, '設定'))), body);
  const cell = (ic, lead, label, desc, onclick, extra) => h(onclick ? 'button' : 'div', { class: 'cell', onclick }, h('span', { class: `lead ${lead}` }, icon(ic)), h('div', { class: 'grow' }, h('div', { class: 'label' }, label), desc ? h('div', { class: 'desc' }, desc) : null), extra || (onclick ? icon('chevR', 'chev') : null));
  function update() {
    clear(body);
    const s = repo.state;
    const due = repo.backupDue();
    const lastBk = s.lastBackupAt ? `${formatDateTime(s.lastBackupAt)}${s.lastBackupRevision >= s.revision ? '（以降の変更なし）' : '（以降に変更あり）'}` : 'まだバックアップしていません';
    const intervalSel = h('select', { class: 'select', style: { width: 'auto', minHeight: '36px' } }, [1, 3, 7, 14, 30, 0].map((d) => h('option', { value: d }, d ? `${d}日ごと` : '案内しない')));
    intervalSel.value = String(repo.settings.backupIntervalDays);
    intervalSel.addEventListener('change', () => repo.saveSettings({ backupIntervalDays: Number(intervalSel.value) || 36500 }));
    if (!repo.settings.backupIntervalDays || repo.settings.backupIntervalDays > 3650) intervalSel.value = '0';
    body.append(
      app.mode === 'sample'
        ? h('div', { class: 'banner sample' }, icon('flask'), h('div', { class: 'grow' }, h('b', null, 'サンプルモード中'), h('div', { class: 'small' }, '本番データとは別の領域です。ここでの操作は本番データに影響しません。')), h('button', { class: 'btn', onclick: () => window.__switchMode('main') }, '終了'))
        : null,
      h('div', { class: 'section' }, h('div', { class: 'section-h' }, '表示'), h('div', { class: 'group', style: { padding: '12px 14px' } }, field('テーマ', seg([['system', '自動（OS連動）'], ['light', 'ライト'], ['dark', 'ダーク']], repo.settings.theme, async (v) => (applyTheme(v), await repo.saveSettings({ theme: v })))))),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-h' }, 'バックアップ'),
        h(
          'div',
          { class: 'group' },
          cell('download', 'accent', 'バックアップを作成', `写真を含む全データをZIPで保存 ・ 最終：${lastBk}`, runBackup, due.due ? h('span', { class: 'badge low' }, '推奨') : null),
          cell('upload', 'info', 'バックアップから復元', '全件置き換え / 重複チェック付き統合', runRestore),
          cell('clock', '', '案内の間隔', 'データ変更があり、期間が過ぎたら案内します', null, intervalSel)
        ),
        h('div', { class: 'footnote' }, 'iPhoneでは共有シートから「ファイルに保存」を選ぶと iCloud Drive などに保存できます。データはこの端末のブラウザ内にのみ保存されているため、定期的なバックアップをおすすめします。')
      ),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-h' }, 'CSV（Excel・Numbers）'),
        h(
          'div',
          { class: 'group' },
          cell('table', '', '商品一覧を出力', '在庫数・評価額（税込/税抜別）を含む', () => exportCsv('items')),
          cell('table', '', '購入履歴を出力', '購入分ごとの価格・残数', () => exportCsv('purchases')),
          cell('table', '', '全履歴を出力', '入庫・使用・移動・棚卸し・訂正・取り消し', () => exportCsv('history')),
          cell('upload', 'info', 'CSVから取り込み', '新規登録・既存更新・入庫・棚卸し（プレビュー付き）', importCsv),
          cell('file', '', '取り込み用テンプレート', '列の見本付きCSV', () => exportCsv('template'))
        )
      ),
      h('div', { class: 'section' }, h('div', { class: 'section-h' }, 'マスター'), h('div', { class: 'group' }, cell('layers', '', 'カテゴリ・保管場所・管理区分', `${repo.categories.size}カテゴリ ・ ${[...repo.locations.values()].filter((l) => !l.archived).length}か所 ・ ${repo.divisions.size}区分`, () => go('#/manage/places')))),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-h' }, 'データの状態'),
        h(
          'div',
          { class: 'group' },
          cell('shield', 'accent', '整合性チェック', '全商品の在庫履歴を再計算して検証', () => {
            const p = repo.checkIntegrity();
            if (!p.length) alertDialog('問題はありません', `${repo.items.size}商品・${repo.ops.size}件の履歴を再計算し、在庫数・購入分残数・参照関係に矛盾がないことを確認しました。`);
            else alertDialog(`${p.length}件の問題`, p.slice(0, 15).map((x) => `${x.name || ''}：${x.error}`).join('\n'));
          }),
          h('div', { class: 'cell', id: 'storage-cell' }, h('span', { class: 'lead' }, icon('folder')), h('div', { class: 'grow' }, h('div', { class: 'label' }, '保存容量'), h('div', { class: 'desc', id: 'storage-desc' }, '計算中…')))
        )
      ),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-h' }, 'サンプルデータ'),
        h(
          'div',
          { class: 'group' },
          app.mode === 'sample'
            ? [cell('refresh', 'warn', 'サンプルをリセット', 'サンプル領域だけを初期状態に戻します', () => window.__resetSample()), cell('box', 'accent', 'サンプルモードを終了', '本番データに戻ります', () => window.__switchMode('main'))]
            : cell('flask', 'info', 'サンプルデータで試す', '本番データとは別の領域で操作を試せます（本番データは消えません）', () => window.__switchMode('sample'))
        )
      ),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-h' }, 'このアプリについて'),
        h('div', { class: 'group' }, cell('info', '', '在庫ノート', `バージョン ${APP_VERSION} ・ バックアップ形式 v${BACKUP_FORMAT_VERSION}`, null), cell('file', '', '仕様書・ドキュメント', 'バックアップ形式・設計資料（オンライン時）', () => window.open('docs/', '_blank'))),
        h('div', { class: 'footnote' }, '外部へのデータ送信・解析・広告は一切ありません。すべてのデータはこの端末内（IndexedDB）に保存されます。')
      )
    );
    showStorage();
  }
  async function showStorage() {
    const desc = body.querySelector('#storage-desc');
    if (!desc) return;
    let txt = '';
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) txt = `使用 ${(est.usage / 1048576).toFixed(1)}MB / 上限目安 ${(est.quota / 1048576 / 1024).toFixed(1)}GB`;
      const persisted = await navigator.storage?.persisted?.();
      txt += persisted ? ' ・ 永続保存：有効' : ' ・ 永続保存：未許可';
      if (!persisted && navigator.storage?.persist) {
        const b = h('button', { class: 'btn sm', onclick: async () => toast((await navigator.storage.persist()) ? '永続保存が有効になりました' : 'ブラウザが永続保存を許可しませんでした（ホーム画面に追加すると許可されやすくなります）') }, '永続化を要求');
        desc.parentElement.parentElement.appendChild(b);
      }
    } catch {
      txt = '取得できません';
    }
    desc.textContent = txt + ` ・ 商品${repo.items.size} / 履歴${repo.ops.size} / 写真${repo.photos.size}`;
  }
  update();
  return { el, update };
}
