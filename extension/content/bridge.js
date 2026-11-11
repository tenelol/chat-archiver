// hook.js からの「返信完了」の合図を受けて、拡張の background に同期を依頼する。
(() => {
  const host = location.hostname;
  const service = host.endsWith('claude.ai') ? 'claude' : host.endsWith('grok.com') ? 'grok' : 'chatgpt';

  const idFromLocation = () => {
    const re = service === 'claude' ? /\/chat\/([0-9a-f-]{36})/ : /\/c\/([0-9A-Za-z-]+)/; // ChatGPT・Grok は /c/<id>
    return location.pathname.match(re)?.[1] || null;
  };

  const send = (id) => {
    const cid = id || idFromLocation();
    if (!cid) return;
    try {
      chrome.runtime.sendMessage({ type: 'conversation-updated', service, id: cid }).catch(() => {});
    } catch {
      /* 拡張が再読み込みされた直後など */
    }
  };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.__chatArchiver !== 'turn-complete') return;
    const id = ev.data.id;
    setTimeout(() => send(id), 3000); // 返信の保存を待ってから
    setTimeout(() => send(id), 25000); // 新規チャットのタイトル自動生成を拾う
  });
})();
