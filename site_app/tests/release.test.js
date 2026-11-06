// 配信の決まりの確認（docs/site_app_spec.md 5-e）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('アプリの版とキャッシュの版がそろっている（古い版がキャッシュに残らないように）', () => {
  const app = read('app.js').match(/APP_VERSION = '([^']+)'/)[1];
  const sw = read('sw.js').match(/VERSION = '([^']+)'/)[1];
  assert.equal(app, sw);
});

test('アプリ本体のパスはすべて相対パス（GitHub Pages は /<リポジトリ名>/ の下に置かれるため）', () => {
  const html = read('index.html');
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) assert.ok(!m[1].startsWith('/'), `${m[1]} が絶対パス`);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const p of [manifest.start_url, manifest.scope, ...manifest.icons.map((i) => i.src)]) assert.ok(!p.startsWith('/'), `${p} が絶対パス`);
});

test('オフライン用に保存するファイルがすべて存在する', () => {
  const shell = [...read('sw.js').match(/SHELL = \[([^\]]+)\]/)[1].matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  for (const p of shell) assert.doesNotThrow(() => readFileSync(new URL(`../${p}`, import.meta.url)), `${p} が無い`);
});

test('オフライン用に保存するファイルは、すべて GitHub Pages に公開する（漏れると公開URLでアプリが動き出さない）', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/site-app-pages.yml', import.meta.url), 'utf8');
  const shell = [...read('sw.js').match(/SHELL = \[([^\]]+)\]/)[1].matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  for (const p of shell) {
    const top = p.split('/')[0]; // icons/… はフォルダごと写す
    assert.ok(workflow.includes(`site_app/${p}`) || workflow.includes(`site_app/${top} `), `${p} が公開の手順（site-app-pages.yml）に無い`);
  }
});

test('画面のスクリプトに書き間違い（構文の誤り）がない（app.js はテストから読み込まないため、ここで確かめる）', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  for (const f of ['app.js', 'calc.js', 'record.js', 'datastore.js', 'sw.js']) {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(`../${f}`, import.meta.url))]); // 誤りがあれば例外
  }
});
