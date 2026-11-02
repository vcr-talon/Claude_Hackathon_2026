"""階・部材・所属関係・プロパティセット名の分布を読み取り専用で調べる。"""
import sys
from collections import Counter, defaultdict
from pathlib import Path

import ifcopenshell
import ifcopenshell.util.element as ue
import ifcopenshell.util.placement as up

sys.stdout.reconfigure(encoding="utf-8")
IFC_PATH = Path(__file__).resolve().parent.parent / "hackathon_model.ifc"
f = ifcopenshell.open(str(IFC_PATH))

ELEMENT_TYPES = ["IfcColumn", "IfcBeam", "IfcSlab", "IfcWall", "IfcWallStandardCase",
                 "IfcFooting", "IfcStair", "IfcStairFlight", "IfcMember", "IfcRailing",
                 "IfcRamp", "IfcPile", "IfcPlate", "IfcCovering", "IfcBuildingElementProxy",
                 "IfcOpeningElement", "IfcDoor", "IfcWindow", "IfcSpace"]

print("=== units ===")
for u in f.by_type("IfcUnitAssignment")[0].Units:
    if u.is_a("IfcSIUnit"):
        print(u.UnitType, u.Prefix, u.Name)
    elif u.is_a("IfcConversionBasedUnit"):
        print(u.UnitType, u.Name)

print("\n=== storeys ===")
storeys = sorted(f.by_type("IfcBuildingStorey"), key=lambda s: s.Elevation or 0)
for s in storeys:
    z = up.get_local_placement(s.ObjectPlacement)[2][3]
    direct = [e for r in s.ContainsElements for e in r.RelatedElements]
    by = Counter(e.is_a() for e in direct)
    print(f"{s.Name!r:14} LongName={s.LongName!r:14} Elev={s.Elevation} placementZ={z:.1f} "
          f"direct={len(direct)} {dict(by)}")

print("\n=== element counts / storey membership ===")
for t in ELEMENT_TYPES:
    try:
        els = [e for e in f.by_type(t) if e.is_a() == t]
    except RuntimeError:
        continue
    if not els:
        continue
    direct = sum(1 for e in els if e.ContainedInStructure)
    via_parent = sum(1 for e in els if not e.ContainedInStructure and ue.get_aggregate(e))
    none = [e for e in els if not ue.get_container(e)]
    print(f"{t:26} total={len(els):5} direct={direct:5} viaAggregate={via_parent:4} noStorey={len(none)}")

print("\n=== aggregates (parent -> child types) ===")
agg = Counter()
for r in f.by_type("IfcRelAggregates"):
    for c in r.RelatedObjects:
        agg[(r.RelatingObject.is_a(), c.is_a())] += 1
for k, n in agg.most_common():
    print(k, n)

print("\n=== PredefinedType / ObjectType per class ===")
for t in ["IfcColumn", "IfcBeam", "IfcSlab", "IfcWall", "IfcFooting", "IfcStair", "IfcBuildingElementProxy"]:
    els = f.by_type(t)
    pt = Counter(getattr(e, "PredefinedType", None) for e in els)
    ot = Counter(e.ObjectType for e in els)
    nm = Counter(e.Name for e in els)
    print(f"{t}: PredefinedType={dict(pt)}")
    print(f"   ObjectType top={ot.most_common(8)}")
    print(f"   Name top={nm.most_common(8)}")

print("\n=== proxy types (IfcBuildingElementProxyType names) ===")
pc = Counter()
for e in f.by_type("IfcBuildingElementProxy"):
    ty = ue.get_type(e)
    pc[(ty.Name if ty else None, e.Name)] += 1
for k, n in pc.most_common(25):
    print(k, n)

print("\n=== pset names by class (count of elements having it) ===")
pset_by_class = defaultdict(Counter)
for t in ["IfcColumn", "IfcBeam", "IfcSlab", "IfcWall", "IfcFooting", "IfcStair", "IfcBuildingElementProxy"]:
    for e in f.by_type(t):
        for r in e.IsDefinedBy:
            if r.is_a("IfcRelDefinesByProperties"):
                pset_by_class[t][r.RelatingPropertyDefinition.Name] += 1
            else:
                pset_by_class[t]["<type>" + r.RelatingType.is_a()] += 1
for t, c in pset_by_class.items():
    print(t, dict(c.most_common()))

print("\n=== IfcElementQuantity ===", len(f.by_type("IfcElementQuantity")))
print("=== classification references ===")
for r in f.by_type("IfcRelAssociatesClassification"):
    c = r.RelatingClassification
    targets = Counter(o.is_a() for o in r.RelatedObjects)
    print(c.ItemReference, c.Name, getattr(c.ReferencedSource, "Name", None), dict(targets))

print("\n=== materials ===")
for r in f.by_type("IfcRelAssociatesMaterial"):
    m = r.RelatingMaterial
    targets = Counter(o.is_a() for o in r.RelatedObjects)
    print(m.is_a(), getattr(m, "Name", None), "->", dict(targets))
for m in f.by_type("IfcMaterial"):
    print("IfcMaterial:", m.Name)

print("\n=== GlobalId uniqueness ===")
gids = [e.GlobalId for e in f.by_type("IfcRoot")]
print("IfcRoot", len(gids), "unique", len(set(gids)))
