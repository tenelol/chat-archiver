const FIELDS = ['token', 'owner', 'repo', 'branch', 'basePath', 'intervalMin', 'enableChatgpt', 'enableClaude', 'enableGrok', 'saveRaw', 'commitEachTurn'];
const DEFAULTS = {
  token: '', owner: '', repo: '', branch: 'main', basePath: '', intervalMin: 15,
  enableChatgpt: true, enableClaude: true, enableGrok: true, saveRaw: false, commitEachTurn: true,
};
const $ = (id) => document.getElementById(id);
const msg = (t) => ($('msg').textContent = t);

async function load() {
  const { config } = await chrome.storage.local.get('config');
  const c = { ...DEFAULTS, ...(config || {}) };
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!c[f];
    else el.value = c[f];
  }
  renderStatus();
}

function read() {
  const c = {};
  for (const f of FIELDS) {
    const el = $(f);
    c[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
  }
  return c;
}

const fmt = (t) => (t ? new Date(t).toLocaleString('ja-JP') : '-');

async function renderStatus() {
  const { status = {}, convs = {}, retry = {} } = await chrome.storage.local.get(['status', 'convs', 'retry']);
  const retryCount = Object.values(retry).reduce((n, m) => n + Object.keys(m || {}).length, 0);
  const counts = Object.keys(convs).reduce((a, k) => ((a[k.split(':')[0]] = (a[k.split(':')[0]] || 0) + 1), a), {});
  $('status').textContent = [
    `実行中: ${status.running ? 'はい' : 'いいえ'} ${status.progress || ''}`,
    `保存済み会話: ChatGPT ${counts.chatgpt || 0} / Claude ${counts.claude || 0} / Grok ${counts.grok || 0}`,
    retryCount ? `次回やり直す会話: ${retryCount}件` : '',
    `最終巡回: ${fmt(status.lastSweepAt)}`,
    `最終コミット: ${fmt(status.lastCommitAt)} ${status.lastCommitMsg || ''}`,
    status.lastError ? `\n最後のエラー (${fmt(status.lastErrorAt)}):\n${status.lastError}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ブラウザによってはパスワード欄にキーボードで貼り付けられない(Phi など)ので、
// ボタンからクリップボードを読んで入れる。権限は押したときにだけ求める(optional_permissions)
$('pasteToken').onclick = async () => {
  try {
    const granted = await chrome.permissions.request({ permissions: ['clipboardRead'] });
    if (!granted) return msg('クリップボードの読み取りが許可されませんでした');
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) return msg('クリップボードが空です');
    $('token').value = text;
    msg(/^(github_pat_|ghp_)/.test(text) ? 'トークンを貼り付けました。「保存」を押してください' : '⚠️ トークンらしくない文字列です。コピーした内容を確認してください');
  } catch (e) {
    msg(`❌ 貼り付けできませんでした: ${e.message}`);
  }
};

$('save').onclick = async () => {
  await chrome.storage.local.set({ config: read() });
  msg('保存しました');
};

$('test').onclick = async () => {
  await chrome.storage.local.set({ config: read() });
  msg('確認中…');
  const r = await chrome.runtime.sendMessage({ type: 'test' });
  if (r?.error) msg(`❌ ${r.error}`);
  else msg(`✅ ${r.fullName} に書き込めます${r.private ? '' : '（⚠️ 公開リポジトリです。非公開を強くおすすめします）'}`);
};

async function sweep(full) {
  await chrome.storage.local.set({ config: read() });
  msg('同期中…（初回は会話数によって数分〜数十分かかります。このページは閉じてもOK）');
  const r = await chrome.runtime.sendMessage({ type: 'sweep', full });
  if (r?.error) return msg(`❌ ${r.error}`);
  msg(
    Object.entries(r)
      .map(([k, v]) => (v.error ? `${k}: ❌ ${v.error}` : `${k}: ${v.committed}件コミット（確認 ${v.checked}件、エラー ${v.errors}件）`))
      .join(' / ') || '対象サービスがありません',
  );
}
$('sweep').onclick = () => sweep(false);
$('full').onclick = () => sweep(true);

$('reset').onclick = async () => {
  if (!confirm('同期履歴をリセットしますか？')) return;
  await chrome.runtime.sendMessage({ type: 'reset-state' });
  msg('リセットしました');
  renderStatus();
};

chrome.storage.onChanged.addListener((ch) => {
  if (ch.status || ch.convs || ch.retry) renderStatus();
});
load();
