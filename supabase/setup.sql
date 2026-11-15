-- nurubowf: 承認ワークフロー試作（Web公開版）の共有の保存場所
-- Supabase の SQL Editor に貼り付けて、1回だけ実行してください。何度実行しても大丈夫です。
--
-- しくみ
-- - 表には誰も直接さわれません（RLSを有効にして、公開用の鍵には何も許可しない）。
-- - 画面からは下の関数（wf_login / wf_get / wf_version / wf_save / wf_logout）だけを呼べます。
-- - wf_log は書き足すだけ。書き換え・削除の口はありません。
-- - テスト用アカウント（ID・パスワード）は別のファイルで入れます（このリポジトリには入れません）。

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.wf_testers (
  login_id     text primary key,
  pw_hash      text not null,
  display_name text not null,
  is_admin     boolean not null default false
);

create table if not exists public.wf_sessions (
  token      text primary key,
  login_id   text not null references public.wf_testers(login_id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.wf_world (
  id         int primary key default 1 check (id = 1),
  version    bigint not null default 0,
  state      jsonb,
  updated_at timestamptz,
  updated_by text
);
insert into public.wf_world (id) values (1) on conflict (id) do nothing;

create table if not exists public.wf_log (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  login_id text not null,
  version  bigint not null,
  command  jsonb
);

alter table public.wf_testers  enable row level security;
alter table public.wf_sessions enable row level security;
alter table public.wf_world    enable row level security;
alter table public.wf_log      enable row level security;
revoke all on public.wf_testers, public.wf_sessions, public.wf_world, public.wf_log from anon, authenticated;

-- ログイン中の人を確かめる（中だけで使う）
create or replace function public.wf_who(p_token text) returns public.wf_testers
language plpgsql security definer set search_path = public, extensions as $$
declare t public.wf_testers;
begin
  select w.* into t
    from public.wf_sessions s join public.wf_testers w on w.login_id = s.login_id
   where s.token = p_token and s.created_at > now() - interval '14 days';
  if not found then
    raise exception 'ログインの期限が切れました。もう一度ログインしてください' using errcode = '28000';
  end if;
  return t;
end $$;
revoke execute on function public.wf_who(text) from public, anon, authenticated;

create or replace function public.wf_login(p_login text, p_password text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare t public.wf_testers; tok text;
begin
  select * into t from public.wf_testers where login_id = lower(trim(p_login));
  if not found or t.pw_hash <> extensions.crypt(p_password, t.pw_hash) then
    raise exception 'ログインIDかパスワードが違います' using errcode = '28000';
  end if;
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.wf_sessions (token, login_id) values (tok, t.login_id);
  return json_build_object('token', tok, 'loginId', t.login_id, 'name', t.display_name, 'admin', t.is_admin);
end $$;

create or replace function public.wf_logout(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from public.wf_sessions where token = p_token;
$$;

create or replace function public.wf_version(p_token text) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.wf_who(p_token);
  return (select version from public.wf_world where id = 1);
end $$;

create or replace function public.wf_get(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.wf_who(p_token);
  return (select json_build_object('version', version, 'state', state) from public.wf_world where id = 1);
end $$;

-- 書き込み: 読んだときの版（p_expected）のままなら保存して版を1つ進める。
-- 誰かが先に書いていたら -1 を返す（画面は読み直してやり直す）。
create or replace function public.wf_save(p_token text, p_expected bigint, p_state jsonb, p_command jsonb) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare t public.wf_testers; v bigint;
begin
  t := public.wf_who(p_token);
  if coalesce(p_command->>'kind', '') = 'reset' and not t.is_admin then
    raise exception '最初の状態に戻せるのは管理用のアカウントだけです' using errcode = '42501';
  end if;
  update public.wf_world
     set version = version + 1, state = p_state, updated_at = now(), updated_by = t.login_id
   where id = 1 and version = p_expected
  returning version into v;
  if v is null then return -1; end if;
  insert into public.wf_log (login_id, version, command) values (t.login_id, v, p_command);
  return v;
end $$;

revoke execute on function public.wf_login(text, text), public.wf_logout(text), public.wf_version(text),
  public.wf_get(text), public.wf_save(text, bigint, jsonb, jsonb) from public;
grant execute on function public.wf_login(text, text), public.wf_logout(text), public.wf_version(text),
  public.wf_get(text), public.wf_save(text, bigint, jsonb, jsonb) to anon, authenticated;
