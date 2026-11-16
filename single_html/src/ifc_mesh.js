// IFCの関係（材料・親部材・階）を読み、部材の形を閉じた立体にする（Python版 ifc_loader.py の前半と geometry.py の _manifold_from_mesh）。
//   IFCの形状化：web-ifc（Python版は IfcOpenShell）
//   閉じた立体：manifold-3d（Python版と同じ Manifold の WASM 版）

export const CONCRETE_KEYWORD = 'コンクリート';
const WELD_TOLERANCE = 1e-4; // m（0.1mm）

export const isConcrete = (name) => !!name && name.includes(CONCRETE_KEYWORD);

// ---------------------------------------------------------------- IFCの関係を読む
function refId(v) { return v && typeof v === 'object' && 'value' in v ? v.value : v; }
function str(v) { return v && typeof v === 'object' && 'value' in v ? v.value : v ?? null; }

function lines(api, mid, typeCode) {
  const ids = api.GetLineIDsWithType(mid, typeCode);
  const out = [];
  for (let i = 0; i < ids.size(); i++) out.push(ids.get(i));
  return out;
}

export function buildRelations(api, W, mid) {
  const T = W;
  const matOf = new Map();      // 要素ID → 材料定義ID
  const parentOf = new Map();   // 子要素ID → 親ID（IfcRelAggregates）
  const typeOf = new Map();     // 要素ID → タイプID（IfcRelDefinesByType）
  const containerOf = new Map();// 要素ID → 階ID
  for (const id of lines(api, mid, T.IFCRELASSOCIATESMATERIAL)) {
    const r = api.GetLine(mid, id);
    const m = refId(r.RelatingMaterial);
    for (const o of r.RelatedObjects) matOf.set(refId(o), m);
  }
  for (const id of lines(api, mid, T.IFCRELAGGREGATES)) {
    const r = api.GetLine(mid, id);
    const p = refId(r.RelatingObject);
    for (const o of r.RelatedObjects) parentOf.set(refId(o), p);
  }
  for (const id of lines(api, mid, T.IFCRELDEFINESBYTYPE)) {
    const r = api.GetLine(mid, id);
    const t = refId(r.RelatingType);
    for (const o of r.RelatedObjects) typeOf.set(refId(o), t);
  }
  for (const id of lines(api, mid, T.IFCRELCONTAINEDINSPATIALSTRUCTURE)) {
    const r = api.GetLine(mid, id);
    const s = refId(r.RelatingStructure);
    for (const o of r.RelatedElements) containerOf.set(refId(o), s);
  }
  return { matOf, parentOf, typeOf, containerOf };
}

// ifcopenshell.util.element.get_material(should_skip_usage=True) と get_materials に合わせる
export function materialNames(api, mid, rel, id) {
  let m = rel.matOf.get(id);
  if (m === undefined) {
    const t = rel.typeOf.get(id);
    if (t !== undefined) m = rel.matOf.get(t);
  }
  if (m === undefined) return [];
  const line = api.GetLine(mid, m);
  const tname = api.GetNameFromTypeCode(line.type).toUpperCase();
  const nameOf = (mid2) => str(api.GetLine(mid, refId(mid2)).Name);
  switch (tname) {
    case 'IFCMATERIAL': return [str(line.Name)];
    case 'IFCMATERIALLAYERSETUSAGE': {
      const ls = api.GetLine(mid, refId(line.ForLayerSet));
      return ls.MaterialLayers.map((l) => nameOf(api.GetLine(mid, refId(l)).Material));
    }
    case 'IFCMATERIALLAYERSET':
      return line.MaterialLayers.map((l) => nameOf(api.GetLine(mid, refId(l)).Material));
    case 'IFCMATERIALPROFILESETUSAGE': {
      const ps = api.GetLine(mid, refId(line.ForProfileSet));
      return ps.MaterialProfiles.map((p) => nameOf(api.GetLine(mid, refId(p)).Material));
    }
    case 'IFCMATERIALPROFILESET':
      return line.MaterialProfiles.map((p) => nameOf(api.GetLine(mid, refId(p)).Material));
    case 'IFCMATERIALCONSTITUENTSET':
      return line.MaterialConstituents.map((c) => nameOf(api.GetLine(mid, refId(c)).Material));
    case 'IFCMATERIALLIST':
      return line.Materials.map((x) => nameOf(x));
    default: return [];
  }
}

// ---------------------------------------------------------------- 形状の修復（Python版と同じ手順）
function weld(verts, faces) {
  const key = new Map(); const first = []; const inv = new Int32Array(verts.length / 3);
  for (let i = 0; i < inv.length; i++) {
    const k = Math.round(verts[3 * i] / WELD_TOLERANCE) + ',' + Math.round(verts[3 * i + 1] / WELD_TOLERANCE)
      + ',' + Math.round(verts[3 * i + 2] / WELD_TOLERANCE);
    let j = key.get(k);
    if (j === undefined) { j = first.length; key.set(k, j); first.push(i); }
    inv[i] = j;
  }
  const v = new Float64Array(first.length * 3);
  first.forEach((i, j) => { v[3 * j] = verts[3 * i]; v[3 * j + 1] = verts[3 * i + 1]; v[3 * j + 2] = verts[3 * i + 2]; });
  const f = [];
  for (let t = 0; t < faces.length; t += 3) {
    const a = inv[faces[t]], b = inv[faces[t + 1]], c = inv[faces[t + 2]];
    if (a !== b && b !== c && a !== c) f.push(a, b, c);
  }
  return [v, Uint32Array.from(f)];
}

const ekey = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);

function splitTJunctions(v, faces, rounds = 10) {
  let F = Array.from(faces);
  for (let r = 0; r < rounds; r++) {
    const cnt = new Map();
    for (let t = 0; t < F.length; t += 3)
      for (let k = 0; k < 3; k++) { const e = ekey(F[t + k], F[t + (k + 1) % 3]); cnt.set(e, (cnt.get(e) || 0) + 1); }
    const open = new Set(); const candSet = new Set();
    for (const [e, n] of cnt) if (n === 1) { open.add(e); candSet.add(Math.floor(e / 4294967296)); candSet.add(e % 4294967296); }
    if (!open.size) break;
    const cand = [...candSet].sort((a, b) => a - b);
    const out = []; let changed = false;
    for (let t = 0; t < F.length; t += 3) {
      const tri = [F[t], F[t + 1], F[t + 2]]; let pieces = [tri];
      for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3];
        if (!open.has(ekey(a, b))) continue;
        const ax = v[3 * a], ay = v[3 * a + 1], az = v[3 * a + 2];
        const abx = v[3 * b] - ax, aby = v[3 * b + 1] - ay, abz = v[3 * b + 2] - az;
        const ab2 = abx * abx + aby * aby + abz * abz;
        const inner = [];
        for (const c of cand) {
          const px = v[3 * c] - ax, py = v[3 * c + 1] - ay, pz = v[3 * c + 2] - az;
          const s = (px * abx + py * aby + pz * abz) / ab2;
          if (!(s > 1e-9 && s < 1 - 1e-9)) continue;
          const dx = ax + s * abx - v[3 * c], dy = ay + s * aby - v[3 * c + 1], dz = az + s * abz - v[3 * c + 2];
          if (Math.hypot(dx, dy, dz) < WELD_TOLERANCE) inner.push([s, c]);
        }
        if (!inner.length) continue;
        inner.sort((p, q) => p[0] - q[0]);
        const chain = [a, ...inner.map((x) => x[1]), b]; const c = tri[(k + 2) % 3];
        pieces = []; for (let i = 0; i < chain.length - 1; i++) pieces.push([chain[i], chain[i + 1], c]);
        changed = true; break;
      }
      for (const p of pieces) out.push(...p);
    }
    F = out;
    if (!changed) break;
  }
  return Uint32Array.from(F);
}

function orientFaces(faces) {
  const F = Uint32Array.from(faces); const n = F.length / 3;
  const ef = new Map();
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const e = ekey(F[3 * i + k], F[3 * i + (k + 1) % 3]); let l = ef.get(e); if (!l) ef.set(e, (l = [])); l.push(i);
  }
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue; seen[s] = 1; const q = [s];
    while (q.length) {
      const i = q.pop();
      for (let k = 0; k < 3; k++) {
        const a = F[3 * i + k], b = F[3 * i + (k + 1) % 3];
        for (const j of ef.get(ekey(a, b))) {
          if (seen[j]) continue;
          let same = false;
          for (let m = 0; m < 3; m++) if (F[3 * j + m] === a && F[3 * j + (m + 1) % 3] === b) same = true;
          if (same) { const t = F[3 * j]; F[3 * j] = F[3 * j + 2]; F[3 * j + 2] = t; }
          seen[j] = 1; q.push(j);
        }
      }
    }
  }
  return F;
}

function meshVolume(v, f) {
  let s = 0;
  for (let t = 0; t < f.length; t += 3) {
    const a = 3 * f[t], b = 3 * f[t + 1], c = 3 * f[t + 2];
    s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c])
      + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return Math.abs(s) / 6;
}

function toManifold(M, v, f) {
  const mesh = new M.Mesh({ numProp: 3, vertProperties: Float32Array.from(v), triVerts: Uint32Array.from(f) });
  mesh.merge();
  return new M.Manifold(mesh);
}

function flip(f) { const g = Uint32Array.from(f); for (let t = 0; t < g.length; t += 3) { const x = g[t]; g[t] = g[t + 2]; g[t + 2] = x; } return g; }

export function buildManifold(M, verts, faces) {
  if (faces.length < 12) return [null, '形状データが空または不足'];
  const [wv, wf] = weld(verts, faces);
  const attempts = [[verts, faces], [wv, wf]];
  if (wf.length >= 12) attempts.push([wv, orientFaces(splitTJunctions(wv, wf))]);
  let box = 1; for (let k = 0; k < 3; k++) { let lo = Infinity, hi = -Infinity; for (let i = k; i < verts.length; i += 3) { lo = Math.min(lo, verts[i]); hi = Math.max(hi, verts[i]); } box *= hi - lo; }
  for (const [v, f] of attempts) {
    let man;
    try { man = toManifold(M, v, f); } catch { continue; }
    if (man.status() === 'NoError' && !man.isEmpty()) {
      if (man.volume() < 0) { man.delete(); man = toManifold(M, v, flip(f)); }
      if (man.volume() <= box * (1 + 1e-4)) return [man, null]; // 単精度の丸め分だけ許容を広げる
    }
    man.delete();
  }
  return [null, '形のデータが閉じていない（面の抜けなど）ため、切って数えられない'];
}

// 閉じた立体にできなかった形の参考体積（Python版 Solid.reference_volume と同じ）。箱を超えるときは null
export function referenceVolume(v, f, b) {
  const [wv, wf] = weld(v, f);
  if (!wf.length) return null;
  const vol = meshVolume(wv, orientFaces(wf));
  const box = (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]);
  return vol <= box * (1 + 1e-6) ? vol : null;
}

