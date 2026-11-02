"""打設区分の重なり検出の検証。"""
import pytest
from shapely.geometry import box

from qto.units import PourUnit, compute_units, region_from_rings
from test_geometry import REL, box_solid


def test_overlapping_zones_are_reported():
    beam = box_solid((0, 0, 0), (4, 1, 1), key="beam")
    units = [PourUnit("A", 0, 1, box(0, -1, 2, 2)), PourUnit("B", 0, 1, box(1, -1, 3, 2))]
    r = compute_units([beam], units)
    assert [u.total for u in r.results] == pytest.approx([2.0, 2.0], rel=REL)
    assert len(r.overlaps) == 1
    o = r.overlaps[0]
    assert (o.a, o.b) == (0, 1)
    assert o.volume == pytest.approx(1.0, rel=REL)
    assert o.shared.total == pytest.approx(1.0, rel=REL)
    assert [m.member_id for m in o.shared.members] == ["beam"]
    assert r.sum_total == pytest.approx(4.0, rel=REL)
    assert r.union_total == pytest.approx(3.0, rel=REL)


def test_touching_heights_do_not_overlap():
    col = box_solid((0, 0, 0), (1, 1, 2), key="col", category="柱")
    r = compute_units([col], [PourUnit("下", 0, 1), PourUnit("上", 1, 2)])
    assert r.overlaps == []
    assert r.union_total == pytest.approx(2.0, rel=REL)


def test_disjoint_categories_do_not_overlap():
    """柱＋梁の区分とスラブの区分は、同じ範囲でも重ならない。"""
    solids = [box_solid((0, 0, 0), (1, 1, 3), key="col", category="柱"),
              box_solid((0, 0, 3), (4, 4, 3.2), key="slab", category="スラブ")]
    r = compute_units(solids, [PourUnit("柱梁", 0, 3.2, categories={"柱", "梁"}),
                               PourUnit("スラブ", 0, 3.2, categories={"スラブ"})])
    assert r.overlaps == []
    assert r.union_total == pytest.approx(3.0 + 3.2, rel=REL)


def test_selected_member_unit_overlaps_whole_unit():
    """パラペットだけの区分と、パラペットを含む範囲全体の区分は、パラペット分だけ重なる。"""
    solids = [box_solid((0, 0, 0), (4, 4, 0.2), key="slab", category="スラブ"),
              box_solid((0, 0, 0.2), (4, 0.2, 1.2), key="parapet", category="壁")]
    r = compute_units(solids, [PourUnit("床", 0, 1.2), PourUnit("パラペット", 0, 1.2, member_ids={"parapet"})])
    assert len(r.overlaps) == 1
    assert r.overlaps[0].volume == pytest.approx(0.8, rel=REL)
    assert r.union_total == pytest.approx(3.2 + 0.8, rel=REL)


def test_interpenetrating_members_in_separate_units():
    """柱がスラブに食い込んでいると、柱の区分とスラブの区分は部材が別でも食い込み分だけ重なる。"""
    solids = [box_solid((0, 0, 0), (1, 1, 3.2), key="col", category="柱"),
              box_solid((0, 0, 3), (4, 4, 3.2), key="slab", category="スラブ")]
    r = compute_units(solids, [PourUnit("柱", 0, 3.2, categories={"柱"}),
                               PourUnit("スラブ", 0, 3.2, categories={"スラブ"})])
    assert len(r.overlaps) == 1
    assert r.overlaps[0].volume == pytest.approx(0.2, rel=REL)
    assert r.overlaps[0].shared is None
    assert r.union_total == pytest.approx(3.2 + 3.2 - 0.2, rel=REL)


def test_three_way_overlap_union_is_exact():
    beam = box_solid((0, 0, 0), (6, 1, 1), key="beam")
    units = [PourUnit("A", 0, 1, box(0, -1, 3, 2)), PourUnit("B", 0, 1, box(2, -1, 5, 2)),
             PourUnit("C", 0, 1, box(1, -1, 4, 2)), PourUnit("全体", 0, 1)]
    r = compute_units([beam], units)
    assert r.union_total == pytest.approx(6.0, rel=REL)


def test_duplicate_unit_is_counted_once():
    solids = [box_solid((0, 0, 0), (1, 1, 3), key="col", category="柱"),
              box_solid((0, 0, 2.8), (4, 4, 3), key="slab", category="スラブ")]
    r = compute_units(solids, [PourUnit("1", 0, 3), PourUnit("2", 0, 3)])
    assert r.sum_total == pytest.approx(2 * r.union_total, rel=REL)
    assert len(r.overlaps) == 1


def test_region_from_rings_keeps_holes():
    outer = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]
    hole = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]
    assert region_from_rings([[outer, hole]]).area == pytest.approx(12.0)
    assert region_from_rings(None) is None
