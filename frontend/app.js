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
  materials: new Set(), // 数える材料（初期値は名前に「コンクリート」を含む材料）
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
  zoneNames: {}, // 工区の表示名 {A: '1工区', ...}。内部のキーはA〜Fのまま
  remainCells: [], // 打設終盤の残りのスパン（打設順）
};

// 工区の表示名：名前を付けていればその名前、なければ「A」（見出しでは「工区 A」）
const zoneName = (l) => state.zoneNames[l] || l;
const zoneTitle = (l) => state.zoneNames[l] || `工区 ${l}`;

// ---------- 取り消し（Ctrl+Z）／やり直し（Ctrl+Y） ----------
// 境界線・工区名・打設リストを変える直前の状態を積む
const HISTORY_MAX = 30;
const undoStack = [], redoStack = [];
const snapshot = () => structuredClone({ boundaries: state.boundaries, seeds: state.seeds, units: state.units, zoneNames: state.zoneNames });
function pushHistory(s = snapshot()) {
  undoStack.push(s);
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
}
function restoreHistory(from, to, msg) {
  if (!from.length) return;
  to.push(snapshot());
  Object.assign(state, from.pop());
  cancelPending();
  renderBoundaryList();
  renderZoneLabels();
  onUnitsChanged();
  scheduleCompute();
  toast(msg, 'info');
}

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
    m.visible = state.categories.has(u.category) && state.materials.has(u.material)
      && u.bbox.max.z > state.z0 && u.bbox.min.z < state.z1
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
// 点列の両端の区間を、モデルの外まで延ばして描く（計算側の延長と同じ考え方）
function extendedLine(points, color, dashed = false) {
  const [b0, b1, b2, b3] = state.meta.bounds;
  const reach = Math.hypot(b2 - b0, b3 - b1);
  const out = (from, to) => {
    const d = new THREE.Vector2(to[0] - from[0], to[1] - from[1]).normalize().multiplyScalar(reach);
    return new THREE.Vector3(to[0] + d.x, to[1] + d.y, 0);
  };
  const n = points.length;
  const pts = [out(points[1], points[0]), ...points.slice(1, -1).map(([x, y]) => new THREE.Vector3(x, y, 0)),
    out(points[n - 2], points[n - 1])];
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
  const legs = state.pending ? pendingLegs() : [];
  const preview = legs.length && legsPolyline(legs);
  if (preview) lineGroup.add(extendedLine(preview, 0x1565c0, true));
  if (state.pending?.axis) {
    const pts = offsetAxisLine(gridOf(state.pending.axis), pendingOffset());
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
    div.textContent = zoneName(s.label);
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
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(ringsShape(rings)), new THREE.MeshBasicMaterial({
        color: ZONE_COLORS[z.label] ?? 0x888888, transparent: true, opacity: 0.16, depthTest: false, side: THREE.DoubleSide,
      }));
      mesh.renderOrder = 3;
      zoneGroup.add(mesh);
    }
  }
  // 名前のない範囲は数量に含まれないので、斜線と「未設定」で目に見えるようにする
  const named = new Set(state.seeds.map((s) => regionOf(s.x, s.y)));
  state.regions.forEach((polys, i) => {
    if (named.has(i)) return;
    let sx = 0, sy = 0, n = 0;
    for (const rings of polys) {
      zoneGroup.add(Object.assign(new THREE.Mesh(new THREE.ShapeGeometry(ringsShape(rings)), hatchMat), { renderOrder: 3 }));
      for (const [x, y] of rings[0].slice(0, -1)) { sx += x; sy += y; n++; }
    }
    const div = document.createElement('div');
    div.className = 'unsettag';
    div.textContent = state.mode === 'zone' ? 'クリックで工区名を付ける' : '未設定';
    const label = new CSS2DObject(div);
    label.position.set(sx / n, sy / n, 0);
    zoneGroup.add(label);
  });
  updateHatch();
  drawRegionHover();
}

const ringsShape = (rings) => {
  const shape = new THREE.Shape(rings[0].map(([x, y]) => new THREE.Vector2(x, y)));
  shape.holes = rings.slice(1).map((r) => new THREE.Path(r.map(([x, y]) => new THREE.Vector2(x, y))));
  return shape;
};

// 斜線ハッチ：32pxの透明キャンバスに灰色の斜線1本（角の切れ端も描いて継ぎ目なく並ぶようにする）
const hatchTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.strokeStyle = '#616161';
  g.lineWidth = 3;
  for (const d of [-32, 0, 32]) { g.beginPath(); g.moveTo(d, 32); g.lineTo(d + 32, 0); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const hatchMat = new THREE.MeshBasicMaterial({ map: hatchTex, transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide });
// ShapeGeometryのUVは平面座標(m)そのままなので、1マスが画面上で32pxになるよう繰り返し数を合わせる
function updateHatch() {
  const k = 1 / (32 * worldPerPixel());
  hatchTex.repeat.set(k, k);
}

// 工区名モードで、クリックすると名前が付く範囲を選択中の工区色でなぞる
// ---------- 打設終盤の残量 ----------
// スパン＝隣り合う通り芯で囲まれたマス。外側の通り芯からモデルの端までの帯（バルコニー等）も1マスにする
let cells = []; // {id, label, ring}
const remainGroup = new THREE.Group();
overlay.add(remainGroup);

function buildCells() {
  const groups = [];
  for (const a of state.meta.grids) {
    const n = axisNormal(a);
    let g = groups.find((x) => Math.abs(x.n[0] * n[1] - x.n[1] * n[0]) < 0.05);
    if (!g) groups.push(g = { n, lines: [] });
    g.lines.push({ o: g.n[0] * a.start[0] + g.n[1] * a.start[1], tag: a.tag });
  }
  groups.sort((a, b) => b.lines.length - a.lines.length);
  cells = [];
  if (groups.length < 2) return;
  const [b0, b1, b2, b3] = state.meta.bounds;
  for (const g of groups.slice(0, 2)) {
    g.lines.sort((a, b) => a.o - b.o);
    const os = [[b0, b1], [b2, b1], [b2, b3], [b0, b3]].map(([x, y]) => g.n[0] * x + g.n[1] * y);
    if (Math.min(...os) < g.lines[0].o - 0.2) g.lines.unshift({ o: Math.min(...os), tag: '端' });
    if (Math.max(...os) > g.lines.at(-1).o + 0.2) g.lines.push({ o: Math.max(...os), tag: '端' });
  }
  const [A, B] = groups;
  const pt = (a, b) => { // A.n·p = a.o かつ B.n·p = b.o の点
    const [ax, ay] = A.n, [bx, by] = B.n, det = ax * by - ay * bx;
    return [(a.o * by - ay * b.o) / det, (ax * b.o - a.o * bx) / det];
  };
  for (let i = 0; i + 1 < A.lines.length; i++) {
    for (let j = 0; j + 1 < B.lines.length; j++) {
      const [a0, a1, c0, c1] = [A.lines[i], A.lines[i + 1], B.lines[j], B.lines[j + 1]];
      const p = pt(a0, c0);
      cells.push({ id: `${i},${j}`, label: `${a0.tag}〜${a1.tag}×${c0.tag}〜${c1.tag}`,
        ring: [p, pt(a1, c0), pt(a1, c1), pt(a0, c1), p] });
    }
  }
}
// 残量モードで選ぶスパン。境界線があれば工区割の境界で切った片（タブレット用の書き出しと同じ切り方・名前）
let spans = [];
let spansKey = '';
const cellById = (id) => spans.find((c) => c.id === id);
const cellAt = (p) => spans.find((c) => pointInRings(p.x, p.y, [c.ring]));

// 工区（名前のない範囲は「未設定」）の境界でスパンを切る。工区割が変わったときだけサーバーに聞く
async function updateSpans() {
  let zones = null;
  if (state.boundaries.length && state.regions.length && state.result) {
    const named = new Set(state.seeds.map((s) => regionOf(s.x, s.y)));
    zones = state.result.zones.filter((z) => z.polygons).map((z) => ({ key: z.label, name: zoneName(z.label), polygons: z.polygons }));
    state.regions.forEach((polys, i) => { if (!named.has(i)) zones.push({ key: `R${i + 1}`, name: '未設定', polygons: polys }); });
  }
  const key = JSON.stringify(zones);
  if (key === spansKey) return;
  spansKey = key;
  if (!zones) {
    spans = cells;
  } else {
    const res = await fetch('/api/split_cells', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cells: cells.map(({ id, label, ring }) => ({ id, label, ring })), zones }) });
    if (!res.ok) { toast(`スパンを工区で分けられません：${await errorDetail(res)}`, 'error'); spans = cells; return; }
    if (key !== spansKey) return; // 待っている間に工区割が変わった
    spans = await res.json();
  }
  state.remainCells = state.remainCells.filter((id) => cellById(id)); // 切り方が変わって無くなったスパンは外す
  drawRemain();
  if (state.mode === 'remain') scheduleRemain();
}

// 部材の平面の外接箱がスパンに掛かるか。辺で接するだけの部材は数えないよう1cm縮めて判定（サーバーの touches と同じ）
const TOUCH_INSET = 0.01;
function rectTouchesRing(x0, y0, x1, y1, ring) {
  [x0, y0, x1, y1] = [x0 + TOUCH_INSET, y0 + TOUCH_INSET, x1 - TOUCH_INSET, y1 - TOUCH_INSET];
  if (x0 >= x1 || y0 >= y1) return pointInRings((x0 + x1) / 2, (y0 + y1) / 2, [ring]); // 細い部材は中心で
  if (ring.some(([x, y]) => x > x0 && x < x1 && y > y0 && y < y1)) return true;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  if (corners.some(([x, y]) => pointInRings(x, y, [ring]))) return true;
  const cross = (a, b, c, d) => { // 線分 ab と cd が交わるか
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  };
  for (let i = 0; i + 1 < ring.length; i++) {
    for (let k = 0; k < 4; k++) if (cross(ring[i], ring[i + 1], corners[k], corners[(k + 1) % 4])) return true;
  }
  return false;
}

function drawRemain() {
  remainGroup.clear();
  if (state.mode !== 'remain') return;
  state.remainCells.forEach((id, k) => {
    const c = cellById(id);
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(ringsShape([c.ring])), new THREE.MeshBasicMaterial({
      color: 0xfb8c00, transparent: true, opacity: 0.3, depthTest: false, side: THREE.DoubleSide }));
    fill.renderOrder = 4;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(c.ring.map(([x, y]) => new THREE.Vector3(x, y, 0))),
      new THREE.LineBasicMaterial({ color: 0xe65100, depthTest: false }));
    line.renderOrder = 8;
    const div = document.createElement('div');
    div.className = 'celltag';
    div.textContent = k + 1; // 打設順
    const tag = new CSS2DObject(div);
    const n = c.ring.length - 1;
    tag.position.set(c.ring.slice(0, n).reduce((s, q) => s + q[0], 0) / n, c.ring.slice(0, n).reduce((s, q) => s + q[1], 0) / n, 0);
    remainGroup.add(fill, line, tag);
  });
}

function toggleCell(p) {
  const c = cellAt(p);
  if (!c) return;
  const i = state.remainCells.indexOf(c.id);
  if (i >= 0) state.remainCells.splice(i, 1); else state.remainCells.push(c.id);
  drawRemain();
  scheduleRemain();
}

// 残りのスパンの条件：柱・梁など（スラブ以外）は打ち上がり高さ〜上端、スラブは全厚。重なりは1回だけ数える
function remainParts(ids, depthMm) {
  const polygons = ids.map((id) => [cellById(id).ring]);
  const top = state.z1, level = Math.max(state.z0, top - depthMm / 1000);
  const vertical = [...state.categories].filter((c) => c !== 'スラブ');
  const materials = customMaterials([...state.materials]);
  const parts = [];
  if (vertical.length && top - level > 1e-6) parts.push({ z0: level, z1: top, polygons, categories: vertical, member_ids: null, materials });
  if (state.categories.has('スラブ')) parts.push({ z0: state.z0, z1: top, polygons, categories: ['スラブ'], member_ids: null, materials });
  return parts;
}

async function remainVolume(ids, depthMm) {
  const parts = remainParts(ids, depthMm);
  if (!ids.length || !parts.length) return 0;
  const res = await fetch('/api/units', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ units: [{ name: '残量', parts }], exclude_registered: false }) });
  if (!res.ok) throw new Error(await errorDetail(res));
  return (await res.json()).units[0].total;
}

// 打設済み高さの欄（mm）。空欄は未計測で、少なく見積もらないよう柱・梁を全部残りに数える（全高さを打設済み高さにしたのと同じ）
const fullDepth = () => Math.round((state.z1 - state.z0) * 1000);
const remainDepthValue = () => ($('remainDepth').value.trim() === '' ? null : Math.max(0, Number($('remainDepth').value) || 0));

// 打ち上がり高さの目安：残りのスパン（なければ全体）に掛かる、上端付近のスラブ下端・梁せい中央の中央値
function presetDepth(kind) {
  const top = state.z1;
  if (kind === 'none') return fullDepth();
  const rings = (state.remainCells.length ? state.remainCells.map(cellById) : spans).map((c) => c.ring);
  const cat = kind === 'slab' ? 'スラブ' : '梁';
  const ds = [];
  for (const m of meshes) {
    const u = m.userData, bb = u.bbox;
    if (u.category !== cat || !state.materials.has(u.material) || Math.abs(bb.max.z - top) > 0.35) continue;
    if (!rings.some((r) => rectTouchesRing(bb.min.x, bb.min.y, bb.max.x, bb.max.y, r))) continue;
    ds.push(kind === 'slab' ? top - bb.min.z : top - (bb.min.z + bb.max.z) / 2);
  }
  if (!ds.length) return null;
  ds.sort((a, b) => a - b);
  return Math.round(ds[Math.floor(ds.length / 2)] * 100) * 10; // 10mm単位
}

// 生コン車の台数：割増を含めた量を1台の積載量で割り、端数は最終車の量にする
function truckPlan(volume) {
  const cap = Number($('truckM3').value) || 4.25, extra = Number($('extraPct').value) || 0;
  const need = volume * (1 + extra / 100);
  let n = Math.floor(need / cap + 1e-9), last = need - n * cap;
  if (last < 0.005) last = 0;
  const text = !need ? '残りなし' : !n ? `1台（${fmt(last)} m³）` : last
    ? `${fmt(cap)} m³ × ${n}台 ＋ 最終車 ${fmt(last)} m³（計 ${n + 1} 台）`
    : `${fmt(cap)} m³ × ${n}台（計 ${n} 台）`;
  return { need, extra, text };
}

let remainTimer = null, remainSeq = 0;
function scheduleRemain() {
  clearTimeout(remainTimer);
  remainTimer = setTimeout(runRemain, 150);
}
async function runRemain() {
  const ids = [...state.remainCells], input = remainDepthValue(), depth = input ?? fullDepth(), seq = ++remainSeq;
  if (!ids.length) { $('remainResult').innerHTML = '<span class="muted">残りのスパンを選ぶと計算します</span>'; return; }
  $('remainResult').innerHTML = '<span class="muted">計算中…</span>';
  try {
    const v = await remainVolume(ids, depth);
    if (seq !== remainSeq) return;
    const t = truckPlan(v);
    $('remainResult').innerHTML = `<div class="muted">残り ${ids.length} スパン・柱・梁は${input === null ? '未計測（全量で計算）' : `${input ? `コン天から ${input.toLocaleString('ja-JP')} mm 下` : 'コン天'}まで打設済み`}</div>` +
      `<div class="total">${fmt(v)} m³</div>` + (t.extra ? `<div class="muted">割増 ${t.extra}% 込み ${fmt(t.need)} m³</div>` : '') +
      `<div class="trucks">${t.extra ? '発注の目安：' : '発注の目安（割増なし）：'}${t.text}</div>`;
  } catch (e) {
    if (seq === remainSeq) $('remainResult').innerHTML = `<div class="warn">計算できませんでした（詳細：${esc(e.message)}）</div>`;
  }
}

// 残量の一覧表（早見表）：「残りのスパン数（打設順の後ろから）× 打ち上がり高さ」の残量と台数
async function exportRemainCsv() {
  const order = [...state.remainCells];
  if (!order.length) { toast('先に残りのスパンを選んでください', 'error'); return; }
  const levels = [['未計測（全量）', presetDepth('none')], ['梁せい中央', presetDepth('beam')], ['スラブ下', presetDepth('slab')]]
    .filter(([, d]) => d !== null);
  const cur = remainDepthValue() ?? fullDepth();
  if (!levels.some(([, d]) => d === cur)) levels.push(['入力値', cur]);
  toast('残量の一覧表を計算しています…', 'info');
  const rows = order.map((_, k) => order.slice(k)); // 残り n, n-1, ..., 1 スパン
  const vols = await Promise.all(rows.flatMap((ids) => levels.map(([, d]) => remainVolume(ids, d))));
  const head = ['残りのスパン数', '残りのスパン（打設順）'];
  for (const [name, d] of levels) head.push(`${name}${d === fullDepth() ? '' : `：コン天から${d}mm`}（m3）`, `${name}：生コン車`);
  const out = [head];
  rows.forEach((ids, r) => {
    const row = [ids.length, ids.map((id) => cellById(id).label).join(' → ')];
    levels.forEach((_, l) => { const v = vols[r * levels.length + l]; row.push(m3(v), truckPlan(v).text); });
    out.push(row);
  });
  out.push([], [`生コン車 ${$('truckM3').value} m³／台・割増 ${$('extraPct').value}%・高さ範囲 ${$('rangeText').textContent}`]);
  download(`${state.meta.source.replace(/\.ifc$/i, '')}_${stamp()}_残量一覧表.csv`, csvBlob(out));
  toast('残量の一覧表を書き出しました', 'ok');
}

// タブレット用データ：全スパンの「上端からの深さ→体積」の表を計算サーバーで作り、1つのJSONに保存する
// （docs/site_app_spec.md）。スパンを分けて送り、進捗を出す
const SITE_BATCH = 10;
async function exportSite() {
  if (!cells.length) { toast('通り芯からスパンを作れないため書き出せません', 'error'); return; }
  const r = state.result;
  const zones = (r?.zones ?? []).filter((z) => z.polygons)
    .map((z) => ({ key: z.label, name: zoneName(z.label), polygons: z.polygons }));
  const range = $('rangeText').textContent.split('（')[0];
  const conditions = [`高さ範囲：${$('rangeText').textContent}`];
  if (state.categories.size !== state.meta.categories.length) conditions.push(`数える部材：${[...state.categories].join('・')}`);
  conditions.push(`数える材料：${[...state.materials].join('・')}`);
  const base = {
    z0: state.z0, z1: state.z1, categories: [...state.categories], materials: [...state.materials], step: 0.05,
    zones: zones.length ? zones : null,
    title: zones.length ? `${range} ${zonesText(zones.map((z) => z.key).sort())}` : range, conditions,
    truck_m3: Number($('truckM3').value) || 4.25, extra_pct: Number($('extraPct').value) || 0,
    boundaries: zones.length ? state.boundaries.map((b) => b.points) : [],
  };
  const missing = (r?.zones ?? []).reduce((a, z) => a + z.uncomputed.length, 0);
  if (missing) toast(`未計算 ${missing} 件は含まれません`, 'error');
  let data = null;
  for (let i = 0; i < cells.length; i += SITE_BATCH) {
    if (!missing || i) toast(`スパン ${i} / ${cells.length} を計算しています…`, 'info');
    const res = await fetch('/api/export_site', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, header: i === 0,
        cells: cells.slice(i, i + SITE_BATCH).map(({ id, label, ring }) => ({ id, label, ring })) }),
    });
    if (!res.ok) throw new Error(await errorDetail(res));
    const part = await res.json();
    if (!data) data = part;
    else { data.cells.push(...part.cells); data.uncomputed.push(...part.uncomputed); }
  }
  const sum = data.cells.reduce((a, c) => a + c.from_top.at(-1) + c.slab, 0);
  data.overlap_note = data.total - sum; // 全スパンを合わせてから差を記録
  data.uncomputed = [...new Map(data.uncomputed.map((u) => [`${u.name}|${u.category}|${u.reason}`, u])).values()];
  const name = `${state.meta.source.replace(/\.ifc$/i, '')}_${base.title.replace(/[\s（）()]/g, '')}_現場用_${stamp()}.json`;
  download(name, new Blob([JSON.stringify(data)], { type: 'application/json' }));
  toast(`スパン ${data.cells.length} 件・合計 ${fmt(sum)} m³ を書き出しました${missing ? `（未計算 ${missing} 件は含まれません）` : ''}`, 'ok');
}

const regionHoverGroup = new THREE.Group();
overlay.add(regionHoverGroup);
let hoverRegion = -1;
function drawRegionHover(i = hoverRegion) {
  hoverRegion = state.mode === 'zone' && state.view === 'plan' ? i : -1;
  regionHoverGroup.clear();
  const polys = state.regions[hoverRegion];
  if (!polys) return;
  const color = ZONE_COLORS[state.zoneLabel] ?? 0x333333;
  for (const rings of polys) {
    for (const r of rings) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(r.map(([x, y]) => new THREE.Vector3(x, y, 0))),
        new THREE.LineBasicMaterial({ color, depthTest: false }));
      line.renderOrder = 8;
      regionHoverGroup.add(line);
    }
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(ringsShape(rings)), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.12, depthTest: false, side: THREE.DoubleSide }));
    fill.renderOrder = 4;
    regionHoverGroup.add(fill);
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
  // 残量モードは入るときだけ平面にする（3Dに切り替えても残りのスパンは立体で見える）
  if (['boundary', 'zone', 'remain'].includes(state.mode) && state.view !== 'plan') setView('plan');
  if (state.mode !== 'boundary') cancelPending();
  document.querySelectorAll('button.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  $('boundaryHelp').classList.toggle('hidden', state.mode !== 'boundary');
  $('zoneLabels').classList.toggle('hidden', state.mode !== 'zone');
  $('zoneHelp').classList.toggle('hidden', state.mode !== 'zone');
  $('selectHelp').classList.toggle('hidden', state.mode !== 'select');
  $('remainHelp').classList.toggle('hidden', state.mode !== 'remain');
  $('remainBody').classList.toggle('hidden', state.mode !== 'remain');
  if (state.meta) { drawRemain(); if (state.mode === 'remain') scheduleRemain(); }
  planCtl.mouseButtons.LEFT = state.mode === 'select' ? null : THREE.MOUSE.PAN;
  if (state.meta) highlightAxis(null);
  renderer.domElement.style.cursor = '';
  updateHint();
  if (state.meta) drawZones(); // 「未設定」の文言がモードで変わる
  if (needBoundary) toast('先に境界線を引いてください', 'error');
}

function updateHint() {
  const base = state.view === 'plan' ? '左ドラッグ：移動　ホイール：拡大縮小' : '左ドラッグ：回転　右ドラッグ：移動　ホイール：拡大縮小';
  const extra = state.guide ? `　｜　${state.guide}` : {
    boundary: '　｜　通り芯をクリックして境界線を作成',
    zone: `　｜　範囲をクリックして工区「${zoneName(state.zoneLabel)}」を付ける`,
    remain: '　｜　残りのスパンをタップ（打設順。もう一度タップで外す）',
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
// 折れ線は「区間」（通り芯＋寸法）をつなぎ、曲がり角は隣り合う区間の線の交点にする。
// 最初と最後の区間は、通り芯をクリックした位置（pick）の側へ延ばす
let lastPendingOff = 0; // 前回入力した寸法を次の初期値にする
const gridOf = (tag) => state.meta.grids.find((a) => a.tag === tag);
const boundaryLegs = (b) => [{ axis: b.axis, offset: b.offset }, ...(b.turns ?? [])];

function startPending(axisTag, editIndex = null, pick = null) {
  let legs = [], cur = null;
  if (editIndex !== null) { // 修正は最後の区間から。前の区間は「1つ前に戻る」で直す
    const b = state.boundaries[editIndex], all = boundaryLegs(b);
    legs = all.slice(0, -1).map((l, k) => ({ ...l, pick: k === 0 ? b.points[0] : null }));
    cur = all.at(-1);
    axisTag = cur.axis;
    pick = all.length > 1 ? b.points.at(-1) : b.points[0];
  }
  state.pending = { legs, axis: axisTag, pick, editIndex, side: cur && cur.offset < 0 ? -1 : 1, cursor: null };
  $('pendingOff').value = cur ? Math.abs(cur.offset) : lastPendingOff;
  showPendingAxis();
}

// 寸法入力欄の見出しと「1つ前に戻る」の出し分け。次の通り芯を選ぶ間は寸法欄を隠す
function showPendingAxis() {
  const pd = state.pending, choosing = pd.axis === null;
  $('pendingAxis').textContent = choosing ? '' : pd.axis;
  $('pendingLegs').textContent = pd.legs.length ? `${pd.legs.map((l) => boundaryText(l)).join(' → ')} → ` : '';
  $('pendingInput').classList.toggle('hidden', choosing);
  $('pendingChoose').classList.toggle('hidden', !choosing);
  $('pendingBack').classList.toggle('hidden', !pd.legs.length);
  $('pendingTurn').classList.toggle('hidden', choosing);
  $('pending').classList.remove('hidden');
  if (!choosing) { $('pendingOff').focus(); $('pendingOff').select(); }
  highlightAxis(pd.axis);
  drawLines();
}

// 側（+1/-1、符号の決まりと同じ向き）を付けた寸法。保存形式の offset そのもの
function pendingOffset() {
  return Math.abs(Number($('pendingOff').value) || 0) * state.pending.side;
}

// 入力中の区間を含めた全区間
function pendingLegs() {
  const pd = state.pending;
  return pd.axis === null ? pd.legs : [...pd.legs, { axis: pd.axis, offset: pendingOffset() || 0, pick: pd.pick }];
}

// 区間の並び → 境界線の点列 [延長側の点, 曲がり角..., 延長側の点]。平行な区間が続くと交点がないので null
function legsPolyline(legs) {
  const lines = legs.map((l) => offsetAxisLine(gridOf(l.axis), l.offset));
  if (lines.length === 1) return lines[0];
  const corners = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const c = lineIntersection(lines[i], lines[i + 1]);
    if (!c) return null;
    corners.push(c);
  }
  // 端の区間は、角から pick の側へ1m 出した点で向きを表す（両端は計算でモデルの外まで延長される）
  const end = ([p, q], corner, pick) => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]), ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
    const s = pick ? Math.sign((pick[0] - corner[0]) * ux + (pick[1] - corner[1]) * uy) || 1 : 1;
    return [corner[0] + ux * s, corner[1] + uy * s];
  };
  return [end(lines[0], corners[0], legs[0].pick), ...corners, end(lines.at(-1), corners.at(-1), legs.at(-1).pick)];
}

function lineIntersection([[x1, y1], [x2, y2]], [[x3, y3], [x4, y4]]) {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-9 * Math.hypot(x1 - x2, y1 - y2) * Math.hypot(x3 - x4, y3 - y4)) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

// 入力中の区間を固定して、次の通り芯を選ぶ状態にする（Shift+クリック／「ここで折る」）
function turnPending() {
  const pd = state.pending;
  if (!pd || pd.axis === null) return;
  pd.legs = pendingLegs();
  lastPendingOff = Math.abs(pd.legs.at(-1).offset);
  Object.assign(pd, { axis: null, pick: null, side: 1 });
  $('pendingOff').value = lastPendingOff;
  showPendingAxis();
}

// 折れ線の次の区間に使える通り芯（直前の区間と平行なものは交点がないので除く）
function pickNextAxis(axis, p) {
  const pd = state.pending;
  pd.axis = axis.tag;
  pd.pick = [p.x, p.y];
  pd.side = 1;
  showPendingAxis();
}
function crossesLastLeg(axis) {
  const last = state.pending?.legs.at(-1);
  if (!last) return true;
  const [ax, ay] = axisNormal(gridOf(last.axis)), [bx, by] = axisNormal(axis);
  return Math.abs(ax * by - ay * bx) > 0.05;
}

function backPending() {
  const pd = state.pending;
  if (!pd?.legs.length) return;
  const pts = legsPolyline(pendingLegs()), k = pd.legs.length - 1;
  const prev = pd.legs.pop();
  // 最初の区間に戻るときはその pick（延ばす側）をそのまま使う。
  // 途中の区間に戻るときは、外した区間との角の側へ延ばす（今の形を保つ）
  const pick = k === 0 || !pts ? prev.pick : pts[k + 1];
  Object.assign(pd, { axis: prev.axis, pick, side: prev.offset < 0 ? -1 : 1 });
  $('pendingOff').value = Math.abs(prev.offset);
  showPendingAxis();
}

// カーソルが通り芯のどちら側にあるかで線を出す側を決める
function updatePendingSide(p) {
  if (state.pending.axis === null) return;
  const axis = state.meta.grids.find((a) => a.tag === state.pending.axis);
  const [nx, ny] = axisNormal(axis);
  const s = nx * (p.x - axis.start[0]) + ny * (p.y - axis.start[1]);
  if (Math.abs(s) > 4 * worldPerPixel()) state.pending.side = Math.sign(s); // 通り芯の真上では直前の側を保つ
  state.pending.cursor = { x: p.x, y: p.y };
  drawLines();
}

function confirmPending() {
  if (!state.pending) return;
  const legs = pendingLegs(); // 次の通り芯を選ぶ前に確定したら、そこまでの区間で終える
  if (!legs.length) { cancelPending(); return; }
  const points = legsPolyline(legs);
  if (!points) { toast('平行な通り芯どうしはつなげません', 'error'); return; }
  lastPendingOff = Math.abs(legs.at(-1).offset);
  const [first, ...turns] = legs.map(({ axis, offset }) => ({ axis, offset }));
  const b = { ...first, points };
  if (turns.length) b.turns = turns; // 折れ線のときだけ持つ（直線は今までの形のまま）
  pushHistory();
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
    `<li><span data-edit="${i}" title="クリックで修正">境界${i + 1}：${esc(boundaryLegs(b).map(boundaryText).join(' → '))}</span>` +
    `<button data-del="${i}">削除</button></li>`).join('');
  drawLines();
}

// ボタンは作り直さず見た目だけ更新する（作り直すとダブルクリックが届かない）
function renderZoneLabels() {
  const box = $('zoneLabels');
  if (!box.children.length) {
    box.innerHTML = ZONE_LABELS.map((l) => `<button data-label="${l}" title="ダブルクリックで名前を変更"></button>`).join('');
  }
  for (const b of box.querySelectorAll('button[data-label]')) {
    const l = b.dataset.label, on = l === state.zoneLabel;
    b.textContent = zoneName(l);
    b.style.color = on ? '#fff' : hex(ZONE_COLORS[l]);
    b.style.background = on ? hex(ZONE_COLORS[l]) : '#fff';
  }
}

// 工区のボタンをダブルクリックすると、その場で名前を入力できる（空にするとA〜Fに戻る）
function editZoneName(btn) {
  const l = btn.dataset.label;
  const input = document.createElement('input');
  input.className = 'zonename';
  input.value = state.zoneNames[l] ?? '';
  input.placeholder = l;
  btn.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.replaceWith(btn);
    if (save && name !== (state.zoneNames[l] ?? '')) {
      pushHistory();
      state.zoneNames = { ...state.zoneNames };
      if (name) state.zoneNames[l] = name; else delete state.zoneNames[l];
      onZoneNamesChanged();
    }
    renderZoneLabels();
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation(); // Escでモードが終わらないように
    if (ev.key === 'Enter') finish(true);
    if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function onZoneNamesChanged() {
  for (const u of state.units) if (u.autoName) u.name = unitName(u.parts);
  renderZoneLabels();
  drawLines();
  updateHint();
  renderUnits();
  if (state.result) renderResults();
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
function nearestAxis(p, usable = () => true) {
  let best = null, bestD = Infinity;
  for (const a of state.meta.grids) {
    if (!usable(a)) continue;
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
    if (state.pending?.axis === null) { // 折れ線の次の通り芯を選ぶ
      const axis = p && nearestAxis(p, crossesLastLeg);
      if (axis) pickNextAxis(axis, p);
      return;
    }
    if (state.pending) { // 寸法入力中のクリックは「この側で確定」、Shift+クリックは「ここで折る」
      if (p) updatePendingSide(p);
      ev.shiftKey ? turnPending() : confirmPending();
      return;
    }
    const axis = p && nearestAxis(p);
    if (axis) startPending(axis.tag, null, [p.x, p.y]);
    return;
  }
  if (state.mode === 'remain') {
    const p = state.view === 'plan' && planPoint(ev);
    if (p) toggleCell(p);
    return;
  }
  if (state.mode === 'zone' && state.view === 'plan') {
    const p = planPoint(ev);
    if (!p) return;
    if (!state.boundaries.length) { toast('先に境界線を引いてください', 'error'); return; }
    const r = regionOf(p.x, p.y);
    const existing = state.seeds.filter((s) => regionOf(s.x, s.y) === r);
    pushHistory();
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
    if (state.pending?.axis) {
      if (p) updatePendingSide(p);
    } else {
      const tag = p ? nearestAxis(p, state.pending ? crossesLastLeg : undefined)?.tag ?? null : null;
      highlightAxis(tag);
      renderer.domElement.style.cursor = tag ? 'crosshair' : '';
    }
  }
  if (state.mode === 'zone' && state.view === 'plan' && !down) {
    const p = planPoint(ev);
    const i = p ? regionOf(p.x, p.y) : -1;
    if (i !== hoverRegion) drawRegionHover(i);
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
    if (typeof d === 'string') return d;
    // 入力チェックの誤りは、どの項目かを添える（原因を追えるように）
    const where = Array.isArray(d) && d[0]?.loc ? `：${d[0].loc.slice(1).join('.')} ${d[0].msg ?? ''}` : '';
    return `入力の形式が正しくありません（${res.status}${where}）`;
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
    materials: [...state.materials],
    exclude_parts: state.excludeRegistered ? allParts() : [],
  };
  const res = await fetch('/api/compute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (seq !== computeSeq) return;
  if (!res.ok) {
    const detail = await errorDetail(res);
    $('resultBody').innerHTML = `<div class="warn">計算できませんでした（詳細：${esc(detail)}）</div>`;
    toast(`計算できませんでした（詳細：${detail}）`, 'error');
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
  if (state.mode === 'remain') scheduleRemain(); // 高さ範囲・部材種別・材料の変更を残量にも反映
  updateSpans().catch((e) => toast(`スパンを工区で分けられません：${e.message}`, 'error'));
}

function renderResults() {
  const r = state.result;
  const allCats = state.categories.size === state.meta.categories.length;
  const filters = [];
  if (!allCats) filters.push(`部材種別：${[...state.categories].join('・')}`);
  const mats = customMaterials([...state.materials]);
  if (mats) filters.push(`材料：${mats.join('・')}`);
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
      `<div class="muted">${r.zones.map((z) => `${esc(zoneName(z.label))} ${fmt(whole(z))}`).join(' ＋ ')}` +
      `${open < sum - 0.0005 ? `　（未登録 ${fmt(open)}）` : ''}</div></div>`;
  }
  for (const z of r.zones) {
    const color = ZONE_COLORS[z.label];
    html += `<div class="zone"><h3>${color ? `<span class="chip" style="background:${hex(color)}"></span>` : ''}${esc(z.polygons ? zoneTitle(z.label) : wholeName())}</h3>`;
    html += `<div class="muted">この条件の数量</div><div class="total">${fmt(whole(z))} <small>m³</small></div>`;
    if (z.excluded > 0.0005) {
      html += '<div class="breakdown">' +
        `<span class="done">うち打設リストに登録済み（灰色表示）</span><span class="num done">${fmt(z.excluded)} m³</span>` +
        `<span class="open">未登録（追加できる分）</span><span class="num open">${fmt(z.total)} m³</span></div>`;
    }
    // 常に見せるのは工区名・数量・種別内訳・未計算の警告・追加ボタンだけ。根拠は折りたたむ
    if (z.total > 0.0005) {
      html += `<div class="muted">${z.excluded > 0.0005 ? '未登録分の内訳' : '内訳'}` +
        ' <span class="qmark" title="柱→梁→壁→スラブ→基礎→階段→その他の順で重なりを配分した参考値です。総数量は重複を除いた体積です。">？</span></div>';
    }
    html += '<table class="mini">';
    for (const [cat, v] of Object.entries(z.by_category)) {
      if (v < 0.0005) continue;
      html += `<tr><td><span class="chip" style="background:${hex(CAT_COLORS[cat] ?? 0x546e7a)}"></span> ${esc(cat)}</td><td class="num">${fmt(v)}</td></tr>`;
    }
    html += '</table>';
    if (z.uncomputed.length) {
      const ref = z.uncomputed.reduce((a, u) => a + (u.reference_volume || 0), 0);
      html += `<details><summary class="warn">⚠ 未計算 ${z.uncomputed.length} 件（参考体積 ${fmt(ref)} m³・総数量に含まず）</summary><table class="mini">` +
        z.uncomputed.map((u) => `<tr><td>${esc(u.category)} ${esc(u.name)}</td><td>${esc(u.reason)}</td></tr>`).join('') + '</table></details>';
    }
    html += `<details class="basis"><summary>根拠を見る</summary>` +
      `<div class="muted">対象 ${z.members.length} 部材　重複控除 ${fmt(z.overlap)} m³（単純合計 ${fmt(z.raw_sum)}）</div>`;
    const mats = Object.entries(z.by_material);
    if (mats.length > 1) {
      html += '<div class="muted">材料内訳</div><table class="mini">' +
        mats.map(([m, v]) => `<tr><td>${esc(m)}</td><td class="num">${fmt(v)}</td></tr>`).join('') + '</table>';
    }
    html += '<div class="muted">対象部材の一覧（範囲内に切り取った体積・重複控除前）</div><table class="mini">' +
      z.members.slice(0, 300).map((m) => `<tr><td>${esc(m.category)}</td><td>${esc(m.name)}</td><td class="num">${fmt(m.volume, 3)}</td></tr>`).join('') +
      '</table></details>';
    if (z.total > 0.0005) {
      const zi = r.zones.indexOf(z);
      html += `<div class="regrow"><button class="reg primary" data-reg="${zi}" title="未登録の ${fmt(z.total)} m³ を追加します">` +
        // 一部が登録済みのときだけ「未登録分」と添え、全体をもう一度足すと誤解されないようにする（数量はすぐ上に出ている）
        `＋ ${z.excluded > 0.0005 ? '未登録分を' : ''}打設リストに追加</button>`;
      if (state.units.length) {
        html += `<select data-addto="${zi}"><option value="">打設リストの既存の行にまとめる…</option>` +
          state.units.map((u, i) => `<option value="${i}">区分${i + 1}「${esc(u.name)}」にまとめる</option>`).join('') + '</select>';
      }
      html += '</div>';
    } else if (z.excluded > 0.0005) {
      const ui = unitContaining(r, z);
      html += `<div class="alldone">✓ この条件はすべて打設リストに入っています${ui >= 0 ? `（区分${ui + 1}「${esc(state.units[ui].name)}」）` : ''}</div>`;
    }
    html += '</div>';
  }
  $('resultBody').innerHTML = html;
}

// いまの条件と同じ条件（高さ範囲・工区の形・絞り込み）を持つ区分の番号。なければ -1
function unitContaining(r, z) {
  const req = r.request;
  const allCats = req.categories.length === state.meta.categories.length;
  const same = (p) => Math.abs(p.z0 - r.z0) < 1e-6 && Math.abs(p.z1 - r.z1) < 1e-6
    && JSON.stringify(p.polygons) === JSON.stringify(z.polygons)
    && JSON.stringify(p.categories) === JSON.stringify(allCats ? null : req.categories)
    && JSON.stringify(p.member_ids) === JSON.stringify(req.member_ids)
    && JSON.stringify(p.materials ?? null) === JSON.stringify(customMaterials(req.materials));
  return state.units.findIndex((u) => u.parts.some(same));
}

// ---------- 打設区分 ----------
// materials が null（省略）の条件は、サーバー側で初期の材料（コンクリート）として数える
const partJson = ({ z0, z1, polygons, categories, member_ids, materials }) => ({ z0, z1, polygons, categories, member_ids, materials });

// 初期の材料と同じなら null（区分名や条件の表示に材料を出さない）。違えば並べ替えた材料名
const defaultMaterials = () => Object.entries(state.meta.materials).filter(([, v]) => v.included).map(([k]) => k).sort();
function customMaterials(list) {
  const sorted = [...list].sort();
  return JSON.stringify(sorted) === JSON.stringify(defaultMaterials()) ? null : sorted;
}
const allParts = () => state.units.flatMap((u) => u.parts.map(partJson));

// target が null なら新しい区分、数値ならその区分に条件を追加する
function registerUnit(zi, target = null) {
  const r = state.result, z = r.zones[zi], req = r.request;
  const allCats = req.categories.length === state.meta.categories.length;
  const part = {
    z0: r.z0, z1: r.z1, rangeText: r.rangeText,
    label: z.polygons ? z.label : null, polygons: z.polygons, wholeName: z.polygons ? undefined : wholeName(),
    categories: allCats ? null : req.categories, member_ids: req.member_ids,
    materials: customMaterials(req.materials),
  };
  pushHistory();
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
    const filters = (p.categories ? `（${p.categories.join('・')}）` : '') + (p.member_ids ? `（選択${p.member_ids.length}部材）` : '')
      + (p.materials ? `（${p.materials.join('・')}）` : '');
    const key = p.rangeText.split('（')[0] + filters;
    if (!groups.has(key)) groups.set(key, { range: p.rangeText.split('（')[0], filters, labels: new Set(), wholeName: p.wholeName ?? 'フロア全体' });
    if (p.label) groups.get(key).labels.add(p.label);
  }
  return [...groups.values()].map((g) => g.range + ` ${g.labels.size ? zonesText([...g.labels].sort()) : g.wholeName}` + g.filters).join(' ＋ ');
}

// 工区の並び：名前を変えていなければ「A・B工区」、変えていれば「1工区・東側」
function zonesText(labels) {
  if (!labels.some((l) => state.zoneNames[l])) return `${labels.join('・')}工区`;
  return labels.map((l) => state.zoneNames[l] || `${l}工区`).join('・');
}

function onUnitsChanged() {
  showUnitOutline(null); // 行の番号がずれるので縁取りを消す
  state.unitResult = null;
  renderUnits();
  runUnits();
  if (state.excludeRegistered) scheduleCompute(); // 登録した部分を今の計算から差し引く
  else if (state.result) renderResults(); // 「既存の区分に追加」の選択肢を更新
}

// 条件の表示用の各項目（画面の行とCSVで共通）
function partFields(p) {
  const filters = [p.categories ? p.categories.join('・') : null, p.member_ids ? `選択${p.member_ids.length}部材` : null,
    p.materials ? `材料：${p.materials.join('・')}` : null].filter(Boolean);
  return { range: p.rangeText, zone: p.label ? zonesText([p.label]) : p.wholeName ?? 'フロア全体', filters: filters.join('／') };
}
function partText(p) {
  const f = partFields(p);
  return `${f.range}　${f.zone}${f.filters ? `　絞り込み：${f.filters}` : ''}`;
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
    $('unitSummary').innerHTML = `<div class="warn">計算できませんでした（詳細：${esc(detail)}）</div>`;
    toast(`打設リストを計算できませんでした（詳細：${detail}）`, 'error');
    return;
  }
  state.unitResult = await res.json();
  renderUnits();
}

function renderUnits() {
  const ur = state.unitResult;
  const overlapping = new Set((ur?.overlaps ?? []).filter((o) => o.members.length).flatMap((o) => [o.a, o.b]));
  $('unitHelp').classList.toggle('hidden', state.units.length > 0);
  $('exportCsv').classList.toggle('hidden', !state.units.length);
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
  // 下段が上限まで広がった後も、追加した行が見えるようにする
  if (state.flash && Date.now() - state.flash.at < 300) {
    $('unitList').querySelector(`li[data-uidx="${state.flash.index}"]`)?.scrollIntoView({ block: 'nearest' });
  }
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
    boundaries: state.boundaries, seeds: state.seeds, zoneNames: state.zoneNames,
    categories: [...state.categories], materials: [...state.materials], selected: [...state.selected], selectedOnly: state.selectedOnly,
    units: state.units,
  };
  const name = `${state.meta.source.replace(/\.ifc$/i, '')}_工区割_${stamp()}.json`;
  download(name, new Blob([JSON.stringify(plan, null, 1)], { type: 'application/json' }));
  toast(`工区割を保存しました：${name}`, 'ok');
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- CSV書き出し ----------
// Excelでそのまま開けるよう、BOM付きUTF-8・CRLFにする
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvBlob = (rows) => new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'],
  { type: 'text/csv' });
const m3 = (v) => (v === null || v === undefined ? '' : v.toFixed(3));

// 打設リスト（区分ごとの条件と数量）と部材明細の2ファイル。明細を求めるため計算し直す
async function exportCsv() {
  if (!state.units.length) return;
  const res = await fetch('/api/units', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ units: state.units.map((u) => ({ name: u.name, parts: u.parts.map(partJson) })),
      exclude_registered: state.excludeRegistered, detail: true }),
  });
  if (!res.ok) { toast(`表を書き出せません：${await errorDetail(res)}`, 'error'); return; }
  const ur = await res.json();
  if (ur.units.some((u) => !u.members)) { // 画面だけ新しく、計算サーバーが古いまま動いているとき
    toast('表を書き出せません。アプリが古い状態です。いったん閉じて、起動し直してください（start.bat の画面を閉じてから、もう一度起動）', 'error');
    return;
  }
  const join = (u, key) => u.parts.map((p) => partFields(p)[key]).join(' ＋ ');
  const list = [['区分', '区分名', '高さ範囲', '工区', '絞り込み', '数量（m3）', '部材数', '未計算（件）']];
  state.units.forEach((u, i) => {
    const r = ur.units[i];
    list.push([i + 1, u.name, join(u, 'range'), join(u, 'zone'), join(u, 'filters'), m3(r.total), r.member_count, r.uncomputed_count]);
  });
  if (ur.overlaps.length) list.push(['区分の単純合計', '', '', '', '', m3(ur.sum_total), '', '']);
  list.push(['合計（重複を除く）', '', '', '', '', m3(ur.union_total), '', '']);

  const detail = [['区分', '区分名', '部材ID', '種別', '名称', '所属階', '材料', '体積（m3・区分内・重複控除前）', '備考']];
  // 種別（柱→梁→壁→スラブ→…）、名称、所属階の順に並べる
  const catOrder = Object.keys(CAT_COLORS);
  const rank = (c) => (catOrder.includes(c) ? catOrder.indexOf(c) : catOrder.length);
  const byKind = (a, b) => rank(a.category) - rank(b.category)
    || String(a.name).localeCompare(String(b.name), 'ja', { numeric: true })
    || String(a.storey).localeCompare(String(b.storey), 'ja', { numeric: true });
  state.units.forEach((u, i) => {
    for (const m of [...ur.units[i].members].sort(byKind)) {
      detail.push([i + 1, u.name, m.member_id, m.category, m.name, m.storey, m.material, m3(m.volume),
        m.reason ? `未計算：${m.reason}` : '']);
    }
  });
  const base = `${state.meta.source.replace(/\.ifc$/i, '')}_${stamp()}`;
  download(`${base}_打設リスト.csv`, csvBlob(list));
  setTimeout(() => download(`${base}_部材明細.csv`, csvBlob(detail)), 300); // 2つ目の保存が抑止されないよう少し空ける
  toast('表を書き出しました（打設リスト・部材明細。Excelで開けます）', 'ok');
}

function applyPlan(plan) {
  if (plan.format !== PLAN_FORMAT) throw new Error('このアプリで保存した工区割ファイルではありません');
  const storeys = new Set(state.meta.storeys.map((s) => s.name));
  const missing = ['storey', 'upBase', 'lowBase'].map((id) => plan.range[id]).filter((n) => n !== ALL_STOREYS && !storeys.has(n));
  if (missing.length) throw new Error(`開いているIFCに無い階があります（${[...new Set(missing)].join('、')}）`);
  const tags = new Set(state.meta.grids.map((a) => a.tag));
  const lost = plan.boundaries.flatMap(boundaryLegs).map((l) => l.axis).filter((t) => !tags.has(t));
  if (lost.length) throw new Error(`開いているIFCに無い通り芯があります（${[...new Set(lost)].join('、')}）`);

  cancelPending();
  pushHistory(); // 開く前の工区割に Ctrl+Z で戻れる
  for (const id of RANGE_IDS) $(id).value = plan.range[id];
  state.boundaries = plan.boundaries;
  state.seeds = plan.seeds;
  state.zoneNames = plan.zoneNames ?? {}; // 名前のない古いファイルはA〜Fのまま
  renderZoneLabels();
  state.categories = new Set(plan.categories.filter((c) => state.meta.categories.includes(c)));
  for (const cb of document.querySelectorAll('#categories input')) cb.checked = state.categories.has(cb.dataset.cat);
  // 材料を保存していない古いファイルは初期の材料（コンクリート）
  state.materials = new Set((plan.materials ?? defaultMaterials()).filter((n) => n in state.meta.materials));
  for (const cb of document.querySelectorAll('#materials input')) cb.checked = state.materials.has(cb.dataset.mat);
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
  const uncomputed = m.uncomputed.filter((u) => m.materials[u.material]?.included || u.material.includes('コンクリート'));
  // 部材の数（1つの部材が複数の形状に分かれていることがあるので、形状の数ではなく部材で数える）
  const concrete = new Set(meshes.filter((x) => m.materials[x.userData.material]?.included).map((x) => x.userData.member_id));
  uncomputed.forEach((u) => concrete.add(u.member_id));
  $('modelInfo').innerHTML = `${esc(m.source)}　コンクリート部材 ${concrete.size.toLocaleString('ja-JP')} 件` +
    (uncomputed.length
      ? `<details class="missing"><summary>数量に入っていない部材 ${uncomputed.length} 件（押すと一覧）</summary><ul>` +
        uncomputed.map((u) => `<li>${esc(u.category ?? '')} ${esc(u.name || '(名称なし)')}：${esc(u.reason)}</li>`).join('') +
        '</ul><div>形が閉じていないなど、体積を正しく計算できない部材です。推定では補いません</div></details>'
      : '');
  state.materials = new Set(defaultMaterials());
  // 複数材料の形状と材料なしは切り分けられないので選べない（コンクリートを含むものは未計算として一覧に出る）
  $('materials').innerHTML = Object.entries(m.materials).map(([name, info]) => {
    const selectable = name !== '（材料なし）' && !name.includes(' / ');
    return `<tr><td>${selectable ? `<input type="checkbox" data-mat="${esc(name)}"${info.included ? ' checked' : ''}>` : '—'}</td>` +
      `<td>${esc(name)}${selectable ? '' : '<div class="muted">複数材料・材料なしは選べません</div>'}</td><td class="num">${info.count}</td></tr>`;
  }).join('');
  state.categories = new Set(m.categories);
  $('categories').innerHTML = m.categories.map((c) =>
    `<label><input type="checkbox" data-cat="${esc(c)}" checked><span class="chip" style="background:${hex(CAT_COLORS[c])}"></span>${esc(c)}</label>`).join('');
}

// 読込中は経過秒数を足して、止まっていないことが分かるようにする
let loadingTimer = null;
function showLoading(msg) {
  const el = $('loading'), t0 = Date.now();
  el.textContent = msg;
  el.classList.remove('hidden');
  clearInterval(loadingTimer);
  loadingTimer = setInterval(() => { el.textContent = `${msg}　${Math.floor((Date.now() - t0) / 1000)}秒`; }, 1000);
}
function endLoading(msg = null) {
  clearInterval(loadingTimer);
  if (msg) $('loading').textContent = msg;
  else $('loading').classList.add('hidden');
}

async function loadModel() {
  showLoading('IFCを読み込んでいます…');
  const res = await fetch('/api/model');
  if (!res.ok) {
    endLoading('IFCファイルを開いてください（左上「IFCを開く」）');
    return;
  }
  state.meta = await res.json();
  state.boundaries = [];
  state.seeds = [];
  state.zoneNames = {};
  undoStack.length = redoStack.length = 0; // 別のIFCの工区割には戻さない
  renderZoneLabels();
  state.selected.clear();
  state.units = [];
  state.unitResult = null;
  renderUnits();
  buildMeshes(await (await fetch('/api/meshes')).json());
  buildGrid();
  buildCells();
  spans = cells;
  spansKey = '';
  state.remainCells = [];
  renderSidebar();
  renderBoundaryList();
  fillStoreys();
  resize();
  fit();
  setView('3d'); // 読込直後はモデル全体を3Dで見せる
  endLoading();
}

$('storey').addEventListener('change', onStoreyChange);
for (const id of ['upBase', 'lowBase', 'upOff', 'lowOff']) $(id).addEventListener('change', applyRange);
document.querySelectorAll('button.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('button.view').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('fit').addEventListener('click', fit);
$('slabSee').addEventListener('change', (ev) => { state.slabSee = ev.target.checked; paint(); });
// 拡大縮小しても帯の太さとハッチの間隔を画面上で一定に
planCtl.addEventListener('change', () => { if (highlightTag) updateBand(); updateHatch(); hideTip(); });
renderer.domElement.addEventListener('pointerleave', () => { if (hoverRegion >= 0) drawRegionHover(-1); });
perspCtl.addEventListener('change', hideTip);
$('toast').addEventListener('click', () => $('toast').classList.add('hidden'));
$('pendingOk').addEventListener('click', confirmPending);
$('pendingCancel').addEventListener('click', cancelPending);
$('pendingTurn').addEventListener('click', turnPending);
$('pendingBack').addEventListener('click', backPending);
$('pendingOff').addEventListener('input', drawLines);
$('pendingOff').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') confirmPending(); });
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { cancelPending(); if (state.mode !== 'view') setMode(state.mode); } });
window.addEventListener('keydown', (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || !state.meta) return;
  // 文字や数値の入力中はブラウザ標準の取り消しに任せる
  const el = document.activeElement;
  if (el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || (el?.tagName === 'INPUT' && ['text', 'number'].includes(el.type))) return;
  const key = ev.key.toLowerCase();
  if (key === 'z' && !ev.shiftKey) restoreHistory(undoStack, redoStack, '元に戻しました（Ctrl+Y でやり直し）');
  else if (key === 'y' || (key === 'z' && ev.shiftKey)) restoreHistory(redoStack, undoStack, 'やり直しました');
  else return;
  ev.preventDefault();
});
$('boundaryList').addEventListener('click', (ev) => {
  const del = ev.target.dataset.del, edit = ev.target.dataset.edit;
  if (del !== undefined) {
    // 範囲の形が変わり名前の対応が崩れるため、工区名は付け直してもらう
    pushHistory();
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
  drawRegionHover();
  updateHint();
});
$('zoneLabels').addEventListener('dblclick', (ev) => { if (ev.target.dataset.label) editZoneName(ev.target); });
$('materials').addEventListener('change', (ev) => {
  const name = ev.target.dataset.mat;
  if (name === undefined) return;
  ev.target.checked ? state.materials.add(name) : state.materials.delete(name);
  paint();
  scheduleCompute();
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
    pushHistory();
    state.units.splice(Number(udel), 1);
  } else if (pdel !== undefined) {
    pushHistory();
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
// 区分名の手入力は、入力欄に入ってから出るまでを1回の取り消し単位にする
let nameBefore = null;
$('unitList').addEventListener('focusin', (ev) => { if (ev.target.dataset.uname !== undefined) nameBefore = snapshot(); });
$('unitList').addEventListener('input', (ev) => {
  if (ev.target.dataset.uname === undefined) return;
  if (nameBefore) { pushHistory(nameBefore); nameBefore = null; }
  const u = state.units[Number(ev.target.dataset.uname)];
  u.name = ev.target.value;
  u.autoName = false; // 手で付けた名前は、条件を追加しても上書きしない
  renderUnitSummary();
});
$('clearSel').addEventListener('click', () => { state.selected.clear(); onSelectionChanged(); });
$('selectedOnly').addEventListener('change', (ev) => { state.selectedOnly = ev.target.checked; paint(); scheduleCompute(); });
$('savePlan').addEventListener('click', savePlan);
for (const id of ['remainDepth', 'truckM3', 'extraPct']) $(id).addEventListener('input', scheduleRemain);
$('remainBody').addEventListener('click', (ev) => {
  const kind = ev.target.dataset.preset;
  if (!kind) return;
  if (kind === 'none') { $('remainDepth').value = ''; scheduleRemain(); return; } // 未計測に戻す
  const d = presetDepth(kind);
  if (d === null) { toast(`選んだスパンに${kind === 'slab' ? 'スラブ' : '梁'}がありません。mm を直接入れてください`, 'error'); return; }
  $('remainDepth').value = d;
  scheduleRemain();
});
$('exportSite').addEventListener('click', () => exportSite().catch((e) => toast(`タブレット用に書き出せません：${e.message}`, 'error')));
$('remainCsv').addEventListener('click', () => exportRemainCsv().catch((e) => toast(`残量の一覧表を書き出せませんでした（詳細：${e.message}）`, 'error')));
$('exportCsv').addEventListener('click', () => exportCsv().catch((e) => toast(`表を書き出せません：${e.message}`, 'error')));
$('planInput').addEventListener('change', (ev) => {
  if (ev.target.files[0]) openPlan(ev.target.files[0]);
  ev.target.value = ''; // 同じファイルをもう一度選べるように
});
$('fileInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  showLoading(`${file.name} を読み込んでいます…（初回は数十秒かかります）`);
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/open', { method: 'POST', body: fd });
  if (!res.ok) { endLoading(`読み込めませんでした：${await errorDetail(res)}`); return; }
  await loadModel();
});

renderZoneLabels();
resize();
setView('plan');
animate();
loadModel();
