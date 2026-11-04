"""実モデルの基準値を素早く確かめる（フック・スキル用。人が手で実行してもよい）。

使い方: .venv\\Scripts\\python.exe backend\\scripts\\quick_check.py
hackathon_model.ifc を前処理キャッシュから読み、全体と 5SL～6SL の総数量を基準値と比べる。
キャッシュが無いときは読み込みに数分かかるため、検証を省略して終了コード 0 で終える。
終了コード：0＝一致（または省略）、1＝基準値とずれた
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
EXPECTED = {"全体": 4377.07, "5SL～6SL": 372.90}


def main() -> int:
    if not IFC.exists() or not _cache_path(IFC, ROOT / ".qto_cache").exists():
        print("キャッシュなしのため実モデルの検証は省略（start.bat で一度IFCを読み込むと作られる）")
        return 0
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
    print(f"基準値と一致（±{TOLERANCE} m³）：{summary}　{time.perf_counter() - t0:.1f}秒")
    return 0


if __name__ == "__main__":
    sys.exit(main())
