"""数量エンジンのMCPサーバー（docs/claude_setup.md 5章）。

Claude（Claude Code・Claudeデスクトップ）から、日本語で数量を聞けるようにする。
**Claudeは数量を推測しない。このサーバーの道具（既存の計算エンジンを包むだけ）を使う。**
IFCそのものはClaudeに渡らず、返るのは数量・部材名・階・通り芯だけ。処理はこのPCの中だけで行う。

起動: .venv\\Scripts\\python.exe backend\\mcp_server.py [IFCパス]（.mcp.json に登録済み。Claude Code が自動で起動する）
"""
from __future__ import annotations

import contextlib
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
from mcp.server.fastmcp import FastMCP  # noqa: E402
from shapely.geometry import Polygon, box  # noqa: E402
from shapely.ops import unary_union  # noqa: E402

from qto.geometry import compute  # noqa: E402
from qto.ifc_loader import Model, load_model  # noqa: E402
from qto.site_export import _preset_mm  # noqa: E402
from qto.units import PourUnit, Unit, compute_units  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
IFC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "hackathon_model.ifc"
IFC = IFC if IFC.is_absolute() else ROOT / IFC

mcp = FastMCP("qto", instructions=(
    "コンクリート数量の計算エンジン。数量（m³）・生コン車の台数は、自分で計算・推定せず、必ずこのサーバーの道具を使うこと。"
    "返り値の「定義」の一文を、回答にそのまま添えること。"))

_model: Model | None = None


def model() -> Model:
    """IFCを（前処理キャッシュがあれば数秒で）読む。標準出力はMCPの通信に使うので、読み込み中の出力は標準エラーへ。"""
    global _model
    if _model is None:
        with contextlib.redirect_stdout(sys.stderr):
            _model = load_model(IFC)
    return _model


def definition(uncomputed: int) -> str:
    return f"定義：境界で切った幾何学的体積、重複は1回、未計算 {uncomputed} 件は含まず（PCアプリと同じ計算エンジン）"


@mcp.tool()
def model_info() -> dict:
    """読み込んでいるIFCの概要：階とSL（高さ）、通り芯、数える材料と除外する材料、未計算部材の件数。

    数量を答える前に、階の名前・通り芯の記号・材料名をここで確かめる。数量を自分で計算・推定しないこと。
    """
    m = model()
    mats = m.default_materials
    uncomputed = [s for s in m.solids if s.manifold is None and s.material in mats]
    uncomputed_skipped = [s for s in m.skipped if "コンクリート" in (s.material or "")]
    grids = [a.tag for a in m.grids]
    return {
        "ファイル": IFC.name,
        "階": [{"名前": s.name, "高さmm": round(s.elevation * 1000)} for s in m.storeys],
        "通り芯": {"X": [t for t in grids if t.upper().startswith("X")], "Y": [t for t in grids if t.upper().startswith("Y")],
                 "その他": [t for t in grids if not t.upper().startswith(("X", "Y"))]},
        "部材種別": sorted({s.category for s in m.solids if s.material in mats}),
        "数える材料（初期値）": {k: v["count"] for k, v in m.materials.items() if v["included"]},
        "除外する材料": {k: v["count"] for k, v in m.materials.items() if not v["included"]},
        "未計算部材": {"件数": len(uncomputed) + len(uncomputed_skipped),
                  "一覧": [f"{s.category} {s.member_name}：{s.error}" for s in uncomputed]
                  + [f"{s.name}：{s.reason}" for s in uncomputed_skipped]},
        "定義": definition(len(uncomputed) + len(uncomputed_skipped)),
    }


class AskAgain(ValueError):
    """利用者に言い直してもらう誤り（存在しない階・通り芯など）。候補を添えた文をそのまま返す。"""


ALL_STOREYS = ("モデル全体", "建物全体", "全体")


def resolve_range(m: Model, storey: str) -> tuple[str, float, float]:
    """施工階 → (名前, 下端, 上端)。PCアプリと同じく、その階のSL〜直上階のSL。「5階」「5F」「5」も 5SL として受ける。"""
    names = [s.name for s in m.storeys]
    text = unicodedata.normalize("NFKC", storey).strip()
    if text in ALL_STOREYS:
        mats = m.default_materials
        zs = [s.bbox for s in m.solids if s.material in mats]
        return "モデル全体", min(b[2] for b in zs) - 0.05, max(b[5] for b in zs) + 0.05
    name = text if text in names else None
    if name is None:
        digits = re.sub(r"\D", "", text)
        hits = [n for n in names if digits and re.sub(r"\D", "", n) == digits]
        name = hits[0] if len(hits) == 1 else None
    if name is None:
        raise AskAgain(f"「{storey}」という階はありません。階は {'、'.join(names)}（または「モデル全体」）")
    i = names.index(name)
    if i + 1 >= len(names):
        raise AskAgain(f"{name} は最上階のため、直上階がなく高さ範囲を決められません。z0_mm・z1_mm で高さを指定してください")
    return f"{name}～{names[i + 1]}", m.storeys[i].elevation, m.storeys[i + 1].elevation


def _tag_list(tags: list[str]) -> str:
    return f"{tags[0]}～{tags[-1]}" if len(tags) > 2 else "・".join(tags)


def grid_region(m: Model, text: str):
    """「X3～X6×Y1～Y4」→ 平面の多角形。片方だけ（「X3～X6」）なら、もう一方はモデルの端まで。

    通り芯どうしの帯（2本の平行な通り芯の間）を重ねた範囲。PCアプリのスパン（隣り合う通り芯で囲まれたマス）と同じ形になる。
    """
    norm = unicodedata.normalize("NFKC", text).replace("〜", "~").replace("～", "~").replace("－", "-")
    pairs = re.findall(r"([A-Za-z]+\d+)\s*[~\-]\s*([A-Za-z]+\d+)", norm)
    if not pairs:
        raise AskAgain(f"通り芯の範囲「{text}」を読めませんでした。「X3～X6×Y1～Y4」のように書いてください")
    axes = {a.tag.upper(): a for a in m.grids}
    xmin, ymin, xmax, ymax = m.bounds
    reach = 4 * float(np.hypot(xmax - xmin, ymax - ymin))
    region = box(xmin - 1, ymin - 1, xmax + 1, ymax + 1)
    for a_tag, b_tag in pairs:
        for t in (a_tag, b_tag):
            if t.upper() not in axes:
                same = [a.tag for a in m.grids if a.tag.upper().startswith(re.sub(r"\d", "", t).upper())]
                raise AskAgain(f"{t}はありません。通り芯は {_tag_list(same) if same else _tag_list([a.tag for a in m.grids])}")
        a, b = axes[a_tag.upper()], axes[b_tag.upper()]
        da, db = np.subtract(a.end, a.start), np.subtract(b.end, b.start)
        da, db = da / np.linalg.norm(da), db / np.linalg.norm(db)
        if abs(da[0] * db[1] - da[1] * db[0]) > 0.05:
            raise AskAgain(f"{a.tag} と {b.tag} は平行でないため、間の範囲を決められません（例：X3～X6、Y1～Y4）")
        if np.dot(da, db) < 0:
            db = -db
        pa, pb = np.asarray(a.start), np.asarray(b.start)
        strip = Polygon([pa - da * reach, pa + da * reach, pb + db * reach, pb - db * reach]).buffer(0)
        region = region.intersection(strip)
    if region.is_empty or region.area < 1e-6:
        raise AskAgain(f"通り芯の範囲「{text}」に面積がありません")
    return region


def _split_list(value: list[str] | str | None) -> list[str] | None:
    if value is None:
        return None
    items = value if isinstance(value, list) else re.split(r"[・、,，\s]+", value)
    return [unicodedata.normalize("NFKC", v).strip() for v in items if v and v.strip()]


def resolve_filters(m: Model, categories, materials) -> tuple[set[str] | None, set[str]]:
    cats = _split_list(categories)
    known = sorted({s.category for s in m.solids if s.material in m.default_materials})
    if cats is not None:
        bad = [c for c in cats if c not in known]
        if bad:
            raise AskAgain(f"部材種別「{'・'.join(bad)}」はありません。部材種別は {'・'.join(known)}")
    mats = _split_list(materials)
    if mats is not None:
        bad = [x for x in mats if x not in m.materials]
        if bad:
            raise AskAgain(f"材料「{'・'.join(bad)}」はありません。材料は {'・'.join(m.materials)}")
    return (set(cats) if cats is not None else None), (set(mats) if mats is not None else m.default_materials)


def _guard(fn):
    """言い直してほしい誤りは、候補を添えた文として返す（Claudeがそのまま利用者に伝えられるように）。"""
    import functools

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except AskAgain as e:
            return {"誤り": str(e)}
    return wrapper


@mcp.tool()
@_guard
def volume(storey: str = "", grid_range: str = "", categories: list[str] | None = None,
           materials: list[str] | None = None, z0_mm: float | None = None, z1_mm: float | None = None) -> dict:
    """コンクリート数量（m³）を計算エンジンで求める。数量を自分で計算・推定せず、必ずこの道具を使うこと。

    - storey：施工階（例「5SL」「5階」「モデル全体」）。その階のSL〜直上階のSLを数える（PCアプリの施工階と同じ）
    - grid_range：通り芯の範囲（例「X3～X6×Y1～Y4」「X3～X6」）。省略するとフロア全体
    - categories：部材種別の絞り込み（例 ["柱", "梁"]）。省略するとすべて
    - materials：数える材料（省略するとコンクリートの材料。model_info の材料名）
    - z0_mm・z1_mm：高さ範囲を mm で直接指定するとき（storey より優先）
    返り値の「定義」を回答に添えること。数値は丸めずに返す（表示は小数2桁でよい）。
    """
    m = model()
    if z0_mm is not None and z1_mm is not None:
        label, z0, z1 = f"{z0_mm:.0f}～{z1_mm:.0f} mm", z0_mm / 1000, z1_mm / 1000
    elif storey:
        label, z0, z1 = resolve_range(m, storey)
    else:
        raise AskAgain("施工階（例「5SL」）か、高さ範囲 z0_mm・z1_mm を指定してください")
    region = grid_region(m, grid_range) if grid_range.strip() else None
    cats, mats = resolve_filters(m, categories, materials)
    r = compute(m.solids, z0, z1, region=region, categories=cats, materials=mats)
    return {
        "条件": {"高さ範囲": f"{label}（{z0 * 1000:,.0f} ～ {z1 * 1000:,.0f} mm）", "平面": grid_range or "フロア全体",
               "部材種別": "・".join(sorted(cats)) if cats else "すべて", "材料": "・".join(sorted(mats))},
        "総数量m3": r.total,
        "種別内訳m3": r.by_category,
        # 材料が1種類のときの材料内訳は重複控除前の値になるため、PCアプリと同じく2種類以上のときだけ出す
        **({"材料内訳m3": r.by_material} if len(r.by_material) > 1 else {}),
        "対象部材数": len(r.members),
        "未計算部材": {"件数": len(r.uncomputed), "一覧": [f"{u.category} {u.member_name}：{u.reason}" for u in r.uncomputed]},
        "定義": definition(len(r.uncomputed)),
    }


SLAB = "スラブ"
PRESETS = {"スラブ下": ("スラブ", "slab"), "梁せい中央": ("梁", "beam")}


def truck_plan(volume_m3: float, truck_m3: float, extra_pct: float) -> tuple[float, str]:
    """生コン車の台数。PCアプリ・タブレットの truckPlan と同じ計算・同じ文面。"""
    cap = truck_m3 or 4.25
    need = volume_m3 * (1 + (extra_pct or 0) / 100)
    n = int(np.floor(need / cap + 1e-9))
    last = need - n * cap
    if last < 0.005:
        last = 0
    if not need:
        return need, "—"
    if not n:
        return need, f"1台（{last:,.2f} m³）"
    if last:
        return need, f"{cap:,.2f} m³ × {n}台 ＋ 最終車 {last:,.2f} m³（計 {n + 1} 台）"
    return need, f"{cap:,.2f} m³ × {n}台（計 {n} 台）"


@mcp.tool()
@_guard
def remaining(storey: str, spans: list[str], depth_mm: float | None = None, preset: str = "",
              truck_m3: float = 4.25, extra_pct: float = 0) -> dict:
    """打設終盤の残り数量（m³）と生コン車の台数を計算エンジンで求める。数量・台数を自分で計算・推定せず、必ずこの道具を使うこと。

    PCアプリの「4. 打設終盤の残量」と同じ計算：残りのスパンの範囲で、柱・梁・壁など（スラブ以外）は打ち上がり高さ〜上端、
    スラブは全厚を数え、重なりは1回だけ数える。
    - storey：施工階（例「5SL」「5階」）
    - spans：残りのスパン。通り芯の範囲で1つずつ（例 ["X8～X9×Y1～Y2", "X9～X10×Y1～Y2"]）。複数スパンをまとめて「X8～X11×Y1～Y2」でもよい
    - depth_mm：柱・梁の打ち上がり。上端から何 mm 下まで打ってあるか（0＝上端まで打設済み＝スラブだけが残る）
    - preset：depth_mm の代わりに「スラブ下」「梁せい中央」「未打設」（PCアプリのボタンと同じ目安。残りのスパンに掛かる部材の中央値）
    - truck_m3：生コン車1台の積載量、extra_pct：割増（%）
    返り値の「定義」を回答に添えること。
    """
    m = model()
    label, z0, z1 = resolve_range(m, storey)
    items = spans if isinstance(spans, list) else re.split(r"[、,，\s]+", spans)
    items = [s for s in items if s and s.strip()]
    if not items:
        raise AskAgain("残りのスパンを、通り芯の範囲で指定してください（例「X8～X9×Y1～Y2」）")
    region = unary_union([grid_region(m, s) for s in items])
    mats = m.default_materials
    p = unicodedata.normalize("NFKC", preset).strip()
    if p:
        if p.startswith("未打設"):
            depth_mm, used = round((z1 - z0) * 1000), "未打設（全量）"
        elif p in PRESETS:
            cat, kind = PRESETS[p]
            depth_mm = _preset_mm(m.solids, region, z1, cat, mats, kind)
            if depth_mm is None:
                raise AskAgain(f"残りのスパンに{cat}が見つからないため「{p}」の目安を出せません。depth_mm で直接指定してください")
            used = p
        else:
            raise AskAgain(f"preset「{preset}」はありません。「スラブ下」「梁せい中央」「未打設」のどれか")
    elif depth_mm is None:
        raise AskAgain("柱・梁の打ち上がりを depth_mm（上端から何 mm 下）か preset（「スラブ下」など）で指定してください")
    else:
        used = "数値で指定"
    depth_mm = max(0.0, float(depth_mm))
    cats = {s.category for s in m.solids}  # PCアプリの初期値（すべての種別）と同じ
    level = max(z0, z1 - depth_mm / 1000)
    parts = []
    if z1 - level > 1e-6:
        parts.append(PourUnit("柱・梁など", level, z1, region, cats - {SLAB}, None, mats))
    parts.append(PourUnit("スラブ", z0, z1, region, {SLAB}, None, mats))
    res = compute_units(m.solids, [Unit("残量", parts)]).results[0]
    need, trucks = truck_plan(res.total, truck_m3, extra_pct)
    return {
        "条件": {"施工階": label, "残りのスパン": items, "スパン数": len(items),
               "柱・梁の打ち上がり": f"上端 −{depth_mm:,.0f} mm（{used}）"},
        "残り数量m3": res.total,
        **({"割増込みm3": need} if extra_pct else {}),
        "生コン車": trucks,
        "未計算部材の件数": res.uncomputed,
        "定義": definition(res.uncomputed),
    }


if __name__ == "__main__":
    model()  # 最初の呼び出しを待たせないよう、起動時に読んでおく
    mcp.run()
