"""ローカルWebサーバー。計算エンジンを画面（ブラウザ）から使えるようにする。

起動: .venv\\Scripts\\python.exe backend\\server.py [IFCパス]
外部への通信は行わず、127.0.0.1 でのみ待ち受ける。
"""
from __future__ import annotations

import base64
import os
import shutil
import sys
import threading
import webbrowser
from datetime import datetime
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from shapely.geometry import MultiPolygon
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qto.geometry import CATEGORY_ORDER, Result, compute  # noqa: E402
from qto.ifc_loader import Model, load_model  # noqa: E402
from qto.partition import ZoneSeed, assign_zones, split_regions  # noqa: E402
from qto.site_export import export_cell, split_cells  # noqa: E402
from qto.units import (  # noqa: E402
    PourUnit, Unit, compute_units, fully_excluded_keys, make_excluder, region_from_rings,
)

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
UPLOADS = ROOT / ".qto_uploads"
DEFAULT_IFC = ROOT / "hackathon_model.ifc"
HOST = "127.0.0.1"
PORT = int(os.environ.get("QTO_PORT") or os.environ.get("PORT") or 8765)

app = FastAPI(title="IFCコンクリート数量算出")
state: dict[str, Model | None] = {"model": None}


def get_model() -> Model:
    model = state["model"]
    if model is None:
        raise HTTPException(409, "IFCが読み込まれていません")
    return model


def _b64(a: np.ndarray, dtype) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype=dtype).tobytes()).decode()


def _rings(geom) -> list[list[list[list[float]]]]:
    """(Multi)Polygon → [ [外周, 穴...], ... ]"""
    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    return [[[list(c) for c in p.exterior.coords]] + [[list(c) for c in r.coords] for r in p.interiors]
            for p in polys if not p.is_empty]


def model_meta(model: Model) -> dict:
    uncomputed = [{"key": s.key, "member_id": s.member_id, "name": s.member_name, "category": s.category,
                   "material": s.material, "reason": s.error, "reference_volume": s.mesh_volume}
                  for s in model.solids if s.manifold is None]
    uncomputed += [{"key": s.key, "member_id": s.member_id, "name": s.name, "category": None,
                    "material": s.material, "reason": s.reason, "reference_volume": None} for s in model.skipped]
    return {
        "source": Path(model.source).name,
        "schema": model.schema,
        "storeys": [{"name": s.name, "elevation": s.elevation} for s in model.storeys],
        "grids": [{"tag": a.tag, "start": a.start, "end": a.end} for a in model.grids],
        "bounds": model.bounds,
        "z_range": [min(s.bbox[2] for s in model.solids), max(s.bbox[5] for s in model.solids)],
        "materials": model.materials,
        "categories": [c for c in CATEGORY_ORDER if any(s.category == c for s in model.solids)],
        "members": {m.member_id: {"name": m.name, "category": m.category, "storey": m.storey,
                                  "ifc_class": m.ifc_class} for m in model.members.values()},
        "uncomputed": uncomputed,
        "solid_count": sum(1 for s in model.solids if s.material in model.default_materials),
    }


@app.get("/api/model")
def api_model():
    return model_meta(get_model())


@app.get("/api/meshes")
def api_meshes():
    """表示用の形状。座標はfloat32、面はuint32をbase64で送る。"""
    model = get_model()
    return [{"key": s.key, "member_id": s.member_id, "category": s.category, "material": s.material,
             "ok": s.manifold is not None,
             "pos": _b64(s.vertices, np.float32), "idx": _b64(s.faces, np.uint32)}
            for s in model.solids]


@app.post("/api/open")
async def api_open(file: UploadFile):
    if not file.filename.lower().endswith(".ifc"):
        raise HTTPException(400, "IFCファイルを選択してください")
    UPLOADS.mkdir(exist_ok=True)
    dest = UPLOADS / Path(file.filename).name
    with dest.open("wb") as fp:
        shutil.copyfileobj(file.file, fp)
    state["model"] = load_model(dest)
    return model_meta(state["model"])


class Seed(BaseModel):
    label: str
    x: float
    y: float


class PartRequest(BaseModel):
    """区分を構成する1つの条件。"""

    z0: float
    z1: float
    polygons: list[list[list[tuple[float, float]]]] | None = None
    categories: list[str] | None = None
    member_ids: list[str] | None = None
    materials: list[str] | None = None  # 省略時はコンクリートの材料（この機能より前に保存した区分もこの扱い）

    def to_part(self, model: Model, name: str = "") -> PourUnit:
        return PourUnit(name, min(self.z0, self.z1), max(self.z0, self.z1), region_from_rings(self.polygons),
                        set(self.categories) if self.categories is not None else None,
                        set(self.member_ids) if self.member_ids is not None else None,
                        _materials(model, self.materials))


def _materials(model: Model, names: list[str] | None) -> set[str]:
    return set(names) if names is not None else model.default_materials


class ComputeRequest(BaseModel):
    z0: float
    z1: float
    boundaries: list[list[tuple[float, float]]] = []
    seeds: list[Seed] = []
    categories: list[str] | None = None
    member_ids: list[str] | None = None
    materials: list[str] | None = None  # 数える材料（省略時はコンクリートの材料）
    exclude_parts: list[PartRequest] = []  # 登録済みの区分の条件（重なる部分を差し引く）


def _mesh_json(pieces: list) -> dict | None:
    """切断片をまとめて1つの表示用メッシュにする。"""
    verts, tris, offset = [], [], 0
    for p in pieces:
        m = p.to_mesh()
        v = np.asarray(m.vert_properties)[:, :3]
        verts.append(v)
        tris.append(np.asarray(m.tri_verts) + offset)
        offset += len(v)
    if not verts:
        return None
    return {"pos": _b64(np.vstack(verts), np.float32), "idx": _b64(np.vstack(tris), np.uint32)}


def _result_json(r: Result, label: str, region) -> dict:
    return {
        "label": label,
        "total": r.total,
        "excluded": r.excluded,
        "raw_sum": r.raw_sum,
        "overlap": r.overlap,
        "by_category": r.by_category,
        "by_material": r.by_material,
        "members": [{"member_id": m.member_id, "name": m.member_name, "category": m.category, "storey": m.storey,
                     "volume": m.volume} for m in r.members],
        "uncomputed": [{"member_id": u.member_id, "name": u.member_name, "category": u.category,
                        "key": u.key, "reason": u.reason, "reference_volume": u.reference_volume}
                       for u in r.uncomputed],
        "polygons": _rings(region) if region is not None else None,
    }


@app.post("/api/compute")
def api_compute(req: ComputeRequest):
    model = get_model()
    try:
        regions = split_regions(model.bounds, req.boundaries) if req.boundaries else None
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    cats = set(req.categories) if req.categories is not None else None
    ids = set(req.member_ids) if req.member_ids is not None else None
    mats = _materials(model, req.materials)
    exclude = make_excluder([p.to_part(model) for p in req.exclude_parts])

    zones: dict = {}
    if regions is not None and req.seeds:
        zones = assign_zones(regions, [ZoneSeed(s.label, s.x, s.y) for s in req.seeds])
    if not zones:
        zones = {"範囲全体": None}
    results, excluded_pieces = [], []
    for label, poly in sorted(zones.items()):
        r = compute(model.solids, req.z0, req.z1, region=poly, categories=cats, member_ids=ids, exclude=exclude,
                    materials=mats)
        results.append(_result_json(r, label, poly))
        excluded_pieces += r.excluded_pieces
    return {
        "z0": min(req.z0, req.z1),
        "z1": max(req.z0, req.z1),
        "zones": results,
        "regions": [_rings(r) for r in regions] if regions is not None else [],
        "excluded_mesh": _mesh_json(excluded_pieces),
        "hidden_keys": fully_excluded_keys(model.solids, min(req.z0, req.z1), max(req.z0, req.z1), exclude)
        if excluded_pieces else [],
    }


class UnitRequest(BaseModel):
    name: str
    parts: list[PartRequest]


class UnitsRequest(BaseModel):
    units: list[UnitRequest]
    exclude_registered: bool = True
    detail: bool = False  # 部材明細も返す（CSV書き出し用）


def _unit_members(model: Model, r) -> list[dict]:
    """区分の部材明細。体積は区分に入った部分（重複控除前）。未計算の立体は体積なしで理由を付ける。"""
    rows = []
    for (member_id, material), volume in sorted(r.member_volumes.items()):
        m = model.members[member_id]
        rows.append({"member_id": member_id, "name": m.name, "category": m.category, "storey": m.storey,
                     "material": material, "volume": volume, "reason": None})
    for s in r.uncomputed_solids:
        rows.append({"member_id": s.member_id, "name": s.member_name, "category": s.category, "storey": s.storey,
                     "material": s.material, "volume": None, "reason": s.error or "形状不備"})
    return rows


@app.post("/api/units")
def api_units(req: UnitsRequest):
    model = get_model()
    units = [Unit(u.name, [p.to_part(model, u.name) for p in u.parts]) for u in req.units]
    res = compute_units(model.solids, units, exclude_registered=req.exclude_registered)
    return {
        "units": [{"name": u.name, "total": r.total, "member_count": len(r.member_ids),
                   "uncomputed_count": r.uncomputed, **({"members": _unit_members(model, r)} if req.detail else {})}
                  for u, r in zip(units, res.results)],
        "sum_total": res.sum_total,
        "union_total": res.union_total,
        "overlaps": [{"a": o.a, "b": o.b, "volume": o.volume, "shared_volume": o.shared_volume,
                      "members": [{"member_id": m.member_id, "name": m.member_name, "category": m.category,
                                   "volume": m.volume} for m in o.shared_members]}
                     for o in res.overlaps],
    }


class SiteCellRequest(BaseModel):
    id: str
    label: str
    ring: list[tuple[float, float]]


class SiteZone(BaseModel):
    key: str  # 工区のキー（A〜F）。スパンのIDに付ける
    name: str  # 表示名（「A」や「1工区」）
    polygons: list[list[list[tuple[float, float]]]]


class ExportSiteRequest(BaseModel):
    """打設当日のタブレット用データ（docs/site_app_spec.md）。進捗を出せるよう、スパンを分けて送れる。"""

    cells: list[SiteCellRequest]
    z0: float
    z1: float
    categories: list[str] | None = None  # 省略時は全種別
    materials: list[str] | None = None  # 省略時はコンクリートの材料
    step: float = 0.05
    zones: list[SiteZone] | None = None  # 工区で分けているとき：スパンを工区の境界で切る
    header: bool = True  # False ならスパンの表だけ返す（2回目以降の分割送信）
    title: str = ""
    conditions: list[str] = []
    truck_m3: float = 4.25
    extra_pct: float = 0.0


def _site_cells(cells: list[SiteCellRequest], zones: list[SiteZone] | None):
    """スパン（工区があれば工区の境界で切ったもの）の (ID, 名前, 外周)。"""
    return split_cells([(c.id, c.label, c.ring) for c in cells],
                       [(z.key, z.name, z.polygons) for z in zones] if zones else None)


class SplitCellsRequest(BaseModel):
    cells: list[SiteCellRequest]
    zones: list[SiteZone]


@app.post("/api/split_cells")
def api_split_cells(req: SplitCellsRequest):
    """残量モードのスパンを工区割の境界で切る（タブレット用の書き出しと同じ切り方・名前）。"""
    return [{"id": cid, "label": label, "ring": ring} for cid, label, ring in _site_cells(req.cells, req.zones)]


@app.post("/api/export_site")
def api_export_site(req: ExportSiteRequest):
    model = get_model()
    z0, z1 = min(req.z0, req.z1), max(req.z0, req.z1)
    cats = set(req.categories) if req.categories is not None else {s.category for s in model.solids}
    mats = _materials(model, req.materials)
    cells = [export_cell(model.solids, cid, label, ring, z0, z1, cats, mats, req.step)
             for cid, label, ring in _site_cells(req.cells, req.zones)]
    uncomputed = {u.key: {"name": u.member_name, "category": u.category, "reason": u.reason}
                  for c in cells for u in c.uncomputed}
    out = {
        "cells": [{"id": c.id, "label": c.label, "ring": c.ring, "from_top": c.from_top, "slab": c.slab,
                   "slab_bottom_mm": c.slab_bottom_mm, "beam_mid_mm": c.beam_mid_mm, "members": c.members}
                  for c in cells],
        "uncomputed": list(uncomputed.values()),
    }
    if not req.header:
        return out
    region = unary_union([region_from_rings(z.polygons) for z in req.zones]) if req.zones else None
    total = compute(model.solids, z0, z1, region=region, categories=cats, materials=mats).total
    footprints = [{"category": s.category, "box": [round(v, 3) for v in (s.bbox[0], s.bbox[1], s.bbox[3], s.bbox[4])]}
                  for s in model.solids
                  if s.category in cats and s.material in mats and s.bbox[5] > z0 and s.bbox[2] < z1]
    return {
        "format": "ifc-concrete-qto/site", "version": 1,
        "exported_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": Path(model.source).name, "title": req.title, "conditions": req.conditions,
        "z0": z0, "z1": z1, "step": req.step, "total": total,
        "overlap_note": total - sum(c.from_top[-1] + c.slab for c in cells),  # 全スパンを1回で送ったときの値
        "truck_m3": req.truck_m3, "extra_pct": req.extra_pct,
        "storeys": [{"name": s.name, "elevation": s.elevation} for s in model.storeys],
        "grids": [{"tag": a.tag, "start": a.start, "end": a.end} for a in model.grids],
        "bounds": model.bounds, "footprints": footprints, **out,
    }


class NoCacheStaticFiles(StaticFiles):
    """画面ファイルを毎回サーバーに確認させる（更新後に古い画面が残らないように）。"""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"  # 変わっていなければ304で済むので負担は小さい
        return response


app.mount("/", NoCacheStaticFiles(directory=FRONTEND, html=True), name="frontend")


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(os.environ.get("QTO_IFC", DEFAULT_IFC))
    if path.exists():
        print(f"IFCを読み込み中: {path}")
        state["model"] = load_model(path)
        print(f"読込完了: 立体 {len(state['model'].solids)} 件")
    if not os.environ.get("QTO_NO_BROWSER"):
        threading.Timer(1.0, lambda: webbrowser.open(f"http://{HOST}:{PORT}/")).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
