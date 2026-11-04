---
name: ui-review
description: 画面を変えた区切りごとに、スクリーンショットを撮って現場担当者の目でレビューしてもらい、指摘を docs/reviews/ に残す。画面の文言・操作の流れを変えたとき、機能凍結の前に使う。
---

# 画面のレビュー（ui-review）

## 手順
1. スクリーンショットを4枚撮る（アプリを 8767 で起動し、PCのEdgeで自動操作する。利用者の start.bat とはぶつからない）
   ```
   .venv\Scripts\python.exe backend\scripts\screenshot.py
   ```
   - できるもの：`docs/reviews/screenshots/` に `1_pc_plan.png`（5SLの平面）、`2_pc_boundary.png`（境界線を引くモード）、
     `3_pc_list.png`（打設リストに追加した後）、`4_tablet.png`（タブレット・iPad縦）
   - 4枚とも開いて、画面が想定どおり（読込中のまま・空白でない）か自分の目で確かめる
2. `site-reviewer` サブエージェントに渡す。依頼文の例：
   「docs/reviews/screenshots/ の4枚と、PC画面・タブレット画面の文言を、工事主任として一巡してレビューしてください。
   今回変えたのは〇〇です。前回の指摘（docs/reviews/ の直近の site-reviewer）がどう変わったかも見てください」
3. 返ってきた指摘を `docs/reviews/日付_site-reviewer.md` に保存する（先頭に、依頼・条件・件数・対応の4行の要約）
4. 指摘のうち直すものを利用者に確認してから直し、1からやり直す

## 合格条件
- 内部用語（offset・seed・cell・from_top・member_id・region・z0・z1 など）が画面にない
- 指摘のうち「迷う」が0件。0件にしないものは、残す理由を保存したレビューの「対応」に書く

## 失敗したら
- スクリーンショットが撮れない：エラーの最後の行を見る。「計算サーバーが起動できませんでした」なら `.qto_cache` があるか、8767 が使われていないかを確かめる
- 指摘を直すときも、画面の文言は現場向けの平易な日本語にする。数量の定義に触れる指摘は直さずに利用者に確認する
