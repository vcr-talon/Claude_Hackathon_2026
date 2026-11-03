// コンクリート数量算出 画面
// 平面図と3D表示は同じThree.jsのシーンを使い、カメラだけを切り替える（要件 D19・D27）。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const $ = (id) => document.getElementById(id);
const CAT_COLORS = { 柱: 0xc62828, 梁: 0xef6c00, 壁: 0x0288d1, スラブ: 0xa0a4a8, 基礎: 0x6d4c41, 階段: 0x6a1b9a, その他: 0x546e7a };
const ZONE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];
const ZONE_COLORS = { A: 0xe53935, B: 0x1e88e5, C: 0x43a047, D: 0xfb8c00, E: 0x8e24aa, F: 0x00897b };
const SELECT_COLOR = 0xffd600;
const ERROR_COLOR = 0xff1744;
const DIM_COLOR = 0xd5d8dc;
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const fmt = (v, d = 2) => v.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
const mm = (z) => Math.round(z * 1000).toLocaleString('ja-JP');
const signed = (v) => (v > 0 ? `+${v}` : v < 0 ? `${v}` : '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  meta: null,
  z0: 0, z1: 0,
  boundaries: [], // {axis, offset(mm), points:[[x,y],[x,y]]}
  seeds: [], // {label, x, y}
  regions: [], // 直近の計算で得た分割範囲 [[外周, 穴...], ...][]
  categories: new Set(),
  selected: new Set(),
  selectedOnly: false,
  mode: 'view',
  zoneLabel: 'A',
  view: 'plan',
  pending: null, // {axis, editIndex}
  result: null,
  units: [], // 打設区分 {name, parts: [{z0, z1, rangeText, label, polygons, categories, member_ids}]}
  unitResult: null,
  excludeRegistered: true, // 登録済みの区分と重なる部分を差し引く（先に登録した区分が優先）
  hiddenKeys: new Set(), // 高さ範囲内がすべて登録済みの立体（表示しない）
  slabSee: true, // 平面表示でスラブを透かす
};

// ---------- Three.js の準備 ----------
const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.localClippingEnabled = true;
viewport.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'labels';
viewport.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf5f6f8);
const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.6);
hemi.position.set(0, 0, 1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.6, -1, 2);
scene.add(sun);

const modelGroup = new THREE.Group();
const overlay = new THREE.Group(); // 通り芯・境界線・工区（高さ範囲の上端に置く）
const gridGroup = new THREE.Group();
const zoneGroup = new THREE.Group();
const lineGroup = new THREE.Group();
overlay.add(gridGroup, zoneGroup, lineGroup);
const excludedGroup = new THREE.Group(); // 登録済みの区分と重なり、差し引いた部分（灰色）
scene.add(modelGroup, excludedGroup, overlay);

// 高さ範囲の切断面：z0以上、z1以下だけを描画する
const clipBottom = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const clipTop = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
const clips = [clipBottom, clipTop];

const planCam = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 20000);
planCam.up.set(0, 1, 0);
const perspCam = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
perspCam.up.set(0, 0, 1);
const planCtl = new OrbitControls(planCam, renderer.domElement);
planCtl.enableRotate = false;
planCtl.screenSpacePanning = true;
planCtl.zoomToCursor = true;
planCtl.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
const perspCtl = new OrbitControls(perspCam, renderer.domElement);
perspCtl.enabled = false;
let camera = planCam;

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  const halfH = (planCam.top - planCam.bottom) / 2;
  planCam.left = -halfH * w / h;
  planCam.right = halfH * w / h;
  planCam.updateProjectionMatrix();
  perspCam.aspect = w / h;
  perspCam.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

// ---------- 形状 ----------
let meshes = [];
const matCache = new Map();
const edgeMat = new THREE.LineBasicMaterial({ color: 0x37474f, clippingPlanes: clips, transparent: true, opacity: 0.45 });

// 同じ高さで重なる面（梁天端とスラブ上面など）のちらつきを防ぐため、部材の種類ごとに
// カメラから見た奥行きを実長でずらす（m）。スラブを最も手前にし、スラブ上面と±1.5cm以内で
// 重なる柱頭・梁天端は必ずスラブに隠れる。モデルには数mm高い梁天端も低い梁天端もあるため、
// 画面の奥行き精度を単位にするずらし（polygonOffset）では距離や角度によってどちらかで点が出た
const DEPTH_BIAS = { スラブ: 0, 柱: 0.015, 梁: 0.03, 壁: 0.045, 階段: 0.045, 基礎: 0.045, その他: 0.045 };

// 頂点をカメラからの視線に沿って奥へずらす。視線上を動かすだけなので画面上の位置や形は変わらない
function applyDepthBias(material, bias) {
  if (!bias) return material;
  material.defines = { ...material.defines, DEPTH_BIAS: bias.toFixed(4) };
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      mvPosition.xyz += (isPerspectiveMatrix(projectionMatrix) ? normalize(mvPosition.xyz) : vec3(0.0, 0.0, -1.0)) * DEPTH_BIAS;
      gl_Position = projectionMatrix * mvPosition;`);
  };
  return material;
}

// depthWrite=false は透かしたスラブ用：下の部材を隠さず、白い三角のちらつきも出ない
function surfaceMat(color, opacity = 1, depthWrite = true, bias = 0) {
  const key = `${color}-${opacity}-${depthWrite}-${bias}`;
  if (!matCache.has(key)) {
    matCache.set(key, applyDepthBias(new THREE.MeshLambertMaterial({
      color, side: THREE.DoubleSide, clippingPlanes: clips, transparent: opacity < 1, opacity, depthWrite,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, // 輪郭線を面より手前に見せる
    }), bias));
  }
  return matCache.get(key);
}

// 平面表示で直上階のスラブが柱・梁・壁を覆わないよう、スラブを透かす（数量の範囲は変えない）
const seeThroughSlab = () => state.view === 'plan' && state.slabSee;

function decode(b64, Type) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Type(buf.buffer);
}

function buildMeshes(solids) {
  modelGroup.clear();
  meshes = solids.map((s) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(decode(s.pos, Float32Array), 3));
    g.setIndex(new THREE.BufferAttribute(decode(s.idx, Uint32Array), 1));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), edgeMat);
    const flat = g.toNonIndexed();
    flat.computeVertexNormals();
    flat.computeBoundingBox();
    const bb = flat.boundingBox;
    const mesh = new THREE.Mesh(flat, surfaceMat(CAT_COLORS[s.category] ?? CAT_COLORS['その他']));
    mesh.userData = { ...s, pos: null, idx: null, bbox: bb };
    mesh.add(edges);
    modelGroup.add(mesh);
    return mesh;
  });
}

const excludedMat = new THREE.MeshLambertMaterial({
  color: 0x4f5459, side: THREE.DoubleSide, clippingPlanes: clips, // スラブの薄い灰色と区別できる濃さ
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16, // 元の部材の面より手前に描く
});
function drawExcluded(mesh) {
  excludedGroup.clear();
  if (!mesh) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(decode(mesh.pos, Float32Array), 3));
  g.setIndex(new THREE.BufferAttribute(decode(mesh.idx, Uint32Array), 1));
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  const mesh3 = new THREE.Mesh(flat, excludedMat);
  mesh3.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), edgeMat)); // 元の形状を隠しても輪郭が分かるように
  excludedGroup.add(mesh3);
}

function paint() {
  const dimOthers = state.selectedOnly && state.selected.size > 0;
  for (const m of meshes) {
    const u = m.userData;
    m.visible = state.categories.has(u.category) && u.bbox.max.z > state.z0 && u.bbox.min.z < state.z1
      && !state.hiddenKeys.has(u.key); // 全部が登録済みの部材は灰色の除外部分だけを見せる
    let color = CAT_COLORS[u.category] ?? CAT_COLORS['その他'];
    let opacity = 1;
    if (!u.ok) color = ERROR_COLOR;
    else if (state.selected.has(u.member_id)) color = SELECT_COLOR;
    else if (dimOthers) { color = DIM_COLOR; opacity = 0.35; }
    const seeThrough = u.category === 'スラブ' && seeThroughSlab();
    const bias = DEPTH_BIAS[u.category] ?? DEPTH_BIAS['その他'];
    m.material = seeThrough ? surfaceMat(color, Math.min(opacity, 0.25), false, bias) : surfaceMat(color, opacity, true, bias);
    m.renderOrder = seeThrough ? 2 : 0; // 透明なスラブは他の部材の後に描く
  }
}

// ---------- 通り芯 ----------
const axisLines = new Map();
const axisTags = new Map(); // 通り芯名 → 両端の記号ラベル要素
function buildGrid() {
  gridGroup.clear();
  axisLines.clear();
  axisTags.clear();
  for (const a of state.meta.grids) {
    const [x0, y0] = a.start, [x1, y1] = a.end;
    const d = new THREE.Vector2(x1 - x0, y1 - y0).normalize().multiplyScalar(3);
    const p0 = new THREE.Vector3(x0 - d.x, y0 - d.y, 0), p1 = new THREE.Vector3(x1 + d.x, y1 + d.y, 0);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p0, p1]),
      new THREE.LineDashedMaterial({ color: 0x607d8b, dashSize: 1.2, gapSize: 0.5, depthTest: false }));
    line.computeLineDistances();
    line.renderOrder = 5;
    gridGroup.add(line);
    axisLines.set(a.tag, line);
    axisTags.set(a.tag, []);
    for (const p of [p0, p1]) {
      const div = document.createElement('div');
      div.className = 'gridtag';
      div.textContent = a.tag;
      const label = new CSS2DObject(div);
      label.position.copy(p);
      gridGroup.add(label);
      axisTags.get(a.tag).push(div);
    }
  }
}

// 強調中の通り芯：線は太くできないので、画面上で約8pxの帯（板）を重ねる
const band = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
  color: 0x1565c0, transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide,
}));
band.renderOrder = 6;
band.visible = false;
overlay.add(band);
let highlightTag = null;

function highlightAxis(tag) {
  if (tag !== highlightTag) {
    for (const [t, divs] of axisTags) divs.forEach((d) => d.classList.toggle('active', t === tag));
    highlightTag = tag;
  }
  updateBand();
}

function updateBand() {
  const a = highlightTag && state.meta.grids.find((g) => g.tag === highlightTag);
  band.visible = Boolean(a) && state.view === 'plan';
  if (!band.visible) return;
  const [x0, y0] = a.start, [x1, y1] = a.end;
  band.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
  band.rotation.set(0, 0, Math.atan2(y1 - y0, x1 - x0));
  band.scale.set(Math.hypot(x1 - x0, y1 - y0) + 6, 8 * worldPerPixel(), 1); // 長さは通り芯の表示（両端3m延長）に合わせる
}

// 通り芯の法線。保存形式の符号の決まり（X方向の線なら+X、Y方向の線なら+Y が正）に向ける
function axisNormal(a) {
  const [x0, y0] = a.start, [x1, y1] = a.end;
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  let nx = dy / len, ny = -dx / len;
  if ((Math.abs(nx) >= Math.abs(ny) && nx < 0) || (Math.abs(nx) < Math.abs(ny) && ny < 0)) { nx = -nx; ny = -ny; }
  return [nx, ny];
}

function offsetAxisLine(a, offsetMm) {
  const off = offsetMm / 1000;
  const [x0, y0] = a.start, [x1, y1] = a.end;
  const [nx, ny] = axisNormal(a);
  return [[x0 + nx * off, y0 + ny * off], [x1 + nx * off, y1 + ny * off]];
}

// 「X3通りから X4側 500 mm」：線を出した側で最も近い平行な通り芯の名前
function boundaryText(b) {
  if (!b.offset) return `${b.axis}通り`;
  const a = state.meta.grids.find((g) => g.tag === b.axis);
  const [nx, ny] = axisNormal(a);
  const dir = Math.sign(b.offset);
  let best = null, bestD = Infinity;
  for (const g of state.meta.grids) {
    const [gx, gy] = axisNormal(g);
    if (g.tag === a.tag || Math.abs(nx * gy - ny * gx) > 0.05) continue; // 平行でない通り芯は除く
    const d = (nx * (g.start[0] - a.start[0]) + ny * (g.start[1] - a.start[1])) * dir;
    if (d > 1e-6 && d < bestD) { bestD = d; best = g.tag; }
  }
  return `${b.axis}通りから ${best ? `${best}側` : '外側'} ${Math.abs(b.offset).toLocaleString('ja-JP')} mm`;
}

// ---------- 境界線・工区の描画 ----------
function extendedLine(points, color, dashed = false) {
  const [b0, b1, b2, b3] = state.meta.bounds;
  const reach = Math.hypot(b2 - b0, b3 - b1);
  const [p, q] = [points[0], points[points.length - 1]];
  const d = new THREE.Vector2(q[0] - p[0], q[1] - p[1]).normalize().multiplyScalar(reach);
  const pts = [new THREE.Vector3(p[0] - d.x, p[1] - d.y, 0), new THREE.Vector3(q[0] + d.x, q[1] + d.y, 0)];
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.8, gapSize: 0.4, depthTest: false })
    : new THREE.LineBasicMaterial({ color, depthTest: false });
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
  if (dashed) line.computeLineDistances();
  line.renderOrder = 9;
  return line;
}

function drawLines() {
  lineGroup.clear();
  state.boundaries.forEach((b, i) => {
    if (state.pending?.editIndex === i) return;
    lineGroup.add(extendedLine(b.points, 0xd50000));
  });
  if (state.pending) {
    const axis = state.meta.grids.find((a) => a.tag === state.pending.axis);
    const pts = offsetAxisLine(axis, pendingOffset());
    lineGroup.add(extendedLine(pts, 0x1565c0, true));
    // 寸法をプレビュー線のカーソル寄りに出す（カーソルがなければ通り芯の中央）
    const [[px, py], [qx, qy]] = pts, len = Math.hypot(qx - px, qy - py);
    const c = state.pending.cursor;
    const t = c ? ((c.x - px) * (qx - px) + (c.y - py) * (qy - py)) / len : len / 2;
    const div = document.createElement('div');
    div.className = 'dimtag';
    div.textContent = Math.abs(Number($('pendingOff').value) || 0).toLocaleString('ja-JP');
    const label = new CSS2DObject(div);
    label.position.set(px + (qx - px) * t / len, py + (qy - py) * t / len, 0);
    lineGroup.add(label);
  }
  for (const s of state.seeds) {
    const div = document.createElement('div');
    div.className = 'seedtag';
    div.style.color = hex(ZONE_COLORS[s.label] ?? 0x333333);
    div.textContent = s.label;
    const label = new CSS2DObject(div);
    label.position.set(s.x, s.y, 0);
    lineGroup.add(label);
  }
}

function drawZones() {
  zoneGroup.clear();
  for (const z of state.result?.zones ?? []) {
    if (!z.polygons) continue;
    for (const rings of z.polygons) {
      const shape = new THREE.Shape(rings[0].map(([x, y]) => new THREE.Vector2(x, y)));
      shape.holes = rings.slice(1).map((r) => new THREE.Path(r.map(([x, y]) => new THREE.Vector2(x, y))));
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({
        color: ZONE_COLORS[z.label] ?? 0x888888, transparent: true, opacity: 0.16, depthTest: false, side: THREE.DoubleSide,
      }));
      mesh.renderOrder = 3;
      zoneGroup.add(mesh);
    }
  }
}

// ---------- 視点 ----------
function fit() {
  const [x0, y0, x1, y1] = state.meta.bounds;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = x1 - x0, h = y1 - y0;
  const aspect = viewport.clientWidth / viewport.clientHeight;
  const halfH = Math.max(h / 2, w / 2 / aspect) * 1.12;
  Object.assign(planCam, { left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH, zoom: 1,
    near: 1, far: state.meta.z_range[1] - state.meta.z_range[0] + 200 }); // カメラは最上部+100mにある
  planCam.position.set(cx, cy, state.meta.z_range[1] + 100);
  planCtl.target.set(cx, cy, 0);
  planCam.updateProjectionMatrix();
  planCtl.update();
  aimPersp(true);
}

// 3Dのカメラを今の高さ範囲に向ける。reset でなければ見る向きと距離は保ち、高さだけ合わせる
function aimPersp(reset = false) {
  const [x0, y0, x1, y1] = state.meta.bounds;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, span = Math.max(x1 - x0, y1 - y0);
  const zc = (state.z0 + state.z1) / 2;
  if (reset) {
    perspCam.position.set(cx - span * 0.7, cy - span * 1.3, state.z1 + span * 0.9);
    // 描画距離をモデルの大きさに合わせて絞る（広すぎると奥行きの精度が落ち、面がちらつく）
    perspCam.near = Math.max(0.2, span / 500);
    perspCam.far = span * 20;
    perspCam.updateProjectionMatrix();
    perspCtl.maxDistance = span * 8;
  } else {
    perspCam.position.z += zc - perspCtl.target.z;
  }
  perspCtl.target.set(cx, cy, zc);
  perspCtl.update();
}

function setView(view) {
  state.view = view;
  camera = view === 'plan' ? planCam : perspCam;
  planCtl.enabled = view === 'plan';
  perspCtl.enabled = view !== 'plan';
  document.querySelectorAll('button.view').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (state.meta) { updateBand(); paint(); } // スラブの透かしは平面表示だけ
  $('slabSeeWrap').classList.toggle('hidden', view !== 'plan');
  // 境界線・工区名は平面でしか操作できないので、3Dに切り替えたらモードを抜ける
  if (view !== 'plan' && (state.mode === 'boundary' || state.mode === 'zone')) setMode(state.mode);
  updateHint();
}

// ---------- 高さ範囲 ----------
const elev = (name) => state.meta.storeys.find((s) => s.name === name).elevation;

const ALL_STOREYS = '__all__';

function fillStoreys() {
  for (const id of ['storey', 'upBase', 'lowBase']) {
    $(id).innerHTML = state.meta.storeys.map((s) => `<option>${esc(s.name)}</option>`).join('');
  }
  $('storey').insertAdjacentHTML('beforeend', `<option value="${ALL_STOREYS}">モデル全体</option>`);
  // 前回の施工階（同じIFCのとき）→ なければ中央の階
  const names = state.meta.storeys.map((s) => s.name);
  let last = null;
  try { last = localStorage.getItem(storeyKey()); } catch { /* 保存できない環境では使わない */ }
  $('storey').value = last && (last === ALL_STOREYS || names.includes(last)) ? last : names[Math.ceil(names.length / 2) - 1];
  onStoreyChange();
}

// 工区割がないときの呼び名（サーバーのラベル「範囲全体」は画面に出さない）
const wholeName = () => ($('storey').value === ALL_STOREYS ? '建物全体' : 'フロア全体');
const storeyKey = () => `qto.storey.${state.meta.source}`;

function onStoreyChange() {
  const names = state.meta.storeys.map((s) => s.name);
  try { localStorage.setItem(storeyKey(), $('storey').value); } catch { /* 同上 */ }
  if ($('storey').value === ALL_STOREYS) {
    // 最下階・最上階からの寸法で、モデル全体の高さを50mm単位で包む
    const [zmin, zmax] = state.meta.z_range, lo = names[0], up = names[names.length - 1];
    $('lowBase').value = lo;
    $('upBase').value = up;
    $('lowOff').value = Math.floor((zmin - elev(lo)) * 20) * 50;
    $('upOff').value = Math.ceil((zmax - elev(up)) * 20) * 50;
    applyRange();
    return;
  }
  const i = names.indexOf($('storey').value);
  $('lowBase').value = names[i];
  $('upBase').value = names[Math.min(i + 1, names.length - 1)];
  $('lowOff').value = 0;
  $('upOff').value = 0;
  applyRange();
}

function applyRange() {
  const lo = elev($('lowBase').value) + (Number($('lowOff').value) || 0) / 1000;
  const up = elev($('upBase').value) + (Number($('upOff').value) || 0) / 1000;
  state.z0 = Math.min(lo, up);
  state.z1 = Math.max(lo, up);
  clipBottom.constant = -state.z0;
  clipTop.constant = state.z1;
  overlay.position.z = state.z1 + 0.02;
  aimPersp(); // 3Dのカメラをその階の高さに向ける
  const lowTxt = `${$('lowBase').value}${signed(Number($('lowOff').value) || 0)}`;
  const upTxt = `${$('upBase').value}${signed(Number($('upOff').value) || 0)}`;
  $('rangeText').textContent = `${lowTxt} ～ ${upTxt}（${mm(state.z0)} ～ ${mm(state.z1)} mm）`;
  paint();
  scheduleCompute();
}

// ---------- モード ----------
function setMode(mode) {
  let next = state.mode === mode ? 'view' : mode; // 同じボタンをもう一度押すと終了
  const needBoundary = next === 'zone' && !state.boundaries.length;
  if (needBoundary) next = 'boundary';
  state.mode = next;
  state.guide = null;
  if ((state.mode === 'boundary' || state.mode === 'zone') && state.view !== 'plan') setView('plan');
  if (state.mode !== 'boundary') cancelPending();
  document.querySelectorAll('button.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  $('boundaryHelp').classList.toggle('hidden', state.mode !== 'boundary');
  $('zoneLabels').classList.toggle('hidden', state.mode !== 'zone');
  $('zoneHelp').classList.toggle('hidden', state.mode !== 'zone');
  $('selectHelp').classList.toggle('hidden', state.mode !== 'select');
  planCtl.mouseButtons.LEFT = state.mode === 'select' ? null : THREE.MOUSE.PAN;
  if (state.meta) highlightAxis(null);
  renderer.domElement.style.cursor = '';
  updateHint();
  if (needBoundary) toast('先に境界線を引いてください', 'error');
}

function updateHint() {
  const base = state.view === 'plan' ? '左ドラッグ：移動　ホイール：拡大縮小' : '左ドラッグ：回転　右ドラッグ：移動　ホイール：拡大縮小';
  const extra = state.guide ? `　｜　${state.guide}` : {
    boundary: '　｜　通り芯をクリックして境界線を作成',
    zone: `　｜　範囲をクリックして工区「${state.zoneLabel}」を付ける`,
    select: '　｜　部材をクリックで選択',
    view: '　｜　部材をクリックで情報表示',
  }[state.mode];
  $('hint').textContent = base + extra;
}

// 次にすることの案内（モードを変えるまで出し続ける）
function setGuide(text) {
  if (state.guide === text) return;
  state.guide = text;
  updateHint();
}

// 複線方式：通り芯をクリック → 寸法（常に正）を入力 → マウスのある側に線を出す
let lastPendingOff = 0; // 前回入力した寸法を次の初期値にする
function startPending(axisTag, editIndex = null) {
  const prev = editIndex !== null ? state.boundaries[editIndex].offset : null;
  state.pending = { axis: axisTag, editIndex, side: prev !== null && prev < 0 ? -1 : 1, cursor: null };
  $('pendingAxis').textContent = axisTag;
  $('pendingOff').value = prev !== null ? Math.abs(prev) : lastPendingOff;
  $('pending').classList.remove('hidden');
  $('pendingOff').focus();
  $('pendingOff').select();
  highlightAxis(axisTag);
  drawLines();
}

// 側（+1/-1、符号の決まりと同じ向き）を付けた寸法。保存形式の offset そのもの
function pendingOffset() {
  return Math.abs(Number($('pendingOff').value) || 0) * state.pending.side;
}

// カーソルが通り芯のどちら側にあるかで線を出す側を決める
function updatePendingSide(p) {
  const axis = state.meta.grids.find((a) => a.tag === state.pending.axis);
  const [nx, ny] = axisNormal(axis);
  const s = nx * (p.x - axis.start[0]) + ny * (p.y - axis.start[1]);
  if (Math.abs(s) > 4 * worldPerPixel()) state.pending.side = Math.sign(s); // 通り芯の真上では直前の側を保つ
  state.pending.cursor = { x: p.x, y: p.y };
  drawLines();
}

function confirmPending() {
  if (!state.pending) return;
  const axis = state.meta.grids.find((a) => a.tag === state.pending.axis);
  const offset = pendingOffset() || 0; // -0 を 0 にそろえる
  lastPendingOff = Math.abs(offset);
  const b = { axis: axis.tag, offset, points: offsetAxisLine(axis, offset) };
  if (state.pending.editIndex !== null) state.boundaries[state.pending.editIndex] = b;
  else state.boundaries.push(b);
  cancelPending();
  renderBoundaryList();
  scheduleCompute();
  if (!state.seeds.length) setGuide('線を足すなら次の通り芯をクリック。終わったら「工区名を付ける」へ');
}

function cancelPending() {
  state.pending = null;
  $('pending').classList.add('hidden');
  if (state.meta) highlightAxis(null);
  drawLines();
}

function renderBoundaryList() {
  $('boundaryList').innerHTML = state.boundaries.map((b, i) =>
    `<li><span data-edit="${i}" title="クリックで修正">境界${i + 1}：${esc(boundaryText(b))}</span>` +
    `<button data-del="${i}">削除</button></li>`).join('');
  drawLines();
}

function renderZoneLabels() {
  $('zoneLabels').innerHTML = ZONE_LABELS.map((l) =>
    `<button data-label="${l}" style="color:${l === state.zoneLabel ? '#fff' : hex(ZONE_COLORS[l])};` +
    `background:${l === state.zoneLabel ? hex(ZONE_COLORS[l]) : '#fff'}">${l}</button>`).join('');
}

// ---------- 画面操作（クリック・ドラッグ） ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function setRay(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}
function planPoint(ev) {
  setRay(ev);
  const p = new THREE.Vector3();
  return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -overlay.position.z), p) ? p : null;
}
function pickMember(ev) {
  setRay(ev);
  const hits = raycaster.intersectObjects(meshes.filter((m) => m.visible), false);
  const inRange = hits.filter((h) => h.point.z >= state.z0 - 1e-3 && h.point.z <= state.z1 + 1e-3);
  // スラブを透かしているときは、透けて見えている柱・梁・壁を優先して選ぶ
  const hit = (seeThroughSlab() && inRange.find((h) => h.object.userData.category !== 'スラブ')) || inRange[0];
  return hit ? hit.object.userData : null;
}
function worldPerPixel() {
  return (planCam.top - planCam.bottom) / planCam.zoom / viewport.clientHeight;
}
function nearestAxis(p) {
  let best = null, bestD = Infinity;
  for (const a of state.meta.grids) {
    const [x0, y0] = a.start, [x1, y1] = a.end;
    const dx = x1 - x0, dy = y1 - y0;
    const d = Math.abs(dy * (p.x - x0) - dx * (p.y - y0)) / Math.hypot(dx, dy);
    if (d < bestD) { bestD = d; best = a; }
  }
  return bestD <= 18 * worldPerPixel() ? best : null;
}
function pointInRings(x, y, rings) {
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return inRing(rings[0]) && !rings.slice(1).some(inRing);
}
const regionOf = (x, y) => state.regions.findIndex((polys) => polys.some((rings) => pointInRings(x, y, rings)));

function onClick(ev) {
  if (state.mode === 'boundary' && state.view === 'plan') {
    const p = planPoint(ev);
    if (state.pending) { // 寸法入力中のクリックは「この側で確定」
      if (p) updatePendingSide(p);
      confirmPending();
      return;
    }
    const axis = p && nearestAxis(p);
    if (axis) startPending(axis.tag);
    return;
  }
  if (state.mode === 'zone' && state.view === 'plan') {
    const p = planPoint(ev);
    if (!p) return;
    if (!state.boundaries.length) { toast('先に境界線を引いてください', 'error'); return; }
    const r = regionOf(p.x, p.y);
    const existing = state.seeds.filter((s) => regionOf(s.x, s.y) === r);
    state.seeds = state.seeds.filter((s) => !existing.includes(s));
    if (!existing.some((s) => s.label === state.zoneLabel)) state.seeds.push({ label: state.zoneLabel, x: p.x, y: p.y });
    drawLines();
    scheduleCompute();
    return;
  }
  const u = pickMember(ev);
  if (state.mode === 'select') {
    if (!u) { if (!ev.shiftKey) state.selected.clear(); }
    else if (ev.shiftKey) state.selected.has(u.member_id) ? state.selected.delete(u.member_id) : state.selected.add(u.member_id);
    else state.selected = new Set(state.selected.size === 1 && state.selected.has(u.member_id) ? [] : [u.member_id]);
    onSelectionChanged();
    return;
  }
  if (u) {
    const m = state.meta.members[u.member_id];
    const reason = u.ok ? '' : state.meta.uncomputed.find((x) => x.key === u.key)?.reason ?? '形状不備';
    showTip(ev, `<b>${esc(m.category)}　${esc(m.name || '(名称なし)')}</b>` +
      `<div>所属階：${esc(m.storey ?? '-')}　材料：${esc(u.material)}</div>` +
      (u.ok ? '' : `<div class="warn">未計算（${esc(reason)}）</div>`));
  }
}

let down = null;
const selbox = document.createElement('div');
selbox.className = 'selbox hidden';
viewport.appendChild(selbox);
renderer.domElement.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, button: ev.button }; hideTip(); });
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (state.mode === 'boundary' && state.view === 'plan') {
    const p = planPoint(ev);
    if (state.pending) {
      if (p) updatePendingSide(p);
    } else {
      const tag = p ? nearestAxis(p)?.tag ?? null : null;
      highlightAxis(tag);
      renderer.domElement.style.cursor = tag ? 'crosshair' : '';
    }
  }
  if (down && down.button === 0 && state.mode === 'select' && state.view === 'plan') {
    const r = viewport.getBoundingClientRect();
    Object.assign(selbox.style, {
      left: `${Math.min(down.x, ev.clientX) - r.left}px`, top: `${Math.min(down.y, ev.clientY) - r.top}px`,
      width: `${Math.abs(ev.clientX - down.x)}px`, height: `${Math.abs(ev.clientY - down.y)}px`,
    });
    selbox.classList.remove('hidden');
  }
});
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!down) return;
  const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
  if (down.button === 0 && moved < 5) onClick(ev);
  else if (down.button === 0 && state.mode === 'select' && state.view === 'plan') boxSelect(down, ev);
  selbox.classList.add('hidden');
  down = null;
});

function boxSelect(a, b) {
  const p = planPoint({ clientX: a.x, clientY: a.y }), q = planPoint(b);
  if (!p || !q) return;
  const [x0, x1] = [Math.min(p.x, q.x), Math.max(p.x, q.x)], [y0, y1] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
  if (!b.shiftKey) state.selected.clear();
  for (const m of meshes) {
    if (!m.visible) continue;
    const bb = m.userData.bbox;
    const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) state.selected.add(m.userData.member_id);
  }
  onSelectionChanged();
}

function onSelectionChanged() {
  $('selInfo').textContent = state.selected.size ? `${state.selected.size} 部材を選択中` : '';
  paint();
  if (state.selectedOnly) scheduleCompute();
}

// サーバーのエラー応答から理由を取り出す（JSONでない応答でも落ちないように）
async function errorDetail(res) {
  try {
    const d = (await res.json()).detail;
    return typeof d === 'string' ? d : `入力の形式が正しくありません（${res.status}）`;
  } catch {
    return `サーバーの応答が正しくありません（${res.status}）`;
  }
}

// 通知はビューポート上部のトーストに出す（画面下のヒント欄は操作ヒント専用）。
// error：赤・6秒またはクリックで閉じる／ok：緑・3秒／info：紺・4秒。同時には1つだけ
const TOAST_MS = { error: 6000, ok: 3000, info: 4000 };
let toastTimer = null;
function toast(msg, kind = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), TOAST_MS[kind] ?? 4000);
}

// 部材情報の吹き出し。次のクリックかカメラ操作で閉じる
function showTip(ev, html) {
  const el = $('tip'), r = viewport.getBoundingClientRect();
  el.innerHTML = html;
  el.classList.remove('hidden');
  // クリック位置の右下に出し、ビューポートからはみ出す場合は左・上に回す
  const x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
  el.style.left = `${Math.min(x, r.width - el.offsetWidth - 8)}px`;
  el.style.top = `${y + el.offsetHeight > r.height - 8 ? ev.clientY - r.top - el.offsetHeight - 10 : y}px`;
}
const hideTip = () => $('tip').classList.add('hidden');

// ---------- 計算 ----------
let computeTimer = null, computeSeq = 0;
function scheduleCompute() {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(runCompute, 120);
}

async function runCompute() {
  if (!state.meta) return;
  const seq = ++computeSeq;
  const body = {
    z0: state.z0, z1: state.z1,
    boundaries: state.boundaries.map((b) => b.points),
    seeds: state.seeds,
    categories: [...state.categories],
    member_ids: state.selectedOnly ? [...state.selected] : null,
    exclude_parts: state.excludeRegistered ? allParts() : [],
  };
  const res = await fetch('/api/compute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (seq !== computeSeq) return;
  if (!res.ok) {
    const detail = await errorDetail(res);
    $('resultBody').innerHTML = `<div class="warn">計算できません：${esc(detail)}</div>`;
    toast(`計算できません：${detail}`, 'error');
    return;
  }
  // 登録時に「計算した時点の条件」をそのまま使えるよう、条件も一緒に持っておく
  state.result = { ...(await res.json()), request: body, rangeText: $('rangeText').textContent };
  state.regions = state.result.regions;
  drawExcluded(state.result.excluded_mesh);
  state.hiddenKeys = new Set(state.result.hidden_keys);
  paint();
  drawZones();
  renderResults();
}

function renderResults() {
  const r = state.result;
  const allCats = state.categories.size === state.meta.categories.length;
  const filters = [];
  if (!allCats) filters.push(`部材種別：${[...state.categories].join('・')}`);
  if (state.selectedOnly) filters.push(`選択部材のみ（${state.selected.size}部材）`);
  let html = `<div class="muted">高さ範囲：${esc($('rangeText').textContent)}</div>`;
  if (filters.length) html += `<div class="muted">絞り込み：${esc(filters.join('／'))}</div>`;
  const labeled = r.zones.filter((z) => z.polygons);
  if (state.boundaries.length && !labeled.length) {
    html += `<div class="help">工区名が未設定です。「工区名を付ける」で範囲をクリックしてください（下は${wholeName()}の数量）</div>`;
  } else if (labeled.length) {
    const named = new Set(state.seeds.map((s) => regionOf(s.x, s.y)).filter((i) => i >= 0));
    const unnamed = state.regions.length - named.size;
    if (unnamed > 0) html += `<div class="help">⚠ 工区名が付いていない範囲が ${unnamed} か所あります。その範囲は数量に含まれていません</div>`;
    // 付け直しがあるのでモードは解除せず、案内だけ出す
    if (state.mode === 'zone') setGuide(unnamed > 0 ? null : '全部の範囲に名前が付きました。右の計算結果を確認してください');
  }
  // 大きな数字は条件全体の数量（未登録＋登録済み）。登録しても0にならない
  const whole = (z) => z.total + z.excluded;
  if (r.zones.length > 1) {
    const sum = r.zones.reduce((a, z) => a + whole(z), 0);
    const open = r.zones.reduce((a, z) => a + z.total, 0);
    html += `<div class="sum">工区合計 <div class="total">${fmt(sum)} m³</div>` +
      `<div class="muted">${r.zones.map((z) => `${esc(z.label)} ${fmt(whole(z))}`).join(' ＋ ')}` +
      `${open < sum - 0.0005 ? `　（未登録 ${fmt(open)}）` : ''}</div></div>`;
  }
  for (const z of r.zones) {
    const color = ZONE_COLORS[z.label];
    html += `<div class="zone"><h3>${color ? `<span class="chip" style="background:${hex(color)}"></span>工区 ` : ''}${esc(z.polygons ? z.label : wholeName())}</h3>`;
    html += `<div class="muted">この条件の数量</div><div class="total">${fmt(whole(z))} <small>m³</small></div>`;
    if (z.excluded > 0.0005) {
      html += '<div class="breakdown">' +
        `<span class="done">うち打設リストに登録済み（灰色表示）</span><span class="num done">${fmt(z.excluded)} m³</span>` +
        `<span class="open">未登録（追加できる分）</span><span class="num open">${fmt(z.total)} m³</span></div>`;
    }
    if (z.total > 0.0005) html += `<div class="muted">${z.excluded > 0.0005 ? '未登録分の内訳' : '内訳'}</div>`;
    html += '<table class="mini">';
    for (const [cat, v] of Object.entries(z.by_category)) {
      if (v < 0.0005) continue;
      html += `<tr><td><span class="chip" style="background:${hex(CAT_COLORS[cat] ?? 0x546e7a)}"></span> ${esc(cat)}</td><td class="num">${fmt(v)}</td></tr>`;
    }
    html += '</table>';
    const mats = Object.entries(z.by_material);
    if (mats.length > 1) {
      html += '<table class="mini">' + mats.map(([m, v]) => `<tr><td>${esc(m)}</td><td class="num">${fmt(v)}</td></tr>`).join('') + '</table>';
    }
    html += `<div class="muted">対象 ${z.members.length} 部材　重複控除 ${fmt(z.overlap)} m³（単純合計 ${fmt(z.raw_sum)}）</div>`;
    if (z.uncomputed.length) {
      const ref = z.uncomputed.reduce((a, u) => a + (u.reference_volume || 0), 0);
      html += `<details><summary class="warn">⚠ 未計算 ${z.uncomputed.length} 件（参考体積 ${fmt(ref)} m³・総数量に含まず）</summary><table class="mini">` +
        z.uncomputed.map((u) => `<tr><td>${esc(u.category)} ${esc(u.name)}</td><td>${esc(u.reason)}</td></tr>`).join('') + '</table></details>';
    }
    html += `<details><summary>対象部材の一覧</summary><table class="mini">` +
      z.members.slice(0, 300).map((m) => `<tr><td>${esc(m.category)}</td><td>${esc(m.name)}</td><td class="num">${fmt(m.volume, 3)}</td></tr>`).join('') +
      '</table><div class="muted">部材ごとの値は範囲内に切り取った体積（重複控除前）</div></details>';
    if (z.total > 0.0005) {
      const zi = r.zones.indexOf(z);
      html += `<div class="regrow"><button class="reg primary" data-reg="${zi}">＋ 未登録の ${fmt(z.total)} m³ を打設リストに追加</button>`;
      if (state.units.length) {
        html += `<select data-addto="${zi}"><option value="">既存の区分に追加…</option>` +
          state.units.map((u, i) => `<option value="${i}">区分${i + 1}「${esc(u.name)}」に追加</option>`).join('') + '</select>';
      }
      html += '</div>';
    } else if (z.excluded > 0.0005) {
      const ui = unitContaining(r, z);
      html += `<div class="alldone">✓ この条件はすべて打設リストに入っています${ui >= 0 ? `（区分${ui + 1}「${esc(state.units[ui].name)}」）` : ''}</div>`;
    }
    html += '</div>';
  }
  html += '<div class="muted">内訳は「柱→梁→壁→スラブ→基礎→階段→その他」の順で重なりを配分した参考値です。総数量は重複を除いた体積です。</div>';
  $('resultBody').innerHTML = html;
}

// いまの条件と同じ条件（高さ範囲・工区の形・絞り込み）を持つ区分の番号。なければ -1
function unitContaining(r, z) {
  const req = r.request;
  const allCats = req.categories.length === state.meta.categories.length;
  const same = (p) => Math.abs(p.z0 - r.z0) < 1e-6 && Math.abs(p.z1 - r.z1) < 1e-6
    && JSON.stringify(p.polygons) === JSON.stringify(z.polygons)
    && JSON.stringify(p.categories) === JSON.stringify(allCats ? null : req.categories)
    && JSON.stringify(p.member_ids) === JSON.stringify(req.member_ids);
  return state.units.findIndex((u) => u.parts.some(same));
}

// ---------- 打設区分 ----------
const partJson = ({ z0, z1, polygons, categories, member_ids }) => ({ z0, z1, polygons, categories, member_ids });
const allParts = () => state.units.flatMap((u) => u.parts.map(partJson));

// target が null なら新しい区分、数値ならその区分に条件を追加する
function registerUnit(zi, target = null) {
  const r = state.result, z = r.zones[zi], req = r.request;
  const allCats = req.categories.length === state.meta.categories.length;
  const part = {
    z0: r.z0, z1: r.z1, rangeText: r.rangeText,
    label: z.polygons ? z.label : null, polygons: z.polygons, wholeName: z.polygons ? undefined : wholeName(),
    categories: allCats ? null : req.categories, member_ids: req.member_ids,
  };
  if (target !== null) {
    const u = state.units[target];
    u.parts.push(part);
    if (u.autoName) u.name = unitName(u.parts);
  } else {
    state.units.push({ name: unitName([part]), parts: [part], autoName: true });
  }
  state.flash = { index: target ?? state.units.length - 1, at: Date.now() };
  onUnitsChanged();
}

// 条件から区分名を作る。高さ範囲と絞り込みが同じ条件は工区名をまとめる（例：4SL ～ 5SL A・B工区）
function unitName(parts) {
  const groups = new Map();
  for (const p of parts) {
    const filters = (p.categories ? `（${p.categories.join('・')}）` : '') + (p.member_ids ? `（選択${p.member_ids.length}部材）` : '');
    const key = p.rangeText.split('（')[0] + filters;
    if (!groups.has(key)) groups.set(key, { range: p.rangeText.split('（')[0], filters, labels: new Set(), wholeName: p.wholeName ?? 'フロア全体' });
    if (p.label) groups.get(key).labels.add(p.label);
  }
  return [...groups.values()].map((g) =>
    g.range + (g.labels.size ? ` ${[...g.labels].sort().join('・')}工区` : ` ${g.wholeName}`) + g.filters).join(' ＋ ');
}

function onUnitsChanged() {
  showUnitOutline(null); // 行の番号がずれるので縁取りを消す
  state.unitResult = null;
  renderUnits();
  runUnits();
  if (state.excludeRegistered) scheduleCompute(); // 登録した部分を今の計算から差し引く
  else if (state.result) renderResults(); // 「既存の区分に追加」の選択肢を更新
}

function partText(p) {
  const filters = [p.categories ? p.categories.join('・') : null, p.member_ids ? `選択${p.member_ids.length}部材` : null].filter(Boolean);
  return `${p.rangeText}　${p.label ? `工区${p.label}` : p.wholeName ?? 'フロア全体'}${filters.length ? `　絞り込み：${filters.join('／')}` : ''}`;
}

let unitSeq = 0;
async function runUnits() {
  const seq = ++unitSeq;
  if (!state.units.length) { state.unitResult = null; renderUnits(); return; }
  const body = {
    units: state.units.map((u) => ({ name: u.name, parts: u.parts.map(partJson) })),
    exclude_registered: state.excludeRegistered,
  };
  const res = await fetch('/api/units', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (seq !== unitSeq) return;
  if (!res.ok) {
    const detail = await errorDetail(res);
    $('unitSummary').innerHTML = `<div class="warn">計算できません：${esc(detail)}</div>`;
    toast(`打設リストを計算できません：${detail}`, 'error');
    return;
  }
  state.unitResult = await res.json();
  renderUnits();
}

function renderUnits() {
  const ur = state.unitResult;
  const overlapping = new Set((ur?.overlaps ?? []).filter((o) => o.members.length).flatMap((o) => [o.a, o.b]));
  $('unitHelp').classList.toggle('hidden', state.units.length > 0);
  $('unitList').innerHTML = state.units.map((u, i) => {
    const res = ur?.units[i];
    const label = u.parts.find((p) => p.label)?.label;
    const parts = u.parts.map((p, k) => `<div class="part muted">${u.parts.length > 1 ? `${k + 1}. ` : ''}${esc(partText(p))}` +
      `${u.parts.length > 1 ? ` <button class="x" data-pdel="${i}:${k}" title="この条件を外す">×</button>` : ''}</div>`).join('');
    // 追加した行を光らせる。再描画されても光り始めからの経過時間を引き継ぐ
    const flash = state.flash?.index === i && Date.now() - state.flash.at < 1200
      ? ` flash" style="animation-delay:-${Date.now() - state.flash.at}ms` : '';
    return `<li data-uidx="${i}" class="${overlapping.has(i) ? 'overlap' : ''}${flash}"><div class="unitrow">` +
      `<span class="chip" style="background:${hex(ZONE_COLORS[label] ?? 0x90a4ae)}"></span>` +
      `<input class="name" data-uname="${i}" value="${esc(u.name)}" title="区分名（変更できます）">` +
      `<span class="num">${res ? `${fmt(res.total)} m³` : '計算中…'}</span><button data-udel="${i}">削除</button></div>` +
      `<div class="muted">区分${i + 1}${res?.uncomputed_count ? `　<span class="warn">⚠ 未計算 ${res.uncomputed_count} 件</span>` : ''}</div>` +
      `${parts}</li>`;
  }).join('');
  renderUnitSummary();
}

function renderUnitSummary() {
  const ur = state.unitResult;
  // 見出しの大きな数字：二重拾いのない合計（除外オンなら区分の合計と同じ）
  $('listTotal').innerHTML = !state.units.length ? '' : ur ? `${fmt(ur.union_total)} <small>m³</small>` : '<small>計算中…</small>';
  if (!ur || !state.units.length) { $('unitSummary').innerHTML = ''; return; }
  const unitName = (i) => `区分${i + 1}「${esc(state.units[i].name)}」`;
  let html = ur.overlaps.length ? `<div class="unitsum">区分の単純合計<span class="num">${fmt(ur.sum_total)} m³</span></div>` : '';
  // 同じ部材が2つの区分に入っている＝登録の誤りの可能性が高いので黄色で警告する
  const shared = ur.overlaps.filter((o) => o.members.length);
  // 別の部材どうしの食い込み（柱とスラブの取り合いなど）は、モデル上避けられないので注記にとどめる
  const contact = ur.overlaps.filter((o) => o.volume - o.shared_volume > 0.0005);
  if (shared.length) {
    html += '<div class="overlapbox">⚠ 同じ部材が複数の区分に入っています。重なった部分は区分の合計で二重に数えています。';
    for (const o of shared) {
      html += `<div style="margin-top:6px"><b>${unitName(o.a)} と ${unitName(o.b)}</b>：${fmt(o.shared_volume)} m³</div>` +
        `<details><summary>重なっている部材（${o.members.length}）</summary><table class="mini">` +
        o.members.slice(0, 100).map((m) => `<tr><td>${esc(m.category)}</td><td>${esc(m.name)}</td><td class="num">${fmt(m.volume, 3)}</td></tr>`).join('') +
        '</table></details>';
    }
    html += '</div>';
  }
  if (contact.length) {
    html += '<div class="muted" style="margin-top:6px">部材どうしの食い込み（柱とスラブの取り合いなど）を両方の区分で数えている部分：' +
      contact.map((o) => `区分${o.a + 1}と${o.b + 1}で ${fmt(o.volume - o.shared_volume, 3)} m³`).join('、') + '</div>';
  }
  if (ur.overlaps.length) {
    html += `<div class="unitsum" style="margin-top:6px">重複を除いた合計<span class="num">${fmt(ur.union_total)} m³</span></div>`;
  } else if (state.excludeRegistered && state.units.length > 1) {
    html += '<div class="muted" style="margin-top:4px">先に登録した区分を優先し、後の区分から重なりを差し引いています（二重拾いなし）</div>';
  } else if (state.units.length > 1) {
    html += '<div class="muted" style="margin-top:4px">区分どうしの重なりはありません</div>';
  }
  $('unitSummary').innerHTML = html;
}

// リストの行にマウスを乗せると、その区分の範囲を「工区の形 × 高さ範囲」の箱で示す
// （平面図では縁取り、3Dでは立体に見える。今の高さ範囲の外にある条件も見えるよう切断しない）
const hoverGroup = new THREE.Group();
scene.add(hoverGroup);
let hoverUnit = null;
function showUnitOutline(i) {
  if (i === hoverUnit) return;
  hoverUnit = i;
  hoverGroup.clear();
  if (i === null || !state.units[i]) return;
  const [b0, b1, b2, b3] = state.meta.bounds;
  const whole = [[[[b0, b1], [b2, b1], [b2, b3], [b0, b3], [b0, b1]]]]; // 工区なし＝モデル全体
  for (const p of state.units[i].parts) {
    const color = ZONE_COLORS[p.label] ?? 0x37474f;
    for (const rings of p.polygons ?? whole) {
      const shape = new THREE.Shape(rings[0].map(([x, y]) => new THREE.Vector2(x, y)));
      shape.holes = rings.slice(1).map((r) => new THREE.Path(r.map(([x, y]) => new THREE.Vector2(x, y))));
      const geom = new THREE.ExtrudeGeometry(shape, { depth: p.z1 - p.z0, bevelEnabled: false });
      const box = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide,
      }));
      box.position.z = p.z0;
      box.renderOrder = 7;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25),
        new THREE.LineBasicMaterial({ color, depthTest: false })); // 部材に隠れても輪郭は見せる
      edges.renderOrder = 10;
      box.add(edges);
      hoverGroup.add(box);
    }
  }
}

// ---------- 工区割の保存・読込 ----------
const PLAN_FORMAT = 'ifc-concrete-qto/plan';
const RANGE_IDS = ['storey', 'upBase', 'upOff', 'lowBase', 'lowOff'];

function savePlan() {
  if (!state.meta) return;
  const plan = {
    format: PLAN_FORMAT, version: 2, saved_at: new Date().toISOString(), source: state.meta.source,
    excludeRegistered: state.excludeRegistered,
    range: Object.fromEntries(RANGE_IDS.map((id) => [id, $(id).value])),
    boundaries: state.boundaries, seeds: state.seeds,
    categories: [...state.categories], selected: [...state.selected], selectedOnly: state.selectedOnly,
    units: state.units,
  };
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(plan, null, 1)], { type: 'application/json' }));
  a.download = `${state.meta.source.replace(/\.ifc$/i, '')}_工区割_${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`工区割を保存しました：${a.download}`, 'ok');
}

function applyPlan(plan) {
  if (plan.format !== PLAN_FORMAT) throw new Error('このアプリで保存した工区割ファイルではありません');
  const storeys = new Set(state.meta.storeys.map((s) => s.name));
  const missing = ['storey', 'upBase', 'lowBase'].map((id) => plan.range[id]).filter((n) => n !== ALL_STOREYS && !storeys.has(n));
  if (missing.length) throw new Error(`開いているIFCに無い階があります（${[...new Set(missing)].join('、')}）`);
  const tags = new Set(state.meta.grids.map((a) => a.tag));
  const lost = plan.boundaries.filter((b) => !tags.has(b.axis)).map((b) => b.axis);
  if (lost.length) throw new Error(`開いているIFCに無い通り芯があります（${[...new Set(lost)].join('、')}）`);

  cancelPending();
  for (const id of RANGE_IDS) $(id).value = plan.range[id];
  state.boundaries = plan.boundaries;
  state.seeds = plan.seeds;
  state.categories = new Set(plan.categories.filter((c) => state.meta.categories.includes(c)));
  for (const cb of document.querySelectorAll('#categories input')) cb.checked = state.categories.has(cb.dataset.cat);
  state.selected = new Set(plan.selected.filter((id) => id in state.meta.members));
  state.selectedOnly = plan.selectedOnly;
  $('selectedOnly').checked = plan.selectedOnly;
  // version 1 は区分が条件を1つだけ持つ形式
  state.units = plan.units.map((u) => (u.parts ? u : { name: u.name, parts: [{ ...u, name: undefined }] }));
  state.unitResult = null;
  state.excludeRegistered = plan.excludeRegistered ?? true;
  $('excludeRegistered').checked = state.excludeRegistered;
  $('selInfo').textContent = state.selected.size ? `${state.selected.size} 部材を選択中` : '';
  renderBoundaryList();
  renderUnits();
  applyRange(); // 再描画と再計算
  runUnits();
}

async function openPlan(file) {
  try {
    const plan = JSON.parse(await file.text());
    applyPlan(plan);
    const note = plan.source && plan.source !== state.meta.source ? `（保存時のIFCは ${plan.source}。通り芯と階の名前で合わせました）` : '';
    toast(`工区割を開きました：${file.name}${note}`, 'ok');
  } catch (e) {
    toast(`工区割を開けませんでした：${e instanceof SyntaxError ? 'ファイルの形式が正しくありません' : e.message}`, 'error');
  }
}

// ---------- 初期化 ----------
function renderSidebar() {
  const m = state.meta;
  $('modelInfo').textContent = `${m.source}（${m.schema}）　コンクリート立体 ${m.solid_count} 件` +
    (m.uncomputed.length ? `　未計算 ${m.uncomputed.length} 件` : '');
  $('materials').innerHTML = Object.entries(m.materials).map(([name, info]) =>
    `<tr><td>${info.included ? '✅ 対象' : '— 除外'}</td><td>${esc(name)}</td><td class="num">${info.count}</td></tr>`).join('');
  state.categories = new Set(m.categories);
  $('categories').innerHTML = m.categories.map((c) =>
    `<label><input type="checkbox" data-cat="${esc(c)}" checked><span class="chip" style="background:${hex(CAT_COLORS[c])}"></span>${esc(c)}</label>`).join('');
}

async function loadModel() {
  $('loading').classList.remove('hidden');
  const res = await fetch('/api/model');
  if (!res.ok) {
    $('loading').textContent = 'IFCファイルを開いてください（左上「IFCを開く」）';
    return;
  }
  state.meta = await res.json();
  state.boundaries = [];
  state.seeds = [];
  state.selected.clear();
  state.units = [];
  state.unitResult = null;
  renderUnits();
  buildMeshes(await (await fetch('/api/meshes')).json());
  buildGrid();
  renderSidebar();
  renderBoundaryList();
  fillStoreys();
  resize();
  fit();
  setView('3d'); // 読込直後はモデル全体を3Dで見せる
  $('loading').classList.add('hidden');
}

$('storey').addEventListener('change', onStoreyChange);
for (const id of ['upBase', 'lowBase', 'upOff', 'lowOff']) $(id).addEventListener('change', applyRange);
document.querySelectorAll('button.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('button.view').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('fit').addEventListener('click', fit);
$('slabSee').addEventListener('change', (ev) => { state.slabSee = ev.target.checked; paint(); });
planCtl.addEventListener('change', () => { if (highlightTag) updateBand(); hideTip(); }); // 拡大縮小しても帯の太さを画面上で一定に
perspCtl.addEventListener('change', hideTip);
$('toast').addEventListener('click', () => $('toast').classList.add('hidden'));
$('pendingOk').addEventListener('click', confirmPending);
$('pendingCancel').addEventListener('click', cancelPending);
$('pendingOff').addEventListener('input', drawLines);
$('pendingOff').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') confirmPending(); });
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { cancelPending(); if (state.mode !== 'view') setMode(state.mode); } });
$('boundaryList').addEventListener('click', (ev) => {
  const del = ev.target.dataset.del, edit = ev.target.dataset.edit;
  if (del !== undefined) {
    // 範囲の形が変わり名前の対応が崩れるため、工区名は付け直してもらう
    state.boundaries.splice(Number(del), 1);
    state.seeds = [];
    renderBoundaryList(); drawLines(); scheduleCompute();
  }
  if (edit !== undefined) { if (state.mode !== 'boundary') setMode('boundary'); startPending(state.boundaries[Number(edit)].axis, Number(edit)); }
});
$('zoneLabels').addEventListener('click', (ev) => {
  if (!ev.target.dataset.label) return;
  state.zoneLabel = ev.target.dataset.label;
  renderZoneLabels();
  updateHint();
});
$('categories').addEventListener('change', (ev) => {
  const c = ev.target.dataset.cat;
  ev.target.checked ? state.categories.add(c) : state.categories.delete(c);
  paint();
  scheduleCompute();
});
$('resultBody').addEventListener('click', (ev) => {
  if (ev.target.dataset.reg !== undefined) registerUnit(Number(ev.target.dataset.reg));
});
$('resultBody').addEventListener('change', (ev) => {
  if (ev.target.dataset.addto === undefined || ev.target.value === '') return;
  registerUnit(Number(ev.target.dataset.addto), Number(ev.target.value));
});
$('unitList').addEventListener('click', (ev) => {
  const { udel, pdel } = ev.target.dataset;
  if (udel !== undefined) {
    state.units.splice(Number(udel), 1);
  } else if (pdel !== undefined) {
    const [i, k] = pdel.split(':').map(Number);
    const u = state.units[i];
    u.parts.splice(k, 1);
    if (u.autoName) u.name = unitName(u.parts);
  } else return;
  onUnitsChanged();
});
$('unitList').addEventListener('mouseover', (ev) => {
  const li = ev.target.closest('li[data-uidx]');
  showUnitOutline(li ? Number(li.dataset.uidx) : null);
});
$('unitList').addEventListener('mouseleave', () => showUnitOutline(null));
$('excludeRegistered').addEventListener('change', (ev) => {
  state.excludeRegistered = ev.target.checked;
  state.unitResult = null;
  renderUnits();
  runUnits();
  scheduleCompute();
});
$('unitList').addEventListener('input', (ev) => {
  if (ev.target.dataset.uname === undefined) return;
  const u = state.units[Number(ev.target.dataset.uname)];
  u.name = ev.target.value;
  u.autoName = false; // 手で付けた名前は、条件を追加しても上書きしない
  renderUnitSummary();
});
$('clearSel').addEventListener('click', () => { state.selected.clear(); onSelectionChanged(); });
$('selectedOnly').addEventListener('change', (ev) => { state.selectedOnly = ev.target.checked; paint(); scheduleCompute(); });
$('savePlan').addEventListener('click', savePlan);
$('planInput').addEventListener('change', (ev) => {
  if (ev.target.files[0]) openPlan(ev.target.files[0]);
  ev.target.value = ''; // 同じファイルをもう一度選べるように
});
$('fileInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  $('loading').textContent = `${file.name} を読み込んでいます…（初回は数十秒かかります）`;
  $('loading').classList.remove('hidden');
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/open', { method: 'POST', body: fd });
  if (!res.ok) { $('loading').textContent = `読み込めませんでした：${(await res.json()).detail}`; return; }
  await loadModel();
});

renderZoneLabels();
resize();
setView('plan');
animate();
loadModel();
