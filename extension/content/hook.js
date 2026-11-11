// ページ本体(MAIN world)で fetch をフックし、「返信のストリーミングが終わった」瞬間を検知する。
// 会話内容はここでは読まず、完了の合図だけを bridge.js に送る。
(() => {
  if (window.__chatArchiverHooked) return;
  window.__chatArchiverHooked = true;

  const CHATGPT_RE = /\/backend-api\/(?:f\/)?conversation(?:\?|$)/;
  const CLAUDE_RE = /\/api\/organizations\/[^/]+\/chat_conversations\/([0-9a-f-]{36})\/(?:completion|retry_completion)/;
  // Grok: 新規チャットは …/conversations/new、続きは …/conversations/<id>/responses
  const GROK_RE = /\/rest\/app-chat\/conversations\/(?:new|([0-9a-f-]{36})\/responses)(?:\?|$)/;

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req?.url || '';
      const method = String(args[1]?.method || (req instanceof Request ? req.method : 'GET')).toUpperCase();
      if (method !== 'POST') return res;

      let id = null;
      let hit = false;
      const m = url.match(CLAUDE_RE) || url.match(GROK_RE);
      if (m) {
        hit = true;
        id = m[1] || null; // Grok の新規チャットは完了後に URL(/c/<id>) から取る
      } else if (CHATGPT_RE.test(url)) {
        hit = true; // ChatGPT は新規チャットだと完了後に URL(/c/<id>) から取る
      }
      if (hit && res.body) {
        const reader = res.clone().body.getReader();
        (async () => {
          while (!(await reader.read()).done) {
            /* ストリームの終わりまで待つ */
          }
          window.postMessage({ __chatArchiver: 'turn-complete', id }, location.origin);
        })().catch(() => {});
      }
    } catch {
      /* フックの失敗でページを壊さない */
    }
    return res;
  };
})();
