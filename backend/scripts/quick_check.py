"""実モデルの基準値を素早く確かめる（フック・スキル用。人が手で実行してもよい）。

使い方: .venv\\Scripts\\python.exe backend\\scripts\\quick_check.py
hackathon_model.ifc を前処理キャッシュから読み、全体と 5SL～6SL の総数量を基準値と比べる。
キャッシュが無いとき（キャッシュの版を上げた直後など）も省略せず、IFCから読み込んで確かめる（約5秒）。
省略するのは hackathon_model.ifc そのものが無いときだけ（IFCを含まない複製など）。
終了コード：0＝一致（またはIFCが無く省略）、1＝基準値とずれた
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

from qto.geometry import compute  # noqa: E402
from qto.ifc_loader import _cache_path, load_model  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
IFC = ROOT / "hackathon_model.ifc"
TOLERANCE = 0.01  # m³
# 基準値（CLAUDE.md「許容値と基準値」）。数字を合わせるためにここを変えない。変えるなら先に確認を求める
# 2026-11-04 全体 4377.07 → 4381.88：辺の食い違い・裏返った面を直して2件（FG10・W3）を数えるようにした（利用者承認済み）
EXPECTED = {"全体": 4381.88, "5SL～6SL": 372.90}


def main() -> int:
    if not IFC.exists():
        print("hackathon_model.ifc が無いため実モデルの検証は省略")
        return 0
    # キャッシュが無くても省略しない：キャッシュの版を上げる変更（読み込みの判定を変えたとき）こそ確かめる必要がある
    cached = _cache_path(IFC, ROOT / ".qto_cache").exists()
    t0 = time.perf_counter()
    model = load_model(IFC)
    mats = model.default_materials  # 画面・APIと同じく、材料を選ばないときはコンクリートだけ（D20）
    lo = min(s.bbox[2] for s in model.solids) - 1
    hi = max(s.bbox[5] for s in model.solids) + 1
    st = {s.name: s.elevation for s in model.storeys}
    actual = {
        "全体": compute(model.solids, lo, hi, materials=mats).total,
        "5SL～6SL": compute(model.solids, st["5SL"], st["6SL"], materials=mats).total,
    }
    bad = [f"{k} {EXPECTED[k]:.2f} → {v:.2f}（差 {v - EXPECTED[k]:+.3f} m³）"
           for k, v in actual.items() if abs(v - EXPECTED[k]) > TOLERANCE]
    summary = "、".join(f"{k} {v:.3f} m³" for k, v in actual.items())
    if bad:
        print("数量が基準値とずれています：" + "／".join(bad), file=sys.stderr)
        print(f"（実測：{summary}）", file=sys.stderr)
        return 1
    how = "" if cached else "（キャッシュが無いためIFCから読み込み）"
    print(f"基準値と一致（±{TOLERANCE} m³）：{summary}　{time.perf_counter() - t0:.1f}秒{how}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
