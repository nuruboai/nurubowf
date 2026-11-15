// 画面と仕組みを1つのHTMLにまとめる(サーバーなしで動く)。
// node tools/build-single.mjs → dist/承認ワークフロー試作.html
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TOOLS, '..');
const ROOT = path.join(REPO, 'src'); // 試作(block-workflow-proto)から写した元のファイル
const rd = f => readFile(path.join(ROOT, f), 'utf8');

// node:crypto の代わり(SHA-256 と乱数)
const CRYPTO_SHIM = `
const __K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function __sha256(str){const b=new TextEncoder().encode(str);const l=b.length;const n=((l+9+63)>>6)<<6;const m=new Uint8Array(n);m.set(b);m[l]=0x80;const dv=new DataView(m.buffer);dv.setUint32(n-4,(l*8)>>>0);dv.setUint32(n-8,Math.floor(l/0x20000000));
let h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];const w=new Uint32Array(64);const r=(x,k)=>(x>>>k)|(x<<(32-k));
for(let i=0;i<n;i+=64){for(let t=0;t<16;t++)w[t]=dv.getUint32(i+t*4);for(let t=16;t<64;t++){const s0=r(w[t-15],7)^r(w[t-15],18)^(w[t-15]>>>3),s1=r(w[t-2],17)^r(w[t-2],19)^(w[t-2]>>>10);w[t]=(w[t-16]+s0+w[t-7]+s1)>>>0;}
let[a,bb,c,d,e,f,g,hh]=h;for(let t=0;t<64;t++){const S1=r(e,6)^r(e,11)^r(e,25),ch=(e&f)^(~e&g),t1=(hh+S1+ch+__K[t]+w[t])>>>0,S0=r(a,2)^r(a,13)^r(a,22),mj=(a&bb)^(a&c)^(bb&c),t2=(S0+mj)>>>0;hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=bb;bb=a;a=(t1+t2)>>>0;}
h=[h[0]+a,h[1]+bb,h[2]+c,h[3]+d,h[4]+e,h[5]+f,h[6]+g,h[7]+hh].map(x=>x>>>0);}return h.map(x=>x.toString(16).padStart(8,'0')).join('');}
const createHash=()=>{let s='';const o={update(x){s+=x;return o;},digest(){return __sha256(s);}};return o;};
const randomBytes=n=>{const a=crypto.getRandomValues(new Uint8Array(n));return{toString:()=>[...a].map(x=>x.toString(16).padStart(2,'0')).join('')};};
`;

const strip = src => src
  .replace(/^import[^;]*;\s*$/gm, '')
  .replace(/^export\s+(async\s+)?(function|class|const|let)/gm, (m, a, k) => `${a || ''}${k}`);

const engine = strip(await rd('server/engine.js'));
const org = strip(await rd('server/org.js')).replace(/async function loadOrg[\s\S]*?\n}\n/, '');
const api = strip(await rd('server/api.js'));
const seed = await rd('data/sample-org.json');

// Web公開版の差し替え: 保存場所はSupabase、入口はログイン画面
const SUPABASE_URL = 'https://kggkmecwelzlsgydrkct.supabase.co';
const SUPABASE_KEY = 'sb_publishable_nZwq7tnAkjnL2FNRWtLLLg_xS6ertCC'; // 公開用の鍵(画面に入って誰でも見えるもの。表には直接さわれない設定)
const BROWSER_SERVER = (await readFile(path.join(TOOLS, 'web-shim.js'), 'utf8'))
  .replace('/*__SEED__*/null', () => seed)
  .replace('__SUPABASE_URL__', SUPABASE_URL)
  .replace('__SUPABASE_KEY__', SUPABASE_KEY);
const EXTRA_CSS = await readFile(path.join(TOOLS, 'web-extra.css'), 'utf8');

// 画面
let html = await rd('web/index.html');
const css = await rd('web/style.css');
let appJs = await rd('web/app.js');
const svgDirs = ['web/images', 'web/icons'];
const svgs = {};
for (const d of svgDirs) {
  let files = [];
  try { files = await readdir(path.join(ROOT, d)); } catch {}
  for (const f of files) if (f.endsWith('.svg')) svgs[`${path.basename(d)}/${f}`] = `data:image/svg+xml;base64,${Buffer.from(await rd(`${d}/${f}`)).toString('base64')}`;
}
const inlineAssets = s => s.replace(/(\.\/)?(images|icons)\/([\w.-]+\.svg)/g, (m, dot, dir, f) => svgs[`${dir}/${f}`] || m);
appJs = inlineAssets(strip(appJs));
html = inlineAssets(html)
  .replace(/<link[^>]+href="[^"]*style\.css"[^>]*>/, `<style>\n${css}\n${EXTRA_CSS}\n</style>`)
  .replace(/<script[^>]+src="[^"]*app\.js"[^>]*><\/script>/, () => `<script type="module">\nconst { Engine, initialState, simulate, WorkflowError, normalizeOrg, handleApi, errorResponse, USER_KINDS } = (() => {\n${CRYPTO_SHIM}\n${engine}\n${org}\n${api}\nreturn { Engine, initialState, simulate, WorkflowError, normalizeOrg, handleApi, errorResponse, USER_KINDS };\n})();\n${BROWSER_SERVER}\n{\n${appJs}\n}\n</script>`);
if (html.includes('src="app.js"') || html.includes("src='./app.js'")) throw new Error('app.js の読み込みを置き換えられませんでした');
// 1台で2人分を試すための道具は外し、ログイン中の名前とログアウトを出す
const replaceOnce = (src, from, to) => { if (!src.includes(from)) throw new Error(`置き換え先が見つかりません: ${from.slice(0, 40)}`); return src.replace(from, () => to); };
html = replaceOnce(html, '<div class="button-row two-person-tools"><button type="button" data-command="open-other-tab">もう1人のタブを開く</button><button type="button" data-command="open-pair-view">2人で試す（並べて表示）</button></div>',
  '<p class="login-info"><span id="login-name"></span><button type="button" id="logout" class="button-quiet">ログアウト</button></p>');
html = replaceOnce(html, '選んだ人の立場で表示・操作します（タブごとに別の人にできます）', '役は自分で選べます。選んだ人の立場で表示・操作します');
html = replaceOnce(html, '試作版 · 操作する人を切り替えて、申請から承認までの流れを確かめられます。', '試作版 · 本物の名前や情報は入れないでください。お試し期間が終わると、入れたデータはまとめて消します。');
const out = path.join(REPO, 'index.html');
await writeFile(out, html);
console.log(`できました: ${out} (${Math.round(html.length / 1024)} KB)`);
