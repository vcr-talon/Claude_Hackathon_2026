// 計算エンジン（Python版 backend/qto/ をJavaScriptに移植したもの）。
// 数量の定義・判定・手順はPython版と同じ。違いは IFC を立体に変える部品（IfcOpenShell → web-ifc）だけ。
import { Region, regionPrism } from './geom2d.js';
import { buildManifold, referenceVolume, materialNames, buildRelations, isConcrete } from './ifc_mesh.js';

export const CATEGORY_ORDER = ['柱', '梁', '壁', 'スラブ', '基礎', '階段', 'その他'];
export const EXTRA_MATERIAL_KEYWORD = '増し打ち';
export const EPS_VOLUME = 1e-9;
// 高さの比較の許容（m）。web-ifc の座標は IfcOpenShell より桁末で僅かにずれ、SL ちょうどで接するだけの部材を
// 「範囲に入る」と判定してしまうため、1µm 以内の差は接しているだけとみなす（Python版の厳密な比較と同じ結果にする）
const ZTOL = 1e-6;
// 切り取った片を「範囲に入る」とみなす最小の体積（m³）。Python版は 1e-9 だが、Manifold JS は頂点が単精度のため
// 切断面に 1e-7 m³ 程度のかけらが残る。1cm³ 未満は誤差として捨てる（許容値 0.001 m³ より十分小さい）
const PIECE_EPS = 1e-6;
const CATEGORY_BY_CLASS = {
  IFCCOLUMN: '柱', IFCBEAM: '梁', IFCWALL: '壁', IFCWALLSTANDARDCASE: '壁', IFCSLAB: 'スラブ',
  IFCFOOTING: '基礎', IFCPILE: '基礎', IFCSTAIR: '階段', IFCSTAIRFLIGHT: '階段',
};
const NON_ELEMENT = new Set(['IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE']);

let M = null;
export function setManifold(mod) { M = mod; }

const str = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v ?? null);
const ref = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- IFCの読み込み（Python版 ifc_loader._extract）
function lengthScale(api, W, mid) {
  const ids = api.GetLineIDsWithType(mid, W.IFCUNITASSIGNMENT);
  if (!ids.size()) return 1;
  const prefix = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9 };
  for (const u of api.GetLine(mid, ids.get(0)).Units) {
    const line = api.GetLine(mid, ref(u));
    if (str(line.UnitType) !== 'LENGTHUNIT') continue;
    const cls = api.GetNameFromTypeCode(line.type).toUpperCase();
    if (cls === 'IFCSIUNIT') return prefix[str(line.Prefix)] ?? 1;
    if (cls === 'IFCCONVERSIONBASEDUNIT') { const f = api.GetLine(mid, ref(line.ConversionFactor)); return Number(str(f.ValueComponent)) || 1; }
  }
  return 1;
}

function placementMatrix(api, mid, id, scale, cache = new Map()) {
  if (id == null) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (cache.has(id)) return cache.get(id);
  const lp = api.GetLine(mid, id);
  const parent = placementMatrix(api, mid, ref(lp.PlacementRelTo), scale, cache);
  const a = api.GetLine(mid, ref(lp.RelativePlacement));
  const loc = api.GetLine(mid, ref(a.Location)).Coordinates.map((c) => Number(str(c)) * scale);
  while (loc.length < 3) loc.push(0);
  const vec = (r, d) => { if (r == null) return d; const v = api.GetLine(mid, ref(r)).DirectionRatios.map((c) => Number(str(c))); while (v.length < 3) v.push(0); return v; };
  const z = norm(vec(a.Axis, [0, 0, 1]));
  let x = vec(a.RefDirection, [1, 0, 0]);
  const d = dot(x, z); x = norm([x[0] - d * z[0], x[1] - d * z[1], x[2] - d * z[2]]);
  const y = cross(z, x);
  // 列優先の4x4
  const local = [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, loc[0], loc[1], loc[2], 1];
  const m = mul(parent, local); cache.set(id, m); return m;
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const n = Math.hypot(...a) || 1; return a.map((v) => v / n); };
function mul(A, B) { const C = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) C[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k]; return C; }

function readGrids(api, W, mid, scale) {
  const axes = new Map();
  for (const gid of iter(api.GetLineIDsWithType(mid, W.IFCGRID))) {
    const g = api.GetLine(mid, gid);
    const m = placementMatrix(api, mid, ref(g.ObjectPlacement), scale);
    for (const ax of [...(g.UAxes || []), ...(g.VAxes || []), ...(g.WAxes || [])]) {
      const a = api.GetLine(mid, ref(ax));
      const curve = api.GetLine(mid, ref(a.AxisCurve));
      if (api.GetNameFromTypeCode(curve.type).toUpperCase() !== 'IFCPOLYLINE') continue;
      const P = curve.Points.map((p) => api.GetLine(mid, ref(p)).Coordinates.map((c) => Number(str(c)) * scale));
      const ends = [P[0], P[P.length - 1]].map((c) => { const v = [...c, 0, 0].slice(0, 3); return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13]]; });
      const tag = str(a.AxisTag) || `#${ref(ax)}`;
      if (!axes.has(tag)) axes.set(tag, { tag, start: ends[0], end: ends[1] });
    }
  }
  const num = (t) => Number(t.replace(/\D/g, '') || 0);
  return [...axes.values()].sort((p, q) => (p.tag[0] < q.tag[0] ? -1 : p.tag[0] > q.tag[0] ? 1 : num(p.tag) - num(q.tag)));
}
function* iter(vec) { for (let i = 0; i < vec.size(); i++) yield vec.get(i); }

/** IFCを読み込み、閉じた立体を作る。座標は模型の中心に寄せた値（offset を足すと元の座標） */
export async function loadModel(api, W, bytes, source, onProgress = () => {}) {
  const t0 = performance.now();
  const mid = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  const scale = lengthScale(api, W, mid);
  const rel = buildRelations(api, W, mid);
  const clsName = (id) => api.GetNameFromTypeCode(api.GetLineType(mid, id));
  const guid = (id) => str(api.GetLine(mid, id).GlobalId);
  const name = (id) => str(api.GetLine(mid, id).Name) || '';
  const container = (id) => { let x = id; for (let k = 0; k < 20 && x !== undefined; k++) { const s = rel.containerOf.get(x); if (s !== undefined) return str(api.GetLine(mid, s).Name); x = rel.parentOf.get(x); } return null; };

  onProgress('形状を取り出しています…'); await tick();
  const meshes = new Map();
  api.StreamAllMeshes(mid, (fm) => {
    const acc = { v: [], f: [], parts: [] };
    for (let i = 0; i < fm.geometries.size(); i++) {
      const pg = fm.geometries.get(i);
      const g = api.GetGeometry(mid, pg.geometryExpressID);
      const vd = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
      const ix = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
      const m = pg.flatTransformation; const base = acc.v.length / 3;
      for (let k = 0; k < vd.length; k += 6) {
        const x = vd[k], y = vd[k + 1], z = vd[k + 2];
        const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
        acc.v.push(X, -Z, Y); // web-ifc は Y が上。IFCの座標（Z が上）に戻す
      }
      const f0 = acc.f.length;
      for (let k = 0; k < ix.length; k++) acc.f.push(base + ix[k]);
      acc.parts.push([f0, acc.f.length]);
      g.delete();
    }
    meshes.set(fm.expressID, acc);
  });

  const materials = new Map(); const members = new Map(); const meta = new Map(); const skipped = [];
  for (const id of meshes.keys()) {
    const cls = clsName(id).toUpperCase();
    if (NON_ELEMENT.has(cls) || cls === 'IFCOPENINGELEMENT') continue;
    const names = materialNames(api, mid, rel, id);
    const key = names.length ? names.join(' / ') : '（材料なし）';
    materials.set(key, (materials.get(key) || 0) + 1);
    let mat;
    if (names.length === 1) mat = names[0];
    else if (names.length > 1 && names.some(isConcrete)) mat = null;
    else continue;
    let mem = rel.parentOf.get(id);
    if (mem === undefined || NON_ELEMENT.has(clsName(mem).toUpperCase())) mem = id;
    const memGuid = guid(mem);
    if (!members.has(memGuid)) {
      const mc = clsName(mem);
      members.set(memGuid, { member_id: memGuid, name: name(mem), ifc_class: mc, category: CATEGORY_BY_CLASS[mc.toUpperCase()] || 'その他', storey: container(mem) });
    }
    if (mat === null) {
      skipped.push({ key: guid(id), member_id: memGuid, name: name(mem), reason: '1つの形状に複数の材料が含まれ、コンクリート部分を切り出せない', material: names.join(' / ') });
      continue;
    }
    meta.set(id, { key: guid(id), member: memGuid, mat });
  }

  // 単精度（Manifold JS は Float32）の誤差を避けるため、平面の座標を模型の中心に寄せる
  let cx = 0, cy = 0, n = 0;
  for (const id of meta.keys()) { const v = meshes.get(id).v; for (let i = 0; i < v.length; i += 3) { cx += v[i]; cy += v[i + 1]; n++; } }
  const offset = n ? [Math.round(cx / n), Math.round(cy / n)] : [0, 0];
  const solids = []; let i = 0;
  for (const [id, mt] of meta) {
    const acc = meshes.get(id); meshes.delete(id);
    const v = Float64Array.from(acc.v); for (let k = 0; k < v.length; k += 3) { v[k] -= offset[0]; v[k + 1] -= offset[1]; }
    const f = Uint32Array.from(acc.f);
    let [man, err] = buildManifold(M, v, f);
    if (!man && acc.parts.length > 1) {
      const ms = [];
      for (const [a, b] of acc.parts) { const [pm] = buildManifold(M, v, f.subarray(a, b)); if (!pm) { ms.forEach((x) => x.delete()); ms.length = 0; break; } ms.push(pm); }
      if (ms.length) { man = M.Manifold.union(ms); err = null; ms.forEach((x) => x.delete()); }
    }
    const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < v.length; k += 3) for (let c = 0; c < 3; c++) { if (v[k + c] < bbox[c]) bbox[c] = v[k + c]; if (v[k + c] > bbox[c + 3]) bbox[c + 3] = v[k + c]; }
    const mem = members.get(mt.member);
    solids.push({ key: mt.key, member_id: mt.member, member_name: mem.name, category: mem.category, material: mt.mat, storey: mem.storey,
      vertices: v, faces: f, manifold: man, error: err, bbox, reference_volume: man ? null : referenceVolume(v, f, bbox) });
    if (++i % 300 === 0) { onProgress(`立体を作っています… ${i.toLocaleString()} / ${meta.size.toLocaleString()}`); await tick(); }
  }
  const storeys = [];
  for (const sid of iter(api.GetLineIDsWithType(mid, W.IFCBUILDINGSTOREY))) {
    const s = api.GetLine(mid, sid); storeys.push({ name: str(s.Name), elevation: (Number(str(s.Elevation)) || 0) * scale });
  }
  storeys.sort((a, b) => a.elevation - b.elevation);
  const grids = readGrids(api, W, mid, scale).map((g) => ({ tag: g.tag, start: [g.start[0] - offset[0], g.start[1] - offset[1]], end: [g.end[0] - offset[0], g.end[1] - offset[1]] }));
  const schema = api.GetModelSchema(mid);
  api.CloseModel(mid);
  const matList = [...materials].sort((a, b) => b[1] - a[1]);
  const model = {
    source, schema, storeys, grids, members, solids, skipped, offset,
    materials: Object.fromEntries(matList.map(([k, c]) => [k, { count: c, included: isConcrete(k) && !k.includes(' / ') }])),
    load_seconds: (performance.now() - t0) / 1000,
  };
  model.defaultMaterials = new Set(matList.filter(([k]) => model.materials[k].included).map(([k]) => k));
  const b = solids.map((s) => s.bbox);
  model.bounds = b.length ? [Math.min(...b.map((x) => x[0])), Math.min(...b.map((x) => x[1])), Math.max(...b.map((x) => x[3])), Math.max(...b.map((x) => x[4]))] : [0, 0, 1, 1];
  return model;
}

// ---------------------------------------------------------------- 計算（Python版 geometry.compute）
export { ZTOL };
export const union = (list) => (list.length === 1 ? list[0] : M.Manifold.union(list));

export function priorityBreakdown(groups, order) {
  const keys = [...order.filter((k) => groups.has(k)), ...[...groups.keys()].filter((k) => !order.includes(k)).sort()];
  const result = {}; let cum = null;
  for (const k of keys) {
    const u = union(groups.get(k));
    const part = cum === null ? u : u.subtract(cum);
    result[k] = part.volume();
    cum = cum === null ? u : M.Manifold.union([cum, u]);
  }
  return [result, cum];
}

export function materialOrder(mats) {
  return [...mats].sort((a, b) => (a.includes(EXTRA_MATERIAL_KEYWORD) - b.includes(EXTRA_MATERIAL_KEYWORD)) || (a < b ? -1 : a > b ? 1 : 0));
}

export function bboxOverlaps(s, z0, z1, region) {
  const [xmin, ymin, zmin, xmax, ymax, zmax] = s.bbox;
  if (zmax <= z0 + ZTOL || zmin >= z1 - ZTOL) return false;
  if (!region) return true;
  return region.intersectsBox(xmin, ymin, xmax, ymax);
}

export function compute(solids, z0, z1, { region = null, categories = null, memberIds = null, exclude = null, materials = null, categoryOrder = CATEGORY_ORDER } = {}) {
  if (z0 > z1) [z0, z1] = [z1, z0];
  const empty = { z0, z1, total: 0, raw_sum: 0, by_category: {}, by_material: {}, members: [], uncomputed: [], union: null, excluded: 0, excluded_pieces: [], excluded_solids: [] };
  if (region && region.isEmpty()) return empty;
  let cand = solids.filter((s) => (!categories || categories.has(s.category)) && (!memberIds || memberIds.has(s.member_id)) && (!materials || materials.has(s.material)));
  cand = cand.filter((s) => bboxOverlaps(s, z0, z1, region));
  if (!region && cand.length) {
    const b = cand.map((s) => s.bbox);
    region = Region.box(Math.min(...b.map((x) => x[0])) - 1, Math.min(...b.map((x) => x[1])) - 1, Math.max(...b.map((x) => x[3])) + 1, Math.max(...b.map((x) => x[4])) + 1);
  }
  const prism = cand.length ? regionPrism(region, z0, z1) : null;
  const uncomputed = []; const pieces = []; const excludedPieces = []; const excludedSolids = [];
  for (const s of cand) {
    if (!s.manifold) {
      uncomputed.push({ member_id: s.member_id, member_name: s.member_name, category: s.category, key: s.key, reason: s.error || '不明', reference_volume: s.reference_volume });
      continue;
    }
    const [xmin, ymin, zmin, xmax, ymax, zmax] = s.bbox;
    let piece = (z0 <= zmin && zmax <= z1 && region.containsBox(xmin, ymin, xmax, ymax)) ? s.manifold : s.manifold.intersect(prism);
    const cut = exclude ? exclude(s) : null;
    if (cut) {
      const removed = piece.intersect(cut);
      if (removed.volume() > PIECE_EPS) { excludedPieces.push(removed); excludedSolids.push(s); piece = piece.subtract(cut); }
    }
    const v = piece.volume();
    if (v > PIECE_EPS) pieces.push([s, piece, v]);
  }
  const byCat = new Map(), byMat = new Map(), members = new Map();
  for (const [s, piece, v] of pieces) {
    (byCat.get(s.category) || byCat.set(s.category, []).get(s.category)).push(piece);
    (byMat.get(s.material) || byMat.set(s.material, []).get(s.material)).push(piece);
    const mv = members.get(s.member_id) || members.set(s.member_id, { member_id: s.member_id, member_name: s.member_name, category: s.category, storey: s.storey, volume: 0, solid_keys: [] }).get(s.member_id);
    mv.volume += v; mv.solid_keys.push(s.key);
  }
  const [byCategory, u] = priorityBreakdown(byCat, categoryOrder);
  let byMaterial;
  if (byMat.size > 1) [byMaterial] = priorityBreakdown(byMat, materialOrder(byMat.keys()));
  else byMaterial = Object.fromEntries([...byMat].map(([k, g]) => [k, g.reduce((a, p) => a + p.volume(), 0)]));
  return { z0, z1, total: u ? u.volume() : 0, raw_sum: pieces.reduce((a, p) => a + p[2], 0), by_category: byCategory, by_material: byMaterial,
    members: [...members.values()].sort((a, b) => b.volume - a.volume), uncomputed, union: u,
    excluded: excludedPieces.length ? union(excludedPieces).volume() : 0, excluded_pieces: excludedPieces, excluded_solids: excludedSolids };
}

// ---------------------------------------------------------------- 打設区分（Python版 units.py）
export function makePart({ name = '', z0, z1, region = null, categories = null, memberIds = null, materials = null, topAtMost = null }) {
  return { name, z0: Math.min(z0, z1), z1: Math.max(z0, z1), region, categories, memberIds, materials, topAtMost };
}
const accepts = (u, s) => (!u.categories || u.categories.has(s.category)) && (!u.memberIds || u.memberIds.has(s.member_id))
  && (!u.materials || u.materials.has(s.material)) && (u.topAtMost == null || s.bbox[5] <= u.topAtMost + ZTOL);
const common = (a, b) => (a == null ? b : b == null ? a : new Set([...a].filter((x) => b.has(x))));

export function intersectUnits(u, v) {
  const z0 = Math.max(u.z0, v.z0), z1 = Math.min(u.z1, v.z1);
  if (z1 - z0 <= 1e-9) return null;
  let region;
  if (!u.region) region = v.region;
  else if (!v.region) region = u.region;
  else { region = u.region.intersection(v.region); if (region.area() <= 1e-9) return null; }
  const tops = [u.topAtMost, v.topAtMost].filter((t) => t != null);
  return makePart({ name: `${u.name}∩${v.name}`, z0, z1, region, categories: common(u.categories, v.categories), memberIds: common(u.memberIds, v.memberIds),
    materials: common(u.materials, v.materials), topAtMost: tops.length ? Math.min(...tops) : null });
}

/** 立体ごとに、複数の条件をまとめた切り取り型を作る（Python版 _Clipper） */
export function makeClipper(parts) {
  if (!parts.length) return null;
  return (s) => {
    const hits = parts.filter((u) => accepts(u, s) && bboxOverlaps(s, u.z0, u.z1, u.region));
    if (!hits.length) return null;
    const [xmin, ymin, , xmax, ymax] = s.bbox;
    const own = Region.box(xmin - 1, ymin - 1, xmax + 1, ymax + 1);
    const byH = new Map();
    for (const u of hits) { const k = `${u.z0}|${u.z1}`; (byH.get(k) || byH.set(k, { z0: u.z0, z1: u.z1, rs: [] }).get(k)).rs.push(u.region ? u.region.intersection(own) : own); }
    const prisms = [...byH.values()].map((h) => regionPrism(Region.union(h.rs), h.z0, h.z1));
    return prisms.length === 1 ? prisms[0] : union(prisms);
  };
}
export const makeExcluder = makeClipper;

// 表示だけに使う判定（元の形を隠すか）。単精度の切断で残る 1cm³ 未満のかけらは「残りなし」とみなす
const HIDE_EPS = 1e-6;
export function fullyExcludedKeys(solids, z0, z1, exclude) {
  if (!exclude) return [];
  const keys = [];
  for (const s of solids) {
    if (!s.manifold || s.bbox[5] <= z0 + ZTOL || s.bbox[2] >= z1 - ZTOL) continue;
    const cut = exclude(s);
    if (!cut) continue;
    const [xmin, ymin, zmin, xmax, ymax, zmax] = s.bbox;
    let piece = s.manifold;
    if (zmin < z0 || zmax > z1) piece = piece.intersect(regionPrism(Region.box(xmin - 1, ymin - 1, xmax + 1, ymax + 1), z0, z1));
    if (piece.subtract(cut).volume() <= HIDE_EPS) keys.push(s.key);
  }
  return keys;
}

function unitTotal(solids, parts, excludeParts = null) {
  const clip = makeClipper(parts), cut = makeExcluder(excludeParts || []);
  const r = { total: 0, member_ids: new Set(), uncomputed: 0, member_volumes: new Map(), uncomputed_solids: [] };
  const pieces = [];
  for (const s of solids) {
    const c = clip(s);
    if (!c) continue;
    if (!s.manifold) { r.uncomputed++; r.uncomputed_solids.push(s); continue; }
    let piece = s.manifold.intersect(c);
    const e = cut ? cut(s) : null;
    if (e) piece = piece.subtract(e);
    const v = piece.volume();
    if (v > PIECE_EPS) {
      pieces.push(piece); r.member_ids.add(s.member_id);
      const k = `${s.member_id}\u0000${s.material}`; r.member_volumes.set(k, (r.member_volumes.get(k) || 0) + v);
    }
  }
  r.total = pieces.length ? union(pieces).volume() : 0;
  return [r, pieces];
}
export const unionVolume = (solids, parts) => unitTotal(solids, parts)[0].total;

// 2つの区分の条件の箱（高さ範囲 × 平面の外接矩形）が体積を持って重なりうるか。重い体積計算の前の振り落とし（Python版 _may_overlap）
function mayOverlap(a, b) {
  for (const p of a.parts) for (const q of b.parts) {
    if (Math.min(p.z1, q.z1) - Math.max(p.z0, q.z0) <= 1e-9) continue;
    if (!p.region || !q.region) return true;
    const [px0, py0, px1, py1] = p.region.bounds(), [qx0, qy0, qx1, qy1] = q.region.bounds();
    if (Math.min(px1, qx1) - Math.max(px0, qx0) > 1e-9 && Math.min(py1, qy1) - Math.max(py0, qy0) > 1e-9) return true;
  }
  return false;
}

// skipSelected なら、先の区分 a の部材を選んだ条件（パラペットを先に打つ分など）は数えない（D34。Python版 _shared）
function shared(solids, a, b, skipSelected = false) {
  const commons = [];
  for (const p of a.parts) for (const q of b.parts) {
    if (skipSelected && p.memberIds) continue;
    const c = intersectUnits(p, q); if (c) commons.push(c);
  }
  if (!commons.length) return [0, []];
  const members = new Map();
  for (const c of commons) {
    const r = compute(solids.filter((s) => c.topAtMost == null || s.bbox[5] <= c.topAtMost + ZTOL), c.z0, c.z1,
      { region: c.region, categories: c.categories, memberIds: c.memberIds, materials: c.materials });
    for (const m of r.members) if (!members.has(m.member_id) || members.get(m.member_id).volume < m.volume) members.set(m.member_id, m);
  }
  if (!members.size) return [0, []];
  return [unionVolume(solids, commons), [...members.values()].sort((x, y) => y.volume - x.volume)];
}

// memo（任意）：前回の計算結果を覚えておく入れ物 { unitKey(i), pairKey(i, j), map }。区分の数量は、その区分と前の区分の条件だけで決まり、
// 重なりは2つの区分の条件だけで決まるので、同じ条件なら前回の値をそのまま使う（打設リストに1行足したとき、新しい行の分だけ計算する）
export function computeUnits(solids, units, excludeRegistered = false, memo = null) {
  const remember = (key, f) => { if (!memo) return f(); if (!memo.map.has(key)) memo.map.set(key, f()); return memo.map.get(key); };
  const results = units.map((u, i) => remember(memo?.unitKey(i), () => unitTotal(solids, u.parts, excludeRegistered ? units.slice(0, i).flatMap((v) => v.parts) : null)[0]));
  // 重なり（D34）は「除く」がオンでも調べる。オンのときは区分の数量から先の区分が引かれているので、
  // 条件の共通部分の体積（shared_volume）だけを返す
  const overlaps = [];
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
    if (!mayOverlap(units[i], units[j])) continue;
    if (excludeRegistered) {
      const [sharedVolume, sharedMembers] = remember(memo?.pairKey(i, j), () => shared(solids, units[i], units[j], true));
      if (sharedMembers.length) overlaps.push({ a: i, b: j, volume: sharedVolume, shared_volume: sharedVolume, shared_members: sharedMembers });
      continue;
    }
    if (results[i].total <= EPS_VOLUME || results[j].total <= EPS_VOLUME) continue;
    const [sharedVolume, sharedMembers] = shared(solids, units[i], units[j]);
    const volume = results[i].total + results[j].total - unionVolume(solids, [...units[i].parts, ...units[j].parts]);
    if (volume > 1e-6 || sharedMembers.length) overlaps.push({ a: i, b: j, volume: Math.max(volume, sharedVolume), shared_volume: sharedVolume, shared_members: sharedMembers });
  }
  const all = units.flatMap((u) => u.parts);
  const unionTotal = all.length > 1 ? unionVolume(solids, all) : results.reduce((a, r) => a + r.total, 0);
  return { results, overlaps, union_total: unionTotal, sum_total: results.reduce((a, r) => a + r.total, 0) };
}

// ---------------------------------------------------------------- タブレット用の書き出し（Python版 site_export.py）
const SLAB = 'スラブ';
const PRESET_NEAR_TOP = 0.35;
const RISE_EPS = 0.005;
const RISE_EXCLUDED = new Set(['柱']);
const TOUCH_INSET = 0.01;

const volumeAbove = (m, z) => (m ? m.trimByPlane([0, 0, 1], z).volume() : 0);
function table(m, z1, steps) {
  const t = steps.map((d) => (d > 0 ? volumeAbove(m, z1 - d) : 0));
  for (let k = 1; k < t.length; k++) t[k] = Math.max(t[k], t[k - 1]);
  return t;
}
export function depthSteps(z0, z1, step) {
  const h = z1 - z0; const n = Math.floor(h / step + 1e-9);
  const steps = []; for (let k = 0; k <= n; k++) steps.push(k * step);
  if (h - steps[steps.length - 1] > 1e-9) steps.push(h);
  return steps;
}
export function touches(ring, xmin, ymin, xmax, ymax) {
  let x0 = xmin + TOUCH_INSET, y0 = ymin + TOUCH_INSET, x1 = xmax - TOUCH_INSET, y1 = ymax - TOUCH_INSET;
  if (x0 >= x1 || y0 >= y1) return ring.covers((xmin + xmax) / 2, (ymin + ymax) / 2);
  return ring.intersectsBox(x0, y0, x1, y1);
}
export function conTop(z0, z1, elevations) {
  const inside = elevations.filter((e) => z0 + 1e-6 < e && e <= z1 + 1e-6);
  return inside.length ? Math.min(Math.max(...inside), z1) : z1;
}
// Python の round（偶数への丸め）
function pyRound(x) { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; }
function presetMm(solids, ring, z1, category, materials, kind, top = null) {
  top = top == null ? z1 : top;
  const ds = [];
  for (const s of solids) {
    if (s.category !== category || (materials && !materials.has(s.material))) continue;
    const [xmin, ymin, zmin, xmax, ymax, zmax] = s.bbox;
    if (Math.abs(zmax - top) > PRESET_NEAR_TOP || !touches(ring, xmin, ymin, xmax, ymax)) continue;
    ds.push(kind === 'slab' ? top - zmin : top - (zmin + zmax) / 2);
  }
  if (!ds.length) return null;
  ds.sort((a, b) => a - b);
  return pyRound(ds[Math.floor(ds.length / 2)] * 100) * 10 + pyRound((z1 - top) * 1000);
}

export function splitCells(cells, zones) {
  if (!zones) return cells.map(([id, label, ring]) => [id, label, ring.map((p) => [...p])]);
  const regions = zones.map(([key, name, polys]) => [key, name, Region.fromRings(polys)]);
  const out = [];
  for (const [cid, label, ring] of cells) {
    const cell = Region.fromRing(ring);
    for (const [key, name, region] of regions) {
      const part = cell.intersection(region);
      const polys = part.rings().filter((p) => Math.abs(ringAreaSigned(p[0])) > 1e-6);
      polys.forEach((p, k) => {
        const suffix = `#${key}` + (polys.length > 1 ? `-${k + 1}` : '');
        out.push([cid + suffix, `${label}（${name}）`, p[0]]);
      });
    }
  }
  return out;
}
function ringAreaSigned(r) { let s = 0; for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return s / 2; }

// exclude：先に打設リストに入れた区分と重なる部分を、柱・梁・壁、スラブ、コン天より上に続く部材のすべてから除く（D35。Python版 export_cell）
export function exportCell(solids, id, label, ring, z0, z1, categories, materials, step, top = null, exclude = null) {
  const region = Region.fromRing(ring);
  const vertical = new Set([...categories].filter((c) => c !== SLAB));
  const rv = vertical.size ? compute(solids, z0, z1, { region, categories: vertical, materials, exclude }) : null;
  const rs = categories.has(SLAB) ? compute(solids, z0, z1, { region, categories: new Set([SLAB]), materials, exclude }) : null;
  let v = rv ? rv.union : null;
  const s = rs ? rs.union : null;
  if (v && s) v = v.subtract(s);
  const steps = depthSteps(z0, z1, step);
  const fromTop = table(v, z1, steps);
  let rise = null;
  if (top != null && z1 - top > 1e-6 && vertical.size) {
    const risers = solids.filter((x) => x.bbox[5] > top + RISE_EPS + ZTOL && !RISE_EXCLUDED.has(x.category));
    const rr = risers.length ? compute(risers, z0, z1, { region, categories: vertical, materials, exclude }) : null;
    let r = rr ? rr.union : null;
    if (r && s) r = r.subtract(s);
    if (r) {
      rise = table(r, z1, steps).map((a, k) => Math.round(Math.min(a, fromTop[k]) * 1e6) / 1e6);
      if (rise[rise.length - 1] <= EPS_VOLUME) rise = null;
    }
  }
  const results = [rv, rs].filter(Boolean);
  const members = new Set(results.flatMap((r) => r.members.filter((m) => m.volume > EPS_VOLUME).map((m) => m.member_id)));
  return { id, label, ring, from_top: fromTop, slab: s ? s.volume() : 0,
    slab_bottom_mm: presetMm(solids, region, z1, SLAB, materials, 'slab', top),
    beam_mid_mm: presetMm(solids, region, z1, '梁', materials, 'beam', top),
    members: members.size, uncomputed: results.flatMap((r) => r.uncomputed), rise_from_top: rise };
}
