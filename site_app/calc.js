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

// スパンの状態：'todo'（未打設）・'pouring'（打設中）・'done'（打設済み）
// 打設中は、柱・梁を上端から dMm まで打設済みとして、その上の柱・梁とスラブの全厚が残る
export function remaining(cell, status, dMm, data) {
  if (status === 'done') return 0;
  if (status !== 'pouring') return fullVolume(cell);
  return interp(cell.from_top, data.step, data.z1 - data.z0, dMm) + cell.slab;
}

// 全体の合計。予定はスパンの全量の合計（書き出し時に「いまの条件の数量」と一致を確認済み）、打設済みは予定−残り
export function totals(data, statusOf, depthOf) {
  let planned = 0, rest = 0, restCount = 0;
  for (const c of data.cells) {
    const s = statusOf(c.id);
    planned += fullVolume(c);
    rest += remaining(c, s, depthOf(c.id), data);
    if (s !== 'done') restCount++;
  }
  return { planned, remaining: rest, done: planned - rest, restCount };
}

// 打ち上がり高さの目安：対象スパンの値（スラブ下・梁せい中央）の中央値。PCアプリと同じく上側の中央値
export function presetMm(cells, key) {
  const vs = cells.map((c) => c[key]).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  return vs.length ? vs[Math.floor(vs.length / 2)] : null;
}

// 生コン車の台数：割増を含めた量を1台の積載量で割り、端数は最終車の量にする（PCアプリの truckPlan と同じ文面）
export function truckPlan(volume, truckM3, extraPct) {
  const cap = Number(truckM3) || 4.25, extra = Number(extraPct) || 0;
  const need = volume * (1 + extra / 100);
  const n = Math.floor(need / cap + 1e-9);
  let last = need - n * cap;
  if (last < 0.005) last = 0;
  const text = !need ? '—' : !n ? `1台（${fmt(last)} m³）` : last
    ? `${fmt(cap)} m³ × ${n}台 ＋ 最終車 ${fmt(last)} m³（計 ${n + 1} 台）`
    : `${fmt(cap)} m³ × ${n}台（計 ${n} 台）`;
  return { need, extra, text };
}
