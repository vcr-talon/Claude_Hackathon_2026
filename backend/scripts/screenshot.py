"""画面のスクリーンショットを4枚撮る（ui-review スキル用。人が手で実行してもよい）。

使い方: .venv\\Scripts\\python.exe backend\\scripts\\screenshot.py
アプリを 8767 で起動し、PCのEdgeで操作して docs/reviews/screenshots/ に保存する。
  1_pc_plan.png      5SLの平面
  2_pc_boundary.png  境界線を引くモード（通り芯を1本選んだところ）
  3_pc_list.png      打設リストに追加した後
  4_tablet.png       タブレット画面（iPad縦）でデータを開き、2スパンを打設中にしたところ
タブレット用に書き出したファイルは一時フォルダに置き、終わったら消す。
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app_driver import ROOT, browser, export_site, open_pc, running_app, utf8_stdout  # noqa: E402

OUT = ROOT / "docs" / "reviews" / "screenshots"


def main() -> int:
    utf8_stdout()
    OUT.mkdir(parents=True, exist_ok=True)
    saved = []
    with tempfile.TemporaryDirectory() as tmp, running_app() as base:
        with browser(1400, 850) as ctx:
            page = open_pc(ctx, base, "5SL")
            page.click("button[data-view=plan]")
            page.wait_for_timeout(1000)
            page.screenshot(path=OUT / "1_pc_plan.png")
            saved.append("1_pc_plan.png")

            page.click("button[data-mode=boundary]")
            page.wait_for_timeout(500)
            # 平面図の中央付近の通り芯を1本選び、寸法入力の欄が出たところを撮る
            box = page.locator("#viewport canvas").bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] * 0.15)
            tag = page.locator(".gridtag").nth(7)
            tb = tag.bounding_box()
            page.mouse.click(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2 + 40)
            page.wait_for_timeout(500)
            page.screenshot(path=OUT / "2_pc_boundary.png")
            saved.append("2_pc_boundary.png")
            page.keyboard.press("Escape")

            page.click("#resultBody button.reg")
            page.wait_for_function("document.querySelector('#listTotal').textContent.includes('m')", timeout=60_000)
            page.wait_for_timeout(800)
            page.screenshot(path=OUT / "3_pc_list.png")
            saved.append("3_pc_list.png")

            data = export_site(page, Path(tmp) / "site.json")

        with browser(768, 1024) as ctx:  # iPad 縦
            tab = ctx.new_page()
            tab.goto(f"{base}/site/")
            tab.set_input_files("#fileInput", str(data))
            tab.wait_for_selector("#work:not(.hidden)")
            # 残り数量の大きい2スパンを打設中にする（見本として分かりやすいように）
            nums = tab.locator(".cellnum")
            texts = nums.all_text_contents()  # SVGの文字は inner_text では取れない
            top = sorted((i for i, t in enumerate(texts) if t), key=lambda i: -float(texts[i]))[:2]
            for i in top:
                b = nums.nth(i).bounding_box()
                tab.mouse.click(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
            tab.wait_for_timeout(500)
            tab.screenshot(path=OUT / "4_tablet.png")
            saved.append("4_tablet.png")
    for name in saved:
        print(f"保存：docs/reviews/screenshots/{name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
