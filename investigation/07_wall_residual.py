"""石膏ボードで説明できない壁の差の原因を、代表1件の寸法と形状範囲で確認する（読み取り専用）。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.stdout.reconfigure(encoding="utf-8")

import ifcopenshell  # noqa: E402
import ifcopenshell.util.element as ue  # noqa: E402

from qto.ifc_loader import load_model  # noqa: E402

model = load_model(ROOT / "hackathon_model.ifc")
f = ifcopenshell.open(str(ROOT / "hackathon_model.ifc"))
for gid in ["2RP6BXBpjFGAf9$Ft8OmnO", "24gsd$7H1Fj9iXSbt6Lqza"]:
    w = f.by_guid(gid)
    bq = ue.get_pset(w, "BaseQuantities")
    print(w.Name, gid, {k: round(v, 3) for k, v in bq.items() if isinstance(v, float)})
    for c in ue.get_decomposition(w):
        mat = ue.get_material(c).Name
        s = next((s for s in model.solids if s.key == c.GlobalId), None)
        if s is not None:
            x0, y0, z0, x1, y1, z1 = s.bbox
            print(f"   {mat:16} vol={s.manifold.volume():.3f} size=({x1 - x0:.3f},{y1 - y0:.3f},{z1 - z0:.3f})")
        else:
            print(f"   {mat:16} (対象外)")
