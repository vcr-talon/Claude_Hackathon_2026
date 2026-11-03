"""単純形状による数量計算の検証（要件の検証段階①②）。"""
import numpy as np
import pytest
from shapely.geometry import Polygon, box

from qto.geometry import Solid, compute
from qto.partition import ZoneSeed, assign_zones, split_regions

REL = 1e-6  # 単純形状の許容相対誤差
ABS = 1e-3  # 分割の整合の許容値 m3

BOX_FACES = np.array([
    [0, 2, 1], [0, 3, 2],  # 下面
    [4, 5, 6], [4, 6, 7],  # 上面
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
])


def box_solid(lo, hi, key="b", category="梁", material="コンクリート", member=None, faces=BOX_FACES):
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    verts = np.array([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
                      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], float)
    return Solid(key, member or key, key, category, material, "1SL", verts, faces).build()


def test_unit_cube_is_one():
    r = compute([box_solid((0, 0, 0), (1, 1, 1))], 0, 1)
    assert r.total == pytest.approx(1.0, rel=REL)


def test_half_cut_by_zone():
    r = compute([box_solid((0, 0, 0), (1, 1, 1))], 0, 1, region=box(-5, -5, 0.5, 5))
    assert r.total == pytest.approx(0.5, rel=REL)


def test_diagonal_zone_line():
    # 対角線で切った三角形の範囲 → 半分
    tri = Polygon([(-1, -1), (2, 2), (2, -1)])
    r = compute([box_solid((0, 0, 0), (1, 1, 1))], 0, 1, region=tri)
    assert r.total == pytest.approx(0.5, rel=REL)


def test_height_range_and_swapped_limits():
    s = [box_solid((0, 0, 0), (1, 1, 1))]
    assert compute(s, 0.2, 0.5).total == pytest.approx(0.3, rel=REL)
    assert compute(s, 0.5, 0.2).total == pytest.approx(0.3, rel=REL)  # 上下逆は自動で入替
    assert compute(s, 1.0, 2.0).total == pytest.approx(0.0, abs=1e-12)  # 上面ちょうどは含まない


def test_overlap_counted_once_and_breakdown_sums_to_total():
    col = box_solid((0, 0, 0), (1, 1, 1), key="c", category="柱")
    beam = box_solid((0.5, 0, 0), (1.5, 1, 1), key="g", category="梁")
    r = compute([col, beam], 0, 1)
    assert r.total == pytest.approx(1.5, rel=REL)
    assert r.raw_sum == pytest.approx(2.0, rel=REL)
    assert r.overlap == pytest.approx(0.5, rel=REL)
    # 柱 → 梁 の順位：重なりは柱に配分
    assert r.by_category["柱"] == pytest.approx(1.0, rel=REL)
    assert r.by_category["梁"] == pytest.approx(0.5, rel=REL)
    assert sum(r.by_category.values()) == pytest.approx(r.total, abs=ABS)


def test_extra_concrete_breakdown():
    base = box_solid((0, 0, 0), (1, 1, 1), key="w1", material="コンクリート", member="W")
    extra = box_solid((1, 0, 0), (1.1, 1, 1), key="w2", material="コンクリート-増し打ち", member="W")
    r = compute([base, extra], 0, 1)
    assert r.total == pytest.approx(1.1, rel=REL)
    assert r.by_material["コンクリート"] == pytest.approx(1.0, rel=REL)
    assert r.by_material["コンクリート-増し打ち"] == pytest.approx(0.1, rel=REL)
    assert len(r.members) == 1 and r.members[0].volume == pytest.approx(1.1, rel=REL)


def test_category_and_member_filters():
    col = box_solid((0, 0, 0), (1, 1, 1), key="c", category="柱")
    wall = box_solid((2, 0, 0), (3, 1, 1), key="w", category="壁")
    assert compute([col, wall], 0, 1, categories={"壁"}).total == pytest.approx(1.0, rel=REL)
    assert compute([col, wall], 0, 1, member_ids={"c"}).total == pytest.approx(1.0, rel=REL)
    assert compute([col, wall], 0, 1, member_ids={"c", "w"}).total == pytest.approx(2.0, rel=REL)


def test_open_shape_is_reported_not_counted():
    good = box_solid((0, 0, 0), (1, 1, 1), key="ok")
    broken = box_solid((2, 0, 0), (3, 1, 1), key="ng", faces=BOX_FACES[:-2])  # 側面が1枚欠けている
    r = compute([good, broken], 0, 1)
    assert r.total == pytest.approx(1.0, rel=REL)
    assert [u.key for u in r.uncomputed] == ["ng"]
    assert r.uncomputed[0].reason


def test_inside_out_shape_is_repaired():
    r = compute([box_solid((0, 0, 0), (1, 1, 1), faces=BOX_FACES[:, ::-1])], 0, 1)
    assert r.total == pytest.approx(1.0, rel=REL)


def test_zones_sum_to_whole():
    # 2本の境界線（十字）で4分割 → 各工区の合計＝全体
    solids = [box_solid((0, 0, 0), (4, 3, 0.2), key="slab", category="スラブ"),
              box_solid((1, 0, 0.2), (1.5, 3, 0.8), key="beam", category="梁")]
    bounds = (0, 0, 4, 3)
    lines = [[(1.2, 0), (1.2, 3)], [(0, 1.0), (4, 2.0)]]  # 縦線（梁を横切る）と斜め線
    regions = split_regions(bounds, lines)
    assert len(regions) == 4
    seeds = [ZoneSeed("A", 0.5, 0.5), ZoneSeed("B", 3, 0.5), ZoneSeed("C", 0.5, 2.8), ZoneSeed("D", 3, 2.9)]
    zones = assign_zones(regions, seeds)
    whole = compute(solids, 0, 1).total
    parts = sum(compute(solids, 0, 1, region=z).total for z in zones.values())
    assert whole == pytest.approx(4 * 3 * 0.2 + 0.5 * 3 * 0.6, rel=REL)
    assert parts == pytest.approx(whole, abs=ABS)


def test_same_label_regions_are_merged():
    regions = split_regions((0, 0, 4, 1), [[(1, 0), (1, 1)], [(3, 0), (3, 1)]])
    zones = assign_zones(regions, [ZoneSeed("A", 0.5, 0.5), ZoneSeed("A", 3.5, 0.5), ZoneSeed("B", 2, 0.5)])
    slab = [box_solid((0, 0, 0), (4, 1, 0.1), category="スラブ")]
    assert compute(slab, 0, 1, region=zones["A"]).total == pytest.approx(0.2, rel=REL)
    assert compute(slab, 0, 1, region=zones["B"]).total == pytest.approx(0.2, rel=REL)


def test_short_boundary_is_extended_through_model():
    # 外形まで届かない短い線でも、自動延長されて全体が2分割される
    regions = split_regions((0, 0, 10, 10), [[(5, 4), (5, 6)]])
    assert len(regions) == 2


def test_cranked_boundary_splits_slab():
    # スラブ面でクランクする打継ぎ：x=4 を上から y=5 まで下り、y=5 を x=6 まで進み、x=6 を下へ抜ける
    # 画面と同じ形の点列（端の点は角から1m出した向きの点。計算側でモデルの外まで延長する）
    slab = [box_solid((0, 0, 0), (10, 10, 0.2), category="スラブ")]
    regions = split_regions((0, 0, 10, 10), [[(4, 6), (4, 5), (6, 5), (6, 4)]])
    assert len(regions) == 2
    zones = assign_zones(regions, [ZoneSeed("A", 1, 1), ZoneSeed("B", 9, 9)])
    a = compute(slab, 0, 1, region=zones["A"]).total
    b = compute(slab, 0, 1, region=zones["B"]).total
    assert a == pytest.approx((4 * 5 + 6 * 5) * 0.2, rel=REL)  # 左上 4×5 ＋ 下側 6×5
    assert a + b == pytest.approx(10 * 10 * 0.2, abs=ABS)


def test_self_crossing_boundary_is_rejected():
    with pytest.raises(ValueError):
        split_regions((0, 0, 10, 10), [[(0, 0), (5, 5), (5, 0), (0, 5)]])
