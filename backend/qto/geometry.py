"""切断・合体・体積の計算（要件 D1・D3・D4・D26）。

単位はすべてメートル。部材形状を閉じた立体（manifold）として扱い、
工区の多角形を高さ範囲で立ち上げた柱状の型で切り取り、和集合の体積を求める。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import manifold3d as m3
import numpy as np
from shapely.geometry import MultiPolygon, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.geometry.polygon import orient
from shapely.prepared import prep

CATEGORY_ORDER = ["柱", "梁", "壁", "スラブ", "基礎", "階段", "その他"]
EXTRA_MATERIAL_KEYWORD = "増し打ち"
EPS_VOLUME = 1e-9  # m3。これ未満の切断片は「範囲外」とみなす
WELD_TOLERANCE = 1e-4  # m。閉じていない形状の修復時に頂点を結合する距離（0.1mm）


@dataclass
class Solid:
    """数量計算の最小単位となる1つの立体。"""

    key: str  # 立体自身のGlobalId（分解された子部材ならその子のGlobalId）
    member_id: str  # 部材のGlobalId（子部材なら親）
    member_name: str
    category: str
    material: str
    storey: str | None
    vertices: np.ndarray  # (n, 3) float64
    faces: np.ndarray  # (m, 3) int
    manifold: m3.Manifold | None = field(default=None, repr=False, compare=False)
    error: str | None = None
    bbox: tuple[float, float, float, float, float, float] = ()

    def build(self) -> "Solid":
        self.bbox = (*self.vertices.min(axis=0), *self.vertices.max(axis=0))
        self.manifold, self.error = build_manifold(self.vertices, self.faces)
        return self

    @property
    def mesh_volume(self) -> float:
        return mesh_volume(self.vertices, self.faces)


def mesh_volume(vertices: np.ndarray, faces: np.ndarray) -> float:
    """発散定理による体積。閉じていない形状では参考値にしかならない。"""
    v = vertices[faces]
    return abs(float(np.einsum("ij,ij->i", v[:, 0], np.cross(v[:, 1], v[:, 2])).sum()) / 6.0)


def _to_manifold(vertices: np.ndarray, faces: np.ndarray) -> m3.Manifold:
    mesh = m3.Mesh64(vert_properties=np.ascontiguousarray(vertices, dtype=np.float64),
                     tri_verts=np.ascontiguousarray(faces, dtype=np.uint64))
    mesh.merge()
    return m3.Manifold(mesh)


def _weld(vertices: np.ndarray, faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """近接頂点を結合し、つぶれた三角形を除く。"""
    keys = np.round(vertices / WELD_TOLERANCE).astype(np.int64)
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    new_faces = inverse.reshape(-1)[faces]
    ok = (new_faces[:, 0] != new_faces[:, 1]) & (new_faces[:, 1] != new_faces[:, 2]) \
        & (new_faces[:, 0] != new_faces[:, 2])
    return vertices[first], new_faces[ok]


def build_manifold(vertices: np.ndarray, faces: np.ndarray) -> tuple[m3.Manifold | None, str | None]:
    """閉じた立体に変換する。直らない場合は (None, 理由) を返す。"""
    if len(faces) < 4:
        return None, "形状データが空または不足"
    attempts = [(vertices, faces), _weld(vertices, faces)]
    status = None
    for verts, tris in attempts:
        man = _to_manifold(verts, tris)
        status = man.status()
        if status == m3.Error.NoError and not man.is_empty():
            if man.volume() < 0:  # 面の向きが裏返っている
                man = _to_manifold(verts, tris[:, ::-1])
            return man, None
    return None, f"閉じた立体にできない形状（{status.name}）"


def region_prism(region: BaseGeometry, z0: float, z1: float) -> m3.Manifold:
    """平面の多角形を z0〜z1 の柱状の立体にする。"""
    polys = region.geoms if isinstance(region, MultiPolygon) else [region]
    contours = []
    for p in polys:
        if p.is_empty:
            continue
        p = orient(p, 1.0)  # 外周は反時計回り、穴は時計回り
        contours.append(np.asarray(p.exterior.coords[:-1], dtype=np.float64))
        contours.extend(np.asarray(r.coords[:-1], dtype=np.float64) for r in p.interiors)
    cs = m3.CrossSection(contours, m3.FillRule.Positive)
    return m3.Manifold.extrude(cs, z1 - z0).translate([0.0, 0.0, z0])


def _union(manifolds: list[m3.Manifold]) -> m3.Manifold:
    return m3.Manifold.batch_boolean(manifolds, m3.OpType.Add)


def priority_breakdown(groups: dict[str, list[m3.Manifold]], order: list[str]
                       ) -> tuple[dict[str, float], m3.Manifold | None]:
    """順位の高いグループとの重なりを下位から差し引いて配分する。内訳の合計は和集合の体積と一致する。"""
    ordered = [k for k in order if k in groups] + sorted(k for k in groups if k not in order)
    result: dict[str, float] = {}
    cumulative: m3.Manifold | None = None
    for key in ordered:
        u = _union(groups[key])
        part = u if cumulative is None else m3.Manifold.batch_boolean([u, cumulative], m3.OpType.Subtract)
        result[key] = part.volume()
        cumulative = u if cumulative is None else _union([cumulative, u])
    return result, cumulative


def material_order(materials: set[str]) -> list[str]:
    """普通コンクリートを先、増し打ちを後に配分する。"""
    return sorted(materials, key=lambda m: (EXTRA_MATERIAL_KEYWORD in m, m))


@dataclass
class MemberVolume:
    member_id: str
    member_name: str
    category: str
    storey: str | None
    volume: float  # 範囲内に切り取った体積（他部材との重複控除前）
    solid_keys: list[str]


@dataclass
class Uncomputed:
    member_id: str
    member_name: str
    category: str
    key: str
    reason: str
    reference_volume: float  # 立体全体の参考体積（総数量には含めない）


@dataclass
class Result:
    z0: float
    z1: float
    total: float  # 重複を除いた総体積
    raw_sum: float  # 切り取った部材体積の単純合計（重複控除前）
    by_category: dict[str, float]
    by_material: dict[str, float]
    members: list[MemberVolume]
    uncomputed: list[Uncomputed]
    union: m3.Manifold | None = field(default=None, repr=False)

    @property
    def overlap(self) -> float:
        """重複として控除した体積。"""
        return self.raw_sum - self.total


def _bbox_overlaps(s: Solid, z0: float, z1: float, region_prep, region_bounds) -> bool:
    xmin, ymin, zmin, xmax, ymax, zmax = s.bbox
    if zmax <= z0 or zmin >= z1:
        return False
    if region_prep is None:
        return True
    rx0, ry0, rx1, ry1 = region_bounds
    if xmax < rx0 or xmin > rx1 or ymax < ry0 or ymin > ry1:
        return False
    return region_prep.intersects(box(xmin, ymin, xmax, ymax))


def compute(solids: list[Solid], z0: float, z1: float, region: BaseGeometry | None = None,
            categories: set[str] | None = None, member_ids: set[str] | None = None,
            category_order: list[str] = CATEGORY_ORDER) -> Result:
    """打設区分（工区 × 高さ範囲 × 部材の絞り込み）のコンクリート体積を計算する。

    region が None の場合は平面方向に制限しない（高さ範囲のみ）。
    """
    if z0 > z1:
        z0, z1 = z1, z0
    if region is not None and region.is_empty:
        return Result(z0, z1, 0.0, 0.0, {}, {}, [], [])

    candidates = [s for s in solids
                  if (categories is None or s.category in categories)
                  and (member_ids is None or s.member_id in member_ids)]
    region_prep = prep(region) if region is not None else None
    region_bounds = region.bounds if region is not None else None
    candidates = [s for s in candidates if _bbox_overlaps(s, z0, z1, region_prep, region_bounds)]

    if region is None and candidates:
        b = np.array([s.bbox for s in candidates])
        region = box(b[:, 0].min() - 1, b[:, 1].min() - 1, b[:, 3].max() + 1, b[:, 4].max() + 1)
        region_prep = prep(region)
    prism = region_prism(region, z0, z1) if candidates else None

    uncomputed: list[Uncomputed] = []
    pieces: list[tuple[Solid, m3.Manifold, float]] = []
    for s in candidates:
        if s.manifold is None:
            uncomputed.append(Uncomputed(s.member_id, s.member_name, s.category, s.key,
                                         s.error or "不明", s.mesh_volume))
            continue
        xmin, ymin, zmin, xmax, ymax, zmax = s.bbox
        if z0 <= zmin and zmax <= z1 and region_prep.contains(box(xmin, ymin, xmax, ymax)):
            piece = s.manifold  # 全体が範囲内なので切断不要
        else:
            piece = m3.Manifold.batch_boolean([s.manifold, prism], m3.OpType.Intersect)
        v = piece.volume()
        if v > EPS_VOLUME:
            pieces.append((s, piece, v))

    by_cat_groups: dict[str, list[m3.Manifold]] = {}
    by_mat_groups: dict[str, list[m3.Manifold]] = {}
    members: dict[str, MemberVolume] = {}
    for s, piece, v in pieces:
        by_cat_groups.setdefault(s.category, []).append(piece)
        by_mat_groups.setdefault(s.material, []).append(piece)
        mv = members.setdefault(s.member_id, MemberVolume(s.member_id, s.member_name, s.category,
                                                          s.storey, 0.0, []))
        mv.volume += v
        mv.solid_keys.append(s.key)

    by_category, union = priority_breakdown(by_cat_groups, category_order)
    if len(by_mat_groups) > 1:
        by_material, _ = priority_breakdown(by_mat_groups, material_order(set(by_mat_groups)))
    else:
        by_material = {k: sum(p.volume() for p in g) for k, g in by_mat_groups.items()}
    total = union.volume() if union is not None else 0.0
    return Result(z0, z1, total, sum(v for _, _, v in pieces), by_category, by_material,
                  sorted(members.values(), key=lambda m: -m.volume), uncomputed, union)
