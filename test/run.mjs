// node test/run.mjs  — 変換処理と GitHub コミット処理をモックで確認する
import assert from 'node:assert/strict';
import { chatgptToMarkdown, claudeToMarkdown, grokToMarkdown, buildPath, slugify } from '../extension/lib/convert.js';
import { commitFiles } from '../extension/lib/github.js';

process.env.TZ = 'Asia/Tokyo';

/* ---- ChatGPT: 編集で分岐した会話。current_node のブランチだけが出ること ---- */
const gpt = {
  title: '京都旅行の計画',
  create_time: 1794228000.12,
  update_time: '2026-11-09T12:40:00Z',
  default_model_slug: 'gpt-5',
  current_node: 'a2',
  mapping: {
    root: { id: 'root', message: null, parent: null, children: ['sys'] },
    sys: { id: 'sys', parent: 'root', message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] } } },
    u1old: { id: 'u1old', parent: 'sys', message: { author: { role: 'user' }, create_time: 1794228001, content: { content_type: 'text', parts: ['古い質問'] } } },
    u1: { id: 'u1', parent: 'sys', message: { author: { role: 'user' }, create_time: 1794228002, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer' }, '紅葉の時期は？'] } } },
    th: { id: 'th', parent: 'u1', message: { author: { role: 'assistant' }, create_time: 1794228003, content: { content_type: 'thoughts', thoughts: [{ summary: '時期を考える', content: '11月中旬〜下旬' }] } } },
    tc: { id: 'tc', parent: 'th', message: { author: { role: 'assistant' }, recipient: 'python', create_time: 1794228004, content: { content_type: 'code', language: 'python', text: 'print("```")' } } },
    to: { id: 'to', parent: 'tc', message: { author: { role: 'tool', name: 'python' }, create_time: 1794228005, content: { content_type: 'execution_output', text: '```' } } },
    a2: { id: 'a2', parent: 'to', message: { author: { role: 'assistant' }, create_time: 1794228006, content: { content_type: 'text', parts: ['**11月下旬**がおすすめです。'] } } },
  },
};
const g = chatgptToMarkdown(gpt, { id: '6730a1b2-aaaa-bbbb' });
console.log('----- ChatGPT -----\n' + g.markdown);
assert.ok(!g.markdown.includes('古い質問'), '別ブランチは含めない');
assert.ok(g.markdown.includes('紅葉の時期は？') && g.markdown.includes('*[画像]*'));
assert.ok(g.markdown.includes('<summary>思考</summary>'));
assert.ok(g.markdown.includes('ツール呼び出し: python'));
assert.ok(g.markdown.includes('````python'), 'バッククォートを含むコードはフェンスを伸ばす');
assert.equal((g.markdown.match(/## 🤖 ChatGPT/g) || []).length, 1, '連続するassistantは1見出し');
assert.ok(g.markdown.includes('created: "2026-11-09T21:40:00+09:00"'));

/* ---- Claude: tree=True の全ブランチから current_leaf を辿る ---- */
const root = '00000000-0000-4000-8000-000000000000';
const cl = {
  uuid: '11111111-2222-3333-4444-555555555555',
  name: 'ピアノの選び方',
  model: 'claude-opus-5-5',
  created_at: '2026-11-09T12:00:00.000000Z',
  updated_at: '2026-11-09T12:05:00.000000Z',
  current_leaf_message_uuid: 'm4',
  chat_messages: [
    { uuid: 'm1', parent_message_uuid: root, sender: 'human', created_at: '2026-11-09T12:00:00Z', content: [{ type: 'text', text: '電子ピアノとアップライト、どっち？' }], attachments: [{ file_name: 'memo.txt', extracted_content: '予算30万' }], files: [] },
    { uuid: 'm2', parent_message_uuid: 'm1', sender: 'assistant', created_at: '2026-11-09T12:01:00Z', content: [{ type: 'text', text: '没になった回答' }] },
    { uuid: 'm3', parent_message_uuid: 'm1', sender: 'assistant', created_at: '2026-11-09T12:02:00Z', content: [{ type: 'thinking', thinking: '住環境を考慮' }, { type: 'tool_use', name: 'web_search', input: { query: '電子ピアノ おすすめ' } }, { type: 'tool_result', name: 'web_search', content: [{ type: 'text', text: '検索結果' }] }, { type: 'text', text: '住環境次第です。' }] },
    { uuid: 'm4', parent_message_uuid: 'm3', sender: 'human', created_at: '2026-11-09T12:05:00Z', content: [], text: 'マンションです', files_v2: [{ file_name: 'room.jpg' }] },
  ],
};
const c = claudeToMarkdown(cl);
console.log('----- Claude -----\n' + c.markdown);
assert.ok(!c.markdown.includes('没になった回答'));
assert.ok(c.markdown.includes('📎 memo.txt') && c.markdown.includes('予算30万'));
assert.ok(c.markdown.includes('ツール: web_search') && c.markdown.includes('住環境次第です。'));
assert.ok(c.markdown.includes('マンションです') && c.markdown.includes('📎 room.jpg'));
assert.ok(c.markdown.includes('url: "https://claude.ai/chat/11111111-2222-3333-4444-555555555555"'));

/* ---- Grok: 発言の木から、いちばん新しい末端のブランチだけを辿る ---- */
const gk = grokToMarkdown({
  conversation: { conversationId: 'aaaaaaaa-0000-4000-8000-000000000000', title: '旅行の持ち物', createTime: '2026-11-10T02:24:00.000Z', modifyTime: '2026-11-10T02:30:00.000Z' },
  responseNodes: [
    { responseId: 'r1', parentResponseId: 'root', sender: 'human' },
    { responseId: 'r2old', parentResponseId: 'r1', sender: 'assistant' },
    { responseId: 'r2', parentResponseId: 'r1', sender: 'assistant' },
  ],
  responses: [
    { responseId: 'r1', sender: 'human', message: '京都に何を持っていく？', createTime: '2026-11-10T02:24:00.000Z', steps: [], webSearchResults: [] },
    { responseId: 'r2old', sender: 'assistant', message: '没になった回答', createTime: '2026-11-10T02:25:00.000Z', steps: [], webSearchResults: [] },
    { responseId: 'r2', sender: 'assistant', model: 'grok-3', message: '**雨具**を忘れずに。', createTime: '2026-11-10T02:26:00.000Z',
      steps: [{ text: ['天気を調べる'] }, { text: [''] }, { text: ['<xai:tool_usage_card>\n  <xai:tool_usage_card_id>x</xai:tool_usage_card_id>\n  <xai:tool_name>WebSearch</xai:tool_name>\n  <xai:tool_args><![CDATA[{"args":{"query":"京都 天気"}}]]></xai:tool_args>\n</xai:tool_usage_card>'] }], webSearchResults: [{ title: '京都の天気 [週間]', url: 'https://example.com/w', preview: '…' }] },
  ],
}, { id: 'aaaaaaaa-0000-4000-8000-000000000000' });
console.log('----- Grok -----\n' + gk.markdown);
assert.ok(!gk.markdown.includes('没になった回答'), '古いブランチは含めない');
assert.ok(gk.markdown.includes('## 🤖 Grok') && gk.markdown.includes('**雨具**を忘れずに。'));
assert.ok(gk.markdown.includes('<summary>思考</summary>') && gk.markdown.includes('天気を調べる'));
assert.ok(gk.markdown.includes('🔧 WebSearch: {"query":"京都 天気"}') && !gk.markdown.includes('<xai:'), 'ツール呼び出しの XML は1行にする');
assert.ok(gk.markdown.includes('<summary>参照 1件</summary>') && gk.markdown.includes('- [京都の天気 週間](https://example.com/w)'));
assert.ok(gk.markdown.includes('model: "grok-3"') && gk.markdown.includes('url: "https://grok.com/c/aaaaaaaa-0000-4000-8000-000000000000"'));
assert.equal(buildPath('chat-history', 'grok', gk.created, gk.title, 'aaaaaaaa-0000'), 'chat-history/2026/11/2026-11-10_1124_grok_旅行の持ち物_aaaaaaaa.md');

/* ---- 返信完了の検知(webRequest で見る URL)と、ページ URL からの会話 ID ---- */
const { detectTurn, idFromPageUrl } = await import('../extension/lib/detect.js');
assert.deepEqual(detectTurn('https://chatgpt.com/backend-api/f/conversation'), { service: 'chatgpt', id: null });
assert.deepEqual(detectTurn('https://chatgpt.com/backend-api/f/conversation/resume'), { service: 'chatgpt', id: null });
assert.equal(detectTurn('https://chatgpt.com/backend-api/conversation/abc'), null, '会話の読み込みは対象外');
assert.deepEqual(detectTurn('https://claude.ai/api/organizations/o-1/chat_conversations/11111111-2222-3333-4444-555555555555/completion'), { service: 'claude', id: '11111111-2222-3333-4444-555555555555' });
assert.deepEqual(detectTurn('https://grok.com/rest/app-chat/conversations/new'), { service: 'grok', id: null });
assert.deepEqual(detectTurn('https://grok.com/rest/app-chat/conversations/138462d3-8e43-4f8d-a1d7-3079605b1124/responses'), { service: 'grok', id: '138462d3-8e43-4f8d-a1d7-3079605b1124' });
assert.equal(detectTurn('https://grok.com/rest/app-chat/conversations/138462d3-8e43-4f8d-a1d7-3079605b1124/load-responses'), null);
assert.equal(idFromPageUrl('chatgpt', 'https://chatgpt.com/g/g-p-abc/c/6af65375-0000-8000-9000-000000000000'), '6af65375-0000-8000-9000-000000000000');
assert.equal(idFromPageUrl('claude', 'https://claude.ai/chat/11111111-2222-3333-4444-555555555555'), '11111111-2222-3333-4444-555555555555');
assert.equal(idFromPageUrl('grok', 'https://grok.com/'), null);

/* ---- パス ---- */
const p = buildPath('', 'claude', c.created, c.title, cl.uuid);
console.log(p);
assert.equal(p, '2026/11/2026-11-09_2100_claude_ピアノの選び方_11111111.md');
assert.equal(buildPath('archive/', 'chatgpt', new Date('2026-01-02T00:00:00+09:00'), 'a/b: c?', 'abc'), 'archive/2026/01/2026-01-02_0000_chatgpt_ab-c_abc.md');
assert.equal(slugify(''), 'untitled');

/* ---- GitHub: モックfetchで 1コミット作成・競合リトライ・削除失敗時のリトライ ---- */
const calls = [];
let refPatchFails = 1;
let treeFailOnDelete = true;
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  assert.equal(opts.cache, 'no-store', 'ブラウザの HTTP キャッシュで古い ref を読まない');
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push(`${method} ${url.replace('https://api.github.com/repos/me/archive', '')}`);
  const json = (status, j) => ({ ok: status < 300, status, text: async () => JSON.stringify(j) });
  if (url.endsWith('/git/ref/heads/main')) return json(200, { object: { sha: 'head1' } });
  if (url.endsWith('/git/commits/head1')) return json(200, { tree: { sha: 'tree0' } });
  if (url.endsWith('/git/trees')) {
    if (treeFailOnDelete && body.tree.some((t) => t.sha === null)) {
      treeFailOnDelete = false;
      return json(422, { message: 'tree.sha null is not a valid blob' });
    }
    assert.equal(body.base_tree, 'tree0');
    return json(201, { sha: 'tree1' });
  }
  if (url.endsWith('/git/commits')) return json(201, { sha: 'commit1' });
  if (url.endsWith('/git/refs/heads/main')) {
    if (refPatchFails-- > 0) return json(422, { message: 'Update is not a fast forward' });
    return json(200, {});
  }
  return json(404, { message: 'not found' });
};
const res = await commitFiles(
  { token: 't', owner: 'me', repo: 'archive', branch: 'main' },
  [{ path: 'a.md', content: 'あ' }, { path: 'old.md', delete: true }],
  'msg',
);
console.log(calls.join('\n'));
assert.equal(res.sha, 'commit1');

console.log('\n✅ all JS tests passed');
