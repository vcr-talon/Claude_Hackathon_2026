// 平面図の描き方：「等間隔」は通り芯と通り芯の間をどこも同じ幅にして描く（狭いスパンもタップしやすく）。
// 「実寸」は書き出したときの座標のまま。どちらも描き方だけで、数量の計算（calc.js）には使わない。

const EPS = 1e-6;

// 1方向の引き伸ばし。knots（通り芯の位置）の間をどこも avg 幅に、建物の外側の帯（範囲の端〜最初の通り芯）は avg の半分にする。
// 範囲の外（延ばした通り芯や境界線の先）は、外側の帯と同じ割合で続ける
export function axisWarp(positions, lo, hi) {
  const knots = [...positions].sort((a, b) => a - b)
    .filter((v, i, a) => i === 0 || v - a[i - 1] > 1e-3);
  if (knots.length < 2) return (v) => v;
  const n = knots.length - 1, k0 = knots[0], kn = knots[n];
  const avg = (kn - k0) / n, band = avg / 2;
  const left = k0 - lo > EPS ? band / (k0 - lo) : 1;
  const right = hi - kn > EPS ? band / (hi - kn) : 1;
  return (v) => {
    if (v <= k0) return k0 - (k0 - v) * left;
    if (v >= kn) return k0 + n * avg + (v - kn) * right;
    let i = 0;
    while (v > knots[i + 1]) i++;
    return k0 + (i + (v - knots[i]) / (knots[i + 1] - knots[i])) * avg;
  };
}

// 通り芯の向き：x が一定なら 'x'（縦の線）、y が一定なら 'y'（横の線）、斜めなら null
function gridAxis({ start: [sx, sy], end: [ex, ey] }) {
  if (Math.abs(ex - sx) < 1e-6) return 'x';
  if (Math.abs(ey - sy) < 1e-6) return 'y';
  return null;
}

// 描くための座標一式。rings はスパンのID → 描く輪郭
function build(data, fx, fy) {
  const pt = ([x, y]) => [fx(x), fy(y)];
  const [x0, y0, x1, y1] = data.bounds;
  return {
    bounds: [fx(x0), fy(y0), fx(x1), fy(y1)],
    grids: (data.grids ?? []).map((g) => ({ ...g, start: pt(g.start), end: pt(g.end) })),
    footprints: (data.footprints ?? []).map((f) => {
      const [a, b, c, d] = f.box;
      return { ...f, box: [fx(a), fy(b), fx(c), fy(d)] };
    }),
    boundaries: (data.boundaries ?? []).map((pts) => pts.map(pt)),
    rings: new Map(data.cells.map((c) => [c.id, c.ring.map(pt)])),
  };
}

export const realLayout = (data) => build(data, (x) => x, (y) => y);

export function equalLayout(data) {
  const xs = [], ys = [];
  for (const g of data.grids ?? []) {
    const a = gridAxis(g);
    if (a === 'x') xs.push(g.start[0]);
    if (a === 'y') ys.push(g.start[1]);
  }
  const [x0, y0, x1, y1] = data.bounds;
  return build(data, axisWarp(xs, x0, x1), axisWarp(ys, y0, y1));
}
