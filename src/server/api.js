// APIの中身。サーバー(app.js)と、1ファイル版HTML(ブラウザの中)の両方で使う。
import { Engine, WorkflowError, simulate, USER_KINDS } from './engine.js';

// ctx: { getState(), setState(s), save(), fresh() }
export async function handleApi(ctx, method, pathname, query, body) {
  const state = ctx.getState();
  const e = new Engine(state);
  const as = query.get('as');
  let m;
  const ok = json => ({ status: 200, json });
  if (method === 'GET' && pathname === '/api/org') {
    const { settings, units, roles, people, assignments, proxyOrder, absences } = state;
    return ok({ settings, units, roles, people, assignments, proxyOrder, absences: (absences || []).map((a, i) => ({ id: a.id || `S${i + 1}`, ...a })), today: e.today(), roleChoices: e.roleChoices(), boxKinds: USER_KINDS, caseTypes: e.caseTypes(), usableCaseTypes: e.usableCaseTypes(), builders: e.builders(), admins: e.admins(), amountTables: state.amountTables || [], unitManagers: Object.fromEntries((units || []).map(u => [u.id, e.unitManagers(u.id)])), buildFlagLog: [...(state.buildFlagLog || [])].reverse().slice(0, 200), glossary: e.glossary(), glossaryLog: [...(state.glossaryLog || [])].reverse().slice(0, 50) });
  }
  if (method === 'GET' && pathname === '/api/case-types') return ok(as && !e.canBuild(as) ? e.usableCaseTypes() : e.caseTypes());
  if (method === 'PUT' && pathname === '/api/glossary') { const r = e.setGlossary(body.as, body); await ctx.save(); return ok(r); }
  if (method === 'PUT' && pathname === '/api/settings') { const r = e.setSettings(body.as, body.values); await ctx.save(); return ok(r); }
  if ((m = pathname.match(/^\/api\/people\/([\w-]+)\/can-build$/)) && method === 'PUT') { const r = e.setBuildFlag(body.as, m[1], body.value); await ctx.save(); return ok({ person: r.person, entry: r.entry }); }
  if (method === 'GET' && pathname === '/api/build-flag-log') return ok([...(state.buildFlagLog || [])].reverse().slice(0, 200));
  if (method === 'POST' && pathname === '/api/absences') { const r = e.addAbsence(body.as, body); await ctx.save(); return ok(r); }
  if ((m = pathname.match(/^\/api\/absences\/([\w-]+)$/)) && method === 'DELETE') { const r = e.removeAbsence(as, m[1]); await ctx.save(); return ok(r); }
  if (method === 'PUT' && pathname === '/api/case-types') { const r = e.setCaseTypes(body.as, body.items); await ctx.save(); return ok(r); }
  if (method === 'GET' && pathname === '/api/templates') {
    return ok(state.templates.map(t => t.useSharedAmountTable ? { ...t, amountTable: e.amountTableFor(t, e.today()).rows } : t));
  }
  if ((m = pathname.match(/^\/api\/templates\/([\w-]+)$/)) && method === 'PUT') {
    const builder = body?.as || as;
    e.mustBuild(builder);
    const tpl = { ...body, id: m[1] };
    delete tpl.as;
    if (tpl.amountTable?.length) delete tpl.useSharedAmountTable;
    // 「要修正」が1つでもあれば保存しない(「注意」だけなら保存できる)
    const check = simulate(state, tpl);
    if (!check.canSave) throw new WorkflowError(`要修正が${check.errors}件あるため保存できません。試し運行の結果を直してください`, 400, 'needsFix');
    const i = state.templates.findIndex(t => t.id === m[1]);
    if (i >= 0) state.templates[i] = tpl; else state.templates.push(tpl);
    await ctx.save();
    return ok(tpl);
  }
  if ((m = pathname.match(/^\/api\/templates\/([\w-]+)\/simulate$/)) && method === 'POST') {
    const tpl = body && body.steps ? { ...body, id: m[1] } : e.template(m[1]);
    if (tpl.amountTable?.length) delete tpl.useSharedAmountTable;
    return ok(simulate(state, tpl));
  }
  if (method === 'GET' && pathname === '/api/cases') { const out = e.list(as, query.get('view') || 'mine', query.get('q') || ''); await ctx.save(); return ok(out); }
  if (method === 'POST' && pathname === '/api/cases') { const c = e.createCase(body); await ctx.save(); return ok(e.view(c, c.applicant)); }
  if ((m = pathname.match(/^\/api\/cases\/(\w+)$/)) && method === 'GET') return ok(e.view(e.getCase(m[1]), as));
  if (/^\/api\/cases\/\w+\/chat(\/[\w-]+)?$/.test(pathname) && ['PUT', 'PATCH', 'DELETE'].includes(method)) throw new WorkflowError('チャットは一度書いたら直せません・消せません', 405, 'chatImmutable');
  if ((m = pathname.match(/^\/api\/cases\/(\w+)\/actions$/)) && method === 'POST') { const c = e.act(m[1], body); await ctx.save(); return ok(e.view(c, body.as)); }
  if (method === 'GET' && pathname === '/api/outbox') return ok([...state.outbox].reverse().slice(0, 200));
  if (method === 'POST' && pathname === '/api/mail/inbound') { const c = e.inboundMail(body); await ctx.save(); return ok({ ok: true, caseId: c.id, status: c.status }); }
  if (method === 'POST' && pathname === '/api/reset') { ctx.setState(await ctx.fresh()); await ctx.save(); return ok({ ok: true }); }
  throw new WorkflowError('そのAPIはありません', 404);
}

export function errorResponse(err) {
  if (err instanceof WorkflowError) return { status: err.status, json: { error: err.message, code: err.code } };
  return { status: 500, json: { error: `仕組みの中でエラーが起きました: ${err.message}` } };
}
