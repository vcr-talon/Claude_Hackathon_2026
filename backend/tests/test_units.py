"""打設区分の重なり検出の検証。"""
import pytest
from shapely.geometry import box

from qto.geometry import compute
from qto.units import PourUnit, Unit, compute_units, fully_excluded_keys, make_excluder, region_from_rings
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
    assert o.shared_volume == pytest.approx(1.0, rel=REL)
    assert [m.member_id for m in o.shared_members] == ["beam"]
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
    assert r.overlaps[0].shared_members == []
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


def _parapet_model():
    """1階：柱とスラブ（天端 3.0）、スラブ上にパラペット（3.0〜4.0）、2階の柱（3.0〜6.0）。"""
    return [box_solid((0, 0, 0), (1, 1, 3), key="col1", category="柱"),
            box_solid((0, 0, 2.8), (10, 4, 3), key="slab", category="スラブ"),
            box_solid((0, 0, 3), (10, 0.2, 4), key="parapet", category="壁"),
            box_solid((5, 2, 3), (6, 3, 6), key="col2", category="柱")]


def test_unit_with_several_parts():
    """1階の区分に、上階に立ち上がるパラペットだけを追加する。"""
    solids = _parapet_model()
    unit = Unit("1F", [PourUnit("1F", 0, 3), PourUnit("パラペット", 3, 4, member_ids={"parapet"})])
    r = compute_units(solids, [unit])
    assert r.results[0].total == pytest.approx(3 + 8 - 0.2 + 2, rel=REL)  # 柱とスラブの食い込み 0.2
    assert r.results[0].member_ids == {"col1", "slab", "parapet"}


def test_earlier_unit_takes_priority_when_excluding():
    """2階の区分（3.0〜6.0 全部材）は、1階に登録済みのパラペットを差し引く。"""
    solids = _parapet_model()
    units = [Unit("1F", [PourUnit("1F", 0, 3), PourUnit("パラペット", 3, 4, member_ids={"parapet"})]),
             Unit("2F", [PourUnit("2F", 3, 6)])]
    r = compute_units(solids, units, exclude_registered=True)
    assert [u.total for u in r.results] == pytest.approx([12.8, 3.0], rel=REL)
    assert r.overlaps == []
    assert r.sum_total == pytest.approx(r.union_total, rel=REL)
    # 除外しなければパラペットが二重に入り、警告になる
    r = compute_units(solids, units)
    assert r.results[1].total == pytest.approx(5.0, rel=REL)
    assert len(r.overlaps) == 1 and r.overlaps[0].shared_volume == pytest.approx(2.0, rel=REL)


def test_compute_excludes_registered_parts():
    """現在の計算（2階）から登録済みの部分（1階区分のパラペット）を差し引き、差し引いた量を返す。"""
    solids = _parapet_model()
    registered = [PourUnit("1F", 0, 3), PourUnit("パラペット", 3, 4, member_ids={"parapet"})]
    r = compute(solids, 3, 6, exclude=make_excluder(registered))
    assert r.total == pytest.approx(3.0, rel=REL)
    assert r.excluded == pytest.approx(2.0, rel=REL)
    assert [m.member_id for m in r.members] == ["col2"]


def test_fully_excluded_keys():
    """1階区分に全部入る立体だけを返す。2階の柱は1階区分と重ならないので返さない。"""
    solids = _parapet_model()
    exclude = make_excluder([PourUnit("1F", 0, 3), PourUnit("パラペット", 3, 4, member_ids={"parapet"})])
    assert sorted(fully_excluded_keys(solids, 0, 6, exclude)) == ["col1", "parapet", "slab"]
    # 高さ範囲内の部分だけで判定する（2.0〜3.0 なら1階の柱もスラブも全部登録済み）
    assert sorted(fully_excluded_keys(solids, 2, 3, make_excluder([PourUnit("下", 0, 3)]))) == ["col1", "slab"]
    # 一部しか登録されていない立体は返さない
    assert fully_excluded_keys(solids, 0, 3, make_excluder([PourUnit("半分", 0, 3, box(-1, -1, 5, 5))])) == ["col1"]


def test_region_from_rings_keeps_holes():
    outer = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]
    hole = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]
    assert region_from_rings([[outer, hole]]).area == pytest.approx(12.0)
    assert region_from_rings(None) is None
