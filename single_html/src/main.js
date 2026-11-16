// 単一HTML版の入口：先に /api/* をブラウザ内の計算につなぎ、そのあと今の画面（frontend/app.js）をそのまま動かす
import './shim.js';
import '../../frontend/app.js';
