"""打設区分（要件 D22・D23）：複数の条件を登録し、区分ごとの数量と区分どうしの重なりを求める。

条件（PourUnit）= 工区の多角形 × 高さ範囲 × 部材の絞り込み。
区分（Unit）= 1つ以上の条件の集まり（例：5F A工区 ＋ 上階に立ち上がるパラペット）。

「登録済みの部分を除く」場合は、先に登録した区分を優先し、後の区分や現在の計算から
先の区分と重なる部分を差し引く。こうすると区分の合計がそのまま二重拾いのない数量になる。

重なりは2種類ある。
- 同じ部材の同じ部分が2つの区分に入っている（登録の誤り。条件の共通部分を compute() で求める）
- 別々の部材どうしがモデル上で食い込んでいる部分（柱とスラブの取り合いなど）

合体した体積は、立体ごとに「その立体を含む条件の型」を先に合体してから切り取り、
全立体の和集合をとって求める。同じ形状どうしの和集合演算は一致する面の処理で
体積がわずかに欠けるため（実モデルで約0.05m3）、同じ立体を二重に合体しない。
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from itertools import combinations, product

import manifold3d as m3
from shapely.geometry import MultiPolygon, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from shapely.prepared import prep

from .geometry import EPS_VOLUME, MemberVolume, Solid, _bbox_overlaps, _union, compute, region_prism


@dataclass
class PourUnit:
    """区分を構成する1つの条件。"""

    name: str
    z0: float
    z1: float
    region: BaseGeometry | None = None  # None は平面方向に制限なし
    categories: set[str] | None = None
    member_ids: set[str] | None = None
    materials: set[str] | None = None  # 数える材料名（None はすべて）

    def accepts(self, s: Solid) -> bool:
        return ((self.categories is None or s.category in self.categories)
                and (self.member_ids is None or s.member_id in self.member_ids)
                and (self.materials is None or s.material in self.materials))


@dataclass
class Unit:
    name: str
    parts: list[PourUnit]


@dataclass
class UnitTotal:
    total: float
    member_ids: set[str] = field(default_factory=set)
    uncomputed: int = 0
    # 部材明細：(部材ID, 材料) → 区分に入った体積（重複控除前）と、未計算の立体
    member_volumes: dict[tuple[str, str], float] = field(default_factory=dict)
    uncomputed_solids: list[Solid] = field(default_factory=list)


@dataclass
class Overlap:
    a: int  # 区分の番号（0始まり）
    b: int
    volume: float  # 2つの区分で二重に数えている体積
    shared_volume: float  # そのうち、同じ部材が両方の区分に入っている部分
    shared_members: list[MemberVolume]


@dataclass
class UnitsResult:
    results: list[UnitTotal]
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
    """2つの条件の共通部分。高さか平面が接するだけで体積を持たない場合は None。"""
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
                    _common(u.categories, v.categories), _common(u.member_ids, v.member_ids),
                    _common(u.materials, v.materials))


class _Clipper:
    """立体ごとに、複数の条件をまとめた切り取り型を作る。"""

    def __init__(self, parts: list[PourUnit]):
        self.parts = [(u, prep(u.region) if u.region is not None else None,
                       u.region.bounds if u.region is not None else None) for u in parts]

    def __call__(self, s: Solid) -> m3.Manifold | None:
        hits = [u for u, rp, rb in self.parts if u.accepts(s) and _bbox_overlaps(s, u.z0, u.z1, rp, rb)]
        if not hits:
            return None
        xmin, ymin, _, xmax, ymax, _ = s.bbox
        own = box(xmin - 1, ymin - 1, xmax + 1, ymax + 1)  # 平面方向に制限のない条件の代わり
        by_height: dict[tuple[float, float], list[BaseGeometry]] = {}
        for u in hits:
            by_height.setdefault((u.z0, u.z1), []).append(own if u.region is None else u.region & own)
        prisms = [region_prism(unary_union(regions), z0, z1) for (z0, z1), regions in by_height.items()]
        return prisms[0] if len(prisms) == 1 else _union(prisms)


def make_excluder(parts: list[PourUnit]) -> Callable[[Solid], m3.Manifold | None] | None:
    return _Clipper(parts) if parts else None


def fully_excluded_keys(solids: list[Solid], z0: float, z1: float,
                        exclude: Callable[[Solid], m3.Manifold | None] | None) -> list[str]:
    """高さ範囲内の部分がすべて登録済みの区分に含まれる立体のキー。

    表示でこれらの元の形状を隠し、灰色の除外部分と面が重なってちらつくのを防ぐ。
    """
    if exclude is None:
        return []
    keys = []
    for s in solids:
        if s.manifold is None or s.bbox[5] <= z0 or s.bbox[2] >= z1:
            continue
        cut = exclude(s)
        if cut is None:
            continue
        xmin, ymin, zmin, xmax, ymax, zmax = s.bbox
        piece = s.manifold
        if zmin < z0 or zmax > z1:
            piece = m3.Manifold.batch_boolean(
                [piece, region_prism(box(xmin - 1, ymin - 1, xmax + 1, ymax + 1), z0, z1)], m3.OpType.Intersect)
        if m3.Manifold.batch_boolean([piece, cut], m3.OpType.Subtract).volume() <= EPS_VOLUME:
            keys.append(s.key)
    return keys


def _unit_total(solids: list[Solid], parts: list[PourUnit], exclude_parts: list[PourUnit] | None = None
                ) -> tuple[UnitTotal, list[m3.Manifold]]:
    clip, cut = _Clipper(parts), make_excluder(exclude_parts or [])
    result = UnitTotal(0.0)
    pieces = []
    for s in solids:
        c = clip(s)
        if c is None:
            continue
        if s.manifold is None:
            result.uncomputed += 1
            result.uncomputed_solids.append(s)
            continue
        piece = m3.Manifold.batch_boolean([s.manifold, c], m3.OpType.Intersect)
        e = cut(s) if cut is not None else None
        if e is not None:
            piece = m3.Manifold.batch_boolean([piece, e], m3.OpType.Subtract)
        if (v := piece.volume()) > EPS_VOLUME:
            pieces.append(piece)
            result.member_ids.add(s.member_id)
            k = (s.member_id, s.material)
            result.member_volumes[k] = result.member_volumes.get(k, 0.0) + v
    result.total = _union(pieces).volume() if pieces else 0.0
    return result, pieces


def union_volume(solids: list[Solid], parts: list[PourUnit]) -> float:
    """複数の条件を合わせた体積（重なりは1回だけ数える）。"""
    return _unit_total(solids, parts)[0].total


def _as_unit(u: Unit | PourUnit) -> Unit:
    return u if isinstance(u, Unit) else Unit(u.name, [u])


def _shared(solids: list[Solid], a: Unit, b: Unit) -> tuple[float, list[MemberVolume]]:
    """同じ部材が両方の区分に入っている部分。"""
    commons = [c for p, q in product(a.parts, b.parts) if (c := intersect_units(p, q)) is not None]
    if not commons:
        return 0.0, []
    members: dict[str, MemberVolume] = {}
    for c in commons:
        r = compute(solids, c.z0, c.z1, region=c.region, categories=c.categories, member_ids=c.member_ids,
                    materials=c.materials)
        for m in r.members:
            if m.member_id not in members or members[m.member_id].volume < m.volume:
                members[m.member_id] = m
    if not members:
        return 0.0, []
    return union_volume(solids, commons), sorted(members.values(), key=lambda m: -m.volume)


def compute_units(solids: list[Solid], units: list[Unit | PourUnit], exclude_registered: bool = False
                  ) -> UnitsResult:
    """区分ごとの数量。exclude_registered なら先に登録した区分を優先して重なりを差し引く。"""
    units = [_as_unit(u) for u in units]
    results = []
    for i, u in enumerate(units):
        earlier = [p for v in units[:i] for p in v.parts] if exclude_registered else None
        results.append(_unit_total(solids, u.parts, earlier)[0])

    overlaps = []
    if not exclude_registered:
        for i, j in combinations(range(len(units)), 2):
            if results[i].total <= EPS_VOLUME or results[j].total <= EPS_VOLUME:
                continue
            shared_volume, shared_members = _shared(solids, units[i], units[j])
            volume = results[i].total + results[j].total - union_volume(solids, units[i].parts + units[j].parts)
            if volume > 1e-6 or shared_members:
                overlaps.append(Overlap(i, j, max(volume, shared_volume), shared_volume, shared_members))
    all_parts = [p for u in units for p in u.parts]
    union_total = union_volume(solids, all_parts) if len(all_parts) > 1 else sum(r.total for r in results)
    return UnitsResult(results, overlaps, union_total)
