// 各サービスの内部API(ブラウザでログイン中のセッションを利用)へのアダプタ。
// fetchJson(url, headers) は background.js から渡される(タブ内 or 拡張から実行)。
// ※ 非公開APIなので、サービス側の仕様変更で動かなくなる可能性があります。

import { toDate, chatgptToMarkdown, claudeToMarkdown, grokToMarkdown } from './convert.js';

export const chatgpt = {
  name: 'chatgpt',
  label: 'ChatGPT',
  tabPattern: 'https://chatgpt.com/*',

  async auth(fetchJson) {
    const s = await fetchJson('https://chatgpt.com/api/auth/session');
    if (!s?.accessToken) throw new Error('ChatGPT にログインしていません（chatgpt.com を開いてログインしてください）');
    return { headers: { Authorization: `Bearer ${s.accessToken}` } };
  },

  // 更新が新しい順に { id, title, updated(ms) } を返す(プロジェクト内の会話も含まれる)
  list(fetchJson, ctx) {
    return chatgptList(fetchJson, ctx, '');
  },

  // アーカイブ済みの会話は通常の一覧に出てこないので別に読む
  listExtra(fetchJson, ctx) {
    return chatgptList(fetchJson, ctx, '&is_archived=true');
  },

  fetchConversation(fetchJson, ctx, id) {
    return fetchJson(`https://chatgpt.com/backend-api/conversation/${id}`, ctx.headers);
  },

  // 1件ずつの取得は 1分に1件ほどしか通らない(429)が、一括取得は最大10件まとめて返る。
  // 返る形は1件取得と同じ(ただし default_model_slug は含まれない)。
  fetchManyLimit: 10,
  async fetchMany(fetchJson, ctx, ids) {
    const r = await fetchJson('https://chatgpt.com/backend-api/conversations/batch', ctx.headers, {
      conversation_ids: ids,
    });
    if (!Array.isArray(r)) throw new Error('一括取得の応答が配列ではありません');
    return r;
  },
  idOf: (conv) => conv.id || conv.conversation_id,

  render(conv, id) {
    return chatgptToMarkdown(conv, { id, url: `https://chatgpt.com/c/${id}` });
  },
};

async function* chatgptList(fetchJson, ctx, extraQuery) {
  const limit = 100; // API の上限(これ以上は 422)
  let offset = 0;
  const seen = new Set();
  for (;;) {
    const r = await fetchJson(
      `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated${extraQuery}`,
      ctx.headers,
    );
    const items = r?.items || [];
    let fresh = 0;
    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      fresh++;
      yield { id: it.id, title: it.title, updated: toDate(it.update_time)?.getTime() ?? 0 };
    }
    if (items.length < limit || fresh === 0) break;
    offset += items.length;
    if (r.total != null && offset >= r.total) break;
  }
}

export const claude = {
  name: 'claude',
  label: 'Claude',
  tabPattern: 'https://claude.ai/*',

  async auth(fetchJson) {
    const orgs = await fetchJson('https://claude.ai/api/organizations');
    if (!Array.isArray(orgs) || !orgs.length) {
      throw new Error('Claude にログインしていません（claude.ai を開いてログインしてください）');
    }
    const org = orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0];
    return { headers: {}, org: org.uuid };
  },

  async *list(fetchJson, ctx) {
    const limit = 50;
    let offset = 0;
    const seen = new Set();
    for (;;) {
      const r = await fetchJson(
        `https://claude.ai/api/organizations/${ctx.org}/chat_conversations?limit=${limit}&offset=${offset}`,
        ctx.headers,
      );
      const items = Array.isArray(r) ? r : r?.data || r?.items || [];
      let fresh = 0;
      for (const it of items) {
        if (seen.has(it.uuid)) continue;
        seen.add(it.uuid);
        fresh++;
        yield { id: it.uuid, title: it.name, updated: toDate(it.updated_at)?.getTime() ?? 0 };
      }
      // ページングが効かず全件返ってきた場合も fresh===0 で止まる
      if (items.length < limit || fresh === 0) break;
      offset += items.length;
    }
  },

  fetchConversation(fetchJson, ctx, id) {
    return fetchJson(
      `https://claude.ai/api/organizations/${ctx.org}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`,
      ctx.headers,
    );
  },

  render(conv, id) {
    return claudeToMarkdown(conv, { id, url: `https://claude.ai/chat/${id}` });
  },
};

const GROK = 'https://grok.com/rest/app-chat';

export const grok = {
  name: 'grok',
  label: 'Grok',
  tabPattern: 'https://grok.com/*',

  // ログイン中の Cookie だけで動く(トークン不要)。未ログインなら一覧が 401/403 になる
  async auth(fetchJson) {
    try {
      await fetchJson(`${GROK}/conversations?pageSize=1`);
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        throw Object.assign(new Error('Grok にログインしていません（grok.com を開いてログインしてください）'), { status: e.status });
      }
      throw e;
    }
    return { headers: {} };
  },

  // 更新が新しい順。続きは nextPageToken で取る
  async *list(fetchJson, ctx) {
    let token = '';
    const seen = new Set();
    for (;;) {
      const r = await fetchJson(
        `${GROK}/conversations?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
        ctx.headers,
      );
      for (const c of r?.conversations || []) {
        if (c.temporary || seen.has(c.conversationId)) continue;
        seen.add(c.conversationId);
        yield { id: c.conversationId, title: c.title, updated: toDate(c.modifyTime)?.getTime() ?? 0 };
      }
      token = r?.nextPageToken;
      if (!token) break;
    }
  },

  // タイトル等 → 発言の木(response-node) → 発言の本文(load-responses)の3回で1会話
  async fetchConversation(fetchJson, ctx, id) {
    const meta = await fetchJson(`${GROK}/conversations_v2/${id}`, ctx.headers);
    const tree = await fetchJson(`${GROK}/conversations/${id}/response-node`, ctx.headers);
    const responseNodes = tree?.responseNodes || [];
    const loaded = responseNodes.length
      ? await fetchJson(`${GROK}/conversations/${id}/load-responses`, ctx.headers, {
          responseIds: responseNodes.map((n) => n.responseId),
        })
      : { responses: [] };
    return { conversation: meta?.conversation || {}, responseNodes, responses: loaded?.responses || [] };
  },

  render(data, id) {
    return grokToMarkdown(data, { id, url: `https://grok.com/c/${id}` });
  },
};

export const SERVICES = { chatgpt, claude, grok };
