"""打設リストに入れ済みの部分を、区分の条件ごとに分けて返す（画面で区分ごとに色を変えるため）。"""
from types import SimpleNamespace

import pytest
from shapely.geometry import box

import server
from qto.geometry import compute
from qto.units import PourUnit, make_excluder
from test_geometry import REL, box_solid


def _split(solids, parts, z0, z1):
    r = compute(solids, z0, z1, exclude=make_excluder(parts))
    out = server._excluded_by_part(SimpleNamespace(solids=solids), parts, r.excluded_pieces)
    return r, {o["part"]: o["volume"] for o in out}


def test_split_by_category_filter():
    """同じ範囲でも、柱だけの区分と梁だけの区分は、それぞれの部材の色に分かれる。"""
    solids = [box_solid((0, 0, 0), (1, 1, 3), key="col", category="柱"),
              box_solid((1, 0, 2.4), (5, 0.5, 3), key="beam", category="梁")]
    parts = [PourUnit("柱", 0, 3, categories={"柱"}), PourUnit("梁", 0, 3, categories={"梁"})]
    r, by = _split(solids, parts, 0, 3)
    assert by[0] == pytest.approx(3.0, rel=REL)
    assert by[1] == pytest.approx(4 * 0.5 * 0.6, rel=REL)
    assert sum(by.values()) == pytest.approx(r.excluded, rel=REL)


def test_split_by_region_and_priority():
    """工区で分けた区分はそれぞれの範囲に分かれ、重なる部分は先に登録した区分の側に入る。"""
    slab = box_solid((0, 0, 0), (4, 2, 0.2), key="slab", category="スラブ")
    parts = [PourUnit("A", 0, 0.2, box(0, -1, 2.5, 3)), PourUnit("B", 0, 0.2, box(2, -1, 5, 3))]
    r, by = _split([slab], parts, 0, 0.2)
    assert by[0] == pytest.approx(2.5 * 2 * 0.2, rel=REL)
    assert by[1] == pytest.approx(1.5 * 2 * 0.2, rel=REL)
    assert sum(by.values()) == pytest.approx(r.excluded, rel=REL)


def test_only_current_range_is_returned():
    """別の階の区分は、今の計算範囲に入れ済みの部分が無いので返さない。"""
    col = box_solid((0, 0, 0), (1, 1, 6), key="col", category="柱")
    parts = [PourUnit("上の階", 3, 6), PourUnit("この階", 0, 3)]
    r, by = _split([col], parts, 0, 3)
    assert list(by) == [1]
    assert by[1] == pytest.approx(3.0, rel=REL)


def test_selected_only_does_not_hide_other_members():
    """「選択した部材だけで集計」のとき、選んでいない入れ済みの部材は隠さない（隠すと画面から消える）。"""
    from fastapi.testclient import TestClient
    solids = [box_solid((0, 0, 0), (1, 1, 3.6), key="col", category="柱"),     # 上の範囲（+600）にはみ出す
              box_solid((1, 0, 2.4), (5, 0.5, 3), key="beam", category="梁"),   # 入れ済みの範囲に収まる
              box_solid((0, 0, 3), (5, 0.2, 3.6), key="para", category="壁")]  # 選んだ部材
    server.state["model"] = SimpleNamespace(solids=solids, bounds=[-1, -1, 6, 2], default_materials={"コンクリート"})
    try:
        c = TestClient(server.app)
        reg = [{"z0": 0, "z1": 3}]
        base = {"z0": 0, "z1": 3.6, "materials": ["コンクリート"], "exclude_parts": reg}
        everything = c.post("/api/compute", json=base).json()
        assert everything["hidden_keys"] == ["beam"]  # 絞り込みなし：収まる梁は色付きの入れ済み部分として描くので元の形を隠す
        only = c.post("/api/compute", json={**base, "member_ids": ["para", "beam"]}).json()
        assert only["hidden_keys"] == ["beam"]
        only = c.post("/api/compute", json={**base, "member_ids": ["para"]}).json()
        assert only["hidden_keys"] == []  # 選んでいない梁は隠さず、薄く表示する
        cat = c.post("/api/compute", json={**base, "categories": ["壁"]}).json()
        assert cat["hidden_keys"] == []
    finally:
        server.state["model"] = None


def test_nothing_registered():
    assert server._excluded_by_part(SimpleNamespace(solids=[]), [], []) == []
