# 単一HTML版（Python・サーバー不要）

会社のPCに Python を入れられない場合に使う版です。PCアプリの画面（`../frontend/`）をそのまま使い、計算エンジン（`backend/qto/`）を JavaScript に移植したものを、1つのHTMLファイルにまとめます。IFC はブラウザの中だけで処理され、外部には送られません。

## 作り方

```
cd single_html
npm install
npm run build      # → dist/KONTENT.html（約7MB）
```

`dist/` はコミットしません。作り直したHTMLを利用者に渡します。

## 仕組み

| ファイル | 中身 | Python版の対応 |
|---|---|---|
| `src/main.js` | 入口。`shim.js` のあとに `../frontend/app.js` をそのまま読み込む | — |
| `src/shim.js` / `src/client.js` | `fetch('/api/...')` を横取りし、計算エンジンに渡す。エンジンは Web Worker（画面とは別のところ）で動かすので、計算中も画面が止まらない。Worker を使えないブラウザでは画面と同じところで動かす | — |
| `src/engine.js` | 計算エンジンの入口（Worker の中で動く）。`build.mjs` が WASM ごと1つのスクリプトにまとめ、文字列として画面側に埋め込む | — |
| `src/api.js` | `/api/*` と同じ形の応答を作る。WASMのメモリの後始末もここ。打設リストの計算結果を覚えて、1行足したときは新しい行の分だけ計算する | `backend/server.py` |
| `src/qto.js` | 読み込み、数量の計算、打設区分、タブレット用の書き出し | `ifc_loader.py`・`geometry.py`・`units.py`・`site_export.py` |
| `src/ifc_mesh.js` | IFCの関係（材料・親部材・階）と、閉じた立体づくり | `ifc_loader.py`・`geometry._manifold_from_mesh` |
| `src/geom2d.js` | 平面の図形（工区・スパン）。境界線での切り分け | shapely・`partition.py` |

部品は IFC の形状化が **web-ifc**（Python版は IfcOpenShell）、立体の計算が **manifold-3d**（Python版と同じ Manifold の WASM 版）です。

## Python版と同じ計算であることの確かめ方

計算や API を変えたら、`backend/qto/` と `single_html/src/` の両方を直し、同じ入力で結果を突き合わせます。出力には部材の座標が入るので、リポジトリの外に置きます。

```
.venv\Scripts\python.exe single_html/tools/py_side.py hackathon_model.ifc %TEMP%\cmp_py.json
node                     single_html/tools/js_side.mjs hackathon_model.ifc %TEMP%\cmp_py.json %TEMP%\cmp_js.json
.venv\Scripts\python.exe single_html/tools/compare.py %TEMP%\cmp_py.json %TEMP%\cmp_js.json
```

許容値（0.001 m³ または 0.01%）を超える差のうち、次のものは移植の誤りではありません。それ以外の差が出たら移植の誤りです。

- **片方だけ「未計算」の部材**：IFCの形状化の部品が違うため、形が壊れぎみの部材のうち計算できるものが少し違う。hackathon_model では、Python版で未計算の壁 FW20・EW130・梁 W3 をHTML版は計算でき、HTML版は厚さ0.05mmの梁 FG67 を未計算にする。このため全体の数量が違う
- `hidden_keys`（表示で元の形を隠す部材）と `footprints`（タブレットの平面図の下敷き）の数：下の「Python版から変えたところ」による。数量には影響しない
- 先に入れた区分と重なる部分を除いて書き出したとき（`exclude_parts`）、除いた境目にかかるスパンの `members`（部材の件数。表示用）が1つ多いことがある：単精度の切断で境目に小さなかけらが残るため。数量は許容値の中で一致する

メモリの点検（打設リストを繰り返し計算しても WASM のメモリが増えないこと）：

```
node --expose-gc single_html/tools/memory_check.mjs <IFC> <工区割の保存ファイル> 6
```

## HTML版の基準値（hackathon_model.ifc）

| 条件 | Python版 | HTML版 |
|---|---|---|
| 全体 | 4,381.88 m³ | 4,397.02 m³（差は上の未計算の違い） |
| 5SL～6SL | 372.90 m³ | 372.90 m³ |
| 5SL～6SL、X8から1500mmで工区A・B | 278.53 ／ 94.37 m³ | 278.53 ／ 94.37 m³ |

## Python版から変えたところ（単精度のため）

Manifold の JavaScript 版は頂点が単精度（Float32）なので、次の3点だけ Python版と変えています（`qto.js` の先頭）。

- 平面の座標を模型の中心に寄せてから立体にする（`model.offset`。画面とのやり取りは元の座標）
- `ZTOL = 1e-6`：高さの比較で、1µm以内の差は「接しているだけ」とみなす（階の高さちょうどで接する部材を範囲に入れない）
- `PIECE_EPS = 1e-6`：切り口に残る1cm³未満のかけらは捨てる。`HIDE_EPS = 1e-6`：表示で元の形を隠す判定にも同じ値

## 注意

- 計算のたびに作る立体は WASM のメモリにあり、`api.js` の `handle()` が応答を作り終えたらまとめて解放する。新しい計算を足すときも `routes` の中で行えば自動で解放される。`/api/open` で作る部材の立体（`model.solids`）だけは残す
- ブラウザで直接開く（`file://`）ため、並列処理（SharedArrayBuffer）は使えない。web-ifc は1スレッドで動く
- 計算エンジンは Web Worker で動く（`file://` でも動くことを Edge で確かめた）。エンジンを1つのスクリプトにまとめると部品の `import.meta.url` が空になるので、`build.mjs` で形だけの値を入れている（WASM はファイルの中のデータを直接渡すので使われない）
