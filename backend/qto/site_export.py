"""打設当日のタブレット用データ：スパンごとの「上端からの深さ → 残りの体積」の表（docs/site_app_spec.md 1-c）。

スパンごとに、スラブ以外（柱・梁・壁など）の和集合 V とスラブの和集合 S を求める。
from_top[k] は「V から S を除いた部分」のうち、上端 z1 から k·step より上にある体積。
こうしておくと、打ち上がりが上端から d のときの残り「from_top(d) ＋ S」が、
PCアプリの残量（V の d より上 ∪ S の体積）とそのまま一致し、全スパンの合計も重なりなく総数量になる。
単位はメートル。
"""
from __future__ import annotations

from dataclasses import dataclass

import manifold3d as m3
import numpy as np
from shapely.geometry import Point, Polygon, box

from .geometry import EPS_VOLUME, Solid, compute
from .units import region_from_rings

SLAB = "スラブ"
PRESET_NEAR_TOP = 0.35  # 打ち上がり高さの目安に使う部材：上端がこの距離以内（PCアプリの presetDepth と同じ）


@dataclass
class SiteCell:
    id: str
    label: str
    ring: list[list[float]]
    from_top: list[float]
    slab: float
    slab_bottom_mm: float | None
    beam_mid_mm: float | None
    members: int
    uncomputed: list[Solid]


def depth_steps(z0: float, z1: float, step: float) -> list[float]:
    """上端からの深さの刻み [0, step, 2·step, …, z1−z0]。最後は下端で止める（端数を残す）。"""
    height = z1 - z0
    n = int(np.floor(height / step + 1e-9))
    steps = [k * step for k in range(n + 1)]
    if height - steps[-1] > 1e-9:
        steps.append(height)
    return steps


def _volume_above(m: m3.Manifold | None, z: float) -> float:
    if m is None:
        return 0.0
    return m.trim_by_plane((0.0, 0.0, 1.0), z).volume()  # 法線の向き（z が大きい側）を残す


TOUCH_INSET = 0.01  # 外接箱をこれだけ縮めてから判定（隣のスパンと辺で接するだけの部材は数えない）


def touches(ring: Polygon, xmin: float, ymin: float, xmax: float, ymax: float) -> bool:
    """部材の平面の外接箱がスパンに掛かるか（PCアプリの rectTouchesRing と同じ判定）。"""
    x0, y0, x1, y1 = xmin + TOUCH_INSET, ymin + TOUCH_INSET, xmax - TOUCH_INSET, ymax - TOUCH_INSET
    if x0 >= x1 or y0 >= y1:  # 細い部材は中心線で判定
        x0 = x1 = (xmin + xmax) / 2
        y0 = y1 = (ymin + ymax) / 2
        return ring.covers(Point(x0, y0))
    return ring.intersects(box(x0, y0, x1, y1))


def _preset_mm(solids: list[Solid], ring: Polygon, z1: float, category: str, materials: set[str] | None,
               kind: str) -> float | None:
    """PCアプリの presetDepth と同じ：スパンに掛かり上端付近にある部材の中央値を10mm単位で。"""
    ds = []
    for s in solids:
        if s.category != category or (materials is not None and s.material not in materials):
            continue
        xmin, ymin, zmin, xmax, ymax, zmax = s.bbox
        if abs(zmax - z1) > PRESET_NEAR_TOP or not touches(ring, xmin, ymin, xmax, ymax):
            continue
        ds.append(z1 - zmin if kind == "slab" else z1 - (zmin + zmax) / 2)
    if not ds:
        return None
    ds.sort()
    return round(ds[len(ds) // 2] * 100) * 10  # 上側の中央値（画面側と同じ取り方）


def split_cells(cells: list[tuple[str, str, list]], zones: list[tuple[str, str, list]] | None
                ) -> list[tuple[str, str, list[list[float]]]]:
    """スパンを工区（または境界線で分けた範囲）の境界で切る。

    cells は (ID, 名前, 外周)、zones は (キー, 表示名, [[外周, 穴...], ...])。
    切った片は ID に「#キー」、名前に「（表示名）」を付ける。1つのスパンが同じ工区で2片に分かれたら「-1」「-2」。
    zones が無ければそのまま返す。どの工区にも入らない部分は返さない。
    """
    if not zones:
        return [(cid, label, [list(p) for p in ring]) for cid, label, ring in cells]
    regions = [(key, name, region_from_rings(polys)) for key, name, polys in zones]
    out = []
    for cid, label, ring in cells:
        cell = Polygon(ring).buffer(0)
        for key, name, region in regions:
            part = cell.intersection(region)
            polys = [p for p in (part.geoms if hasattr(part, "geoms") else [part])
                     if isinstance(p, Polygon) and p.area > 1e-6]
            for k, p in enumerate(polys):
                suffix = f"#{key}" + (f"-{k + 1}" if len(polys) > 1 else "")
                out.append((cid + suffix, f"{label}（{name}）", [list(q) for q in p.exterior.coords]))
    return out


def export_cell(solids: list[Solid], cell_id: str, label: str, ring: list[list[float]], z0: float, z1: float,
                categories: set[str], materials: set[str] | None, step: float) -> SiteCell:
    region = Polygon(ring).buffer(0)
    vertical = categories - {SLAB}
    rv = compute(solids, z0, z1, region=region, categories=vertical, materials=materials) if vertical else None
    rs = compute(solids, z0, z1, region=region, categories={SLAB}, materials=materials) if SLAB in categories else None
    v = rv.union if rv is not None else None
    s = rs.union if rs is not None else None
    if v is not None and s is not None:
        v = m3.Manifold.batch_boolean([v, s], m3.OpType.Subtract)
    steps = depth_steps(z0, z1, step)
    from_top = [_volume_above(v, z1 - d) if d > 0 else 0.0 for d in steps]
    for k in range(1, len(from_top)):  # 切断の誤差で前の値を下回らないように（単調増加）
        from_top[k] = max(from_top[k], from_top[k - 1])
    results = [r for r in (rv, rs) if r is not None]
    members = {m.member_id for r in results for m in r.members if m.volume > EPS_VOLUME}
    uncomputed = [x for r in results for x in r.uncomputed]
    return SiteCell(cell_id, label, ring, from_top, s.volume() if s is not None else 0.0,
                    _preset_mm(solids, region, z1, SLAB, materials, "slab"),
                    _preset_mm(solids, region, z1, "梁", materials, "beam"),
                    len(members), uncomputed)
