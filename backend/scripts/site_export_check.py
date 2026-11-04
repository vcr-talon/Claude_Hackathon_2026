"""タブレット用の書き出しを確かめる（site-export-check スキル用。人が手で実行してもよい）。

使い方: .venv\\Scripts\\python.exe backend\\scripts\\site_export_check.py [施工階（既定 5SL）]
アプリを 8767 で起動し、PC画面で施工階を選んで「タブレット用に書き出す」を実際に押す。
書き出したファイルは一時フォルダに置いて確かめ、終わったら消す（リポジトリには残さない）。
終了コード：0＝すべて合格、1＝不合格あり
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app_driver import ROOT, browser, export_site, open_pc, running_app, utf8_stdout  # noqa: E402

MAX_KB = 300
OVERLAP_MAX = 0.01  # m³


def main() -> int:
    utf8_stdout()
    storey = sys.argv[1] if len(sys.argv) > 1 else "5SL"
    rows = []  # (項目, 合否, 内容)
    with tempfile.TemporaryDirectory() as tmp, running_app() as base, browser() as ctx:
        page = open_pc(ctx, base, storey)
        shown = page.inner_text("#resultBody .total")  # PC の「いまの条件の数量」（小数2桁）
        pc_total = float(re.sub(r"[^\d.]", "", shown))
        path = export_site(page, Path(tmp) / "site.json")
        size_kb = path.stat().st_size / 1024
        d = json.loads(path.read_text(encoding="utf-8"))
        cells = d["cells"]
        bad_head = [c["label"] for c in cells if c["from_top"][0] != 0]
        bad_mono = [c["label"] for c in cells if any(b < a for a, b in zip(c["from_top"], c["from_top"][1:]))]
        cell_sum = sum(c["from_top"][-1] + c["slab"] for c in cells)
        rows += [
            ("表の先頭が0", not bad_head, f"{len(cells)}スパン中 不合格 {len(bad_head)}件 {bad_head[:3]}"),
            ("表が単調増加", not bad_mono, f"不合格 {len(bad_mono)}件 {bad_mono[:3]}"),
            ("スパンの合計＝総数量（overlap_note）", abs(d["overlap_note"]) < OVERLAP_MAX,
             f"スパン合計 {cell_sum:.4f} / 総数量 {d['total']:.4f} / 差 {d['overlap_note']:.2e} m³（{OVERLAP_MAX} 未満）"),
            ("総数量＝PCの「いまの条件の数量」", abs(d["total"] - pc_total) <= 0.005 + 1e-9,
             f"書き出し {d['total']:.4f} / 画面 {shown.strip()}"),
            ("ファイルサイズ", size_kb <= MAX_KB, f"{size_kb:.0f} KB（{MAX_KB} KB 以下）"),
        ]
        title = d["title"]
    node = subprocess.run(["node", "--test"], cwd=ROOT / "site_app", capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    summary = [line for line in node.stdout.splitlines() if re.match(r"^ℹ (pass|fail) ", line)]
    rows.append(("タブレットの単体テスト（node --test）", node.returncode == 0, " ".join(summary)))

    print(f"タブレット用の書き出し：{title}")
    for name, ok, detail in rows:
        print(f"  {'合格' if ok else '不合格'}  {name}：{detail}")
    failed = [name for name, ok, _ in rows if not ok]
    print("結果：すべて合格" if not failed else f"結果：不合格 {len(failed)}件（{'、'.join(failed)}）")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
