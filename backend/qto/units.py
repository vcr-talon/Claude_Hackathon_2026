"""打設区分（要件 D22・D23）：複数の条件を登録し、区分ごとの数量と区分どうしの重なりを求める。

区分 = 工区の多角形 × 高さ範囲 × 部材の絞り込み。

重なりは2種類ある。
- 同じ部材の同じ部分が2つの区分に入っている（登録の誤り。区分の共通部分を compute() で求める）
- 別々の部材どうしがモデル上で食い込んでいる部分（柱とスラブの取り合いなど）

「重複を除いた合計」はどちらも1回だけ数えた体積で、立体ごとに「その立体を含む区分の型」を
先に合体してから切り取り、全立体の和集合をとって求める。同じ形状どうしの和集合演算は
一致する面の処理で体積がわずかに欠けるため（実モデルで約0.05m3）、同じ立体を二重に合体しない。
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations

import manifold3d as m3
from shapely.geometry import MultiPolygon, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from shapely.prepared import prep

from .geometry import EPS_VOLUME, Result, Solid, _bbox_overlaps, _union, compute, region_prism


@dataclass
class PourUnit:
    name: str
    z0: float
    z1: float
    region: BaseGeometry | None = None  # None は平面方向に制限なし
    categories: set[str] | None = None
    member_ids: set[str] | None = None

    def accepts(self, s: Solid) -> bool:
        return ((self.categories is None or s.category in self.categories)
                and (self.member_ids is None or s.member_id in self.member_ids))


@dataclass
class Overlap:
    a: int  # 区分の番号（0始まり）
    b: int
    volume: float  # 2つの区分で二重に数えている体積
    shared: Result | None  # そのうち、同じ部材が両方の区分に入っている部分


@dataclass
class UnitsResult:
    results: list[Result]
    overlaps: list[Overlap]
    union_total: float  # 全区分を合わせ、重なりを1回だけ数えた体積

    @property
    def sum_total(self) -> float:
        return sum(r.total for r in self.results)


def region_from_rings(polygons: list[list[list[list[float]]]] | None) -> BaseGeometry | None:
    """[[外周, 穴...], ...] → MultiPolygon"""
    if polygons is None:
        return None
    return MultiPolygon([Polygon(rings[0], rings[1:]) for rings in polygons]).buffer(0)


def _common(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return a & b


def intersect_units(u: PourUnit, v: PourUnit) -> PourUnit | None:
    """2つの区分の共通部分。高さか平面が接するだけで体積を持たない場合は None。"""
    z0, z1 = max(u.z0, v.z0), min(u.z1, v.z1)
    if z1 - z0 <= 1e-9:
        return None
    if u.region is None:
        region = v.region
    elif v.region is None:
        region = u.region
    else:
        region = u.region.intersection(v.region)
        if region.area <= 1e-9:
            return None
    return PourUnit(f"{u.name}∩{v.name}", z0, z1, region,
                    _common(u.categories, v.categories), _common(u.member_ids, v.member_ids))


def _compute_unit(solids: list[Solid], u: PourUnit) -> Result:
    return compute(solids, u.z0, u.z1, region=u.region, categories=u.categories, member_ids=u.member_ids)


def union_volume(solids: list[Solid], units: list[PourUnit]) -> float:
    """複数の区分を合わせた体積（重なりは1回だけ数える）。"""
    preps = [(u, prep(u.region) if u.region is not None else None,
              u.region.bounds if u.region is not None else None) for u in units]
    pieces = []
    for s in solids:
        if s.manifold is None:
            continue
        hits = [u for u, rp, rb in preps if u.accepts(s) and _bbox_overlaps(s, u.z0, u.z1, rp, rb)]
        if not hits:
            continue
        xmin, ymin, zmin, xmax, ymax, zmax = s.bbox
        own = box(xmin - 1, ymin - 1, xmax + 1, ymax + 1)  # 平面方向に制限のない区分の代わり
        by_height: dict[tuple[float, float], list[BaseGeometry]] = {}
        for u in hits:
            by_height.setdefault((u.z0, u.z1), []).append(own if u.region is None else u.region & own)
        prisms = [region_prism(unary_union(regions), z0, z1) for (z0, z1), regions in by_height.items()]
        clip = prisms[0] if len(prisms) == 1 else _union(prisms)
        piece = m3.Manifold.batch_boolean([s.manifold, clip], m3.OpType.Intersect)
        if piece.volume() > EPS_VOLUME:
            pieces.append(piece)
    return _union(pieces).volume() if pieces else 0.0


def compute_units(solids: list[Solid], units: list[PourUnit]) -> UnitsResult:
    results = [_compute_unit(solids, u) for u in units]
    overlaps = []
    for i, j in combinations(range(len(units)), 2):
        if results[i].total <= EPS_VOLUME or results[j].total <= EPS_VOLUME:
            continue
        common = intersect_units(units[i], units[j])
        shared = _compute_unit(solids, common) if common is not None else None
        if shared is not None and shared.total <= EPS_VOLUME:
            shared = None
        volume = results[i].total + results[j].total - union_volume(solids, [units[i], units[j]])
        if volume > 1e-6 or shared is not None:
            overlaps.append(Overlap(i, j, max(volume, shared.total if shared else 0.0), shared))
    union_total = union_volume(solids, units) if len(units) > 1 else sum(r.total for r in results)
    return UnitsResult(results, overlaps, union_total)
