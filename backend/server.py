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
from qto.units import PourUnit, compute_units, region_from_rings  # noqa: E402

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


class ComputeRequest(BaseModel):
    z0: float
    z1: float
    boundaries: list[list[tuple[float, float]]] = []
    seeds: list[Seed] = []
    categories: list[str] | None = None
    member_ids: list[str] | None = None


def _result_json(r: Result, label: str, region) -> dict:
    return {
        "label": label,
        "total": r.total,
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

    zones = {}
    if regions is not None and req.seeds:
        zones = assign_zones(regions, [ZoneSeed(s.label, s.x, s.y) for s in req.seeds])
    results = [_result_json(compute(model.solids, req.z0, req.z1, region=poly, categories=cats, member_ids=ids),
                            label, poly) for label, poly in sorted(zones.items())]
    if not results:
        results = [_result_json(compute(model.solids, req.z0, req.z1, categories=cats, member_ids=ids),
                                "範囲全体", None)]
    return {
        "z0": min(req.z0, req.z1),
        "z1": max(req.z0, req.z1),
        "zones": results,
        "regions": [_rings(r) for r in regions] if regions is not None else [],
    }


class UnitRequest(BaseModel):
    name: str
    z0: float
    z1: float
    polygons: list[list[list[tuple[float, float]]]] | None = None
    categories: list[str] | None = None
    member_ids: list[str] | None = None


class UnitsRequest(BaseModel):
    units: list[UnitRequest]


def _members_json(r: Result) -> list[dict]:
    return [{"member_id": m.member_id, "name": m.member_name, "category": m.category, "volume": m.volume}
            for m in r.members]


@app.post("/api/units")
def api_units(req: UnitsRequest):
    model = get_model()
    units = [PourUnit(u.name, min(u.z0, u.z1), max(u.z0, u.z1), region_from_rings(u.polygons),
                      set(u.categories) if u.categories is not None else None,
                      set(u.member_ids) if u.member_ids is not None else None) for u in req.units]
    res = compute_units(model.solids, units)
    return {
        "units": [{"name": u.name, "total": r.total, "by_category": r.by_category,
                   "member_count": len(r.members), "uncomputed_count": len(r.uncomputed)}
                  for u, r in zip(units, res.results)],
        "sum_total": res.sum_total,
        "union_total": res.union_total,
        "overlaps": [{"a": o.a, "b": o.b, "volume": o.volume,
                      "shared_volume": o.shared.total if o.shared else 0.0,
                      "members": _members_json(o.shared) if o.shared else []}
                     for o in res.overlaps],
    }


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")


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
