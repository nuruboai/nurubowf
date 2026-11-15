-- 1回のログイン: nurubowf の入口でログイン → 使い捨ての札を作って GAS（Googleの方）へ渡す。
-- GAS は合言葉つきで札を確かめ、そのまま入れる。setup.sql のあとに実行します。
-- 合言葉（gas_secret）はこのファイルには書きません。別ファイルで入れます。

create table if not exists public.wf_tickets (
  ticket     text primary key,
  login_id   text not null references public.wf_testers(login_id) on delete cascade,
  created_at timestamptz not null default now(),
  used       boolean not null default false
);
create table if not exists public.wf_config (
  key   text primary key,
  value text not null
);
alter table public.wf_tickets enable row level security;
alter table public.wf_config  enable row level security;
revoke all on public.wf_tickets, public.wf_config from anon, authenticated;

-- ログイン中の人が、GASへ渡す札を1枚作る（2分で切れる・1回だけ）
create or replace function public.wf_ticket(p_token text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare t public.wf_testers; tk text;
begin
  t := public.wf_who(p_token);
  delete from public.wf_tickets where created_at < now() - interval '1 day';
  tk := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.wf_tickets (ticket, login_id) values (tk, t.login_id);
  return tk;
end $$;

-- GASが札を確かめる（合言葉が合うときだけ）。使ったら使用済みにする。
create or replace function public.wf_redeem(p_ticket text, p_secret text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare s text; r record;
begin
  select value into s from public.wf_config where key = 'gas_secret';
  if s is null or p_secret is distinct from s then
    raise exception '合言葉が合いません' using errcode = '28000';
  end if;
  update public.wf_tickets k set used = true
    from public.wf_testers w
   where k.ticket = p_ticket and not k.used and k.created_at > now() - interval '2 minutes' and w.login_id = k.login_id
  returning w.login_id, w.display_name, w.is_admin into r;
  if r is null then
    raise exception '入口からの受け渡しの期限が切れました。入口からログインし直してください' using errcode = '28000';
  end if;
  return json_build_object('loginId', r.login_id, 'name', r.display_name, 'admin', r.is_admin);
end $$;

revoke execute on function public.wf_ticket(text), public.wf_redeem(text, text) from public;
grant execute on function public.wf_ticket(text), public.wf_redeem(text, text) to anon, authenticated;
