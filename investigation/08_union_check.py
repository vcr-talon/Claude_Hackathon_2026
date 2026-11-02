"""打設区分の「重複を除いた合計」がずれる原因の調査（読み取り専用）。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import manifold3d as m3  # noqa: E402

from qto.geometry import compute  # noqa: E402
from qto.ifc_loader import load_model  # noqa: E402

model = load_model(ROOT / "hackathon_model.ifc")
z0, z1 = 11.91, 14.93
whole = compute(model.solids, z0, z1)
print("whole", whole.total)
u2 = m3.Manifold.batch_boolean([whole.union, whole.union], m3.OpType.Add)
print("whole∪whole", u2.volume(), u2.status())
print("whole union genus/status", whole.union.status(), whole.union.num_tri())
# 体積を union に入れ直して再計算
print("re-volume", whole.union.volume())

# 対策後：包除原理による合計（A・B・範囲全体の3区分）
from shapely.geometry import box  # noqa: E402

from qto.partition import split_regions  # noqa: E402
from qto.units import PourUnit, compute_units  # noqa: E402

x8 = next(a for a in model.grids if a.tag == "X8")
x = x8.start[0] + 1.5
b = model.bounds
units = [PourUnit("A", z0, z1, box(b[0] - 1, b[1] - 1, x, b[3] + 1)),
         PourUnit("B", z0, z1, box(x, b[1] - 1, b[2] + 1, b[3] + 1)),
         PourUnit("全体", z0, z1)]
r = compute_units(model.solids, units)
print("units", [round(u.total, 4) for u in r.results], "sum", round(r.sum_total, 4), "union", round(r.union_total, 4))
for o in r.overlaps:
    print("  overlap", o.a, o.b, round(o.volume, 4), "shared", round(o.shared.total, 4) if o.shared else None)

# 部材種別で分けた区分（柱・梁／壁・スラブ・階段）
units = [PourUnit("柱梁", z0, z1, categories={"柱", "梁"}),
         PourUnit("壁床", z0, z1, categories={"壁", "スラブ", "階段"})]
r = compute_units(model.solids, units)
print("by category", [round(u.total, 4) for u in r.results], "sum", round(r.sum_total, 4), "union", round(r.union_total, 4))
for o in r.overlaps:
    print("  overlap", o.a, o.b, round(o.volume, 4), "shared", round(o.shared.total, 4) if o.shared else None)
