import { SERVICES } from './lib/sources.js';
import { buildPath, rawPath } from './lib/convert.js';
import { commitFiles, testConnection } from './lib/github.js';
import { detectTurn, idFromPageUrl } from './lib/detect.js';

const ALARM = 'chat-archiver-sweep';
const RESUME_ALARM = 'chat-archiver-resume'; // 429 や通信断で中断したとき、少し置いて自動で続きから再開する
const RESUME_AFTER_MIN = 10;
const DEFAULTS = {
  token: '',
  owner: '',
  repo: '',
  branch: 'main',
  basePath: '',
  intervalMin: 15,
  enableChatgpt: true,
  enableClaude: true,
  enableGrok: true,
  saveRaw: false,
  commitEachTurn: true,
};
const BATCH = 25; // 1コミットあたりの最大会話数(初回の全件取り込み時)
const FETCH_DELAY_MS = 1000; // サービスへの負荷を抑えるための間隔(400ms では ChatGPT が 429 を返し続けた)
const MAX_429_RETRIES = 6;
const MAX_TRANSIENT_RETRIES = 3;

/* ---------- storage ---------- */

// ChatGPT と Claude を並行に同期するので、storage の読み書き(get→set)とコミットはそれぞれ直列にする
function makeLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const p = tail.then(fn, fn);
    tail = p.catch(() => {});
    return p;
  };
}
const storageLock = makeLock();
const commitLock = makeLock();

async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  return { ...DEFAULTS, ...(config || {}) };
}
async function getState() {
  const { convs = {}, backfill = {} } = await chrome.storage.local.get(['convs', 'backfill']);
  return { convs, backfill };
}
function mergeConvs(updates) {
  if (!Object.keys(updates).length) return Promise.resolve();
  return storageLock(async () => {
    const { convs = {} } = await chrome.storage.local.get('convs');
    await chrome.storage.local.set({ convs: { ...convs, ...updates } });
  });
}
// 取得や変換に失敗した会話は retry に積み、次の巡回で一覧の位置に関係なくやり直す
// (一覧読みは変化なしが続くと打ち切るので、古い会話の失敗はそこからは拾えない)
function updateRetry(serviceName, failed, okIds) {
  if (!Object.keys(failed).length && !okIds.length) return Promise.resolve();
  return storageLock(async () => {
    const { retry = {} } = await chrome.storage.local.get('retry');
    const mine = { ...(retry[serviceName] || {}) };
    for (const id of okIds) delete mine[id];
    Object.assign(mine, failed);
    await chrome.storage.local.set({ retry: { ...retry, [serviceName]: mine } });
  });
}
async function getRetry(serviceName) {
  const { retry = {} } = await chrome.storage.local.get('retry');
  return Object.values(retry[serviceName] || {});
}
function markBackfilled(serviceName) {
  return storageLock(async () => {
    const { backfill = {} } = await chrome.storage.local.get('backfill');
    await chrome.storage.local.set({ backfill: { ...backfill, [serviceName]: true } });
  });
}
function setStatus(patch) {
  return storageLock(async () => {
    const { status = {} } = await chrome.storage.local.get('status');
    await chrome.storage.local.set({ status: { ...status, ...patch } });
  });
}
// 進捗はサービスごとに持ち、設定画面には「ChatGPT: … / Claude: …」とまとめて出す
function setProgress(service, text) {
  return storageLock(async () => {
    const { status = {} } = await chrome.storage.local.get('status');
    const by = { ...(status.progressBy || {}) };
    if (text) by[service.name] = text;
    else delete by[service.name];
    await chrome.storage.local.set({ status: { ...status, progressBy: by, progress: Object.values(by).join(' / ') } });
  });
}

const isConfigured = (c) => !!(c.token && c.owner && c.repo && c.branch);
const enabledServices = (c) =>
  [c.enableChatgpt && SERVICES.chatgpt, c.enableClaude && SERVICES.claude, c.enableGrok && SERVICES.grok].filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- 直列実行(巡回と即時同期が重ならないように) ---------- */

const exclusive = makeLock();

/* ---------- サービスAPIの呼び出し ---------- */

// body があれば JSON の POST、なければ GET
function requestInit(headers, body) {
  return {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  };
}

// タブ内で実行される関数(シリアライズされるので自己完結させる)
function pageFetch(url, headers, body) {
  const init = {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  };
  return fetch(url, init)
    .then(async (r) => ({
      ok: r.ok,
      status: r.status,
      json: r.ok ? await r.json() : null,
      text: r.ok ? null : (await r.text()).slice(0, 300),
      retryAfter: r.headers.get('retry-after'),
    }))
    .catch((e) => ({ ok: false, status: 0, text: String(e) }));
}

function httpError(service, url, r) {
  const e = new Error(`${service.label} API ${r.status}: ${url.replace(/\?.*/, '')} ${r.text || ''}`.trim());
  e.status = r.status;
  e.retryAfter = r.retryAfter;
  return e;
}

// 429 は Retry-After だけ待って再試行する。待機中も10秒ごとに storage を触り、
// MV3 の service worker がアイドル扱い(30秒)で止められないようにする。
async function with429Retry(service, once) {
  let transient = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await once();
    } catch (e) {
      // 通信断(status 0: Failed to fetch)やサーバー側の 5xx は一時的なことが多いので、
      // 5→10→20秒と待って3回までやり直す(一度の失敗で一括取得を手放さないように)
      if ((e.status === 0 || e.status >= 500) && transient < MAX_TRANSIENT_RETRIES) {
        const wait = 5 * 2 ** transient++;
        await setProgress(service, `${service.label}: 通信エラーのため${wait}秒後にやり直します`);
        await sleep(wait * 1000);
        continue;
      }
      if (e.status !== 429 || attempt >= MAX_429_RETRIES) throw e;
      let remain = Math.min(Math.max(Number(e.retryAfter) || 30, 5), 300);
      while (remain > 0) {
        await setProgress(service, `${service.label}: 混雑のため待機中（あと${remain}秒）`);
        const step = Math.min(10, remain);
        await sleep(step * 1000);
        remain -= step;
      }
    }
  }
}

// そのサービスのタブが開いていればタブ内から(Cookie/Cloudflare対策で確実)、なければ拡張から直接取得
async function makeFetcher(service, preferredTabId) {
  let tabId = preferredTabId ?? null;
  if (tabId == null) {
    const tabs = await chrome.tabs.query({ url: service.tabPattern });
    // 凍結(frozen)されたバックグラウンドタブでは fetch が拒否されるので選ばない
    tabId = tabs.find((t) => t.status === 'complete' && !t.discarded && !t.frozen)?.id ?? null;
  }
  const direct = async (url, headers = {}, body) => {
    let res;
    try {
      res = await fetch(url, requestInit(headers, body));
    } catch (e) {
      throw httpError(service, url, { status: 0, text: String(e) }); // タブ経由と同じく通信断は status 0
    }
    if (!res.ok) {
      throw httpError(service, url, {
        status: res.status,
        text: (await res.text()).slice(0, 200),
        retryAfter: res.headers.get('retry-after'),
      });
    }
    return res.json();
  };
  if (tabId == null) return (url, headers = {}, body) => with429Retry(service, () => direct(url, headers, body));
  const viaTab = async (url, headers = {}, body) => {
    let r;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageFetch,
        args: [url, headers, body ?? null],
      });
      r = res?.result;
    } catch {
      return direct(url, headers, body); // タブが閉じられた等
    }
    // タブ側で通信自体が失敗した(凍結中・遷移中など)ときは、拡張から直接取りに行く
    if (r && !r.ok && r.status === 0) return direct(url, headers, body);
    if (!r?.ok) throw httpError(service, url, r || { status: 0 });
    return r.json;
  };
  return (url, headers = {}, body) => with429Retry(service, () => viaTab(url, headers, body));
}

/* ---------- 会話の取得→Markdown化→コミット ---------- */

function commitMessage(service, titles) {
  if (titles.length === 1) return `${service.name}: ${titles[0]}`;
  return `${service.name}: ${titles.length}件の会話を同期\n\n${titles.map((t) => `- ${t}`).join('\n')}`;
}

async function processConversations(service, fetchJson, ctx, items, cfg, { progress } = {}) {
  const { convs } = await getState(); // 前回の状態の参照用。書き込みは mergeConvs で差分だけ
  let batch = [];
  let titles = [];
  let pending = {};
  let committed = 0;
  const errors = [];
  let failed = {}; // id → { id, title, updated }(retry に積む)
  let okIds = []; // retry から外す(保存できた/変化なし)

  const flush = async () => {
    if (batch.length) {
      const msg = commitMessage(service, titles);
      // 巡回の途中で設定画面からトークンを貼り直しても効くよう、コミットのたびに最新のトークンを読む
      const { token } = await getConfig();
      const res = await commitLock(() => commitFiles({ ...cfg, token }, batch, msg));
      if (!res.skipped) {
        committed += titles.length;
        await setStatus({ lastCommitAt: Date.now(), lastCommitMsg: msg.split('\n')[0] });
      }
    }
    await mergeConvs(pending);
    await updateRetry(service.name, failed, okIds);
    batch = [];
    titles = [];
    pending = {};
    failed = {};
    okIds = [];
  };

  // 一括取得(ChatGPT は最大10件/リクエスト)できるサービスは先読みしてキャッシュする。
  // 一括取得が使えなくなっていたら1件ずつの取得に戻す。
  const cache = new Map();
  let manyBroken = !service.fetchMany;
  const getConversation = async (i) => {
    const id = items[i].id;
    if (!cache.has(id) && !manyBroken) {
      const ids = items.slice(i, i + service.fetchManyLimit).map((it) => it.id);
      try {
        for (const conv of await service.fetchMany(fetchJson, ctx, ids)) cache.set(service.idOf(conv), conv);
        await sleep(FETCH_DELAY_MS);
      } catch (e) {
        if (e.status === 401 || e.status === 403 || e.status === 429) throw e;
        // 一時的な失敗(通信断・5xx)が再試行でも直らなかったときは、この10件だけ1件ずつ取る。
        // API が無くなった・形が変わった(4xx や応答の形の違い)ときだけ、以後ずっと1件ずつにする。
        const permanent = e.status >= 400 || e.status == null;
        if (permanent) manyBroken = true;
        await setStatus({
          lastError: `${service.label}: 一括取得に失敗したため${permanent ? '以後' : 'この10件は'}1件ずつ取得します: ${e.message}`,
          lastErrorAt: Date.now(),
        });
      }
    }
    if (cache.has(id)) {
      const conv = cache.get(id);
      cache.delete(id);
      return conv;
    }
    const conv = await service.fetchConversation(fetchJson, ctx, id);
    if (items.length > 1) await sleep(FETCH_DELAY_MS);
    return conv;
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = `${service.name}:${item.id}`;
    try {
      if (progress) await setProgress(service, `${service.label}: ${i + 1}/${items.length}`);
      const conv = await getConversation(i);
      const doc = service.render(conv, item.id);
      const path = buildPath(cfg.basePath, service.name, doc.created, doc.title, item.id);
      const hash = await sha256(doc.markdown);
      const updated = item.updated || doc.updated?.getTime() || Date.now();
      const prev = convs[key];
      okIds.push(item.id);
      if (prev && prev.hash === hash && prev.path === path) {
        pending[key] = { ...prev, updated };
        continue;
      }
      batch.push({ path, content: doc.markdown });
      if (cfg.saveRaw) batch.push({ path: rawPath(cfg.basePath, service.name, item.id), content: JSON.stringify(conv, null, 1) });
      // タイトルが変わるとファイル名も変わるので、古いファイルを消す
      if (prev?.path && prev.path !== path) batch.push({ path: prev.path, delete: true });
      titles.push(doc.title);
      pending[key] = { hash, path, updated };
    } catch (e) {
      errors.push(`${item.title || item.id}: ${e.message}`);
      // 認証切れ・再試行しても続く 429 は中断し、取得済みの分だけコミットして次回続きから再開する
      // (中断した会話は保存状態が古いままなので、次の一覧読みで変更ありとして拾われる)
      if (e.status === 401 || e.status === 403 || e.status === 429) {
        await flush();
        await setStatus({ lastError: errors.slice(-5).join('\n'), lastErrorAt: Date.now() });
        throw e;
      }
      failed[item.id] = { id: item.id, title: item.title || '', updated: item.updated || 0 };
    }
    // コミットの失敗は会話の失敗ではない。batch はそのまま残り、次の flush でまとめて再挑戦する
    if (titles.length >= BATCH) {
      try {
        await flush();
      } catch (e) {
        if (e.status === 401 || e.status === 403 || e.status === 404) throw e; // トークンや設定の問題は中断
        await setStatus({ lastError: `${service.label}: コミットに失敗、次でまとめて再試行します: ${e.message}`, lastErrorAt: Date.now() });
      }
    }
  }
  await flush();
  if (errors.length) await setStatus({ lastError: errors.slice(0, 5).join('\n'), lastErrorAt: Date.now() });
  return { committed, errors: errors.length };
}

async function sweepService(service, cfg, { full = false } = {}) {
  await setProgress(service, `${service.label}: 一覧を取得中`);
  const fetchJson = await makeFetcher(service);
  const ctx = await service.auth(fetchJson);
  const { convs, backfill } = await getState();
  const doneBackfill = backfill[service.name] === true;

  // 更新順に並んだ一覧を見て、前回から更新された会話だけを集める
  const changed = [];
  const isChanged = (item) => {
    const prev = convs[`${service.name}:${item.id}`];
    return full || !prev || prev.updated < item.updated;
  };
  let unchangedStreak = 0;
  let listed = 0;
  for await (const item of service.list(fetchJson, ctx)) {
    if (++listed % 500 === 0) await setProgress(service, `${service.label}: 一覧を取得中（${listed}件）`);
    if (!isChanged(item)) {
      unchangedStreak++;
      if (doneBackfill && unchangedStreak >= 20) break;
      continue;
    }
    unchangedStreak = 0;
    changed.push(item);
  }
  // アーカイブ済みなど、通常の一覧に出てこない会話(件数が少ないので毎回全部見る)
  if (service.listExtra) {
    for await (const item of service.listExtra(fetchJson, ctx)) if (isChanged(item)) changed.push(item);
  }
  changed.sort((a, b) => (a.updated || 0) - (b.updated || 0)); // 古い順にコミット

  // 前回までに失敗した会話は、一覧のどこにあっても最後にやり直す
  const seen = new Set(changed.map((it) => it.id));
  for (const item of await getRetry(service.name)) if (!seen.has(item.id)) changed.push(item);

  const res = await processConversations(service, fetchJson, ctx, changed, cfg, { progress: true });
  // 一覧を最後まで見て処理を中断しなければ初回取り込みは完了。個別の失敗は retry が次回拾う
  await markBackfilled(service.name);
  return { ...res, checked: changed.length };
}

async function sweepAll(opts = {}) {
  const cfg = await getConfig();
  if (!isConfigured(cfg)) return { error: 'GitHub の設定が未完了です' };
  return exclusive(async () => {
    const summary = {};
    await setStatus({ running: true, progress: '', progressBy: {} });
    // サービスごとにレート制限が別なので並行に進める(コミットは commitLock で直列)
    await Promise.all(
      enabledServices(cfg).map(async (service) => {
        try {
          summary[service.name] = await sweepService(service, cfg, opts);
        } catch (e) {
          summary[service.name] = { error: e.message, status: e.status };
          await setStatus({ lastError: `${service.label}: ${e.message}`, lastErrorAt: Date.now() });
        }
        await setProgress(service, '');
      }),
    );
    const throttled = Object.values(summary).some((r) => r?.status === 429 || r?.status === 0);
    if (throttled) chrome.alarms.create(RESUME_ALARM, { delayInMinutes: RESUME_AFTER_MIN });
    await setStatus({
      running: false,
      progress: throttled ? `混雑か通信エラーのため中断。${RESUME_AFTER_MIN}分後に自動で再開します` : '',
      progressBy: {},
      lastSweepAt: Date.now(),
      lastSweep: summary,
    });
    return summary;
  });
}

/* ---------- 返信完了ごとの即時コミット ---------- */

const timers = new Map();
function scheduleOne(serviceName, id, tabId) {
  const key = `${serviceName}:${id}`;
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      syncOne(serviceName, id, tabId).catch(async (e) => {
        await setStatus({ lastError: `${serviceName}: ${e.message}`, lastErrorAt: Date.now() });
      });
    }, 1500),
  );
}

async function syncOne(serviceName, id, tabId) {
  const cfg = await getConfig();
  const service = SERVICES[serviceName];
  if (!service || !isConfigured(cfg) || !cfg.commitEachTurn) return;
  if (!enabledServices(cfg).includes(service)) return;
  return exclusive(async () => {
    const fetchJson = await makeFetcher(service, tabId);
    const ctx = await service.auth(fetchJson);
    return processConversations(service, fetchJson, ctx, [{ id }], cfg);
  });
}

/* ---------- イベント ---------- */

async function setupAlarm() {
  const cfg = await getConfig();
  await chrome.alarms.clear(ALARM);
  if (cfg.intervalMin > 0) {
    chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, Number(cfg.intervalMin)), delayInMinutes: 1 });
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await setupAlarm();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(setupAlarm);
// Service Worker が止まると実行中の巡回も消えるので、起動時に「実行中」のまま残った表示を戻す
storageLock(async () => {
  const { status = {} } = await chrome.storage.local.get('status');
  if (status.running) {
    await chrome.storage.local.set({ status: { ...status, running: false, progress: '', progressBy: {} } });
  }
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM || a.name === RESUME_ALARM) sweepAll();
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener((changes) => {
  if (changes.config) setupAlarm();
});

// 返信の完了は、ページの fetch ではなく拡張側の webRequest で見張る。
// ページ(や他の拡張)が window.fetch を差し替えても取りこぼさず、ページにスクリプトも入れない。
chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (d.method !== 'POST' || d.tabId < 0) return;
    const hit = detectTurn(d.url);
    if (!hit) return;
    const run = async () => {
      let id = hit.id;
      if (!id) {
        const tab = await chrome.tabs.get(d.tabId).catch(() => null);
        id = idFromPageUrl(hit.service, tab?.url);
      }
      if (id) scheduleOne(hit.service, id, d.tabId);
    };
    setTimeout(run, 3000); // 返信の保存を待ってから
    setTimeout(run, 25000); // 新規チャットのタイトル自動生成を拾う
  },
  { urls: ['https://chatgpt.com/*', 'https://claude.ai/*', 'https://grok.com/*'] },
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'sweep') {
    sweepAll({ full: !!msg.full }).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg?.type === 'test') {
    getConfig()
      .then((cfg) => testConnection(cfg))
      .then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg?.type === 'reset-state') {
    chrome.storage.local.remove(['convs', 'backfill', 'status', 'retry']).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
