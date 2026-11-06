// 現場残量アプリの計算（画面から切り離した純粋な関数）。docs/site_app_spec.md 4章
// 数量はPCアプリで作った「スパンごとの上端からの深さ→体積の表」を引いて足すだけ。

export const SITE_FORMAT = 'ifc-concrete-qto/site';

export const fmt = (v, d = 2) => v.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });

// 書き出したファイルを読んで確かめる。違う・壊れているときは画面にそのまま出せる文で投げる
export function parseSiteData(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('このアプリ用のデータではありません'); }
  if (data?.format !== SITE_FORMAT || !Array.isArray(data.cells)) throw new Error('このアプリ用のデータではありません');
  return data;
}

// 上端から dMm（mm）までの間にあるスラブ以外の体積。表の刻みの間は直線で補間し、表の範囲を超えたら全量
export function interp(fromTop, step, height, dMm) {
  const d = dMm / 1000;
  if (!(d > 0)) return fromTop[0];
  if (d >= height || fromTop.length < 2) return fromTop[fromTop.length - 1];
  const i = Math.min(Math.floor(d / step + 1e-9), fromTop.length - 2);
  const w = Math.min(step, height - i * step); // 最後の刻みだけ端数
  return fromTop[i] + (fromTop[i + 1] - fromTop[i]) * (d - i * step) / w;
}

export const fullVolume = (cell) => cell.from_top[cell.from_top.length - 1] + cell.slab;

// コン天：高さ範囲の中で一番上のSL（書き出しの con_top）。古いデータは階の高さから求め、SLがなければ範囲の上端。
// 範囲の上端がSLより上（例：6SL+600）でも、打設済み高さ「コン天から ○mm」はこのSLから測る
export function conTop(data) {
  if (typeof data.con_top === 'number') return data.con_top;
  const inside = (data.storeys ?? []).map((s) => s.elevation).filter((e) => e > data.z0 + 1e-6 && e <= data.z1 + 1e-6);
  return inside.length ? Math.min(Math.max(...inside), data.z1) : data.z1;
}
// コン天から範囲の上端までの高さ（mm）。0 なら上端がコン天
export const aboveMm = (data) => Math.max(0, Math.round((data.z1 - conTop(data)) * 1000));

// スパンの状態：'todo'（未打設）・'pouring'（打設中）・'done'（打設済み）
// 打設中は、柱・梁をコン天から dMm 下まで打設済みとして、そこからコン天までの柱・梁とスラブの全厚が残る。
// コン天より上（範囲の上端がSLより上のときの立ち上がりなど）は打設済みとして数えない（excludedAbove で別に出す）。
// dMm が null（高さ未計測）のときは、少なく見積もらないよう柱・梁を全部（コン天より上も）残りに数える
export function remaining(cell, status, dMm, data) {
  if (status === 'done') return 0;
  if (status !== 'pouring' || dMm === null || dMm === undefined) return fullVolume(cell);
  const h = data.z1 - data.z0, off = aboveMm(data);
  return interp(cell.from_top, data.step, h, off + dMm) - interp(cell.from_top, data.step, h, off) + cell.slab;
}

// 打設中で高さを入れたスパンの、コン天より上の柱・梁など（残りに含めない量）
export function excludedAbove(cell, status, dMm, data) {
  if (status !== 'pouring' || dMm === null || dMm === undefined) return 0;
  const off = aboveMm(data);
  return off ? interp(cell.from_top, data.step, data.z1 - data.z0, off) : 0;
}

// 全体の合計。予定はスパンの全量の合計（書き出し時に「いまの条件の数量」と一致を確認済み）、打設済みは予定−残り。
// excluded：コン天より上で残りに含めなかった量（打設済みに入る）
export function totals(data, statusOf, depthOf) {
  let planned = 0, rest = 0, restCount = 0, excluded = 0;
  for (const c of data.cells) {
    const s = statusOf(c.id);
    planned += fullVolume(c);
    rest += remaining(c, s, depthOf(c.id), data);
    excluded += excludedAbove(c, s, depthOf(c.id), data);
    if (s !== 'done') restCount++;
  }
  return { planned, remaining: rest, done: planned - rest, restCount, excluded };
}

// 打ち上がり高さの目安：対象スパンの値（スラブ下・梁せい中央）の中央値。PCアプリと同じく上側の中央値。
// 書き出しの値は範囲の上端からの距離なので、コン天からの距離に直す（コン天より上の部材の値は使わない）
export function presetMm(cells, key, data) {
  const off = data ? aboveMm(data) : 0;
  const vs = cells.map((c) => c[key]).filter((v) => v !== null && v !== undefined)
    .map((v) => v - off).filter((v) => v >= 0).sort((a, b) => a - b);
  return vs.length ? vs[Math.floor(vs.length / 2)] : null;
}

// 生コン車の台数：割増を含めた量を1台の積載量で割り、端数は最終車の量にする（PCアプリの truckPlan と同じ文面）
export function truckPlan(volume, truckM3, extraPct) {
  const cap = Number(truckM3) || 4.25, extra = Number(extraPct) || 0;
  const need = volume * (1 + extra / 100);
  const n = Math.floor(need / cap + 1e-9);
  let last = need - n * cap;
  if (last < 0.005) last = 0;
  const text = !need ? '残りなし' : !n ? `1台（${fmt(last)} m³）` : last
    ? `${fmt(cap)} m³ × ${n}台 ＋ 最終車 ${fmt(last)} m³（計 ${n + 1} 台）`
    : `${fmt(cap)} m³ × ${n}台（計 ${n} 台）`;
  return { need, extra, text };
}
