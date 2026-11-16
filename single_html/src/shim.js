// 画面のコードより先に読み込み、/api/* の呼び出しを計算エンジン（Web Worker）につなぐ
import { installFetch } from './client.js';
installFetch();
