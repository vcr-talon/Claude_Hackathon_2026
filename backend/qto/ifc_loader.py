"""IFCの前処理：コンクリート形状・階・通り芯を取り出す（要件 D20・D21・D27）。

IFCファイルは読み取りのみ。結果はキャッシュファイルに保存し、2回目以降の読込を速くする。
単位はメートル。
"""
from __future__ import annotations

import multiprocessing
import pickle
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as ue
import ifcopenshell.util.placement as up
import ifcopenshell.util.unit as uu
import numpy as np

from .geometry import Solid

CONCRETE_KEYWORD = "コンクリート"
CATEGORY_BY_CLASS = {
    "IfcColumn": "柱",
    "IfcBeam": "梁",
    "IfcWall": "壁",
    "IfcWallStandardCase": "壁",
    "IfcSlab": "スラブ",
    "IfcFooting": "基礎",
    "IfcPile": "基礎",
    "IfcStair": "階段",
    "IfcStairFlight": "階段",
}
CACHE_VERSION = 2  # 2: コンクリート以外の材料の形状も取り出す（数える材料を画面で選べるように）


def is_concrete(material_name: str | None) -> bool:
    return bool(material_name) and CONCRETE_KEYWORD in material_name


@dataclass
class Storey:
    name: str
    elevation: float


@dataclass
class GridAxis:
    tag: str
    start: tuple[float, float]
    end: tuple[float, float]


@dataclass
class Member:
    """数量の内訳・選択の単位となる部材（分解された子部材の親）。"""

    member_id: str
    name: str
    ifc_class: str
    category: str
    storey: str | None
    base_net_volume: float | None  # IFC内の既存数量（照合用。正解とはしない）


@dataclass
class Skipped:
    key: str
    member_id: str
    name: str
    reason: str
    material: str = ""  # 「A / B」の形の材料名


@dataclass
class Model:
    source: str
    schema: str
    storeys: list[Storey]
    grids: list[GridAxis]
    members: dict[str, Member]
    solids: list[Solid]
    materials: dict[str, dict]  # 材料名 → {"count": 件数, "included": 初期状態で数えるか}
    skipped: list[Skipped] = field(default_factory=list)  # 形状変換に失敗した対象部材
    load_seconds: float = 0.0

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        b = np.array([s.bbox for s in self.solids])
        return b[:, 0].min(), b[:, 1].min(), b[:, 3].max(), b[:, 4].max()

    @property
    def default_materials(self) -> set[str]:
        """画面で選ばなかったときに数える材料（名前に「コンクリート」を含む単一材料）。"""
        return {k for k, v in self.materials.items() if v["included"]}


def _material_names(product) -> list[str]:
    mat = ue.get_material(product, should_skip_usage=True)
    if mat is None:
        return []
    if mat.is_a("IfcMaterial"):
        return [mat.Name]
    return [m.Name for m in ue.get_materials(product)]


def _member_of(product):
    """分解された子部材なら親部材を返す。"""
    parent = ue.get_aggregate(product)
    if parent is not None and parent.is_a("IfcElement"):
        return parent
    return product


def _category(member) -> str:
    for cls, cat in CATEGORY_BY_CLASS.items():
        if member.is_a() == cls:
            return cat
    return "その他"


def _storeys(f, scale: float) -> list[Storey]:
    return sorted((Storey(s.Name, (s.Elevation or 0.0) * scale) for s in f.by_type("IfcBuildingStorey")),
                  key=lambda s: s.elevation)


def _grids(f, scale: float) -> list[GridAxis]:
    """通り芯を世界座標で取り出す。U/V/Wの区分は当てにならないため使わず、名称で重複を除く。"""
    axes: dict[str, GridAxis] = {}
    for g in f.by_type("IfcGrid"):
        m = up.get_local_placement(g.ObjectPlacement)
        for a in [*g.UAxes, *g.VAxes, *(g.WAxes or [])]:
            curve = a.AxisCurve
            if not curve.is_a("IfcPolyline"):
                continue
            pts = []
            for p in (curve.Points[0], curve.Points[-1]):
                c = list(p.Coordinates) + [0.0] * (3 - len(p.Coordinates))
                w = m @ np.array([*c, 1.0])
                pts.append((w[0] * scale, w[1] * scale))
            tag = a.AxisTag or f"#{a.id()}"
            if tag not in axes:
                axes[tag] = GridAxis(tag, pts[0], pts[1])
    return sorted(axes.values(), key=lambda a: (a.tag[0], int("".join(c for c in a.tag if c.isdigit()) or 0)))


def _extract(path: Path) -> Model:
    t0 = time.perf_counter()
    f = ifcopenshell.open(str(path))
    scale = uu.calculate_unit_scale(f)  # IFCの長さ単位 → m

    materials: Counter[str] = Counter()
    targets = []  # (product, material)
    for p in f.by_type("IfcElement"):
        if p.is_a("IfcOpeningElement") or not p.Representation:
            continue
        if not any(r.RepresentationIdentifier == "Body" for r in p.Representation.Representations):
            continue
        names = _material_names(p)
        key = " / ".join(names) if names else "（材料なし）"
        materials[key] += 1
        if len(names) == 1:
            # 材料を画面で選べるよう、コンクリート以外も形状を取り出す（数えるのは選んだ材料だけ）
            targets.append((p, names[0]))
        elif len(names) > 1 and any(is_concrete(n) for n in names):
            # 1つの形状に複数材料：コンクリート部分だけを切り出せないため未計算扱い
            targets.append((p, None))

    members: dict[str, Member] = {}
    meta: dict[int, tuple] = {}
    skipped: list[Skipped] = []
    for p, mat in targets:
        mem = _member_of(p)
        if mem.GlobalId not in members:
            storey = ue.get_container(mem)
            bq = ue.get_pset(mem, "BaseQuantities", "NetVolume")
            members[mem.GlobalId] = Member(mem.GlobalId, mem.Name or "", mem.is_a(), _category(mem),
                                           storey.Name if storey else None, bq)
        if mat is None:
            skipped.append(Skipped(p.GlobalId, mem.GlobalId, mem.Name or "",
                                   "1つの形状に複数の材料が含まれ、コンクリート部分を切り出せない",
                                   " / ".join(_material_names(p))))
            continue
        meta[p.id()] = (p.GlobalId, mem.GlobalId, mat)

    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    solids: list[Solid] = []
    done: set[int] = set()
    products = [f.by_id(i) for i in meta]
    if products:
        it = ifcopenshell.geom.iterator(settings, f, multiprocessing.cpu_count(), include=products)
        if it.initialize():
            while True:
                shape = it.get()
                key, member_id, mat = meta[shape.id]
                mem = members[member_id]
                g = shape.geometry
                verts = np.asarray(g.verts, dtype=np.float64).reshape(-1, 3)
                faces = np.asarray(g.faces, dtype=np.int64).reshape(-1, 3)
                solids.append(Solid(key, member_id, mem.name, mem.category, mat, mem.storey, verts, faces))
                done.add(shape.id)
                if not it.next():
                    break
    for pid, (key, member_id, mat) in meta.items():
        if pid not in done:
            skipped.append(Skipped(key, member_id, members[member_id].name, "形状変換に失敗", mat))

    included = {k: is_concrete(k) and " / " not in k for k in materials}
    return Model(str(path), f.schema, _storeys(f, scale), _grids(f, scale), members, solids,
                 {k: {"count": n, "included": included[k]} for k, n in materials.most_common()},
                 skipped, time.perf_counter() - t0)


def _cache_path(path: Path, cache_dir: Path) -> Path:
    st = path.stat()
    return cache_dir / f"{path.stem}-{st.st_size}-{int(st.st_mtime)}-v{CACHE_VERSION}.pkl"


def load_model(path: str | Path, cache_dir: str | Path | None = None) -> Model:
    """IFCを読み込み、閉じた立体を構築したモデルを返す。キャッシュがあればそれを使う。"""
    path = Path(path)
    cache_dir = Path(cache_dir) if cache_dir else path.parent / ".qto_cache"
    cache = _cache_path(path, cache_dir)
    if cache.exists():
        t0 = time.perf_counter()
        with cache.open("rb") as fp:
            model: Model = pickle.load(fp)
        model.load_seconds = time.perf_counter() - t0
    else:
        model = _extract(path)
        cache_dir.mkdir(parents=True, exist_ok=True)
        with cache.open("wb") as fp:
            pickle.dump(model, fp)  # 立体（manifold）は保存できないため頂点・面のみ
    for s in model.solids:
        s.build()
    return model
