// エントリポイント：起動・ルーティング・タブバー・バナー・サンプルモード切替
import { h, icon, clear, toast, toastError, closeAllSheets, confirmDialog } from './dom.js';
import { app, go, alertCount } from './views.js';
import { Repo } from '../data/store.js';
import { deleteDb } from '../data/db.js';
import { loadSampleData } from '../data/sample.js';
import { makeSamplePhoto } from './photo.js';
import { inventoryScreen } from './inventory.js';
import { itemDetailScreen, itemFormScreen } from './item.js';
import { placesScreen, placeDetailScreen, manageScreen } from './places.js';
import { scanScreen } from './scan.js';
import { historyScreen } from './history.js';
import { printScreen } from './print.js';
import { settingsScreen, applyTheme, runBackup } from './settings.js';

const DB = { main: 'zaiko-main', sample: 'zaiko-sample' };
const root = document.getElementById('app');
const viewHost = h('main', { id: 'view-host' });
const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'メイン' });
root.append(viewHost, tabbar);

let current = null; // { el, update?, static?, destroy?, banners? }
let currentKey = '';
const scrollMemo = new Map();

const TABS = [
  ['inventory', '在庫', 'box', '#/'],
  ['places', '保管場所', 'pin', '#/places'],
  ['scan', 'スキャン', 'scan', '#/scan'],
  ['history', '履歴', 'clock', '#/history'],
  ['settings', '設定', 'gear', '#/settings'],
];

function parseRoute() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  const seg = path.split('/').filter(Boolean);
  let tab = 'inventory';
  let make;
  if (!seg.length) make = () => inventoryScreen();
  else if (seg[0] === 'item' && seg[2] === 'edit') make = () => itemFormScreen(seg[1]);
  else if (seg[0] === 'item') make = () => itemDetailScreen(seg[1]);
  else if (seg[0] === 'new') make = () => itemFormScreen(null, params);
  else if (seg[0] === 'places') (tab = 'places'), (make = () => placesScreen());
  else if (seg[0] === 'place') (tab = 'places'), (make = () => placeDetailScreen(seg[1]));
  else if (seg[0] === 'manage') (tab = 'settings'), (make = () => manageScreen(seg[1]));
  else if (seg[0] === 'scan') (tab = 'scan'), (make = () => scanScreen());
  else if (seg[0] === 'history') (tab = 'history'), (make = () => historyScreen(params));
  else if (seg[0] === 'settings') (tab = 'settings'), (make = () => settingsScreen());
  else if (seg[0] === 'print') make = () => printScreen();
  else make = () => inventoryScreen();
  return { key: raw, tab, make };
}

function renderTabbar(active) {
  clear(tabbar);
  const alerts = app.repo ? alertCount(app.repo) : 0;
  const inner = h('div', { class: 'tabbar-inner' });
  for (const [key, label, ic, hash] of TABS) {
    const on = key === active;
    inner.appendChild(
      h('button', {
        class: 'tab' + (on ? ' on' : ''),
        'aria-current': on ? 'page' : null,
        onclick: () => {
          const cur = location.hash || '#/';
          if (on && cur === hash) window.scrollTo({ top: 0, behavior: 'smooth' });
          else go(hash);
        },
      }, key === 'scan' ? h('span', { class: 'scan-bubble' }, icon(ic)) : icon(ic), label, key === 'inventory' && alerts ? h('span', { class: 'dot-badge num' }, alerts) : null)
    );
  }
  tabbar.appendChild(inner);
}

function banners() {
  const out = [];
  if (app.mode === 'sample') {
    out.push(h('div', { class: 'banner sample' }, icon('flask'), h('div', { class: 'grow' }, h('b', null, 'サンプルモード'), ' ・ 本番データとは別の領域です'), h('button', { class: 'btn', onclick: () => switchMode('main') }, '終了')));
  }
  const due = app.repo.backupDue();
  if (due.due && app.mode === 'main' && sessionStorage.getItem('zaiko.bkSnooze') !== String(app.repo.state.revision)) {
    out.push(
      h(
        'div',
        { class: 'banner backup' },
        icon('shield'),
        h('div', { class: 'grow' }, due.reason === 'never' ? 'まだバックアップがありません' : `前回のバックアップから${due.days}日経過`, h('div', { class: 'tiny' }, '写真を含む全データを保存しましょう')),
        h('button', { class: 'btn', onclick: runBackup }, '今すぐ'),
        h('button', { class: 'icon-btn sm', 'aria-label': '後で', onclick: (e) => (sessionStorage.setItem('zaiko.bkSnooze', String(app.repo.state.revision)), e.currentTarget.parentElement.remove()) }, icon('x'))
      )
    );
  }
  return out;
}

function render(force = false) {
  const r = parseRoute();
  if (!force && current && r.key === currentKey) return;
  // スクロール位置の記憶
  if (currentKey) scrollMemo.set(currentKey, window.scrollY);
  current?.destroy?.();
  closeAllSheets();
  currentKey = r.key;
  try {
    current = r.make();
  } catch (e) {
    console.error(e);
    current = { el: h('div', { class: 'view pad' }, h('h2', null, '表示エラー'), h('pre', { class: 'small' }, String(e?.stack || e))) };
  }
  if (current.banners) for (const b of banners()) current.banners.appendChild(b);
  clear(viewHost).appendChild(current.el);
  renderTabbar(r.tab);
  window.scrollTo(0, scrollMemo.get(r.key) || 0);
}

function onDataChange() {
  renderTabbar(parseRoute().tab);
  if (!current || current.static) return;
  const y = window.scrollY;
  if (current.update) {
    current.update();
    if (current.banners) {
      clear(current.banners);
      for (const b of banners()) current.banners.appendChild(b);
    }
  } else render(true);
  window.scrollTo(0, y);
}

// トップバーの影
addEventListener('scroll', () => document.querySelector('.topbar')?.classList.toggle('scrolled', scrollY > 4), { passive: true });

// 編集中の離脱確認
addEventListener('hashchange', async () => {
  if (current?.isDirty?.()) {
    const target = location.hash;
    history.pushState(null, '', '#' + currentKey);
    const ok = await confirmDialog({ title: '変更を破棄しますか？', message: '入力中の内容は保存されていません。', ok: '破棄して移動', danger: true });
    if (!ok) return;
    current.isDirty = () => false;
    location.hash = target;
    return;
  }
  render();
});

// ───── モード切替（本番 / サンプル） ─────
let channel = null;
async function openRepo(mode) {
  app.repo?.close();
  const repo = new Repo(DB[mode]);
  await repo.open();
  app.repo = repo;
  app.mode = mode;
  repo.subscribe((info) => {
    onDataChange();
    if (info) channel?.postMessage({ db: repo.dbName });
  });
  applyTheme(repo.settings.theme);
  try {
    localStorage.setItem('zaiko.mode', mode);
  } catch {}
  return repo;
}

async function ensureSample(repo) {
  if (repo.items.size || repo.ops.size) return;
  toast('サンプルデータを作成しています…', { duration: 4000 });
  await loadSampleData(repo, makeSamplePhoto);
  await repo.saveSettings({ theme: (() => { try { return localStorage.getItem('zaiko.theme') || 'system'; } catch { return 'system'; } })() });
}

async function switchMode(mode) {
  try {
    const repo = await openRepo(mode);
    if (mode === 'sample') await ensureSample(repo);
    toast(mode === 'sample' ? 'サンプルモードに切り替えました（本番データはそのまま残っています）' : '本番データに戻りました');
    location.hash = '#/';
    render(true);
  } catch (e) {
    toastError(e);
  }
}
window.__switchMode = switchMode;
window.__resetSample = async () => {
  if (app.mode !== 'sample') return;
  const ok = await confirmDialog({ title: 'サンプルをリセット', message: 'サンプル領域のデータを初期状態に戻します。本番データには影響しません。', ok: 'リセット' });
  if (!ok) return;
  try {
    app.repo.close();
    await deleteDb(DB.sample);
    const repo = await openRepo('sample');
    await ensureSample(repo);
    toast('サンプルをリセットしました');
    location.hash = '#/';
    render(true);
  } catch (e) {
    toastError(e);
  }
};

async function boot() {
  let mode = 'main';
  try {
    mode = localStorage.getItem('zaiko.mode') === 'sample' ? 'sample' : 'main';
  } catch {}
  try {
    const repo = await openRepo(mode);
    if (mode === 'sample') await ensureSample(repo);
  } catch (e) {
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'view pad' }, h('h2', null, 'データを開けませんでした'), h('p', null, e.message), h('p', { class: 'small muted' }, 'プライベートブラウズでは保存できない場合があります。通常モードの Safari で開くか、ホーム画面に追加して使用してください。')));
    return;
  }
  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel('zaiko-sync');
    channel.onmessage = async (e) => {
      if (e.data?.db === app.repo?.dbName) await app.repo.reload();
    };
  }
  render(true);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(app.repo.settings.theme));
  // 永続化（ホーム画面追加時は許可されやすい）
  navigator.storage?.persist?.().catch(() => {});
}

// 開発中（localhost）は古いキャッシュで混乱しないよう既定で SW を登録しない。localStorage 'zaiko.sw'='1' で有効化。
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
let devSW = false;
try {
  devSW = localStorage.getItem('zaiko.sw') === '1';
} catch {}
if ('serviceWorker' in navigator && (location.protocol === 'https:' ? true : isLocal && devSW)) {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          toast('新しいバージョンがあります', { action: '更新', onAction: () => location.reload(), duration: 15000 });
        }
      });
    });
  }).catch((e) => console.warn('SW登録失敗', e));
}

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
});

boot();
