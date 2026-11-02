"""既存BaseQuantitiesの集計と、形状計算の所要時間見積もり（読み取り専用・一部要素のみ）。"""
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as ue
import ifcopenshell.util.shape as us

sys.stdout.reconfigure(encoding="utf-8")
IFC_PATH = Path(__file__).resolve().parent.parent / "hackathon_model.ifc"
f = ifcopenshell.open(str(IFC_PATH))

print("=== BaseQuantities summary per class (m3) ===")
print(f"{'class':12}{'n':>6}{'noBQ':>6}{'withKids':>9}{'Net<Gross':>10}{'sumNet':>10}{'sumGross':>10}")
for t in ["IfcColumn", "IfcBeam", "IfcSlab", "IfcWall", "IfcFooting", "IfcStair"]:
    els = f.by_type(t)
    no_bq = net_lt = kids = 0
    s_net = s_gross = 0.0
    for e in els:
        bq = ue.get_pset(e, "BaseQuantities")
        if e.IsDecomposedBy:
            kids += 1
        if not bq:
            no_bq += 1
            continue
        n, g = bq.get("NetVolume") or 0, bq.get("GrossVolume") or 0
        s_net += n
        s_gross += g
        if n < g - 1e-6:
            net_lt += 1
    print(f"{t[3:]:12}{len(els):6}{no_bq:6}{kids:9}{net_lt:10}{s_net:10.1f}{s_gross:10.1f}")

print("\n=== proxy children: count by parent class x material ===")
c = Counter()
for p in f.by_type("IfcBuildingElementProxy"):
    parent = ue.get_aggregate(p)
    c[(parent.is_a(), getattr(ue.get_material(p), "Name", None))] += 1
for k, n in sorted(c.items()):
    print(k, n)

print("\n=== wall 壁種区分 x has-children ===")
c = Counter()
for w in f.by_type("IfcWall"):
    c[(ue.get_pset(w, "一般性能", "壁種区分"), bool(w.IsDecomposedBy))] += 1
for k, n in c.most_common():
    print(k, n)

print("\n=== geometry timing (first 150 proxies) ===")
s = ifcopenshell.geom.settings()
s.set("use-world-coords", True)
targets = f.by_type("IfcBuildingElementProxy")[:150]
t0 = time.perf_counter()
vol = defaultdict(float)
for e in targets:
    sh = ifcopenshell.geom.create_shape(s, e)
    vol[getattr(ue.get_material(e), "Name", None)] += us.get_volume(sh.geometry)
dt = time.perf_counter() - t0
print(f"{len(targets)} shapes in {dt:.1f}s -> {dt / len(targets) * 1000:.0f} ms/shape; vol={dict(vol)}")
n_body = sum(1 for t in ["IfcColumn", "IfcBeam", "IfcSlab", "IfcWall", "IfcFooting",
                         "IfcBuildingElementProxy"] for e in f.by_type(t) if e.Representation)
print(f"elements with Body to compute: {n_body}, est. single-thread {n_body * dt / len(targets):.0f}s")
