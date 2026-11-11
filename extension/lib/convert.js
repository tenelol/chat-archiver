// 会話データ(ChatGPT / Claude の内部APIレスポンス)を Markdown に変換する。
// 依存なし。Node からも import してテストできる。

export function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  if (/^\d+(\.\d+)?$/.test(String(v))) return toDate(Number(v));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n) => String(n).padStart(2, '0');

export function localDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localDateTime(d) {
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// タイムゾーン付き ISO 文字列 (例: 2026-11-09T21:47:00+09:00)
export function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function slugify(title) {
  const s = String(title || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#%{}^~[\]`'\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return Array.from(s).slice(0, 50).join('') || 'untitled';
}

// 例: 2026/11/2026-11-09_1403_chatgpt_旅行の計画_6730a1b2.md
// サービスでフォルダを分けず、開始日時順に並ぶようにする(どのサービスかはファイル名と front matter で分かる)
export function buildPath(basePath, service, created, title, id) {
  const d = created || new Date();
  const base = basePath ? basePath.replace(/^\/+|\/+$/g, '') + '/' : '';
  const shortId = String(id).replace(/-/g, '').slice(0, 8);
  const hhmm = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${base}${d.getFullYear()}/${pad(d.getMonth() + 1)}/${localDate(d)}_${hhmm}_${service}_${slugify(title)}_${shortId}.md`;
}

export function rawPath(basePath, service, id) {
  const base = basePath ? basePath.replace(/^\/+|\/+$/g, '') + '/' : '';
  return `${base}${service}/_raw/${id}.json`;
}

export function codeBlock(text, lang = '') {
  const t = String(text ?? '');
  const longest = Math.max(2, ...(t.match(/`+/g) || []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang || ''}\n${t}\n${fence}`;
}

export function details(summary, body) {
  const b = String(body ?? '').trim();
  if (!b) return '';
  const s = String(summary).replace(/[<>]/g, '');
  return `<details>\n<summary>${s}</summary>\n\n${b}\n\n</details>`;
}

function frontMatter(obj) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue;
    lines.push(`${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

// turns: [{ speaker: 'user'|'assistant', time: Date|null, body }]
function assemble({ service, id, url, title, created, updated, model, assistantLabel, turns }) {
  const out = [
    frontMatter({
      title,
      service,
      id,
      url,
      model,
      created: created ? isoLocal(created) : null,
      updated: updated ? isoLocal(updated) : null,
    }),
    '',
    `# ${title}`,
    '',
  ];
  let last = null;
  for (const t of turns) {
    if (!t.body || !t.body.trim()) continue;
    if (t.speaker !== last) {
      const label = t.speaker === 'user' ? '🧑 ユーザー' : `🤖 ${assistantLabel}`;
      out.push(`## ${label}${t.time ? ` <sub>${localDateTime(t.time)}</sub>` : ''}`, '');
      last = t.speaker;
    }
    out.push(t.body.trim(), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/* ---------------- ChatGPT ---------------- */

function chatgptContent(m) {
  const c = m.content || {};
  const strParts = () => (c.parts || []).filter((p) => typeof p === 'string').join('\n\n');
  switch (c.content_type) {
    case 'text':
      return strParts();
    case 'multimodal_text':
      return (c.parts || [])
        .map((p) => {
          if (typeof p === 'string') return p;
          if (p?.content_type === 'image_asset_pointer') return '*[画像]*';
          if (p?.content_type === 'audio_transcription') return p.text || '';
          if (p?.content_type === 'audio_asset_pointer') return '';
          return p?.text || '';
        })
        .filter(Boolean)
        .join('\n\n');
    case 'code':
      return codeBlock(c.text, c.language === 'unknown' ? '' : c.language);
    case 'execution_output':
      return details('実行結果', codeBlock(c.text));
    case 'thoughts':
      return details(
        '思考',
        (c.thoughts || [])
          .map((t) => [t.summary && `**${t.summary}**`, t.content].filter(Boolean).join('\n\n'))
          .join('\n\n'),
      );
    case 'reasoning_recap':
      return c.content ? `*${c.content}*` : '';
    case 'tether_quote':
      return details(`引用: ${c.title || c.url || ''}`, c.text);
    case 'tether_browsing_display':
      return details('ブラウズ結果', c.result);
    case 'user_editable_context':
    case 'model_editable_context':
      return '';
    default:
      return c.text || strParts() || '';
  }
}

export function chatgptToMarkdown(conv, { id, url } = {}) {
  const mapping = conv.mapping || {};
  let chain = [];
  if (conv.current_node && mapping[conv.current_node]) {
    // 現在表示中のブランチ(編集・再生成後の最終形)だけを辿る
    const seen = new Set();
    let nid = conv.current_node;
    while (nid && mapping[nid] && !seen.has(nid)) {
      seen.add(nid);
      chain.push(mapping[nid]);
      nid = mapping[nid].parent;
    }
    chain.reverse();
  } else {
    chain = Object.values(mapping).sort(
      (a, b) => (toDate(a.message?.create_time)?.getTime() ?? 0) - (toDate(b.message?.create_time)?.getTime() ?? 0),
    );
  }

  const turns = [];
  for (const node of chain) {
    const m = node.message;
    if (!m) continue;
    const role = m.author?.role;
    if (role === 'system') continue;
    if (m.metadata?.is_visually_hidden_from_conversation) continue;
    let body = chatgptContent(m);
    if (!body.trim()) continue;
    if (role === 'tool') {
      if (!body.startsWith('<details>')) body = details(`ツール: ${m.author?.name || 'tool'}`, body);
    } else if (role === 'assistant' && m.recipient && m.recipient !== 'all') {
      if (!body.startsWith('<details>')) body = details(`ツール呼び出し: ${m.recipient}`, body);
    }
    turns.push({ speaker: role === 'user' ? 'user' : 'assistant', time: toDate(m.create_time), body });
  }

  const title = conv.title || 'Untitled';
  const created = toDate(conv.create_time);
  const updated = toDate(conv.update_time);
  // 一括取得の応答には default_model_slug がないので、最後の回答のモデルで補う
  const model =
    conv.default_model_slug ||
    chain.findLast((n) => n.message?.author?.role === 'assistant' && n.message.metadata?.model_slug)?.message.metadata
      .model_slug ||
    null;
  const cid = id || conv.conversation_id || conv.id;
  return {
    title,
    created,
    updated,
    markdown: assemble({
      service: 'chatgpt',
      id: cid,
      url: url || `https://chatgpt.com/c/${cid}`,
      title,
      created,
      updated,
      model,
      assistantLabel: 'ChatGPT',
      turns,
    }),
  };
}

/* ---------------- Claude (claude.ai) ---------------- */

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : c?.type === 'image' ? '*[画像]*' : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return content == null ? '' : JSON.stringify(content, null, 2);
}

function claudeContent(m) {
  const parts = [];
  for (const a of m.attachments || []) {
    if (a.extracted_content) parts.push(details(`📎 ${a.file_name || '添付テキスト'}`, codeBlock(a.extracted_content)));
    else if (a.file_name) parts.push(`📎 ${a.file_name}`);
  }
  const files = [...(m.files || []), ...(m.files_v2 || [])];
  const seenFiles = new Set();
  for (const f of files) {
    if (!f?.file_name || seenFiles.has(f.file_name)) continue;
    seenFiles.add(f.file_name);
    parts.push(`📎 ${f.file_name}`);
  }

  if (Array.isArray(m.content) && m.content.length) {
    for (const c of m.content) {
      if (c.type === 'text') parts.push(c.text || '');
      else if (c.type === 'thinking') parts.push(details('思考', c.thinking));
      else if (c.type === 'tool_use') parts.push(details(`ツール: ${c.name}`, codeBlock(JSON.stringify(c.input ?? {}, null, 2), 'json')));
      else if (c.type === 'tool_result') parts.push(details(`ツール結果${c.name ? `: ${c.name}` : ''}`, toolResultText(c.content)));
      else if (c.type === 'image') parts.push('*[画像]*');
    }
  } else if (m.text) {
    parts.push(m.text);
  }
  return parts.filter((p) => p && p.trim()).join('\n\n');
}

export function claudeToMarkdown(conv, { id, url } = {}) {
  const msgs = conv.chat_messages || [];
  const byId = new Map(msgs.map((m) => [m.uuid, m]));
  let chain;
  const leaf = conv.current_leaf_message_uuid;
  if (leaf && byId.has(leaf)) {
    // tree=True で取得すると全ブランチが来るので、表示中のブランチだけを辿る
    chain = [];
    const seen = new Set();
    let mid = leaf;
    while (mid && byId.has(mid) && !seen.has(mid)) {
      seen.add(mid);
      const m = byId.get(mid);
      chain.push(m);
      mid = m.parent_message_uuid;
    }
    chain.reverse();
  } else {
    chain = [...msgs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }

  const turns = chain.map((m) => ({
    speaker: m.sender === 'human' ? 'user' : 'assistant',
    time: toDate(m.created_at),
    body: claudeContent(m),
  }));

  const title = conv.name || 'Untitled';
  const created = toDate(conv.created_at);
  const updated = toDate(conv.updated_at);
  const cid = id || conv.uuid;
  return {
    title,
    created,
    updated,
    markdown: assemble({
      service: 'claude',
      id: cid,
      url: url || `https://claude.ai/chat/${cid}`,
      title,
      created,
      updated,
      model: conv.model || null,
      assistantLabel: 'Claude',
      turns,
    }),
  };
}

/* ---------------- Grok (grok.com) ---------------- */

// 思考や本文に埋め込まれるツール呼び出しの XML を「🔧 ツール名: 引数」の1行にする
function grokToolCards(text) {
  return String(text || '').replace(/<xai:tool_usage_card>[\s\S]*?<\/xai:tool_usage_card>/g, (card) => {
    const name = card.match(/<xai:tool_name>([\s\S]*?)<\/xai:tool_name>/)?.[1]?.trim() || 'tool';
    const raw = card.match(/<xai:tool_args>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/xai:tool_args>/)?.[1]?.trim() || '';
    let args = raw;
    try {
      const j = JSON.parse(raw);
      args = JSON.stringify(j?.args ?? j);
    } catch {
      /* JSON でなければそのまま */
    }
    return `🔧 ${name}${args ? `: ${args}` : ''}`;
  });
}

function grokContent(r) {
  const parts = [];
  const files = r.fileAttachmentsMetadata || [];
  for (const f of files) parts.push(`📎 ${f?.fileName || f?.name || '添付ファイル'}`);
  if (!files.length && (r.fileAttachments || []).length) parts.push(`📎 添付ファイル ${r.fileAttachments.length}件`);
  if ((r.imageAttachments || []).length) parts.push('*[画像]*');
  if (r.sender !== 'human') {
    // steps は思考の過程(各ステップの text が文字列の配列)
    const thinking = (r.steps || [])
      .map((s) => grokToolCards((s?.text || []).join('\n')))
      .filter((t) => t.trim())
      .join('\n\n');
    parts.push(details('思考', thinking));
  }
  parts.push(grokToolCards(r.message || r.query || ''));
  if ((r.generatedImageUrls || []).length) parts.push('*[画像]*');
  const web = (r.webSearchResults || []).filter((w) => w?.url);
  if (web.length) {
    parts.push(details(`参照 ${web.length}件`, web.map((w) => `- [${String(w.title || w.url).replace(/[[\]]/g, '')}](${w.url})`).join('\n')));
  }
  return parts.filter((p) => p && p.trim()).join('\n\n');
}

// data: { conversation, responseNodes, responses }(sources.js の grok.fetchConversation が組み立てる)
export function grokToMarkdown(data, { id, url } = {}) {
  const conv = data.conversation || {};
  const nodes = data.responseNodes || [];
  const byId = new Map((data.responses || []).map((r) => [r.responseId, r]));
  const parentOf = new Map(nodes.map((n) => [n.responseId, n.parentResponseId]));
  // 編集・再生成で枝分かれしていたら、いちばん新しい末端(子のないノード)から親へたどる
  const hasChild = new Set(nodes.map((n) => n.parentResponseId));
  const time = (rid) => toDate(byId.get(rid)?.createTime)?.getTime() ?? 0;
  const leaf = nodes
    .map((n) => n.responseId)
    .filter((rid) => !hasChild.has(rid))
    .sort((a, b) => time(b) - time(a))[0];
  const chain = [];
  const seen = new Set();
  for (let rid = leaf; rid && byId.has(rid) && !seen.has(rid); rid = parentOf.get(rid)) {
    seen.add(rid);
    chain.push(byId.get(rid));
  }
  chain.reverse();

  const turns = chain.map((r) => ({
    speaker: r.sender === 'human' ? 'user' : 'assistant',
    time: toDate(r.createTime),
    body: grokContent(r),
  }));
  const last = chain.findLast((r) => r.sender !== 'human');
  const model = last?.model || last?.metadata?.request_metadata?.model || null;
  const title = conv.title || 'Untitled';
  const created = toDate(conv.createTime);
  const updated = toDate(conv.modifyTime);
  const cid = id || conv.conversationId;
  return {
    title,
    created,
    updated,
    markdown: assemble({
      service: 'grok',
      id: cid,
      url: url || `https://grok.com/c/${cid}`,
      title,
      created,
      updated,
      model,
      assistantLabel: 'Grok',
      turns,
    }),
  };
}
