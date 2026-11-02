"""配置・通り芯・代表例を調べ、代表例のみ形状から体積を計算して既存数量と照合する（読み取り専用）。"""
import sys
from collections import Counter
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as ue
import ifcopenshell.util.placement as up
import ifcopenshell.util.shape as us

sys.stdout.reconfigure(encoding="utf-8")
IFC_PATH = Path(__file__).resolve().parent.parent / "hackathon_model.ifc"
f = ifcopenshell.open(str(IFC_PATH))

settings = ifcopenshell.geom.settings()
settings.set("use-world-coords", True)

CLASSES = ["IfcColumn", "IfcBeam", "IfcSlab", "IfcWall", "IfcFooting", "IfcStair"]


def world_z(e):
    return up.get_local_placement(e.ObjectPlacement)[2][3] if e.ObjectPlacement else None


def material_name(e):
    m = ue.get_material(e)
    return getattr(m, "Name", None) if m else None


def geom_volume(e):
    """形状から体積(m3)とZ範囲(mm)を求める。単位はmmなので m3 へ換算する。"""
    try:
        shape = ifcopenshell.geom.create_shape(settings, e)
    except Exception as ex:  # noqa: BLE001
        return None, None, f"ERR {ex}"
    g = shape.geometry
    v = us.get_volume(g)
    verts = us.get_vertices(g)
    zs = verts[:, 2]
    # ifcopenshellの形状は既定でメートル換算される
    closed = us.is_manifold(g) if hasattr(us, "is_manifold") else None
    return v, (zs.min(), zs.max()), closed


print("=== placement depth / z vs storey (all elements, no geometry) ===")
for t in CLASSES + ["IfcBuildingElementProxy"]:
    diffs = []
    for e in f.by_type(t):
        c = ue.get_container(e) or ue.get_container(ue.get_aggregate(e))
        z = world_z(e)
        if c is not None and z is not None:
            diffs.append(round(z - c.Elevation))
    print(f"{t:24} placementZ - storeyElev : top {Counter(diffs).most_common(5)}")

print("\n=== grids ===")
for g in f.by_type("IfcGrid"):
    print("Grid", g.GlobalId, g.Name, "container", getattr(ue.get_container(g), "Name", None),
          "placement", [round(x) for x in up.get_local_placement(g.ObjectPlacement)[:3, 3]])
    for label, axes in (("U", g.UAxes), ("V", g.VAxes), ("W", g.WAxes or [])):
        for a in axes:
            pts = [tuple(round(c) for c in p.Coordinates) for p in a.AxisCurve.Points] \
                if a.AxisCurve.is_a("IfcPolyline") else a.AxisCurve.is_a()
            print(f"   {label} tag={a.AxisTag!r:8} sameSense={a.SameSense} curve={pts}")

print("\n=== representative samples (3 per class) + geometry check ===")
for t in CLASSES:
    els = f.by_type(t)
    # 名称の異なるものを優先して3件
    picked, seen = [], set()
    for e in els:
        if e.Name not in seen:
            picked.append(e)
            seen.add(e.Name)
        if len(picked) == 3:
            break
    # 子部材ありの例を1件混ぜる
    with_kids = [e for e in els if e.IsDecomposedBy]
    if with_kids and not any(e.IsDecomposedBy for e in picked):
        picked[-1] = with_kids[0]
    print(f"\n######## {t}")
    for e in picked:
        psets = ue.get_psets(e)
        bq = psets.get("BaseQuantities", {})
        storey = ue.get_container(e)
        print(f"- #{e.id()} GlobalId={e.GlobalId} Name={e.Name!r} 階={storey.Name if storey else None} "
              f"材料={material_name(e)} placementZ={world_z(e):.0f}")
        print(f"    Reference={ue.get_pset(e, 'Pset_' + t[3:] + 'Common', 'Reference')} "
              f"壁種区分={psets.get('一般性能', {}).get('壁種区分')} 分類="
              f"{[r.RelatingClassification.ItemReference for r in e.HasAssociations if r.is_a('IfcRelAssociatesClassification')]}")
        print(f"    BaseQuantities: " + ", ".join(f"{k}={v:.4g}" for k, v in bq.items()
                                                 if k != "id" and isinstance(v, float)))
        if e.Representation:
            v, zr, closed = geom_volume(e)
            print(f"    geom: volume={v} zRange={zr} manifold={closed}")
        kids = ue.get_decomposition(e)
        if kids:
            per_mat = Counter()
            for k in kids:
                v, zr, closed = geom_volume(k)
                per_mat[material_name(k)] += v or 0
            print(f"    children={len(kids)} geomVolume by material: "
                  + ", ".join(f"{m}={v:.4f}" for m, v in per_mat.items()))
