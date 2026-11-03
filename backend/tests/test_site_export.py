"""タブレット用データ（スパンごとの深さ→体積の表）の検証。"""
import pytest
from shapely.geometry import Polygon

from qto.geometry import compute
from qto.site_export import depth_steps, export_cell, split_cells, touches
from qto.units import PourUnit, Unit, compute_units
from test_geometry import box_solid

# 柱（0〜0.5角、高さ0〜1）、梁（x 0.5〜2、上端1・梁せい0.5）、スラブ（0〜2×0〜1、厚さ0.2）。梁とスラブは重なる
SOLIDS = [
    box_solid((0, 0, 0), (0.5, 0.5, 1), key="c", category="柱"),
    box_solid((0.5, 0.4, 0.5), (2, 0.6, 1), key="g", category="梁"),
    box_solid((0, 0, 0.8), (2, 1, 1), key="s", category="スラブ"),
]
CATS = {"柱", "梁", "スラブ"}
CELLS = [("a", [[-1, -1], [1, -1], [1, 2], [-1, 2], [-1, -1]]),  # スパンは x=1 で2つに分かれる
         ("b", [[1, -1], [3, -1], [3, 2], [1, 2], [1, -1]])]


def cells(step=0.05):
    return [export_cell(SOLIDS, cid, cid, ring, 0, 1, CATS, None, step) for cid, ring in CELLS]


def pc_remaining(ring, depth):
    """PCアプリの残量（remainParts → /api/units の1区分）と同じ条件の体積。"""
    region = Polygon(ring)
    parts = [PourUnit("v", 1 - depth, 1, region, CATS - {"スラブ"})] if depth > 0 else []
    parts.append(PourUnit("s", 0, 1, region, {"スラブ"}))
    return compute_units(SOLIDS, [Unit("残量", parts)]).results[0].total


def interp(from_top, step, height, d):
    if d >= height:
        return from_top[-1]
    i = int(d // step)
    w = min(step, height - i * step)
    return from_top[i] + (from_top[i + 1] - from_top[i]) * (d - i * step) / w


def test_depth_steps_end_at_bottom():
    assert depth_steps(0, 1, 0.3) == pytest.approx([0, 0.3, 0.6, 0.9, 1.0])
    assert depth_steps(0, 1, 0.25) == pytest.approx([0, 0.25, 0.5, 0.75, 1.0])


def test_table_starts_at_zero_and_increases():
    for c in cells():
        assert c.from_top[0] == 0
        assert all(b >= a for a, b in zip(c.from_top, c.from_top[1:]))


def test_cells_sum_to_total():
    total = compute(SOLIDS, 0, 1, categories=CATS).total
    assert sum(c.from_top[-1] + c.slab for c in cells()) == pytest.approx(total, abs=1e-6)


@pytest.mark.parametrize("depth", [0.0, 0.2, 0.25, 0.5, 0.77, 1.0])
def test_matches_pc_remaining(depth):
    # 打ち上がりが上端から depth のとき：表の補間＋スラブ ＝ PCの残量（V の depth より上 ∪ S）
    for c, (_, ring) in zip(cells(), CELLS):
        assert interp(c.from_top, 0.05, 1.0, depth) + c.slab == pytest.approx(pc_remaining(ring, depth), abs=1e-6)


def test_presets_use_members_touching_the_span():
    a, b = cells()
    # 1枚のスラブが2つのスパンに掛かる：どちらのスパンでも目安が出る（中心がある側だけにしない）
    assert a.slab_bottom_mm == 200 and b.slab_bottom_mm == 200
    assert b.beam_mid_mm == 250  # 梁せい0.5の中央
    assert a.beam_mid_mm == 250  # 梁（x 0.5〜2）は a にも掛かる


def test_touches_ignores_members_only_sharing_an_edge():
    ring = Polygon([[0, 0], [1, 0], [1, 1], [0, 1]])
    assert touches(ring, 0.5, 0.2, 2.0, 0.4)  # 掛かる
    assert not touches(ring, 1.0, 0.2, 2.0, 0.4)  # 辺で接するだけ
    assert touches(ring, 0.5, 0.5, 0.5, 0.5)  # 点のような細い部材は中心で判定


def test_split_cells_by_zone_boundary():
    # スパン（0〜2×0〜1）を x=1.5 の工区境界で切る。どの工区にも入らない部分は返さない
    zones = [("A", "A", [[[[-5, -5], [1.5, -5], [1.5, 5], [-5, 5]]]]),
             ("B", "東側", [[[[1.5, -5], [5, -5], [5, 5], [1.5, 5]]]])]
    out = split_cells([("0,0", "X1〜X2×Y1〜Y2", [[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]])], zones)
    assert [(i, n) for i, n, _ in out] == [("0,0#A", "X1〜X2×Y1〜Y2（A）"), ("0,0#B", "X1〜X2×Y1〜Y2（東側）")]
    assert sum(Polygon(r).area for _, _, r in out) == pytest.approx(2.0)
    assert split_cells([("0,0", "s", [[0, 0], [1, 0], [1, 1], [0, 0]])], None)[0][0] == "0,0"
