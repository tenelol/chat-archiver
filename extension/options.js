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
  c.token = c.token.replace(/\s+/g, ''); // 貼り付けで紛れ込んだ空白・改行は取り除く
  return c;
}

// GitHub のトークンは英数字と _ だけでできている。伏せ字の「●」などが入っていたら、
// コピーしたのが本物のトークンではない(伏せ字の見た目をコピーした)ので、送る前に止める
function tokenProblem(token) {
  if (!token) return 'トークンが空です';
  if (/^[A-Za-z0-9_]+$/.test(token)) return null;
  return 'トークンに使えない文字（● など）が入っています。伏せ字の見た目ではなく、GitHub で表示された github_pat_… をコピーして貼り直してください';
}
function readChecked() {
  const c = read();
  const problem = tokenProblem(c.token);
  if (problem) msg(`❌ ${problem}`);
  return problem ? null : c;
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
// 権限の確認ダイアログが出るとページからフォーカスが外れ、readText が "Document is not focused" で失敗する。
// フォーカスが戻るのを少し待ってから読む
function waitForFocus(ms = 3000) {
  if (document.hasFocus()) return Promise.resolve();
  window.focus();
  return new Promise((resolve) => {
    window.addEventListener('focus', resolve, { once: true });
    setTimeout(resolve, ms);
  });
}

// readText が使えない場合は、隠したテキスト欄に execCommand('paste') で貼って取り出す(clipboardRead 権限で動く)
function pasteViaExecCommand() {
  const ta = document.createElement('textarea');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  const ok = document.execCommand('paste');
  const text = ta.value;
  ta.remove();
  $('token').focus();
  if (!ok) throw new Error('このブラウザではクリップボードを読めませんでした');
  return text;
}

async function readClipboard() {
  try {
    await waitForFocus();
    return await navigator.clipboard.readText();
  } catch {
    return pasteViaExecCommand();
  }
}

$('pasteToken').onclick = async () => {
  try {
    const has = await chrome.permissions.contains({ permissions: ['clipboardRead'] });
    const granted = has || (await chrome.permissions.request({ permissions: ['clipboardRead'] }));
    if (!granted) return msg('クリップボードの読み取りが許可されませんでした');
    const text = (await readClipboard()).trim();
    if (!text) return msg('クリップボードが空です');
    $('token').value = text;
    if (tokenProblem(text)) return msg(`❌ ${tokenProblem(text)}`);
    msg(/^(github_pat_|ghp_)/.test(text) ? 'トークンを貼り付けました。「保存」を押してください' : '⚠️ トークンらしくない文字列です。コピーした内容を確認してください');
  } catch (e) {
    msg(`❌ 貼り付けできませんでした: ${e.message}`);
  }
};

$('save').onclick = async () => {
  const c = readChecked();
  if (!c) return;
  await chrome.storage.local.set({ config: c });
  msg('保存しました');
};

$('test').onclick = async () => {
  const c = readChecked();
  if (!c) return;
  await chrome.storage.local.set({ config: c });
  msg('確認中…');
  const r = await chrome.runtime.sendMessage({ type: 'test' });
  if (r?.error) msg(`❌ ${r.error}`);
  else msg(`✅ ${r.fullName} に書き込めます${r.private ? '' : '（⚠️ 公開リポジトリです。非公開を強くおすすめします）'}`);
};

async function sweep(full) {
  const c = readChecked();
  if (!c) return;
  await chrome.storage.local.set({ config: c });
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
// 伏せ字の CSS が使えるブラウザ(Chromium 系・Safari)では、トークン欄を普通の入力欄にする。
// パスワード欄のままだと、ブラウザによってコピー・貼り付け・取り消しのショートカットが効かない。
// 使えないブラウザ(古い Firefox など)ではパスワード欄のまま残す。
const useMask = CSS.supports('-webkit-text-security', 'disc');
if (useMask) {
  $('token').type = 'text';
  $('token').classList.add('masked');
}
// 伏せ字の欄から普通にコピーすると「●」がコピーされてしまうので、本物の文字列を渡す
for (const type of ['copy', 'cut']) {
  $('token').addEventListener(type, (e) => {
    const el = e.target;
    const selected = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? el.value.length);
    e.clipboardData.setData('text/plain', selected || el.value);
    e.preventDefault();
    if (type === 'cut') el.setRangeText('', el.selectionStart, el.selectionEnd, 'start');
  });
}
$('copyToken').onclick = async () => {
  const token = $('token').value.replace(/\s+/g, '');
  if (!token) return msg('トークンが空です');
  try {
    await navigator.clipboard.writeText(token);
    msg('トークンをコピーしました。別のブラウザの設定画面に貼り付けてください（チャットなどには貼らないでください）');
  } catch (e) {
    msg(`❌ コピーできませんでした: ${e.message}`);
  }
};
$('toggleToken').onclick = () => {
  const el = $('token');
  const hidden = useMask ? el.classList.contains('masked') : el.type === 'password';
  if (useMask) el.classList.toggle('masked', !hidden);
  else el.type = hidden ? 'text' : 'password';
  $('toggleToken').textContent = hidden ? '隠す' : '表示';
};

load();
