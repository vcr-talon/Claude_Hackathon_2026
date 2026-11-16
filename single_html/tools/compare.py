"""py_side.py と js_side.mjs の結果を突き合わせ、許容値（0.001 m³ または 0.01%）を超える差を一覧にする。
  python single_html/tools/compare.py <py_side.pyの出力> <js_side.mjsの出力>
差の多くは「片方だけ未計算の部材」（IFCの形状化の部品が違うため）。それ以外の差が出たら移植の誤り。
"""
import json, sys, math
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
py = json.load(open(sys.argv[1], encoding="utf-8")); js = json.load(open(sys.argv[2], encoding="utf-8"))
issues = []; maxd = {}
def geom(rings_list):
    return unary_union([Polygon(r[0], r[1:]).buffer(0) for r in rings_list])
def num(path, a, b):
    d = abs(a - b); key = path.split('[')[0]
    if d > max(1e-3, 1e-4 * abs(a)): issues.append(f"{path}: py={a:.6f} js={b:.6f} diff={b-a:+.6f}")
    maxd[key] = max(maxd.get(key, 0), d)
def cmp(path, a, b):
    last = path.split('.')[-1]
    if last in ('exported_at',): return
    if last in ('pos', 'idx'): return
    if last in ('excluded_mesh', 'mesh'):
        if (a is None) != (b is None): issues.append(f"{path}: presence py={a is not None} js={b is not None}")
        return
    if last == 'hidden_keys':
        if set(a) != set(b): issues.append(f"{path}: py-only {len(set(a)-set(b))} js-only {len(set(b)-set(a))}")
        return
    if last in ('polygons',) and a is not None and b is not None:
        ga, gb = geom(a), geom(b); d = ga.symmetric_difference(gb).area
        if d > 1e-6: issues.append(f"{path}: polygon symdiff {d:.6f} (areas {ga.area:.3f}/{gb.area:.3f})")
        return
    if last == 'regions':
        ga = sorted(round(geom(r).area, 4) for r in a); gb = sorted(round(geom(r).area, 4) for r in b)
        if ga != gb: issues.append(f"{path}: region areas py={ga} js={gb}")
        return
    if last == 'ring' and isinstance(a, list):
        d = Polygon(a).buffer(0).symmetric_difference(Polygon(b).buffer(0)).area
        if d > 1e-6: issues.append(f"{path}: ring symdiff {d}")
        return
    if isinstance(a, bool) or isinstance(b, bool):
        if a != b: issues.append(f"{path}: py={a} js={b}")
        return
    if isinstance(a, (int, float)) and isinstance(b, (int, float)): return num(path, float(a), float(b))
    if isinstance(a, dict) and isinstance(b, dict):
        for k in set(a) | set(b):
            if k not in a or k not in b: issues.append(f"{path}.{k}: missing in {'js' if k not in b else 'py'}"); continue
            cmp(f"{path}.{k}", a[k], b[k])
        return
    if isinstance(a, list) and isinstance(b, list):
        if a and isinstance(a[0], dict) and ('member_id' in a[0] or 'id' in a[0] or 'label' in a[0] or 'key' in a[0] or 'part' in a[0]):
            kf = next(k for k in ('id', 'label', 'part', 'key', 'member_id') if k in a[0])
            ka = {}; kb = {}
            for x in a: ka.setdefault((x[kf], x.get('material')), x)
            for x in b: kb.setdefault((x[kf], x.get('material')), x)
            for k in set(ka) | set(kb):
                if k not in ka or k not in kb: issues.append(f"{path}[{k}]: only in {'py' if k in ka else 'js'}" + (f" vol={ (ka.get(k) or kb.get(k)).get('volume')}" )); continue
                cmp(f"{path}[{k[0]}]", ka[k], kb[k])
            return
        if len(a) != len(b): issues.append(f"{path}: len py={len(a)} js={len(b)}"); return
        for i, (x, y) in enumerate(zip(a, b)): cmp(f"{path}[{i}]", x, y)
        return
    if a != b: issues.append(f"{path}: py={str(a)[:80]} js={str(b)[:80]}")
cmp("meta", {k: v for k, v in py['meta'].items() if k not in ('members',)}, {k: v for k, v in js['meta'].items() if k not in ('members',)})
pm, jm = py['meta']['members'], js['meta']['members']
if set(pm) != set(jm): issues.append(f"meta.members: py-only {len(set(pm)-set(jm))} js-only {len(set(jm)-set(pm))}")
else:
    bad = [k for k in pm if pm[k] != jm[k]]
    if bad: issues.append(f"meta.members differ: {len(bad)} e.g. {pm[bad[0]]} vs {jm[bad[0]]}")
for i, (p, j) in enumerate(zip(py['cases'], js['cases'])):
    if p['status'] != j['status']: issues.append(f"case{i} status py={p['status']} js={j['status']} {str(j['js'])[:300]}"); continue
    cmp(f"case{i}{p['url']}", p['py'], j['js'])
print(f"{len(issues)} 件の差")
for s in issues[:80]: print(' ', s)
