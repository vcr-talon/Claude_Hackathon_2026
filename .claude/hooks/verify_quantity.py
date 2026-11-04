"""PostToolUse フック：計算エンジンを編集したら、自動で数量を検証する（docs/claude_setup.md 2-a）。

対象は backend/qto/ と backend/server.py の編集だけ。それ以外は何もせず終える。
単体テスト → 実モデルの基準値（backend/scripts/quick_check.py）の順に確かめ、
失敗したら終了コード 2 で理由を標準エラーに書く（Claude Code がそれを読んで次の手を打つ）。成功時は何も出さない。
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
TAIL = 25  # 失敗時に見せるテスト出力の行数


def target(event: dict) -> bool:
    raw = (event.get("tool_input") or {}).get("file_path") or ""
    if not raw:
        return False
    p = Path(raw)
    p = (p if p.is_absolute() else ROOT / p).resolve()
    try:
        rel = p.relative_to(ROOT).as_posix()
    except ValueError:
        return False
    return rel.startswith("backend/qto/") or rel == "backend/server.py"


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([str(PYTHON), *args], cwd=ROOT, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", env={**os.environ, "PYTHONIOENCODING": "utf-8"})


def main() -> int:
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        # Claude Code は UTF-8 で渡す。Windows の Python は標準入力を cp932 で読むため、日本語のパス（業務改善）で
        # JSON が壊れ、黙って素通りしていた。必ず UTF-8 として読む（BOM付きでも読めるよう utf-8-sig）
        event = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        print(f"verify_quantity フックが入力を読めませんでした（{e}）。数量の検証ができていません", file=sys.stderr)
        return 1  # 止めはしないが、画面に出して気づけるようにする
    if not target(event):
        return 0
    tests = run(["-m", "pytest", "-q", "-x", "backend/tests"])
    if tests.returncode != 0:
        out = "\n".join((tests.stdout + tests.stderr).strip().splitlines()[-TAIL:])
        print("数量検証が失敗：単体テストが通りません。定義を変えたならその旨を利用者に確認し、"
              "そうでなければ修正してください（テストの期待値や許容値を合わせに行かない）。\n" + out, file=sys.stderr)
        return 2
    check = run(["backend/scripts/quick_check.py"])
    if check.returncode != 0:
        print("数量検証が失敗：" + (check.stderr or check.stdout).strip() +
              "\n定義を変えたならその旨を利用者に確認し、そうでなければ修正してください（基準値を合わせに行かない）。",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
