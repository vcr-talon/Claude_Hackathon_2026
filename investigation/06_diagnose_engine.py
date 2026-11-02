"""エンジン結果の差異と不正形状を診断する（読み取り専用）。"""
import sys
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.stdout.reconfigure(encoding="utf-8")

import ifcopenshell  # noqa: E402
import ifcopenshell.geom  # noqa: E402
import ifcopenshell.util.element as ue  # noqa: E402

from qto.geometry import mesh_volume  # noqa: E402
from qto.ifc_loader import load_model  # noqa: E402

model = load_model(ROOT / "hackathon_model.ifc")
f = ifcopenshell.open(str(ROOT / "hackathon_model.ifc"))
settings = ifcopenshell.geom.settings()
settings.set("use-world-coords", True)

print("=== 不正形状の辺の状態 ===")
for s in [s for s in model.solids if s.manifold is None]:
    faces = s.faces
    tri_keys = Counter(tuple(sorted(t)) for t in faces.tolist())
    dup_tris = sum(n - 1 for n in tri_keys.values() if n > 1)
    # 座標で頂点を同一視して辺の使用回数を数える
    keys = np.round(s.vertices / 1e-4).astype(np.int64)
    _, inv = np.unique(keys, axis=0, return_inverse=True)
    ft = inv.reshape(-1)[faces]
    edges = Counter()
    for a, b, c in ft.tolist():
        for e in ((a, b), (b, c), (c, a)):
            edges[tuple(sorted(e))] += 1
    use = Counter(edges.values())
    p = f.by_guid(s.key)
    print(f"{s.category} {s.member_name} {s.key} {p.is_a()} tris={len(faces)} dupTris={dup_tris} "
          f"edgeUse={dict(use)} repr={[r.RepresentationType for r in p.Representation.Representations]}")

print("\n=== 壁の差＝石膏ボードか（既存NetVolume − 計算 と 石膏ボード子部材の体積）===")
gyp = {}
for p in f.by_type("IfcBuildingElementProxy"):
    m = ue.get_material(p)
    if m and "石膏ボード" in m.Name:
        parent = ue.get_aggregate(p)
        sh = ifcopenshell.geom.create_shape(settings, p)
        v = np.asarray(sh.geometry.verts).reshape(-1, 3)
        t = np.asarray(sh.geometry.faces).reshape(-1, 3)
        gyp[parent.GlobalId] = gyp.get(parent.GlobalId, 0.0) + mesh_volume(v, t)
ours = {}
for s in model.solids:
    if s.manifold is not None:
        ours[s.member_id] = ours.get(s.member_id, 0.0) + s.manifold.volume()
explained = unexplained = 0
worst = []
for mid, v in ours.items():
    m = model.members[mid]
    if not m.base_net_volume or abs(v - m.base_net_volume) / m.base_net_volume <= 0.01:
        continue
    resid = m.base_net_volume - v - gyp.get(mid, 0.0)
    if abs(resid) <= 0.01 * m.base_net_volume:
        explained += 1
    else:
        unexplained += 1
        worst.append((abs(resid), m.category, m.name, mid, v, m.base_net_volume, gyp.get(mid, 0.0)))
print(f"差1%超のうち 石膏ボードで説明できる={explained} できない={unexplained}")
for w in sorted(worst, reverse=True)[:10]:
    print("  残差{:.3f} {} {} {} 計算={:.3f} 既存={:.3f} 石膏={:.3f}".format(*w))
