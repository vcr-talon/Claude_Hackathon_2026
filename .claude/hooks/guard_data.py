"""PreToolUse フック：BIMから作ったデータの持ち出しを止める（docs/claude_setup.md 2-b）。

- Edit/Write：site_app/ の中の *.json（package.json を除く）、または .ifc ファイルへの書き込み
- Bash/PowerShell：git add と、IFC・キャッシュ・アップロード・書き出したデータの指定が同時にあるコマンド
を見つけたら、終了コード 2 で理由を標準エラーに書いて止める。hackathon_model.ifc だけは例外（D7）。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ALLOWED_IFC = "hackathon_model.ifc"  # D7：デモとGitHubで使ってよい
SITE_JSON_ALLOWED = {"package.json"}
MESSAGE = ("BIMから作ったデータは公開するフォルダに置かない（CLAUDE.md「データの扱い」）。"
           "止めた理由：{why}。必要なら利用者に確認を求めてください。")


def check_write(file_path: str) -> str | None:
    p = Path(file_path)
    p = (p if p.is_absolute() else ROOT / p).resolve()
    name = p.name
    if p.suffix.lower() == ".ifc" and name != ALLOWED_IFC:
        return f"IFCファイル {name} への書き込み"
    try:
        rel = p.relative_to(ROOT).as_posix()
    except ValueError:
        return None
    if rel.startswith("site_app/") and p.suffix.lower() == ".json" and name not in SITE_JSON_ALLOWED:
        return f"公開するフォルダ site_app/ への {name} の書き込み"
    return None


DATA_PATTERNS = [r"\.qto_cache", r"\.qto_uploads", r"_現場用_"]


def check_command(command: str) -> str | None:
    if not re.search(r"\bgit\s+add\b", command):
        return None
    ifcs = [m for m in re.findall(r"[^\s\"'`]*\.ifc\b", command, re.IGNORECASE) if Path(m).name != ALLOWED_IFC]
    if ifcs:
        return f"git add に IFC（{', '.join(ifcs)}）が含まれる"
    for pat in DATA_PATTERNS:
        if re.search(pat, command):
            return f"git add にキャッシュ・アップロード・書き出したデータ（{pat.replace(chr(92), '')}）が含まれる"
    return None


def main() -> int:
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        # Claude Code は UTF-8 で渡す。Windows の Python は標準入力を cp932 で読むため、日本語のパス（業務改善）で
        # JSON が壊れ、黙って素通りしていた。必ず UTF-8 として読む（BOM付きでも読めるよう utf-8-sig）
        event = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        print(f"guard_data フックが入力を読めませんでした（{e}）。持ち出しの確認ができていません", file=sys.stderr)
        return 1  # 止めはしないが、画面に出して気づけるようにする
    tool = event.get("tool_name", "")
    data = event.get("tool_input") or {}
    if tool in ("Bash", "PowerShell"):
        why = check_command(data.get("command", ""))
    else:
        why = check_write(data.get("file_path", "")) if data.get("file_path") else None
    if why:
        print(MESSAGE.format(why=why), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
