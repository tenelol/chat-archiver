#!/usr/bin/env python3
"""
Claude Code の Stop hook 用スクリプト。
Claude が返信し終わるたびに、そのセッションの会話(transcript)を Markdown にして
アーカイブ用リポジトリへ git commit し、バックグラウンドで push する。

環境変数:
  CHAT_ARCHIVE_REPO   アーカイブ用リポジトリのローカルclone (既定: ~/chat-archive)
  CHAT_ARCHIVE_PUSH   0 にすると push しない (既定: 1)

Claude Code の動作を止めないよう、どんなエラーでも exit 0 で終わる。
"""
import contextlib
import datetime as dt
import json
import os
import re
import subprocess
import sys
import unicodedata

REPO = os.path.expanduser(os.environ.get("CHAT_ARCHIVE_REPO", "~/chat-archive"))
DO_PUSH = os.environ.get("CHAT_ARCHIVE_PUSH", "1") != "0"
SUBDIR = "claude-code"

try:
    import fcntl  # macOS / Linux
except ImportError:  # Windows
    fcntl = None


@contextlib.contextmanager
def repo_lock():
    path = os.path.join(REPO, ".git", "chat-archiver.lock")
    if fcntl is None:
        yield
        return
    with open(path, "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def git(*args, check=True):
    return subprocess.run(["git", "-C", REPO, *args], check=check, capture_output=True, text=True)


def parse_time(s):
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


def slugify(s, n=50):
    s = unicodedata.normalize("NFKC", s or "")
    s = re.sub(r'[\\/:*?"<>|#%{}^~\[\]`\'\x00-\x1f]', "", s)
    s = re.sub(r"\s+", "-", s).strip("-.")
    return s[:n] or "untitled"


def code_block(text, lang=""):
    text = str(text)
    longest = max([2] + [len(m) for m in re.findall(r"`+", text)])
    fence = "`" * (longest + 1)
    return f"{fence}{lang}\n{text}\n{fence}"


def details(summary, body):
    body = (body or "").strip()
    if not body:
        return ""
    summary = re.sub(r"[<>]", "", summary)
    return f"<details>\n<summary>{summary}</summary>\n\n{body}\n\n</details>"


def tool_result_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for c in content:
            if isinstance(c, str):
                out.append(c)
            elif c.get("type") == "text":
                out.append(c.get("text", ""))
            elif c.get("type") == "image":
                out.append("*[画像]*")
        return "\n\n".join(out)
    return json.dumps(content, ensure_ascii=False, indent=2)


def render_content(content):
    if isinstance(content, str):
        if content.startswith("<local-command-stdout>") or content.startswith("<command-"):
            return details("コマンド", code_block(content))
        return content
    parts = []
    for c in content or []:
        t = c.get("type")
        if t == "text":
            parts.append(c.get("text", ""))
        elif t == "thinking":
            parts.append(details("思考", c.get("thinking", "")))
        elif t == "tool_use":
            parts.append(details(f"ツール: {c.get('name')}", code_block(json.dumps(c.get("input", {}), ensure_ascii=False, indent=2), "json")))
        elif t == "tool_result":
            body = tool_result_text(c.get("content"))
            if len(body) > 20000:
                body = body[:20000] + "\n…(省略)"
            parts.append(details("ツール結果", code_block(body)))
        elif t == "image":
            parts.append("*[画像]*")
    return "\n\n".join(p for p in parts if p and p.strip())


def is_only_tool_result(content):
    return isinstance(content, list) and content and all(c.get("type") == "tool_result" for c in content)


def build_markdown(entries, session_id, cwd):
    title = None
    first_user = None
    model = None
    turns = []
    for e in entries:
        if e.get("type") == "summary" and e.get("summary"):
            title = e["summary"]
            continue
        if e.get("type") not in ("user", "assistant") or e.get("isSidechain") or e.get("isMeta"):
            continue
        msg = e.get("message") or {}
        content = msg.get("content")
        if e["type"] == "assistant":
            model = msg.get("model") or model
        body = render_content(content)
        if not body.strip():
            continue
        # tool_result だけの user 行は Claude 側のターンとして扱う
        speaker = "user" if e["type"] == "user" and not is_only_tool_result(content) else "assistant"
        if speaker == "user" and first_user is None and isinstance(content, str) and not content.startswith("<"):
            first_user = content
        elif speaker == "user" and first_user is None and isinstance(content, list):
            txt = " ".join(c.get("text", "") for c in content if c.get("type") == "text")
            if txt and not txt.startswith("<"):
                first_user = txt
        turns.append((speaker, parse_time(e.get("timestamp")), body))

    if not turns:
        return None, None, None
    if not title:
        title = (first_user or "Claude Code session").strip().splitlines()[0][:60]
    created = next((t for _, t, _ in turns if t), None) or dt.datetime.now().astimezone()
    updated = next((t for _, t, _ in reversed(turns) if t), None) or created

    fm = {
        "title": title,
        "service": "claude-code",
        "id": session_id,
        "project": cwd,
        "model": model,
        "created": created.isoformat(timespec="seconds"),
        "updated": updated.isoformat(timespec="seconds"),
    }
    out = ["---"] + [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in fm.items() if v] + ["---", "", f"# {title}", ""]
    last = None
    for speaker, t, body in turns:
        if speaker != last:
            label = "🧑 ユーザー" if speaker == "user" else "🤖 Claude Code"
            out += [f"## {label}" + (f" <sub>{t.strftime('%Y-%m-%d %H:%M')}</sub>" if t else ""), ""]
            last = speaker
        out += [body.strip(), ""]
    md = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).rstrip() + "\n"
    return md, title, created


def load_transcript(path):
    entries = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return entries


def archive(hook):
    transcript = hook.get("transcript_path")
    session_id = hook.get("session_id") or "unknown"
    cwd = hook.get("cwd") or os.getcwd()
    if not transcript or not os.path.exists(transcript):
        return
    if not os.path.isdir(os.path.join(REPO, ".git")):
        print(f"[chat-archiver] {REPO} が git リポジトリではありません", file=sys.stderr)
        return

    md, title, created = build_markdown(load_transcript(transcript), session_id, cwd)
    if not md:
        return

    project = slugify(os.path.basename(os.path.normpath(cwd)) or "root")
    rel = os.path.join(SUBDIR, project, created.strftime("%Y"), created.strftime("%m"), f"{created.strftime('%Y-%m-%d')}_{session_id[:8]}.md")
    dest = os.path.join(REPO, rel)

    with repo_lock():
        old = None
        if os.path.exists(dest):
            with open(dest, encoding="utf-8") as f:
                old = f.read()
        if old == md:
            return
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(md)
        git("add", rel)
        r = git("commit", "-q", "-m", f"claude-code: {project} {title}", "--", rel, check=False)
        if r.returncode != 0:
            return

    if DO_PUSH:
        spawn_push()


def spawn_push():
    """push は時間がかかるので、切り離したプロセスで実行して hook をすぐ返す"""
    kwargs = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.name == "nt":
        kwargs["creationflags"] = 0x00000008  # DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "--push"], **kwargs)


def push():
    with repo_lock():
        # 拡張機能が GitHub 側に直接コミットしているので、先に取り込んでから push
        git("pull", "--rebase", "--autostash", "-q", check=False)
        up = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", check=False).stdout.strip()
        if "/" in up:
            remote, branch = up.split("/", 1)
            git("push", "-q", remote, f"HEAD:{branch}", check=False)
        else:
            git("push", "-q", check=False)


def main():
    if "--push" in sys.argv:
        push()
        return
    try:
        hook = json.load(sys.stdin)
        archive(hook)
    except Exception as e:  # Claude Code を止めない
        print(f"[chat-archiver] {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
    sys.exit(0)
