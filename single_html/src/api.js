// Python版 backend/server.py の /api/* をブラウザの中で受け持つ。
// 画面（frontend/app.js）は fetch('/api/...') のままで、ここが同じ形の応答を返す。
import * as WEBIFC from 'web-ifc';
import Module from 'manifold-3d';
import { Region, setManifold as set2d, splitRegions, assignZones, UserError } from './geom2d.js';
import {
  setManifold, loadModel, compute, CATEGORY_ORDER, EPS_VOLUME, makePart, makeExcluder, fullyExcludedKeys,
  computeUnits, union, splitCells, exportCell, conTop, ZTOL,
} from './qto.js';
import { WEBIFC_WASM, MANIFOLD_WASM } from './wasm_data.js';

let api, M, model = null;
// 打設リストの計算結果を覚えておく（computeUnits の memo）。WASM の立体は入れない（数値と部材の参照だけ）
const unitMemo = { map: new Map() };
const b64dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const ready = (async () => {
  M = await Module({ wasmBinary: b64dec(MANIFOLD_WASM) }); M.setup();
  trackObjects(M);
  setManifold(M); set2d(M);
  api = new WEBIFC.IfcAPI();
  // Node での検証用。Web Worker の中も window がないので、Node かどうかは process で見分ける
  if (typeof process !== 'undefined' && process.versions?.node) await api.Init();
  else await api.Init(() => 'data:application/wasm;base64,' + WEBIFC_WASM, true);
})();

// ---------------------------------------------------------------- WASMのメモリの後始末
// Manifold の立体・平面は WASM のメモリに置かれ、delete() しないと解放されない。
// 1回の計算（API呼び出し）の間に作られたものをすべて覚えておき、応答を作り終えたらまとめて解放する。
// IFCを読み込んだときの部材の立体（model.solids）は計算の外で作るので、ここでは解放されない。
let scope = null;
function remember(x) {
  if (!scope || x == null) return x;
  if (Array.isArray(x)) { for (const y of x) remember(y); return x; }
  if (typeof x.delete === 'function' && typeof x.isDeleted === 'function') scope.add(x);
  return x;
}
function trackObjects(mod) {
  const skip = new Set(['constructor', 'delete', 'isDeleted', 'isAliasOf', 'deleteLater', 'clone']);
  for (const key of ['Manifold', 'CrossSection']) {
    const cls = mod[key];
    // 実際の立体の継承をたどり、各段の関数を包む（setup() が作るクラスと WASM 側のクラスで段が分かれている）
    const sample = key === 'Manifold' ? cls.cube([1, 1, 1]) : cls.square([1, 1]);
    const protos = new Set([cls.prototype]);
    for (let pr = Object.getPrototypeOf(sample); pr && pr !== Object.prototype; pr = Object.getPrototypeOf(pr)) protos.add(pr);
    sample.delete();
    for (const proto of protos) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, name);
        if (skip.has(name) || typeof d.value !== 'function' || d.value.__tracked) continue;
        const f = d.value;
        const w = function (...a) { return remember(f.apply(this, a)); }; w.__tracked = true;
        proto[name] = w;
      }
    }
    for (const name of Object.getOwnPropertyNames(cls)) {
      const f = cls[name];
      if (['prototype', 'length', 'name'].includes(name) || typeof f !== 'function') continue;
      const w = function (...a) { return remember(f.apply(this, a)); }; w.__tracked = true; cls[name] = w;
    }
    mod[key] = new Proxy(cls, { construct: (t, a) => remember(Reflect.construct(t, a)) });
  }
}
function release(set) {
  for (const o of set) { try { if (!o.isDeleted()) o.delete(); } catch { /* すでに解放済み */ } }
}

// IFCを読み込む間の進み具合の表示。画面と同じところで動くときは画面に直接書く。Web Worker の中では setProgress で画面に送る
let progress = (msg) => { const el = typeof document !== 'undefined' && document.getElementById('loading'); if (el) el.textContent = msg; };
export const setProgress = (f) => { progress = f; };

class HttpError extends Error { constructor(status, detail) { super(detail); this.status = status; } }
const getModel = () => { if (!model) throw new HttpError(409, 'IFCが読み込まれていません'); return model; };

// ---------------------------------------------------------------- 座標：内部は模型の中心に寄せた値、画面とのやり取りは元の座標
const L = (p) => [p[0] - model.offset[0], p[1] - model.offset[1]];
const Wd = (p) => [p[0] + model.offset[0], p[1] + model.offset[1]];
const ringsL = (polys) => (polys == null ? null : polys.map((rings) => rings.map((r) => r.map(L))));
const ringsW = (region) => region.rings().map((rings) => rings.map((r) => r.map(Wd)));

function b64(typed) {
  const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function worldPos(v) { const out = new Float32Array(v.length); for (let i = 0; i < v.length; i += 3) { out[i] = v[i] + model.offset[0]; out[i + 1] = v[i + 1] + model.offset[1]; out[i + 2] = v[i + 2]; } return out; }

function modelMeta(m) {
  const uncomputed = m.solids.filter((s) => !s.manifold).map((s) => ({ key: s.key, member_id: s.member_id, name: s.member_name, category: s.category, material: s.material, reason: s.error, reference_volume: s.reference_volume }))
    .concat(m.skipped.map((s) => ({ key: s.key, member_id: s.member_id, name: s.name, category: null, material: s.material, reason: s.reason, reference_volume: null })));
  const b = m.bounds;
  return {
    source: m.source, schema: m.schema,
    storeys: m.storeys,
    grids: m.grids.map((g) => ({ tag: g.tag, start: Wd(g.start), end: Wd(g.end) })),
    bounds: [b[0] + m.offset[0], b[1] + m.offset[1], b[2] + m.offset[0], b[3] + m.offset[1]],
    z_range: [Math.min(...m.solids.map((s) => s.bbox[2])), Math.max(...m.solids.map((s) => s.bbox[5]))],
    materials: m.materials,
    categories: CATEGORY_ORDER.filter((c) => m.solids.some((s) => s.category === c)),
    members: Object.fromEntries([...m.members.values()].map((x) => [x.member_id, { name: x.name, category: x.category, storey: x.storey, ifc_class: x.ifc_class }])),
    uncomputed,
    solid_count: m.solids.filter((s) => m.defaultMaterials.has(s.material)).length,
  };
}

const mats = (names) => (names != null ? new Set(names) : model.defaultMaterials);
const toPart = (p, name = '') => makePart({ name, z0: p.z0, z1: p.z1, region: Region.fromRings(ringsL(p.polygons ?? null)),
  categories: p.categories != null ? new Set(p.categories) : null, memberIds: p.member_ids != null ? new Set(p.member_ids) : null,
  materials: mats(p.materials ?? null), topAtMost: p.top_at_most ?? null });

function meshJson(pieces) {
  const pos = [], idx = []; let off = 0;
  for (const p of pieces) {
    const m = p.getMesh(); const np = m.numProp;
    for (let i = 0; i < m.vertProperties.length; i += np) pos.push(m.vertProperties[i] + model.offset[0], m.vertProperties[i + 1] + model.offset[1], m.vertProperties[i + 2]);
    for (const t of m.triVerts) idx.push(t + off);
    off += m.vertProperties.length / np;
  }
  if (!off) return null;
  return { pos: b64(Float32Array.from(pos)), idx: b64(Uint32Array.from(idx)) };
}

const SLIVER_VOLUME = 1e-6;
// 差し引いた部分を、どの条件に入っていたかで分ける（表示用。数量には使わない。Python版 _excluded_by_part）。
// 部材ごとの差し引いた片を、先に入れた条件から順にその条件の切り取り型で切る（片が小さいので速い）。
// 複数の条件に入る部分は先の条件の側に入れる（数量の差し引きと同じ優先順位）
function excludedByPart(parts, pieces, owners) {
  if (!pieces.length || !parts.length) return [];
  const clips = parts.map((p) => makeExcluder([p]));
  const byPart = parts.map(() => []);
  pieces.forEach((p, i) => {
    let rest = p;
    for (let k = 0; k < parts.length; k++) {
      const c = clips[k](owners[i]);
      if (!c) continue;
      const got = rest.intersect(c);
      if (got.volume() > EPS_VOLUME) byPart[k].push(got);
      rest = rest.subtract(c);
      if (rest.volume() <= EPS_VOLUME) break;
    }
  });
  const out = [];
  byPart.forEach((list, k) => {
    if (!list.length) return;
    // 先の条件を差し引いた境目に残る、厚みのほとんどない離れたかけらは描かない（面が重なって色が混ざって見えるため）
    const keep = union(list).decompose().filter((c) => c.volume() > SLIVER_VOLUME);
    if (!keep.length) return;
    const piece = M.Manifold.compose(keep);
    if (piece.volume() > EPS_VOLUME) out.push({ part: k, volume: piece.volume(), mesh: meshJson([piece]) });
  });
  return out;
}

function resultJson(r, label, region) {
  return {
    label, total: r.total, excluded: r.excluded, raw_sum: r.raw_sum, overlap: r.raw_sum - r.total,
    by_category: r.by_category, by_material: r.by_material,
    members: r.members.map((m) => ({ member_id: m.member_id, name: m.member_name, category: m.category, storey: m.storey, volume: m.volume })),
    uncomputed: r.uncomputed.map((u) => ({ member_id: u.member_id, name: u.member_name, category: u.category, key: u.key, reason: u.reason, reference_volume: u.reference_volume })),
    polygons: region ? ringsW(region) : null,
  };
}

// ---------------------------------------------------------------- API
const routes = {
  'GET /api/model': () => modelMeta(getModel()),
  'GET /api/meshes': () => getModel().solids.map((s) => ({ key: s.key, member_id: s.member_id, category: s.category, material: s.material, ok: !!s.manifold, pos: b64(worldPos(s.vertices)), idx: b64(s.faces) })),

  async 'POST /api/open'(body) {
    const file = body.get('file');
    if (!file || !file.name.toLowerCase().endsWith('.ifc')) throw new HttpError(400, 'IFCファイルを選択してください');
    const say = (msg) => progress(`${file.name}：${msg}`);
    say('ファイルを読んでいます…'); await new Promise((r) => setTimeout(r, 30));
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (model) for (const s of model.solids) s.manifold?.delete();
    model = null;
    unitMemo.map.clear(); // 覚えた打設リストの結果は、前のIFCのもの
    model = await loadModel(api, WEBIFC, bytes, file.name, say);
    return modelMeta(model);
  },

  'POST /api/compute'(req) {
    const m = getModel();
    const regions = req.boundaries?.length ? splitRegions(m.bounds, req.boundaries.map((b) => b.map(L))) : null;
    const cats = req.categories != null ? new Set(req.categories) : null;
    const ids = req.member_ids != null ? new Set(req.member_ids) : null;
    const ms = mats(req.materials ?? null);
    const excludeParts = (req.exclude_parts || []).map((p) => toPart(p));
    const exclude = makeExcluder(excludeParts);
    let zones = new Map();
    if (regions && req.seeds?.length) zones = assignZones(regions, req.seeds.map((s) => { const [x, y] = L([s.x, s.y]); return { label: s.label, x, y }; }));
    if (!zones.size) zones = new Map([['範囲全体', null]]);
    const results = [], excluded = [], owners = [];
    for (const [label, poly] of [...zones].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      const r = compute(m.solids, req.z0, req.z1, { region: poly, categories: cats, memberIds: ids, exclude, materials: ms });
      results.push(resultJson(r, label, poly)); excluded.push(...r.excluded_pieces); owners.push(...r.excluded_solids);
    }
    const z0 = Math.min(req.z0, req.z1), z1 = Math.max(req.z0, req.z1);
    return {
      z0, z1, zones: results,
      regions: regions ? regions.map(ringsW) : [],
      excluded_mesh: meshJson(excluded),
      excluded_by_part: excludedByPart(excludeParts, excluded, owners),
      hidden_keys: excluded.length ? fullyExcludedKeys(m.solids.filter((s) => (!cats || cats.has(s.category)) && (!ids || ids.has(s.member_id)) && ms.has(s.material)), z0, z1, exclude) : [],
    };
  },

  'POST /api/units'(req) {
    const m = getModel();
    const units = req.units.map((u) => ({ name: u.name, parts: u.parts.map((p) => toPart(p, u.name)) }));
    const on = req.exclude_registered ?? true;
    // 条件だけを鍵にする（区分名は数量に関係しない）。「除く」がオンなら区分の数量は前の区分にも関係する
    const pj = req.units.map((u) => JSON.stringify(u.parts.map(({ z0, z1, polygons, categories, member_ids, materials, top_at_most }) => [z0, z1, polygons ?? null, categories ?? null, member_ids ?? null, materials ?? null, top_at_most ?? null])));
    if (unitMemo.map.size > 5000) unitMemo.map.clear();
    const memo = { map: unitMemo.map, unitKey: (i) => `u|${on}|${on ? pj.slice(0, i + 1).join('|') : pj[i]}`, pairKey: (i, j) => `p|${pj[i]}|${pj[j]}` };
    const res = computeUnits(m.solids, units, on, memo);
    const unitMembers = (r) => {
      const rows = [];
      for (const [k, volume] of [...r.member_volumes].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
        const [member_id, material] = k.split('\u0000'); const x = m.members.get(member_id);
        rows.push({ member_id, name: x.name, category: x.category, storey: x.storey, material, volume, reason: null });
      }
      for (const s of r.uncomputed_solids) rows.push({ member_id: s.member_id, name: s.member_name, category: s.category, storey: s.storey, material: s.material, volume: null, reason: s.error || '形状不備' });
      return rows;
    };
    return {
      units: units.map((u, i) => { const r = res.results[i]; return { name: u.name, total: r.total, member_count: r.member_ids.size, uncomputed_count: r.uncomputed, ...(req.detail ? { members: unitMembers(r) } : {}) }; }),
      sum_total: res.sum_total, union_total: res.union_total,
      overlaps: res.overlaps.map((o) => ({ a: o.a, b: o.b, volume: o.volume, shared_volume: o.shared_volume,
        members: o.shared_members.map((x) => ({ member_id: x.member_id, name: x.member_name, category: x.category, volume: x.volume })) })),
    };
  },

  'POST /api/split_cells'(req) {
    getModel();
    return siteCells(req.cells, req.zones).map(([id, label, ring]) => ({ id, label, ring }));
  },

  'POST /api/export_site'(req) {
    const m = getModel();
    const z0 = Math.min(req.z0, req.z1), z1 = Math.max(req.z0, req.z1);
    const cats = req.categories != null ? new Set(req.categories) : new Set(m.solids.map((s) => s.category));
    const ms = mats(req.materials ?? null);
    const step = req.step ?? 0.05;
    const top = conTop(z0, z1, m.storeys.map((s) => s.elevation));
    // 先に打設リストに入れた区分の条件（重なる部分を除いて書き出す。D35）
    const exclude = makeExcluder((req.exclude_parts || []).map((p) => toPart(p)));
    const cells = siteCells(req.cells, req.zones, true).map(([id, label, ring]) => {
      const c = exportCell(m.solids, id, label, ring, z0, z1, cats, ms, step, top, exclude); c.ring = ring.map(Wd); return c;
    });
    const unc = new Map(); for (const c of cells) for (const u of c.uncomputed) unc.set(u.key, { name: u.member_name, category: u.category, reason: u.reason });
    const out = {
      cells: cells.map((c) => ({ id: c.id, label: c.label, ring: c.ring, from_top: c.from_top, slab: c.slab, slab_bottom_mm: c.slab_bottom_mm,
        beam_mid_mm: c.beam_mid_mm, members: c.members, ...(c.rise_from_top ? { rise_from_top: c.rise_from_top } : {}) })),
      uncomputed: [...unc.values()],
    };
    if (req.header === false) return out;
    const region = req.zones?.length ? Region.union(req.zones.map((z) => Region.fromRings(ringsL(z.polygons)))) : null;
    const whole = compute(m.solids, z0, z1, { region, categories: cats, materials: ms, exclude });
    const total = whole.total;
    const conditions = [...(req.conditions ?? []), ...(whole.excluded > EPS_VOLUME ? [EXCLUDED_NOTE] : [])];
    const footprints = m.solids.filter((s) => cats.has(s.category) && ms.has(s.material) && s.bbox[5] > z0 + ZTOL && s.bbox[2] < z1 - ZTOL)
      .map((s) => ({ category: s.category, box: [s.bbox[0] + m.offset[0], s.bbox[1] + m.offset[1], s.bbox[3] + m.offset[0], s.bbox[4] + m.offset[1]].map((v) => Math.round(v * 1000) / 1000) }));
    const b = m.bounds;
    return {
      format: 'ifc-concrete-qto/site', version: 1, exported_at: isoNow(), source: m.source, title: req.title ?? '', conditions,
      z0, z1, con_top: top, step, total, overlap_note: total - cells.reduce((a, c) => a + c.from_top[c.from_top.length - 1] + c.slab, 0),
      truck_m3: req.truck_m3 ?? 4.25, extra_pct: req.extra_pct ?? 0,
      storeys: m.storeys, grids: m.grids.map((g) => ({ tag: g.tag, start: Wd(g.start), end: Wd(g.end) })),
      bounds: [b[0] + m.offset[0], b[1] + m.offset[1], b[2] + m.offset[0], b[3] + m.offset[1]], footprints,
      zones: (req.zones || []).map((z) => ({ key: z.key, name: z.name })),
      boundaries: (req.boundaries || []).map((x) => x.map((p) => [...p])), ...out,
    };
  },
};

const EXCLUDED_NOTE = '先に入れた区分と重なる部分は除いています';

/** スパン（工区があれば工区の境界で切ったもの）。local=true なら内部の座標で返す */
function siteCells(cells, zones, local = false) {
  const res = splitCells(cells.map((c) => [c.id, c.label, c.ring.map(L)]), zones?.length ? zones.map((z) => [z.key, z.name, ringsL(z.polygons)]) : null);
  return local ? res : res.map(([id, label, ring]) => [id, label, ring.map(Wd)]);
}

function isoNow() {
  const d = new Date(); const off = -d.getTimezoneOffset(); const p = (n) => String(Math.abs(n)).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/** /api/* を受け持つ。戻り値は fetch と同じ Response */
export async function handle(method, path, body) {
  await ready;
  const fn = routes[`${method} ${path}`];
  try {
    if (!fn) throw new HttpError(404, 'Not Found');
    let out;
    if (path === '/api/open') out = await fn(body); // 読み込んだ立体は残す
    else {
      const mine = new Set(); scope = mine;
      try { out = fn(body); } finally { scope = null; }
      try { out = JSON.stringify(out); } finally { release(mine); }
      return new Response(out, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof UserError ? 400 : 500;
    if (status === 500) console.error(e);
    return new Response(JSON.stringify({ detail: e.message || String(e) }), { status, headers: { 'Content-Type': 'application/json' } });
  }
}

export function installFetch() {
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (!path.startsWith('/api/')) return orig(input, init);
    const method = (init.method || 'GET').toUpperCase();
    let body = init.body;
    if (typeof body === 'string') body = JSON.parse(body);
    return handle(method, path.split('?')[0], body);
  };
}
// テスト用（Node から呼ぶ）
export const _test = { scoped(fn) { const mine = new Set(); scope = mine; try { return JSON.parse(JSON.stringify(fn())); } finally { scope = null; release(mine); } }, routes, get model() { return model; }, set model(m) { model = m; unitMemo.map.clear(); }, get api() { return api; }, get M() { return M; } };
