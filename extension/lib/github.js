// GitHub の Git Data API で、複数ファイルを1コミットにまとめて push する。

// 通信断(Failed to fetch)はスリープ復帰直後などに起きやすいので、少し待ってやり直す
async function fetchRetrying(url, init) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (attempt >= 2) {
        const err = new Error(`GitHub に接続できません: ${e.message}`);
        err.status = 0;
        throw err;
      }
      await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
    }
  }
}

function makeApi({ token, owner, repo }) {
  return async (path, opts = {}) => {
    const res = await fetchRetrying(`https://api.github.com/repos/${owner}/${repo}${path}`, {
      ...opts,
      // GitHub は ref などを Cache-Control: max-age=60 で返す。ブラウザの HTTP キャッシュが効くと
      // 60秒間古いブランチ先頭が返り、コミットが "not a fast forward" で失敗し続けるので使わない
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* noop */
    }
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}: ${json?.message || text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  };
}

const encBranch = (b) => b.split('/').map(encodeURIComponent).join('/');

function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function testConnection(cfg) {
  const api = makeApi(cfg);
  const r = await api('');
  if (!r?.permissions?.push) throw new Error('このトークンにはリポジトリへの書き込み権限がありません');
  return { fullName: r.full_name, private: r.private, defaultBranch: r.default_branch };
}

async function getHead(api, cfg) {
  try {
    const ref = await api(`/git/ref/heads/${encBranch(cfg.branch)}`);
    return ref.object.sha;
  } catch (e) {
    // 空リポジトリ(409)ならREADMEで初期化してから再取得
    if (e.status === 409) {
      await api('/contents/README.md', {
        method: 'PUT',
        body: JSON.stringify({
          message: 'init chat archive',
          content: b64utf8('# Chat Archive\n\nChatGPT / Claude の会話履歴を自動で保存しています。\n'),
          branch: cfg.branch,
        }),
      });
      const ref = await api(`/git/ref/heads/${encBranch(cfg.branch)}`);
      return ref.object.sha;
    }
    if (e.status === 404) throw new Error(`ブランチ "${cfg.branch}" かリポジトリが見つかりません`);
    throw e;
  }
}

/**
 * files: [{ path, content }] または [{ path, delete: true }]
 * 変更がなければ { skipped: true }
 */
export async function commitFiles(cfg, files, message) {
  if (!files.length) return { skipped: true };
  const api = makeApi(cfg);
  let entries = files;
  for (let attempt = 0; attempt < 6; attempt++) {
    const headSha = await getHead(api, cfg);
    const head = await api(`/git/commits/${headSha}`);
    let tree;
    try {
      tree = await api('/git/trees', {
        method: 'POST',
        body: JSON.stringify({
          base_tree: head.tree.sha,
          tree: entries.map((f) =>
            f.delete
              ? { path: f.path, mode: '100644', type: 'blob', sha: null }
              : { path: f.path, mode: '100644', type: 'blob', content: f.content },
          ),
        }),
      });
    } catch (e) {
      // 既に存在しないファイルを削除しようとすると 422 になるので、削除を外して再試行
      if (e.status === 422 && entries.some((f) => f.delete)) {
        entries = entries.filter((f) => !f.delete);
        if (!entries.length) return { skipped: true };
        attempt--;
        continue;
      }
      throw e;
    }
    if (tree.sha === head.tree.sha) return { skipped: true };
    const commit = await api('/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
    });
    try {
      await api(`/git/refs/heads/${encBranch(cfg.branch)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
      return { sha: commit.sha };
    } catch (e) {
      // 他から push されて fast-forward できなかった → 最新の HEAD でやり直す。
      // コミット直後の ref 読み取りは古い値を返すことがあるので、少しずつ間を空ける(1,2,4,8,16秒)
      if (e.status === 422 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw e;
    }
  }
  throw new Error('GitHub へのコミットに失敗しました（競合が続いています）');
}
