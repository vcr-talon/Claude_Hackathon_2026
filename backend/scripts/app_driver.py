"""スキル用：アプリを専用のポートで起動し、PCのブラウザ（Edge）で自動操作する共通部品。

利用者の start.bat（8765）とぶつからないよう 8767 で起動し、終わったら止める。
ブラウザは新たに入れず、PCに入っている Microsoft Edge を使う（Playwright の channel="msedge"）。
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
PORT = int(os.environ.get("QTO_SKILL_PORT", "8767"))
BASE = f"http://127.0.0.1:{PORT}"


@contextmanager
def running_app(timeout: float = 180):
    """計算サーバーを起動して、モデルを読み終えるまで待つ。"""
    env = {**os.environ, "QTO_PORT": str(PORT), "QTO_NO_BROWSER": "1", "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen([str(PYTHON), "backend/server.py"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        t0 = time.time()
        while True:
            if proc.poll() is not None:
                raise RuntimeError(f"計算サーバーが起動できませんでした：{proc.stderr.read().decode('utf-8', 'replace')[-500:]}")
            try:
                with urllib.request.urlopen(f"{BASE}/api/model", timeout=2) as r:
                    if r.status == 200:
                        break
            except OSError:
                pass
            if time.time() - t0 > timeout:
                raise RuntimeError("計算サーバーの起動を待ちきれませんでした")
            time.sleep(1)
        yield BASE
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


@contextmanager
def browser(width: int = 1400, height: int = 850):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        try:
            ctx = b.new_context(viewport={"width": width, "height": height}, accept_downloads=True, locale="ja-JP")
            yield ctx
        finally:
            b.close()


def open_pc(ctx, base: str, storey: str = "5SL"):
    """PC画面を開き、施工階を選んで計算が終わるまで待つ。"""
    page = ctx.new_page()
    page.goto(f"{base}/")
    page.wait_for_selector("#loading", state="hidden", timeout=120_000)
    page.select_option("#storey", storey)
    page.wait_for_function("document.querySelector('#resultBody .total') !== null", timeout=60_000)
    page.wait_for_timeout(800)  # 再計算の待ち（入力の後 120ms で計算が始まる）
    return page


def export_site(page, dest: Path) -> Path:
    """「4. 打設終盤の残量」の「タブレット用に書き出す」を押して、保存されたファイルを dest に置く。"""
    with page.expect_download(timeout=180_000) as dl:
        page.click("#exportSite")
    dl.value.save_as(dest)
    return dest


def utf8_stdout():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
