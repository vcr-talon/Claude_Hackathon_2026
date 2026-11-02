"""プロパティセットの中身（材料・数量・構造種別）と形状表現の種類を読み取り専用で調べる。"""
import sys
from collections import Counter, defaultdict
from pathlib import Path

import ifcopenshell
import ifcopenshell.util.element as ue

sys.stdout.reconfigure(encoding="utf-8")
IFC_PATH = Path(__file__).resolve().parent.parent / "hackathon_model.ifc"
f = ifcopenshell.open(str(IFC_PATH))

CLASSES = ["IfcColumn", "IfcBeam", "IfcSlab", "IfcWall", "IfcFooting", "IfcStair",
           "IfcBuildingElementProxy"]
# 中身を値の分布まで見るpset
DETAIL_PSETS = ["BaseQuantities", "材質情報", "Material Properties", "梁情報", "STBPropertySet",
                "Pset_ColumnCommon", "Pset_BeamCommon", "Pset_WallCommon", "Pset_SlabCommon",
                "Pset_StairCommon", "スラブ高度", "*スラブ", "*基礎", "一般性能", "床情報",
                "Pset_ManufacturerTypeInformation", "AC_Pset_RenovationAndPhasing"]


def short(v, n=40):
    s = repr(v)
    return s if len(s) <= n else s[:n] + "…"


for t in CLASSES:
    els = f.by_type(t)
    # pset -> prop -> Counter(values)
    vals = defaultdict(lambda: defaultdict(Counter))
    for e in els:
        for pname, props in ue.get_psets(e, psets_only=True).items():
            if pname not in DETAIL_PSETS:
                continue
            for k, v in props.items():
                if k != "id":
                    vals[pname][k][v if not isinstance(v, float) else "<float>"] += 1
    print(f"\n################ {t} ({len(els)})")
    for pname, props in vals.items():
        print(f"  [{pname}]")
        for k, c in props.items():
            top = ", ".join(f"{short(v)}×{n}" for v, n in c.most_common(5))
            more = f" (+{len(c) - 5} kinds)" if len(c) > 5 else ""
            print(f"    {k}: {top}{more}")

print("\n################ property names containing volume/area/length keywords (all psets)")
kw = ("volume", "体積", "area", "面積", "length", "長さ", "height", "高さ", "width", "幅",
      "thickness", "厚", "depth", "成", "コンクリート", "fc", "強度", "構造")
names = Counter()
for p in f.by_type("IfcPropertySingleValue"):
    if any(k in p.Name.lower() for k in kw):
        names[p.Name] += 1
for n, c in names.most_common(80):
    print(f"  {n}: {c}")

print("\n################ representations per class")
for t in CLASSES:
    rep = Counter()
    for e in f.by_type(t):
        if not e.Representation:
            rep["<none>"] += 1
            continue
        for r in e.Representation.Representations:
            items = Counter(i.is_a() for i in r.Items)
            rep[(r.RepresentationIdentifier, r.RepresentationType, tuple(sorted(items)))] += 1
    print(t)
    for k, n in rep.most_common():
        print("   ", k, n)

print("\n################ parents that have exploded children: do parents keep Body geometry?")
for t in ["IfcWall", "IfcBeam", "IfcColumn", "IfcSlab", "IfcStair"]:
    with_children = [e for e in f.by_type(t) if e.IsDecomposedBy]
    has_body = sum(1 for e in with_children if e.Representation and any(
        r.RepresentationIdentifier == "Body" for r in e.Representation.Representations))
    mats = Counter()
    for e in with_children:
        for c in ue.get_decomposition(e):
            m = ue.get_material(c)
            mats[getattr(m, "Name", None)] += 1
    print(f"{t}: parents_with_children={len(with_children)} parent_has_Body={has_body} child_materials={dict(mats)}")
