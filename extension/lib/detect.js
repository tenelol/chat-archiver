// 返信を生成するリクエスト(POST)の URL から、どのサービスのどの会話かを判定する。
// background.js が webRequest で完了を見張るときに使う。
// 新規チャットは URL に会話 ID がないので id: null を返し、完了後にタブの URL から取る。

const RULES = [
  // ChatGPT: 送信は /backend-api/f/conversation、途切れた続きは …/resume
  { service: 'chatgpt', re: /^https:\/\/chatgpt\.com\/backend-api\/(?:f\/)?conversation(?:\/resume)?(?:\?|$)/ },
  { service: 'claude', re: /^https:\/\/claude\.ai\/api\/organizations\/[^/]+\/chat_conversations\/([0-9a-f-]{36})\/(?:completion|retry_completion)(?:\?|$)/ },
  // Grok: 新規チャットは …/conversations/new、続きは …/conversations/<id>/responses
  { service: 'grok', re: /^https:\/\/grok\.com\/rest\/app-chat\/conversations\/(?:new|([0-9a-f-]{36})\/responses)(?:\?|$)/ },
];

export function detectTurn(url) {
  for (const { service, re } of RULES) {
    const m = String(url).match(re);
    if (m) return { service, id: m[1] || null };
  }
  return null;
}

// 会話ページの URL(ChatGPT・Grok は /c/<id>、プロジェクト内も含む。Claude は /chat/<id>)から会話 ID を取る
const PAGE_ID_RE = {
  chatgpt: /\/c\/([0-9A-Za-z-]+)/,
  claude: /\/chat\/([0-9a-f-]{36})/,
  grok: /\/c\/([0-9a-f-]{36})/,
};

export function idFromPageUrl(service, url) {
  try {
    return new URL(url).pathname.match(PAGE_ID_RE[service])?.[1] || null;
  } catch {
    return null;
  }
}
