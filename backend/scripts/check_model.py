"""実IFCでエンジンを通しで確認する（検証段階②③）。

使い方: .venv\\Scripts\\python.exe backend\\scripts\\check_model.py [IFCパス]
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

from qto.geometry import compute  # noqa: E402
from qto.ifc_loader import load_model  # noqa: E402
from qto.partition import ZoneSeed, assign_zones, offset_axis_line, split_regions  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "hackathon_model.ifc"


def timed(label, fn):
    t0 = time.perf_counter()
    r = fn()
    print(f"  [{label}] {time.perf_counter() - t0:.2f}s")
    return r


model = timed("load", lambda: load_model(path))
mats = model.default_materials  # 画面・APIと同じく、材料を選ばないときはコンクリートだけ（D20）
print(f"schema={model.schema} solids={len(model.solids)} members={len(model.members)} "
      f"(前処理 {model.load_seconds:.1f}s)")
print("\n材料一覧（対象／除外）")
for name, info in model.materials.items():
    print(f"  {'対象' if info['included'] else '除外'}  {name}: {info['count']}")
bad = [s for s in model.solids if s.manifold is None]
print(f"\n閉じた立体にできない形状: {len(bad)}  変換失敗・複数材料: {len(model.skipped)}")
for s in bad[:10]:
    ref = s.reference_volume
    print(f"  {s.category} {s.member_name} {s.key}: {s.error} 参考体積={'なし（形状が壊れている）' if ref is None else f'{ref:.4f}'}")
for s in model.skipped[:10]:
    print(f"  {s.name} {s.key}: {s.reason}")

print("\n階")
for st in model.storeys:
    print(f"  {st.name:8} {st.elevation * 1000:8.0f} mm")
print(f"通り芯: {', '.join(a.tag for a in model.grids)}")

# ③ 部材単体（切断なし）とIFC既存数量 NetVolume の比較
vol_by_member: dict[str, float] = {}
for s in model.solids:
    if s.manifold is not None and s.material in mats:
        vol_by_member[s.member_id] = vol_by_member.get(s.member_id, 0.0) + s.manifold.volume()
rows = []
for mid, v in vol_by_member.items():
    m = model.members[mid]
    if m.base_net_volume:
        rows.append((abs(v - m.base_net_volume) / m.base_net_volume, v, m))
within = sum(1 for d, _, _ in rows if d <= 0.01)
print(f"\n部材単体の体積 vs 既存NetVolume: 比較{len(rows)}件、差1%以内 {within}件、"
      f"既存数量なし {len(vol_by_member) - len(rows)}件")
by_cat = {}
for d, v, m in rows:
    if d > 0.01:
        by_cat[m.category] = by_cat.get(m.category, 0) + 1
print(f"  差1%超の種別内訳: {by_cat}")
for d, v, m in sorted(rows, key=lambda r: -r[0])[:8]:
    print(f"  差{d:6.1%} {m.category} {m.name} 計算={v:.3f} 既存={m.base_net_volume:.3f}")

# 全体
lo = min(s.bbox[2] for s in model.solids) - 1
hi = max(s.bbox[5] for s in model.solids) + 1
whole = timed("全体", lambda: compute(model.solids, lo, hi, materials=mats))
print(f"全体: 総体積={whole.total:.2f} m3 単純合計={whole.raw_sum:.2f} 重複控除={whole.overlap:.2f}")
print("  種別内訳:", {k: round(v, 2) for k, v in whole.by_category.items()})
print("  材料内訳:", {k: round(v, 2) for k, v in whole.by_material.items()})
print(f"  内訳合計-総体積 = {sum(whole.by_category.values()) - whole.total:.2e}")

# 施工階ごと（SL〜直上階SL）
print("\n施工階ごと（SL〜直上階SL）")
levels = [st for st in model.storeys]
acc = 0.0
for a, b in zip(levels, levels[1:]):
    r = compute(model.solids, a.elevation, b.elevation, materials=mats)
    acc += r.total
    print(f"  {a.name:6}〜{b.name:6} {r.total:9.2f} m3 部材{len(r.members):4} 未計算{len(r.uncomputed)}")
below = compute(model.solids, lo, levels[0].elevation, materials=mats).total
above = compute(model.solids, levels[-1].elevation, hi, materials=mats).total
print(f"  最下階より下 {below:.2f} / 最上階より上 {above:.2f} / 合計 {acc + below + above:.2f} "
      f"(全体との差 {acc + below + above - whole.total:.2e})")

# 工区分割の整合：5SL〜6SL を X8 通り+1500 で A/B に分割
st = {s.name: s for s in model.storeys}
z0, z1 = st["5SL"].elevation, st["6SL"].elevation
x8 = next(a for a in model.grids if a.tag == "X8")
line = offset_axis_line(x8.start, x8.end, 1.5)
regions = split_regions(model.bounds, [list(line)])
cx = (line[0][0] + line[1][0]) / 2
cy = (model.bounds[1] + model.bounds[3]) / 2
zones = assign_zones(regions, [ZoneSeed("A", cx - 5, cy), ZoneSeed("B", cx + 5, cy)])
r_all = timed("5SL〜6SL 全体", lambda: compute(model.solids, z0, z1, materials=mats))
r_a = timed("工区A", lambda: compute(model.solids, z0, z1, region=zones["A"], materials=mats))
r_b = timed("工区B", lambda: compute(model.solids, z0, z1, region=zones["B"], materials=mats))
print(f"5SL〜6SL: 全体={r_all.total:.3f} A={r_a.total:.3f} B={r_b.total:.3f} "
      f"A+B-全体={r_a.total + r_b.total - r_all.total:.2e}")
print("  A 種別内訳:", {k: round(v, 3) for k, v in r_a.by_category.items()})
