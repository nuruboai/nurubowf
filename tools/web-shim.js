// Web公開版: 画面の /api/... 呼び出しを、ブラウザの中の仕組み(engine)で動かし、
// 結果を Supabase の共有の保存場所に書く。ほかの人が書いたら数秒で読み直す。
// build-web.mjs が __SEED__ などを差し込む。
const __SEED = /*__SEED__*/null;
const SB_URL = '__SUPABASE_URL__';
const SB_KEY = '__SUPABASE_KEY__';
const LOGIN_KEY = 'nurubowf-login';
const POLL_MS = 3000;

window.__protoSingleFile = true; // サーバー版の5秒ごとの読み直しは使わない(下で3秒ごとに版を確かめる)
document.body.classList.add('web-version');

async function __rpc(name, args) {
  let res;
  try {
    res = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
      method: 'POST', cache: 'no-store',
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error('保存場所（サーバー）につながりません。通信を確かめて、もう一度お試しください。');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const err = new Error(data?.message || `保存場所でエラーが起きました（${res.status}）`);
    err.code = data?.code;
    err.auth = data?.code === '28000';
    throw err;
  }
  return data;
}

let __session = null;
try { __session = JSON.parse(sessionStorage.getItem(LOGIN_KEY) || 'null'); } catch {}
const __esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function __showLogin(message = '') {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'login-screen';
    box.innerHTML = `<form class="login-card" novalidate>
      <p class="eyebrow">ブロック型承認ワークフロー <span class="prototype">試作版</span></p>
      <h1>ログイン</h1>
      <p class="hint">お渡ししたログインIDとパスワードを入れてください。役（起案する人・承認する人など）は、入ったあとに自分で選べます。</p>
      <div class="field"><label for="login-id">ログインID</label><input id="login-id" name="id" autocomplete="username" required autocapitalize="off" spellcheck="false"></div>
      <div class="field"><label for="login-pw">パスワード</label><input id="login-pw" name="pw" type="password" autocomplete="current-password" required></div>
      <p class="notice error login-error" role="alert" ${message ? '' : 'hidden'}>${__esc(message)}</p>
      <div class="button-row"><button type="submit" class="primary">ログイン</button></div>
      <p class="hint login-note">これは試作版です。本物の名前や情報は入れないでください。お試し期間が終わると、入れたデータはまとめて消します。</p>
    </form>`;
    document.body.appendChild(box);
    const form = box.querySelector('form');
    const errorBox = box.querySelector('.login-error');
    box.querySelector('#login-id').focus();
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = form.id.value.trim();
      const pw = form.pw.value;
      if (!id || !pw) { errorBox.textContent = 'ログインIDとパスワードを入れてください。'; errorBox.hidden = false; return; }
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        const s = await __rpc('wf_login', { p_login: id, p_password: pw });
        try { sessionStorage.setItem(LOGIN_KEY, JSON.stringify(s)); } catch {}
        box.remove();
        resolve(s);
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
        button.disabled = false;
      }
    });
  });
}

const __fresh = async () => initialState(normalizeOrg(structuredClone(__SEED)));
let __state = null;
let __version = 0;
let __writing = false;

async function __pull() {
  const w = await __rpc('wf_get', { p_token: __session.token });
  __version = Number(w.version);
  __state = w.state;
}

async function __start() {
  let message = '';
  for (;;) {
    if (!__session) __session = await __showLogin(message);
    try { await __pull(); break; }
    catch (err) {
      if (!err.auth) throw err;
      __session = null;
      try { sessionStorage.removeItem(LOGIN_KEY); } catch {}
      message = err.message;
    }
  }
  // 保存場所がまだ空なら、最初の状態を作って入れる(同時に2人が入っても、どちらか1つだけ通る)
  while (!__state) {
    const fresh = await __fresh();
    const v = await __rpc('wf_save', { p_token: __session.token, p_expected: __version, p_state: fresh, p_command: { kind: 'init' } });
    if (v >= 0) { __version = Number(v); __state = fresh; } else await __pull();
  }
}
await __start();

// ヘッダーにログイン中の名前とログアウト
{
  const nameEl = document.getElementById('login-name');
  if (nameEl) nameEl.textContent = `ログイン中: ${__session.name}`;
  document.getElementById('logout')?.addEventListener('click', async () => {
    try { await __rpc('wf_logout', { p_token: __session.token }); } catch {}
    try { sessionStorage.removeItem(LOGIN_KEY); sessionStorage.removeItem('proto-actor'); } catch {}
    location.reload();
  });
}

function __authLost(err) {
  try { sessionStorage.removeItem(LOGIN_KEY); } catch {}
  setTimeout(() => location.reload(), 1500);
  return { status: 401, json: { error: `${err.message}（画面を読み直します）` } };
}

const __origFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.origin !== location.origin || !url.pathname.includes('/api/')) return __origFetch(input, init);
  const pathname = url.pathname.slice(url.pathname.indexOf('/api/'));
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  const reply = (r) => new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });

  // 読むだけ: 手もとの最新のデータで答える(保存はしない)
  if (method === 'GET') {
    const ctx = { getState: () => __state, setState: (s) => { __state = s; }, save: async () => {}, fresh: __fresh };
    try { return reply(await handleApi(ctx, method, pathname, url.searchParams, body)); }
    catch (err) { return reply(errorResponse(err)); }
  }

  // 書く: 最新を読み直してから仕組みを動かし、読んだ版のままなら保存。先を越されたら最初からやり直す。
  __writing = true;
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      try { await __pull(); } catch (err) { return err.auth ? reply(__authLost(err)) : reply({ status: 503, json: { error: err.message } }); }
      let saved = false;
      const ctx = { getState: () => __state, setState: (s) => { __state = s; }, save: async () => { saved = true; }, fresh: __fresh };
      let r;
      try { r = await handleApi(ctx, method, pathname, url.searchParams, body); }
      catch (err) { return reply(errorResponse(err)); }
      if (!saved) return reply(r);
      let v;
      try {
        v = await __rpc('wf_save', {
          p_token: __session.token, p_expected: __version, p_state: __state,
          p_command: { kind: pathname === '/api/reset' ? 'reset' : 'action', method, path: pathname, as: body?.as ?? url.searchParams.get('as'), body: body ?? null },
        });
      } catch (err) {
        if (err.auth) return reply(__authLost(err));
        try { await __pull(); } catch {}
        return reply({ status: err.code === '42501' ? 403 : 503, json: { error: err.message } });
      }
      if (v >= 0) { __version = Number(v); return reply(r); }
      await new Promise((res) => setTimeout(res, 150 + Math.random() * 350));
    }
    return reply({ status: 409, json: { error: 'ほかの人の操作と重なりました。少し待って、もう一度押してください。' } });
  } finally {
    __writing = false;
  }
};

// ほかの人が書いたら(版が進んでいたら)読み直して、画面に知らせる
setInterval(async () => {
  if (document.hidden || __writing) return;
  try {
    const v = Number(await __rpc('wf_version', { p_token: __session.token }));
    if (v !== __version && !__writing) {
      await __pull();
      window.dispatchEvent(new CustomEvent('proto-data-changed'));
    }
  } catch { /* 次の回にまた確かめる */ }
}, POLL_MS);
