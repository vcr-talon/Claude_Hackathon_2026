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
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from shapely.geometry import MultiPolygon

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qto.geometry import CATEGORY_ORDER, Result, compute  # noqa: E402
from qto.ifc_loader import Model, load_model  # noqa: E402
from qto.partition import ZoneSeed, assign_zones, split_regions  # noqa: E402
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
                   "reason": s.error, "reference_volume": s.mesh_volume}
                  for s in model.solids if s.manifold is None]
    uncomputed += [{"key": s.key, "member_id": s.member_id, "name": s.name, "category": None,
                    "reason": s.reason, "reference_volume": None} for s in model.skipped]
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
        "solid_count": len(model.solids),
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

    def to_part(self, name: str = "") -> PourUnit:
        return PourUnit(name, min(self.z0, self.z1), max(self.z0, self.z1), region_from_rings(self.polygons),
                        set(self.categories) if self.categories is not None else None,
                        set(self.member_ids) if self.member_ids is not None else None)


class ComputeRequest(BaseModel):
    z0: float
    z1: float
    boundaries: list[list[tuple[float, float]]] = []
    seeds: list[Seed] = []
    categories: list[str] | None = None
    member_ids: list[str] | None = None
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
    exclude = make_excluder([p.to_part() for p in req.exclude_parts])

    zones: dict = {}
    if regions is not None and req.seeds:
        zones = assign_zones(regions, [ZoneSeed(s.label, s.x, s.y) for s in req.seeds])
    if not zones:
        zones = {"範囲全体": None}
    results, excluded_pieces = [], []
    for label, poly in sorted(zones.items()):
        r = compute(model.solids, req.z0, req.z1, region=poly, categories=cats, member_ids=ids, exclude=exclude)
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


@app.post("/api/units")
def api_units(req: UnitsRequest):
    model = get_model()
    units = [Unit(u.name, [p.to_part(u.name) for p in u.parts]) for u in req.units]
    res = compute_units(model.solids, units, exclude_registered=req.exclude_registered)
    return {
        "units": [{"name": u.name, "total": r.total, "member_count": len(r.member_ids),
                   "uncomputed_count": r.uncomputed} for u, r in zip(units, res.results)],
        "sum_total": res.sum_total,
        "union_total": res.union_total,
        "overlaps": [{"a": o.a, "b": o.b, "volume": o.volume, "shared_volume": o.shared_volume,
                      "members": [{"member_id": m.member_id, "name": m.member_name, "category": m.category,
                                   "volume": m.volume} for m in o.shared_members]}
                     for o in res.overlaps],
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
