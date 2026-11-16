"""Python版（backend/server.py）に、比べるための呼び出しを順に送り、入力と結果を保存する。

使い方（リポジトリの直下で）：
  python single_html/tools/py_side.py <IFC> <出力JSON>
出力JSONには部材の座標が入るので、リポジトリの外（一時フォルダ）に保存すること。
"""
import sys, json, os, tempfile
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))
from fastapi.testclient import TestClient
import server
from qto.ifc_loader import load_model
from qto.partition import offset_axis_line
path = sys.argv[1]; out = sys.argv[2]
m = load_model(path, cache_dir=os.path.join(tempfile.gettempdir(), "qto_compare_cache")); server.state["model"] = m
c = TestClient(server.app)
meta = c.get("/api/model").json()
st = {s["name"]: s["elevation"] for s in meta["storeys"]}
names = [s["name"] for s in meta["storeys"]]
lo, hi = meta["z_range"][0] - 1, meta["z_range"][1] + 1
grids = meta["grids"]
vert = lambda g: abs(g["end"][0]-g["start"][0]) < abs(g["end"][1]-g["start"][1])
xs = sorted([g for g in grids if vert(g)], key=lambda g: g["start"][0])
ys = sorted([g for g in grids if not vert(g)], key=lambda g: g["start"][1])
print("grids", len(xs), len(ys))
# 階：5SL～6SL があればそれ、なければ真ん中の2つ
if "5SL" in st and "6SL" in st: z0, z1 = st["5SL"], st["6SL"]
else: k = len(names)//2; z0, z1 = st[names[k]], st[names[k+1]]
g = next((a for a in grids if a["tag"] == "X8"), xs[len(xs)//2] if xs else None)
line = [list(p) for p in offset_axis_line(g["start"], g["end"], 1.5)]
cx = (line[0][0] + line[1][0]) / 2; cy = (meta["bounds"][1] + meta["bounds"][3]) / 2
seeds = [{"label": "A", "x": cx - 5, "y": cy}, {"label": "B", "x": cx + 5, "y": cy}]
reqs = []
reqs.append(("compute", "/api/compute", {"z0": lo, "z1": hi}))
reqs.append(("compute", "/api/compute", {"z0": z0, "z1": z1, "boundaries": [line], "seeds": seeds}))
r2 = c.post("/api/compute", json=reqs[-1][2]).json()
polyA = next(z["polygons"] for z in r2["zones"] if z["label"] == "A")
polyB = next(z["polygons"] for z in r2["zones"] if z["label"] == "B")
partA = {"z0": z0, "z1": z1, "polygons": polyA}
reqs.append(("compute", "/api/compute", {"z0": z0, "z1": z1 + 0.5, "categories": ["柱", "梁", "スラブ"], "exclude_parts": [partA]}))
units = [{"name": "A", "parts": [partA]}, {"name": "B", "parts": [{"z0": z0, "z1": z1, "polygons": polyB}]},
         {"name": "柱全体", "parts": [{"z0": z0, "z1": z1 + 0.3, "categories": ["柱", "壁"]}]}]
reqs.append(("units", "/api/units", {"units": units, "exclude_registered": True, "detail": True}))
reqs.append(("units", "/api/units", {"units": units, "exclude_registered": False}))
cells = []
for i in range(min(3, len(xs) - 1)):
    for j in range(min(3, len(ys) - 1)):
        x0, x1 = xs[i]["start"][0], xs[i+1]["start"][0]; y0, y1 = ys[j]["start"][1], ys[j+1]["start"][1]
        cells.append({"id": f"{xs[i]['tag']}-{ys[j]['tag']}", "label": f"{xs[i]['tag']}～{xs[i+1]['tag']}・{ys[j]['tag']}～{ys[j+1]['tag']}", "ring": [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]})
# 工区の境界をまたぐスパンを入れる
xa, xb = cx - 6, cx + 6
cells.append({"id": "cross", "label": "境界またぎ", "ring": [[xa, ys[0]["start"][1]], [xb, ys[0]["start"][1]], [xb, ys[min(2,len(ys)-1)]["start"][1]], [xa, ys[min(2,len(ys)-1)]["start"][1]]]})
zones = [{"key": "A", "name": "A", "polygons": polyA}, {"key": "B", "name": "1工区", "polygons": polyB}]
reqs.append(("split", "/api/split_cells", {"cells": cells, "zones": zones}))
reqs.append(("export", "/api/export_site", {"cells": cells, "z0": z0, "z1": z1 + 0.3, "zones": zones, "title": "t", "boundaries": [line]}))
reqs.append(("export", "/api/export_site", {"cells": cells[:2], "z0": z0, "z1": z1, "header": False}))
# 区分ごとの書き出し（D35）：先に入れた区分（工区A）と重なる部分を除く
reqs.append(("export", "/api/export_site", {"cells": cells, "z0": z0, "z1": z1 + 0.3, "zones": zones, "title": "u",
                                            "exclude_parts": [partA]}))
res = []
for kind, url, body in reqs:
    r = c.post(url, json=body); res.append({"kind": kind, "url": url, "body": body, "status": r.status_code, "py": r.json()})
json.dump({"meta": meta, "cases": res}, open(out, "w", encoding="utf-8"), ensure_ascii=False)
print("ok", len(res), [x["status"] for x in res])
