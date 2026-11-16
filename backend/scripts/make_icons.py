"""タブレット（site_app）のアイコン画像 icon-192.png・icon-512.png を作る。

形は site_app/icons/icon.svg（KONTENT のロゴ B1：梁つきの断面とコン天の線）と同じ。
Python の標準ライブラリだけで描く（画像の部品を入れないため）。縁は 4×4 の点で数えてなめらかにする。

  .venv\\Scripts\\python.exe backend\\scripts\\make_icons.py
"""
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UNIT = 54  # icon.svg の viewBox の大きさ
BG, CONCRETE, ORANGE = (0x26, 0x32, 0x38), (0xB0, 0xBE, 0xC5), (0xE8, 0x73, 0x0C)

# icon.svg と同じ形（座標は viewBox の単位）。後に書いたものが上に重なる
RECTS = [((9, 22, 45, 29), CONCRETE),  # スラブ
         ((21, 29, 33, 44), CONCRETE),  # 梁
         ((7, 22 - 1.25, 47, 22 + 1.25), ORANGE)]  # コン天の線（太さ 2.5）
TRIANGLE = ((23, 9), (31, 9), (27, 17))  # ▽（天端の記号）


def _in_triangle(x, y, tri):
    (x1, y1), (x2, y2), (x3, y3) = tri
    d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2)
    d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3)
    d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1)
    return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))


def color_at(x, y):
    c = BG
    for (x0, y0, x1, y1), col in RECTS:
        if x0 <= x < x1 and y0 <= y < y1:
            c = col
    if _in_triangle(x, y, TRIANGLE):
        c = ORANGE
    return c


def render(size, ss=4):
    rows = []
    for py in range(size):
        row = bytearray([0])  # 行ごとのフィルタ：なし
        for px in range(size):
            acc = [0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    c = color_at((px + (sx + 0.5) / ss) * UNIT / size, (py + (sy + 0.5) / ss) * UNIT / size)
                    acc = [a + b for a, b in zip(acc, c)]
            row += bytes(round(a / ss / ss) for a in acc)
        rows.append(bytes(row))
    return b"".join(rows)


def png(size):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8bit・RGB
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(render(size), 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    for n in (192, 512):
        out = ROOT / "site_app" / "icons" / f"icon-{n}.png"
        out.write_bytes(png(n))
        print(out, out.stat().st_size, "bytes")
