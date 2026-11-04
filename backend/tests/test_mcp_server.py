"""MCPサーバーの入力の読み方と文面（数量の計算は既存のエンジンなので、ここでは包み方だけを確かめる）。"""
from types import SimpleNamespace

import pytest

import mcp_server as ms


def test_truck_plan_same_text_as_pc():
    # PCアプリ・タブレットの truckPlan と同じ文面（site_app/tests/calc.test.js と同じ例）
    assert ms.truck_plan(12.933, 4.25, 0)[1] == "4.25 m³ × 3台 ＋ 最終車 0.18 m³（計 4 台）"
    assert ms.truck_plan(23.769, 4.25, 0)[1] == "4.25 m³ × 5台 ＋ 最終車 2.52 m³（計 6 台）"
    assert ms.truck_plan(3.961, 4.25, 0)[1] == "1台（3.96 m³）"
    assert ms.truck_plan(8.5, 4.25, 0)[1] == "4.25 m³ × 2台（計 2 台）"
    assert ms.truck_plan(0, 4.25, 0)[1] == "—"
    need, text = ms.truck_plan(72.78, 4.25, 3)
    assert need == pytest.approx(74.9634)
    assert text == "4.25 m³ × 17台 ＋ 最終車 2.71 m³（計 18 台）"


def _model():
    storeys = [SimpleNamespace(name=n, elevation=e) for n, e in [("4SL", 8.94), ("5SL", 11.91), ("6SL", 14.93)]]
    return SimpleNamespace(storeys=storeys)


@pytest.mark.parametrize("text", ["5SL", "5階", "5F", "５階", "5"])
def test_storey_spoken_forms(text):
    name, z0, z1 = ms.resolve_range(_model(), text)
    assert name == "5SL～6SL" and (z0, z1) == (11.91, 14.93)


def test_unknown_storey_lists_candidates():
    with pytest.raises(ms.AskAgain, match="階は 4SL、5SL、6SL"):
        ms.resolve_range(_model(), "9階")
    with pytest.raises(ms.AskAgain, match="最上階"):
        ms.resolve_range(_model(), "6SL")


def test_split_list_accepts_japanese_separators():
    assert ms._split_list("柱・梁") == ["柱", "梁"]
    assert ms._split_list(["柱", " 梁 "]) == ["柱", "梁"]
    assert ms._split_list(None) is None
