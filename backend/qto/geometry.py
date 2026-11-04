"""切断・合体・体積の計算（要件 D1・D3・D4・D26）。

単位はすべてメートル。部材形状を閉じた立体（manifold）として扱い、
工区の多角形を高さ範囲で立ち上げた柱状の型で切り取り、和集合の体積を求める。
"""
from __future__ import annotations

from collections.abc import Callable
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

    @property
    def reference_volume(self) -> float | None:
        """閉じた立体にできなかった形の参考体積（総数量には含めない）。

        面の向きをそろえてから表面で計算する。部材を囲む箱の体積を超えるときは
        あてにならないため None（画面では「形状が壊れているため参考体積なし」）。
        """
        v, f = _weld(self.vertices, self.faces)
        if len(f) == 0:
            return None
        vol = mesh_volume(v, _orient_faces(f))
        b = np.asarray(self.bbox if self.bbox else (*self.vertices.min(axis=0), *self.vertices.max(axis=0)))
        box_volume = float(np.prod(b[3:] - b[:3]))
        return vol if vol <= box_volume * (1 + 1e-6) else None


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


def _edges(faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """向きを無視した辺と、その辺を持つ面の数。"""
    e = np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1)
    return np.unique(e, axis=0, return_counts=True)


def _split_t_junctions(vertices: np.ndarray, faces: np.ndarray, rounds: int = 10) -> np.ndarray:
    """辺の分け方の食い違い（T字の継ぎ目）を直す。

    片側の面が1本で持つ辺を、反対側の面が途中の頂点で分けて持っているとき、
    1本の側の三角形をその頂点で分け直す。頂点は増やさず、形も変えない（面のつなぎ方だけ）。
    """
    for _ in range(rounds):
        edges, counts = _edges(faces)
        open_edges = {tuple(e) for e in edges[counts == 1]}
        if not open_edges:
            break
        cand = np.array(sorted({i for e in open_edges for i in e}))
        new, changed = [], False
        for tri in faces:
            pieces = [tuple(tri)]
            for k in range(3):
                a, b = tri[k], tri[(k + 1) % 3]
                if (min(a, b), max(a, b)) not in open_edges:
                    continue
                ab = vertices[b] - vertices[a]
                t = ((vertices[cand] - vertices[a]) @ ab) / (ab @ ab)
                d = np.linalg.norm(vertices[a] + np.outer(t, ab) - vertices[cand], axis=1)
                inner = (t > 1e-9) & (t < 1 - 1e-9) & (d < WELD_TOLERANCE)
                if not inner.any():
                    continue
                chain = [a, *cand[inner][np.argsort(t[inner])], b]
                c = tri[(k + 2) % 3]
                pieces = [(chain[i], chain[i + 1], c) for i in range(len(chain) - 1)]
                changed = True
                break  # 1つの三角形は1辺ずつ（残りの辺は次の回で）
            new.extend(pieces)
        faces = np.array(new, dtype=np.int64)
        if not changed:
            break
    return faces


def _orient_faces(faces: np.ndarray) -> np.ndarray:
    """面の向きをそろえる（隣り合う面が辺を逆向きに共有するように）。裏返った面だけを直す。"""
    faces = faces.copy()
    edge_faces: dict[tuple[int, int], list[int]] = {}
    for i, t in enumerate(faces):
        for k in range(3):
            a, b = int(t[k]), int(t[(k + 1) % 3])
            edge_faces.setdefault((min(a, b), max(a, b)), []).append(i)
    seen = np.zeros(len(faces), bool)
    for start in range(len(faces)):
        if seen[start]:
            continue
        seen[start] = True
        queue = [start]
        while queue:
            i = queue.pop()
            t = faces[i]
            for k in range(3):
                a, b = int(t[k]), int(t[(k + 1) % 3])
                for j in edge_faces[(min(a, b), max(a, b))]:
                    if seen[j]:
                        continue
                    u = faces[j]
                    if any(u[m] == a and u[(m + 1) % 3] == b for m in range(3)):  # 同じ向き＝裏返り
                        faces[j] = u[::-1]
                    seen[j] = True
                    queue.append(j)
    return faces


def build_manifold(vertices: np.ndarray, faces: np.ndarray) -> tuple[m3.Manifold | None, str | None]:
    """閉じた立体に変換する。直らない場合は (None, 理由) を返す。

    1. そのまま　2. 近い頂点を結合　3. さらに辺の分け方の食い違いと裏返った面を直す。
    3 は面のつなぎ方と向きだけを直し、穴を埋めたり形を推測したりはしない（D4）。
    念のため、直した体積が部材を囲む箱を超えるときは採用しない。
    """
    if len(faces) < 4:
        return None, "形状データが空または不足"
    welded = _weld(vertices, faces)
    attempts = [(vertices, faces), welded]
    if len(welded[1]) >= 4:
        attempts.append((welded[0], _orient_faces(_split_t_junctions(*welded))))
    box_volume = float(np.prod(vertices.max(axis=0) - vertices.min(axis=0)))
    for verts, tris in attempts:
        man = _to_manifold(verts, tris)
        if man.status() == m3.Error.NoError and not man.is_empty():
            if man.volume() < 0:  # 面の向きが裏返っている
                man = _to_manifold(verts, tris[:, ::-1])
            if man.volume() <= box_volume * (1 + 1e-6):
                return man, None
    return None, "形のデータが閉じていない（面の抜けなど）ため、切って数えられない"


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
    reference_volume: float | None  # 立体全体の参考体積（総数量には含めない）。あてにならないときは None


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
    excluded: float = 0.0  # 登録済みの区分と重なるため差し引いた体積
    excluded_pieces: list[m3.Manifold] = field(default_factory=list, repr=False)

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
            category_order: list[str] = CATEGORY_ORDER,
            exclude: Callable[[Solid], m3.Manifold | None] | None = None,
            materials: set[str] | None = None) -> Result:
    """打設区分（工区 × 高さ範囲 × 部材の絞り込み）のコンクリート体積を計算する。

    region が None の場合は平面方向に制限しない（高さ範囲のみ）。
    materials は数える材料名（None はすべて）。
    exclude は立体ごとに「差し引く型」を返す関数（登録済みの区分の除外に使う）。
    """
    if z0 > z1:
        z0, z1 = z1, z0
    if region is not None and region.is_empty:
        return Result(z0, z1, 0.0, 0.0, {}, {}, [], [])

    candidates = [s for s in solids
                  if (categories is None or s.category in categories)
                  and (member_ids is None or s.member_id in member_ids)
                  and (materials is None or s.material in materials)]
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
    excluded_pieces: list[m3.Manifold] = []
    for s in candidates:
        if s.manifold is None:
            uncomputed.append(Uncomputed(s.member_id, s.member_name, s.category, s.key,
                                         s.error or "不明", s.reference_volume))
            continue
        xmin, ymin, zmin, xmax, ymax, zmax = s.bbox
        if z0 <= zmin and zmax <= z1 and region_prep.contains(box(xmin, ymin, xmax, ymax)):
            piece = s.manifold  # 全体が範囲内なので切断不要
        else:
            piece = m3.Manifold.batch_boolean([s.manifold, prism], m3.OpType.Intersect)
        cut = exclude(s) if exclude is not None else None
        if cut is not None:
            removed = m3.Manifold.batch_boolean([piece, cut], m3.OpType.Intersect)
            if removed.volume() > EPS_VOLUME:
                excluded_pieces.append(removed)
                piece = m3.Manifold.batch_boolean([piece, cut], m3.OpType.Subtract)
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
    excluded = _union(excluded_pieces).volume() if excluded_pieces else 0.0
    return Result(z0, z1, total, sum(v for _, _, v in pieces), by_category, by_material,
                  sorted(members.values(), key=lambda m: -m.volume), uncomputed, union,
                  excluded, excluded_pieces)
