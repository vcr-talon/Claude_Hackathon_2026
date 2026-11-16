// 平面（2D）の図形。Python版の shapely の代わり。
// 面の演算（和・差・共通部分・面積）は Manifold の CrossSection（Clipper2）で行い、
// 点や長方形との位置関係の判定は輪郭の座標で直接行う。単位はメートル。

let M = null;
export function setManifold(mod) { M = mod; }

const closeRing = (r) => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r);
const openRing = (r) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r);
const ringArea = (r) => { let s = 0; for (let i = 0, n = r.length; i < n; i++) { const a = r[i], b = r[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };

/** 平面の範囲（複数の多角形・穴あり）。 */
export class Region {
  constructor(cs) { this.cs = cs; this._contours = null; }
  /** [[外周, 穴...], ...]（shapely の MultiPolygon(...).buffer(0) と同じ扱い） */
  static fromRings(polygons) {
    if (polygons == null) return null;
    const parts = polygons.map((rings) => new M.CrossSection(rings.map((r) => openRing(r.map((p) => [p[0], p[1]]))), 'EvenOdd'));
    return new Region(parts.length === 1 ? parts[0] : M.CrossSection.union(parts));
  }
  static fromRing(ring) { return new Region(new M.CrossSection([openRing(ring.map((p) => [p[0], p[1]]))], 'EvenOdd')); }
  static box(x0, y0, x1, y1) { return new Region(new M.CrossSection([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], 'Positive')); }
  static union(regions) {
    const rs = regions.filter(Boolean);
    if (!rs.length) return new Region(new M.CrossSection([], 'Positive'));
    return new Region(rs.length === 1 ? rs[0].cs : M.CrossSection.union(rs.map((r) => r.cs)));
  }
  intersection(o) { return new Region(this.cs.intersect(o.cs)); }
  difference(o) { return new Region(this.cs.subtract(o.cs)); }
  area() { return this.cs.area(); }
  isEmpty() { return this.cs.isEmpty(); }
  bounds() { const b = this.cs.bounds(); return [b.min[0], b.min[1], b.max[0], b.max[1]]; }
  contours() { return this._contours ??= this.cs.toPolygons().map((c) => c.map((p) => [p[0], p[1]])); }
  /** [[外周, 穴...], ...]（外周は閉じた座標列。shapely の exterior.coords と同じ） */
  rings() {
    return this.cs.decompose().map((part) => {
      const cs = part.toPolygons().map((c) => c.map((p) => [p[0], p[1]]));
      cs.sort((a, b) => ringArea(b) - ringArea(a)); // 外周（正の面積）を先に
      return cs.map(closeRing);
    }).filter((p) => p.length);
  }
  /** 範囲内または境界上（shapely の covers） */
  covers(x, y) {
    let inside = false;
    for (const c of this.contours()) {
      for (let i = 0, n = c.length, j = n - 1; i < n; j = i++) {
        const [xi, yi] = c[i], [xj, yj] = c[j];
        if (onSegment(x, y, xi, yi, xj, yj)) return true;
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }
  /** 長方形と接するか重なるか（shapely の intersects） */
  intersectsBox(x0, y0, x1, y1) {
    const [rx0, ry0, rx1, ry1] = this.bounds();
    if (x1 < rx0 || x0 > rx1 || y1 < ry0 || y0 > ry1) return false;
    if (this.covers(x0, y0) || this.covers(x1, y0) || this.covers(x1, y1) || this.covers(x0, y1)) return true;
    const box = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for (const c of this.contours()) {
      for (let i = 0, n = c.length; i < n; i++) {
        const [px, py] = c[i];
        if (px >= x0 && px <= x1 && py >= y0 && py <= y1) return true;
        const q = c[(i + 1) % n];
        for (let k = 0; k < 4; k++) if (segmentsTouch(c[i], q, box[k], box[(k + 1) % 4])) return true;
      }
    }
    return false;
  }
  /** 長方形を丸ごと含むか（shapely の contains。面積で判定） */
  containsBox(x0, y0, x1, y1) {
    const [rx0, ry0, rx1, ry1] = this.bounds();
    if (x0 < rx0 || y0 < ry0 || x1 > rx1 || y1 > ry1) return false;
    const out = Region.box(x0, y0, x1, y1).cs.subtract(this.cs);
    const a = out.area(); out.delete();
    return a <= 1e-12 * Math.max(1, (x1 - x0) * (y1 - y0));
  }
}

function onSegment(x, y, ax, ay, bx, by) {
  const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const len = Math.hypot(bx - ax, by - ay) || 1;
  if (Math.abs(cross) / len > 1e-9) return false;
  return x >= Math.min(ax, bx) - 1e-9 && x <= Math.max(ax, bx) + 1e-9 && y >= Math.min(ay, by) - 1e-9 && y <= Math.max(ay, by) + 1e-9;
}
const orient2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function segmentsTouch(p1, p2, p3, p4) {
  const d1 = orient2(p3, p4, p1), d2 = orient2(p3, p4, p2), d3 = orient2(p1, p2, p3), d4 = orient2(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return onSegment(p1[0], p1[1], p3[0], p3[1], p4[0], p4[1]) || onSegment(p2[0], p2[1], p3[0], p3[1], p4[0], p4[1])
    || onSegment(p3[0], p3[1], p1[0], p1[1], p2[0], p2[1]) || onSegment(p4[0], p4[1], p1[0], p1[1], p2[0], p2[1]);
}

/** 平面の範囲を z0〜z1 の柱状の立体にする（Python版 region_prism） */
export function regionPrism(region, z0, z1) {
  return M.Manifold.extrude(region.cs, z1 - z0).translate([0, 0, z0]);
}

// ---------------------------------------------------------------- 境界線で切り分ける（Python版 partition.py）
const unit = (v) => { const n = Math.hypot(v[0], v[1]); if (n === 0) throw new UserError('境界線に長さ0の区間があります'); return [v[0] / n, v[1] / n]; };

export class UserError extends Error {}

function segIntersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-15) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  const e = 1e-12;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return { t: Math.min(1, Math.max(0, t)), u: Math.min(1, Math.max(0, u)), p: [a[0] + t * r[0], a[1] + t * r[1]] };
}

export function extendPolyline(points, bounds) {
  if (points.length < 2) throw new UserError('境界線には2点以上が必要です');
  const [xmin, ymin, xmax, ymax] = bounds;
  const reach = 2.0 * Math.hypot(xmax - xmin, ymax - ymin) + 1.0;
  const p = points.map((q) => [q[0], q[1]]);
  const u0 = unit([p[1][0] - p[0][0], p[1][1] - p[0][1]]);
  const n = p.length;
  const u1 = unit([p[n - 1][0] - p[n - 2][0], p[n - 1][1] - p[n - 2][1]]);
  for (let i = 1; i < n; i++) unit([p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]]);
  const line = [[p[0][0] - u0[0] * reach, p[0][1] - u0[1] * reach], ...p.slice(1, -1), [p[n - 1][0] + u1[0] * reach, p[n - 1][1] + u1[1] * reach]];
  // 自分自身との交差（隣り合わない区間どうし）
  for (let i = 0; i < line.length - 1; i++) for (let j = i + 2; j < line.length - 1; j++) {
    if (segIntersect(line[i], line[i + 1], line[j], line[j + 1])) throw new UserError('境界線が自分自身と交差しています');
  }
  return line;
}

/** モデル範囲を覆う長方形を境界線で切り分けた範囲の一覧（Python版 split_regions） */
export function splitRegions(bounds, boundaries, margin = 1.0) {
  const [xmin, ymin, xmax, ymax] = bounds;
  const R = [xmin - margin, ymin - margin, xmax + margin, ymax + margin];
  const rect = [[R[0], R[1]], [R[2], R[1]], [R[2], R[3]], [R[0], R[3]]];
  const segs = [];
  for (let i = 0; i < 4; i++) segs.push([rect[i], rect[(i + 1) % 4]]);
  for (const b of boundaries) {
    const line = extendPolyline(b, R);
    for (let i = 0; i < line.length - 1; i++) segs.push([line[i], line[i + 1]]);
  }
  // 交点で区間を分ける
  const cuts = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const x = segIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
    if (x) { cuts[i].push(x.t); cuts[j].push(x.u); }
  }
  const key = (p) => `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}`;
  const nodes = new Map(); const pts = [];
  const node = (p) => { const k = key(p); let i = nodes.get(k); if (i === undefined) { i = pts.length; nodes.set(k, i); pts.push(p); } return i; };
  const edges = new Set();
  const inRect = (p) => p[0] >= R[0] - 1e-9 && p[0] <= R[2] + 1e-9 && p[1] >= R[1] - 1e-9 && p[1] <= R[3] + 1e-9;
  segs.forEach(([a, b], i) => {
    const ts = [...new Set(cuts[i].map((t) => Math.round(t * 1e12) / 1e12))].sort((x, y) => x - y);
    for (let k = 0; k < ts.length - 1; k++) {
      const p = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]];
      const q = [a[0] + (b[0] - a[0]) * ts[k + 1], a[1] + (b[1] - a[1]) * ts[k + 1]];
      if (!inRect([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2])) continue; // 長方形の外（延長部分）は捨てる
      const u = node(p), v = node(q);
      if (u !== v) edges.add(u < v ? `${u}_${v}` : `${v}_${u}`);
    }
  });
  const adj = new Map();
  for (const e of edges) { const [u, v] = e.split('_').map(Number); (adj.get(u) || adj.set(u, new Set()).get(u)).add(v); (adj.get(v) || adj.set(v, new Set()).get(v)).add(u); }
  // 行き止まり（どこにもつながらない線の端）を取り除く
  let changed = true;
  while (changed) {
    changed = false;
    for (const [u, nb] of adj) if (nb.size <= 1) { for (const v of nb) adj.get(v)?.delete(u); adj.delete(u); changed = true; }
  }
  // 面をたどる（各頂点で反時計回りに並べ、来た辺の1つ手前＝時計回りで次の辺へ）
  const sorted = new Map();
  for (const [u, nb] of adj) sorted.set(u, [...nb].sort((a, b) => Math.atan2(pts[a][1] - pts[u][1], pts[a][0] - pts[u][0]) - Math.atan2(pts[b][1] - pts[u][1], pts[b][0] - pts[u][0])));
  const seen = new Set(); const faces = [];
  for (const [u, nb] of sorted) for (const v of nb) {
    if (seen.has(`${u}>${v}`)) continue;
    const ring = []; let a = u, b = v, guard = 0;
    while (!seen.has(`${a}>${b}`) && guard++ < 100000) {
      seen.add(`${a}>${b}`); ring.push(pts[a]);
      const around = sorted.get(b); const i = around.indexOf(a);
      const c = around[(i - 1 + around.length) % around.length];
      a = b; b = c;
    }
    if (ringArea(ring) > 1e-9) faces.push(ring);
  }
  return faces.map((r) => Region.fromRing(r));
}

/** 種を含む範囲に工区名を付け、同じ名前の範囲を合算する（Python版 assign_zones） */
export function assignZones(regions, seeds) {
  const owner = new Map();
  for (const s of seeds) {
    for (let i = 0; i < regions.length; i++) if (!owner.has(i) && regions[i].covers(s.x, s.y)) { owner.set(i, s.label); break; }
  }
  const zones = new Map();
  for (const [i, label] of owner) (zones.get(label) || zones.set(label, []).get(label)).push(regions[i]);
  return new Map([...zones].map(([l, rs]) => [l, Region.union(rs)]));
}
