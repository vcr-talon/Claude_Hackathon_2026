"""境界線による工区分割（要件 D14〜D17）。

境界線は折れ線（点列）として持ち、両端を自動でモデルの外まで延長する。
モデル全体を覆う長方形を境界線で切り分け、利用者が置いた「工区名の種」を含む範囲に名前を付ける。
単位はメートル。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import polygonize, unary_union

Bounds = tuple[float, float, float, float]  # xmin, ymin, xmax, ymax


@dataclass
class ZoneSeed:
    """工区名と、その工区に含めたい範囲内の1点。"""

    label: str
    x: float
    y: float


def offset_axis_line(start: tuple[float, float], end: tuple[float, float], offset: float
                     ) -> tuple[tuple[float, float], tuple[float, float]]:
    """通り芯と平行に offset だけ離れた線分を返す。

    正の向きは、縦方向の通り芯なら +X 側、横方向の通り芯なら +Y 側。
    """
    p0, p1 = np.asarray(start, float), np.asarray(end, float)
    d = p1 - p0
    n = np.array([d[1], -d[0]]) / np.hypot(*d)
    if (abs(n[0]) >= abs(n[1]) and n[0] < 0) or (abs(n[0]) < abs(n[1]) and n[1] < 0):
        n = -n
    return tuple(p0 + n * offset), tuple(p1 + n * offset)


def extend_polyline(points: list[tuple[float, float]], bounds: Bounds) -> LineString:
    """折れ線の両端を、モデル範囲の外まで延長する。"""
    pts = np.asarray(points, float)
    if len(pts) < 2:
        raise ValueError("境界線には2点以上が必要です")
    xmin, ymin, xmax, ymax = bounds
    reach = 2.0 * np.hypot(xmax - xmin, ymax - ymin) + 1.0
    head = pts[0] - _unit(pts[1] - pts[0]) * reach
    tail = pts[-1] + _unit(pts[-1] - pts[-2]) * reach
    line = LineString([head, *pts[1:-1], tail])
    if not line.is_simple:
        raise ValueError("境界線が自分自身と交差しています")
    return line


def _unit(v: np.ndarray) -> np.ndarray:
    n = np.hypot(*v)
    if n == 0:
        raise ValueError("境界線に長さ0の区間があります")
    return v / n


def split_regions(bounds: Bounds, boundaries: list[list[tuple[float, float]]],
                  margin: float = 1.0) -> list[Polygon]:
    """モデル範囲を覆う長方形を境界線で切り分けた範囲の一覧。"""
    xmin, ymin, xmax, ymax = bounds
    rect = box(xmin - margin, ymin - margin, xmax + margin, ymax + margin)
    lines = [extend_polyline(b, rect.bounds).intersection(rect) for b in boundaries]
    noded = unary_union([rect.exterior, *lines])
    return [p for p in polygonize(noded) if p.area > 1e-9]


def assign_zones(regions: list[Polygon], seeds: list[ZoneSeed]) -> dict[str, Polygon]:
    """種を含む範囲に工区名を付け、同じ名前の範囲を合算する（D15）。"""
    owner: dict[int, str] = {}
    for seed in seeds:
        pt = Point(seed.x, seed.y)
        for i, r in enumerate(regions):
            if i not in owner and r.covers(pt):
                owner[i] = seed.label
                break
    zones: dict[str, list[Polygon]] = {}
    for i, label in owner.items():
        zones.setdefault(label, []).append(regions[i])
    return {label: unary_union(polys) for label, polys in zones.items()}
