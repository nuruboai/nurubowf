// ブロック型承認ワークフロー 中心の仕組み(試作版)
// 仕様: docs/SPEC.md  筋書き: docs/SCENARIO.md
import { randomBytes, createHash } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
const REASON_ACTIONS = new Set(['return', 'reject', 'delegate', 'escalate']);
// メールの返信で「戻す」と読む言葉(用語辞書のどのひな形の言い方でも受け付ける)
const MAIL_RETURN = /^(差し?戻し|差戻し|出した人(に|へ)の?戻(す|し)|戻(す|し))/;
const MAIL_KINDS = new Set(['reception', 'check', 'council', 'parallel']);
// 仕組みの中の箱の種類(画面で選ぶ箱は USER_KINDS)
const KINDS = new Set(['draft', 'reception', 'check', 'decision', 'council', 'parallel', 'notify', 'order', 'submit']);
export const USER_KINDS = ['reception', 'input', 'approval', 'council', 'notify', 'parallel'];

// 用語辞書(2026-11-12 決定): 画面に出る言葉だけを組織ごとに切り替える。箱の種類など中の仕組みは変えない。
// 画面の言葉の「もと」は、だれでも分かる動きの言葉(標準)。会社向け・大学・役所向けのひな形で業界の言葉に変える。
// base は画面のプログラムの中の言葉(置きかえの目印)。checked=false は出典で確かめられていない語(調査メモ: 大学の用語)
const G = (base, standard, company, university, checked = true, note = '') => ({ base, standard, company, university, checked, note, main: true });
// 活用形(「〜しました」「〜した」など)。辞書の表には出さず、ひな形に合わせて一緒に変わる
const F = (base, standard, company = base, university = base) => ({ base, standard, company, university, checked: true, note: '', main: false });
export const GLOSSARY = [
  // 動きの言葉(長い言い方を先に置きかえる)
  G('差し戻す', '出した人に戻す', '差し戻す', '差戻す', true, '一橋大学 電子決裁・文書管理システム仕様書(2024)に「差戻し」'),
  F('差し戻し中', '出した人に戻っている', '差し戻し中', '差戻し中'),
  F('差し戻し・否決', '戻す・通さない', '差し戻し・否決', '差戻し・否決'), F('差し戻しの理由', '戻した理由', '差し戻しの理由', '差戻しの理由'), F('差し戻し理由', '戻した理由', '差し戻し理由', '差戻し理由'), F('差し戻しのあと', '戻したあと', '差し戻しのあと', '差戻しのあと'), F('差し戻しのまま', '戻したまま', '差し戻しのまま', '差戻しのまま'),
  F('差し戻しは', '戻すのは', '差し戻しは', '差戻しは'), F('【差し戻し', '【戻し', '【差し戻し', '【差戻し'), F('差し戻します', '戻します', '差し戻します', '差戻します'),
  F('差し戻しました', '戻しました', '差し戻しました', '差戻しました'), F('差し戻されました', '戻されました', '差し戻されました', '差戻されました'), F('差し戻された', '戻された', '差し戻された', '差戻された'),
  F('差し戻した', '戻した', '差し戻した', '差戻した'), F('差し戻して', '戻して', '差し戻して', '差戻して'), F('差し戻し', '出した人への戻し', '差し戻し', '差戻し'),
  G('軽微な修正', '直して、戻した人へそのまま戻る', '軽微な修正', '軽微な修正'),
  G('否決する', 'ここで終わりにする（通さない）', '否決する', '否決する', false, '一橋大学の規則・仕様書には出てこない。出典未確認'),
  F('否決で終了', 'ここで終わり（通さない）'), F('否決しました', 'ここで終わりにしました（通さない）'), F('否決となりました', 'ここで終わりになりました（通さない）'),
  F('否決になります', 'ここで終わりになります'), F('否決すると', 'ここで終わりにすると'), F('否決しても', 'ここで終わりにしても'),
  F('否決できません', 'ここで終わりにはできません'), F('否決で', '通さずに'), F('否決の', '通さないときの'), F('否決', '通さない'),
  G('可決', '通す', '可決', '可決'),
  F('合議で可決しました', '話し合いで「通す」に決まりました'), F('で可決しました', 'で「通す」に決まりました'), F('合議で否決しました', '話し合いで「通さない」に決まりました'),
  G('引き戻す', '出した人が手元に戻す', '引き戻す', '引戻す', true, '一橋大学 電子決裁・文書管理システム仕様書(2024)に「起案者は、決裁文書の引戻しができること」'),
  F('申請者からの引き戻し', '出した人が手元に戻す', '申請者からの引き戻し', '起案者からの引戻し'), F('引き戻しました', '手元に戻しました', '引き戻しました', '引戻しました'), F('引き戻し', '手元に戻すこと', '引き戻し', '引戻し'),
  G('起案し直す', '最初から出し直す', '申請し直す', '起案し直す', false, '一橋大学の規則では、取りやめは「廃案」。作り直しの言い方は出典未確認'),
  F('起案し直しました', '最初から出し直しました', '申請し直しました'), F('起案し直した', '最初から出し直した', '申請し直した'), F('起案し直して', '最初から出し直して', '申請し直して'),
  G('一つ上へ回す', '上の役職の人へ回す', '上長へ回す', '一つ上へ回す', false, '一橋大学 電子決裁・文書管理システム仕様書(2024)の「引上げ決裁」(間の決裁者を飛ばして決裁)は近いが同じではない'),
  G('代理へ回す', '代わりの人へ回す', '代理へ回す', '代理へ回す'),
  G('後閲する', 'あとで本人が確かめる', '事後確認する', '後閲する', true, '一橋大学 電子決裁・文書管理システム仕様書(2024)に「後閲及び代決指定」'),
  F('後閲', '本人のあとの確認', '事後確認'),
  G('取り下げる', '出すのをやめる', '取り下げる', '取り下げる'),
  F('取り下げました', '出すのをやめました'), F('取り下げて', '出すのをやめて'),
  G('取り下げ', '出すのをやめた', '取り下げ', '廃案', true, '一橋大学文書処理規則(2005) 第18条「当該起案文書が廃案となったとき」'),
  // ものの呼び名
  G('起案者', '起案者', '申請者', '起案者', true, '一橋大学文書処理規則(2005)・一橋大学 電子決裁・文書管理システム仕様書(2024)'),
  G('起案', '起案', '申請', '起案', true, '一橋大学文書処理規則(2005)・一橋大学 電子決裁・文書管理システム仕様書(2024)'),
  G('受付', '受付', '受付', '接受', true, '一橋大学文書処理規則(2005) 第2章「接受及び配布」'),
  G('回覧', '回覧', '回覧', '供閲', true, '一橋大学文書処理規則(2005) 第14条「供閲文書」。ほかの大学では「供覧」の場合あり'),
  G('稟議書', '申請書', '稟議書', '原議書', true, '一橋大学文書処理規則(2005)・一橋大学 電子決裁・文書管理システム仕様書(2024)'),
  G('決裁', '決裁', '決裁', '決裁', true, '一橋大学文書処理規則(2005)・一橋大学 電子決裁・文書管理システム仕様書(2024)'),
  G('合議', '合議', '合議', '合議', true, '一橋大学文書処理規則(2005)・一橋大学 電子決裁・文書管理システム仕様書(2024)'),
  G('代理', '代理', '代理', '代決', true, '一橋大学 電子決裁・文書管理システム仕様書(2024)に「後閲及び代決指定」'),
  G('文書番号', '文書番号', '管理番号', '文書番号', true, '一橋大学文書処理規則(2005)・一橋大学 電子決裁・文書管理システム仕様書(2024)(「文書記号」とも)'),
];
export const GLOSSARY_PRESETS = { standard: 'わかりやすい言葉（標準）', company: '会社向け', university: '大学・役所向け' };
const isGroup = s => s.kind === 'council' || s.kind === 'parallel';
const UP = '{up}'; // 申請者の一つ上の役職(金額のない申請の決裁者)
const ROLE_SUFFIX = { kacho: '決裁者', kakaricho: '上位の承認者', keiri: '経理担当者', kakariin: '担当者' };

// 画面の型(箱5種類+並行の入れ物+終わり方)を、仕組みの中の並びに直す。前の形(check/decision/order/submit)も読める。
export function expandTemplate(tpl) {
  const steps = [];
  const fields = [...(tpl.fields || [])];
  let ending = tpl.ending ? { ...tpl.ending } : null;
  const src = tpl.steps || [];
  // 起案箱はどのルートでも先頭に1つ(なければ足す)
  const draft = src.find(s => s.kind === 'draft') || { id: 'draft', kind: 'draft', label: '起案' };
  steps.push({ ...draft, label: draft.label || '起案' });
  for (const s of src) {
    if (s.kind === 'draft') continue;
    if (s.kind === 'input') { for (const f of s.fields || []) if (!fields.some(x => x.key === f.key)) fields.push(f); continue; }
    if (s.kind === 'approval') { steps.push({ ...s, kind: s.mark === 'decision' ? 'decision' : 'check' }); continue; }
    if (s.kind === 'order') { ending = ending || { type: 'order' }; continue; }
    if (s.kind === 'submit') { ending = ending || { type: 'submit', receiptDoc: s.receiptDoc }; continue; }
    steps.push(s);
  }
  if (ending?.type === 'order') steps.push({ id: 'end', kind: 'order', label: ending.label || '発注・納品', ...(ending.role ? { role: ending.role } : {}) });
  if (ending?.type === 'submit') steps.push({ id: 'end', kind: 'submit', label: ending.label || '提出', receiptDoc: ending.receiptDoc || '提出控え' });
  return { steps, fields, ending: ending || { type: 'none' } };
}

export class WorkflowError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}
const fail = (msg, status, code) => { throw new WorkflowError(msg, status, code); };
const ymd = t => new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10); // 日本時間の日付
const inRange = (day, from, to) => (!from || from <= day) && (!to || day <= to);
const yen = n => `${Number(n).toLocaleString('ja-JP')}円`;

export function initialState(seed) {
  const s = structuredClone(seed);
  s.cases = []; s.outbox = []; s.mailTokens = {};
  s.seq = { case: 0, mail: 0 };
  s.absences = s.absences || [];
  return withBuildFlags(s);
}

// 作る権限のフラグ(人ごと)。使う権限と作る権限はセットで、基本は全員が両方使える(2026-11-12 決定)。
// 古い保存データにはフラグがないので、ない人は true にそろえる。切り替えの記録は buildFlagLog に残す。
export function withBuildFlags(s) {
  for (const p of s.people || []) if (typeof p.canBuild !== 'boolean') p.canBuild = true;
  s.buildFlagLog = s.buildFlagLog || [];
  return s;
}

export class Engine {
  constructor(state, { now = () => Date.now() } = {}) { this.s = withBuildFlags(state); this.now = now; }
  today() { return ymd(this.now()); }

  // ---------- 組織 ----------
  person(id) { return this.s.people.find(p => p.id === id); }
  pname(id) { return id === 'system' ? '仕組み' : this.person(id)?.name || id; }
  role(id) { return this.s.roles.find(r => r.id === id); }
  roleName(id) {
    if (id === UP) return '起案者の上位の承認者';
    const m = /^\{unit\}-(\w+)$/.exec(id || '');
    if (m) return `起案者の課の${ROLE_SUFFIX[m[1]] || m[1]}`;
    if (!id) return '(役職が未設定)';
    return this.role(id)?.name ?? '(表にない役職)';
  }
  // 画面で選ぶ役職の候補(IDは見せず、日本語の名前で選ぶ)
  roleChoices() {
    const tpl = Object.entries(ROLE_SUFFIX).map(([k]) => ({ id: `{unit}-${k}`, name: this.roleName(`{unit}-${k}`) }));
    return [{ id: UP, name: this.roleName(UP) }, ...tpl, ...this.s.roles.map(r => ({ id: r.id, name: r.name }))];
  }
  personBrief(id) { return { id, name: this.pname(id) }; }
  // 役職→人の表(切り替え日つき)。今日の時点で有効な行だけ。
  holders(roleId, day = this.today()) {
    return [...new Set(this.s.assignments.filter(a => a.role === roleId && inRange(day, a.from, a.to)).map(a => a.person))];
  }
  rolesOf(personId, day = this.today()) { return this.s.assignments.filter(a => a.person === personId && inRange(day, a.from, a.to)).map(a => a.role); }
  proxyRule(roleId) { return (this.s.proxyOrder || []).find(p => p.role === roleId) || {}; }
  template(id) { return this.s.templates.find(t => t.id === id) || fail('ルートの型が見つかりません', 404); }
  isAbsent(personId, day = this.today()) { return (this.s.absences || []).some(a => a.person === personId && inRange(day, a.from, a.to)); }

  isAdmin(personId) {
    if ((this.s.settings?.admins || []).includes(personId)) return true;
    if (this.person(personId)?.unit === 'jimukyoku') return true;
    return this.rolesOf(personId).some(r => this.role(r)?.unit === 'jimukyoku');
  }
  resolveRole(roleTpl, applicantId) {
    if (roleTpl === UP) return this.upRole(applicantId);
    return roleTpl ? roleTpl.replaceAll('{unit}', this.person(applicantId)?.unit) : roleTpl;
  }
  // 役職の上下表: 役職の rank(係員・経理担当1 → 係長2 → 課長3 → 部長4 → 事務局長5 → 副学長6 → 学長7)と、上位の表(escalateTo)。
  // 申請者の一番上の役職から一つ上を引く。上位の表にあればそれ、なければ同じ課で rank が次に高い役職。担当がいない・本人だけなら、さらに上へ。
  rankOf(roleId) { return this.role(roleId)?.rank ?? 0; }
  upFrom(roleId) {
    const esc = this.proxyRule(roleId).escalateTo;
    if (esc) return esc;
    const r = this.role(roleId);
    if (!r) return null;
    const cands = this.s.roles.filter(x => x.unit === r.unit && this.rankOf(x.id) > this.rankOf(roleId)).sort((a, b) => this.rankOf(a.id) - this.rankOf(b.id));
    return cands[0]?.id || null;
  }
  upRole(applicantId) {
    const mine = this.rolesOf(applicantId).sort((a, b) => this.rankOf(b) - this.rankOf(a));
    let cur = mine[0], guard = 0;
    while (cur && guard++ < 10) {
      const up = this.upFrom(cur);
      if (!up) return null;
      if (this.holders(up).some(p => p !== applicantId)) return up;
      cur = up;
    }
    return null;
  }

  // ---------- 金額マスター(版つき) ----------
  amountTableFor(tpl, day) {
    if (tpl.amountTable && tpl.amountTable.length && !tpl.useSharedAmountTable) return { version: tpl.amountTableVersion || 1, rows: tpl.amountTable };
    const tables = (this.s.amountTables || []).filter(t => !t.from || t.from <= day).sort((a, b) => (a.from || '').localeCompare(b.from || ''));
    const t = tables[tables.length - 1];
    return t ? { version: t.version, rows: t.rows } : { version: 0, rows: [] };
  }
  pickAmountRow(rows, amount) {
    const row = rows.find(r => r.upTo === null || r.upTo === undefined || Number(amount) <= r.upTo);
    if (!row) fail('金額マスターに当てはまる段がありません');
    return row;
  }

  // ---------- ルートを組み立てる ----------
  buildRoute(tpl, applicantId, fields = {}, day = this.today()) {
    const steps = [];
    const notes = [];
    for (const raw of expandTemplate(tpl).steps) {
      if (!KINDS.has(raw.kind)) fail(`知らない箱の種類です: ${raw.kind}`);
      const base = {
        id: raw.id, kind: raw.kind, label: raw.label || raw.kind,
        requiredDocs: [...(raw.requiredDocs || [])], cc: (raw.cc || []).map(r => this.resolveRole(r, applicantId)),
        switchDaysBefore: raw.switchDaysBefore ?? 3, allowProxy: raw.allowProxy !== false,
        hideRejectReason: !!raw.hideRejectReason, state: 'waiting', flags: [],
      };
      if (raw.kind === 'decision' && raw.fromAmountTable && raw.amountFrom === 'total' && (fields.amount === undefined || fields.amount === '')) {
        steps.push({ ...base, id: raw.id, role: null, label: '合計額で決まる決裁', fromAmountTable: true, pendingTotal: true, rawId: raw.id });
        notes.push('決裁する人は、各課の希望を集めた合計額で金額マスターから決まります');
        continue;
      }
      if (raw.kind === 'decision' && raw.fromAmountTable) {
        if (fields.amount === undefined || fields.amount === '' || Number.isNaN(Number(fields.amount))) fail('金額を入れてください');
        const table = this.amountTableFor(tpl, day);
        const row = this.pickAmountRow(table.rows, fields.amount);
        notes.push(row.approvers.length
          ? `金額マスター(第${table.version}版)により ${yen(fields.amount)} は ${row.approvers.map(r => this.roleName(this.resolveRole(r, applicantId))).join('→')} の決裁`
          : `金額マスター(第${table.version}版)により ${yen(fields.amount)} は決裁なし(受付の裁量で完了)`);
        if (!row.approvers.length) base.flags.push('pettyCash');
        if (!row.approvers.length && steps[0]) steps[0].fromAmountTableEmpty = true;
        row.approvers.forEach((r, i) => {
          const role = this.resolveRole(r, applicantId);
          steps.push({ ...base, id: `${raw.id}-${i + 1}`, role, label: `${this.roleName(role)}の決裁`, fromAmountTable: true, requiredDocs: i === 0 ? base.requiredDocs : [] });
        });
        continue;
      }
      const step = { ...base };
      if (raw.role) step.role = this.resolveRole(raw.role, applicantId);
      if (raw.role === UP) {
        if (!step.role) fail('起案者の上位の承認者が見つかりません(役職の上下表を確かめてください)');
        step.label = `${raw.label || '決裁'}(${this.roleName(step.role)})`;
        notes.push(`${raw.label || '決裁'}は起案者の上位の承認者(${this.roleName(step.role)})`);
      }
      if (raw.kind === 'reception') step.collect = (raw.collect || []).map(c => ({ role: this.resolveRole(c.role, applicantId), doc: c.doc }));
      if (raw.kind === 'council' || raw.kind === 'parallel') {
        const what = raw.kind === 'council' ? '合議の箱' : '並行の入れ物';
        step.members = (raw.members || []).map(r => this.resolveRole(r, applicantId));
        const max = raw.maxMembers ?? this.s.settings?.councilMaxMembers ?? 10;
        if (step.members.length > max) fail(`${what}のメンバーが上限(${max})を超えています`);
        if (!step.members.length) fail(`${what}にメンバーがいません`);
        step.rule = raw.kind === 'parallel' ? 'all' : raw.rule || 'all';
        step.allowExternal = !!raw.allowExternal;
        step.memberDocs = raw.memberDocs || {};
        step.votes = {};
        if (raw.kind === 'parallel') step.branchReturns = {};
        if (raw.kind === 'parallel' && raw.gather) { step.gather = { ...raw.gather }; step.answers = {}; }
      }
      if (raw.kind === 'notify') { step.notifyRoles = (raw.roles || []).map(r => this.resolveRole(r, applicantId)); step.via = raw.via || ['mail']; }
      if (raw.kind === 'submit') step.receiptDoc = raw.receiptDoc || '提出控え';
      steps.push(step);
    }
    const recRole = steps.find(s => s.kind === 'reception')?.role;
    for (const s of steps) if ((s.kind === 'order' || s.kind === 'submit') && !s.role) s.role = recRole;
    return { steps, notes };
  }
  routeSignature(steps) { return steps.map(s => `${s.kind}:${s.role || ''}:${(s.members || []).join('+')}`).join('>'); }

  // 代理の候補(予定不在のとき)。金額の上限、本人の申請、代理の不在を見る。
  proxyCandidates(c, role) {
    const out = [];
    for (const px of this.proxyRule(role).proxies || []) {
      const pr = typeof px === 'string' ? { role: px } : px;
      if (pr.maxAmount != null && Number(c.fields?.amount || 0) > pr.maxAmount) continue;
      out.push(...this.holders(pr.role).filter(p => p !== c.applicant && !this.isAbsent(p)));
    }
    return [...new Set(out)];
  }

  // 担当(申請者は除く。予定不在なら代理)。{ people, proxyFor }
  assign(c, step) {
    if (step.override) return { people: step.override.to.filter(p => !this.isAbsent(p)), override: true };
    if (step.kind === 'draft') return { people: [c.applicant] };
    // 小口(決裁なし)の案件は、起案者と受付が同じ人(課の経理担当)でもよい
    if (step.kind === 'reception' && !step.override && this.isPettyCash(c) && this.holders(step.role).includes(c.applicant)) {
      return { people: this.holders(step.role).filter(p => !this.isAbsent(p)), selfReceptionOk: true };
    }
    if (isGroup(step)) return { people: step.members.flatMap(r => this.holders(r)).filter(p => p !== c.applicant) };
    const hs = this.holders(step.role);
    let others = hs.filter(p => p !== c.applicant);
    if (!others.length && hs.length && (step.kind === 'order' || step.kind === 'submit')) others = hs; // 発注・提出は承認ではない
    const present = others.filter(p => !this.isAbsent(p));
    if (present.length) return { people: present };
    if (others.length && step.allowProxy && (step.kind === 'decision' || step.kind === 'check')) {
      const px = this.proxyCandidates(c, step.role);
      if (px.length) return { people: px, proxyFor: others };
    }
    return { people: [], absent: others };
  }
  baseAssignees(c, s) { return this.assign(c, s).people; }
  isPettyCash(c) { return c.steps.some(x => x.fromAmountTableEmpty) && !c.steps.some(x => x.kind === 'decision'); }

  // ---------- 記録(つながったハッシュで書き換えを見つける) ----------
  log(c, actor, action, step, extra = {}, text = '') {
    const prev = c.history[c.history.length - 1]?.hash || '';
    const e = { at: this.now(), actor, actorName: this.pname(actor), actorRoles: actor === 'system' ? [] : this.rolesOf(actor).map(r => this.roleName(r)), roleTableVersion: this.s.roleTableVersion || 1, action, stepId: step?.id || null, stepLabel: step?.label || null, ...extra, text };
    e.hash = createHash('sha256').update(prev + JSON.stringify({ ...e, hash: undefined })).digest('hex');
    c.history.push(e);
  }
  verifyLog(c) {
    let prev = '';
    for (let i = 0; i < c.history.length; i++) {
      const e = c.history[i];
      const h = createHash('sha256').update(prev + JSON.stringify({ ...e, hash: undefined })).digest('hex');
      if (h !== e.hash) return { ok: false, brokenAt: i };
      prev = e.hash;
    }
    return { ok: true };
  }

  // ---------- 申請 ----------
  caseTypes() { return this.s.caseTypes || []; }
  setCaseTypes(as, items) {
    this.mustBuild(as);
    if (!Array.isArray(items) || !items.length) fail('案件の種類が1つもありません');
    const ids = new Set();
    for (const t of items) {
      if (!t.id || !t.name) fail('案件の種類には名前と記号が要ります');
      if (ids.has(t.id)) fail(`案件の種類の記号が重なっています: ${t.id}`);
      ids.add(t.id);
      this.template(t.templateId);
    }
    this.s.caseTypes = items.map(t => ({ id: t.id, name: t.name, templateId: t.templateId, active: t.active !== false, style: t.style === 'normal' ? 'normal' : 'chat' })); // 既定はチャット型(2026-11-13 決定)
    return this.s.caseTypes;
  }
  createCase({ as, templateId, caseTypeId, title, purpose = '', fields = {}, docs = [], deadline, message = '' }) {
    if (!this.person(as)) fail('申請する人が見つかりません', 403);
    let ct = null;
    if (caseTypeId) {
      ct = this.caseTypes().find(t => t.id === caseTypeId || t.name === caseTypeId);
      if (!ct || ct.active === false) fail('案件の種類が見つかりません(起案箱で種類を選んでください)');
      templateId = ct.templateId;
    } else ct = this.caseTypes().find(t => t.templateId === templateId) || null;
    if (!templateId) fail('起案箱で案件の種類を選んでください');
    if (!title) fail('件名を入れてください');
    const tpl = this.template(templateId);
    if (tpl.deadline?.required && !deadline) fail('この種類の案件は締切日が必要です');
    const { steps, notes } = this.buildRoute(tpl, as, fields);
    const id = `C${String(++this.s.seq.case).padStart(4, '0')}`;
    const docNo = this.issueDocNo(as);
    const late = this.lateCheck(tpl, fields);
    this.periodCheck(tpl, fields);
    const c = {
      id, docNo, templateId, templateName: tpl.name, caseTypeId: ct?.id || null, caseTypeName: ct?.name || tpl.name, purpose, title, fields, applicant: as, deadline: deadline || null,
      status: 'in_progress', steps, current: -1, docs: [], history: [], postReviews: [], memos: [],
      // チャット型(2026-11-12 試し): 箱ごとのチャットで相談し、まとまったら「承認して次へ回す」。軽い案件向け
      style: ct?.style === 'normal' ? 'normal' : 'chat', chat: [], revisions: [],
      createdAt: this.now(), signature: this.routeSignature(steps), alerts: {},
    };
    for (const name of docs) this._addDoc(c, as, name, 'applicant');
    this.s.cases.push(c);
    const d = steps.find(x => x.kind === 'draft');
    if (d) { d.state = 'done'; d.enteredAt = this.now(); }
    this.log(c, as, 'submit', d, { docNo, caseType: c.caseTypeName, purpose }, `${this.pname(as)}さんが起案しました。文書番号: ${docNo}、種類: ${c.caseTypeName}、件名: 「${title}」${purpose ? `、目的: ${purpose}` : ''}。${notes.join('。')}`);
    if (late) {
      c.late = late;
      const rec = steps.find(x => x.kind === 'reception');
      if (rec) rec.flags.push('late');
      this.log(c, 'system', 'late', rec || d, late, `受付期限を過ぎた申請です(${late.text})。止めずに受付へ回します。受け付けるか戻すかは受付が決めます`);
    }
    this.advance(c, -1);
    // チャット型: 起案のときに書いた最初のひとことを、今の箱のチャットに入れる
    if (c.style === 'chat' && String(message || '').trim() && c.status === 'in_progress') this.chat(c, c.steps[c.current], as, message);
    if (late) this.notify(this.receptionHolders(c), `【期限を過ぎた申請】${c.title}`, `${late.text}。受け付けるか、理由を書いて戻すかを決めてください。`, c);
    return c;
  }
  // 文書番号: 起案した時点で仕組みが振る。年度-課-連番(例: 2026-総務-00012)。一生変わらない
  fiscalYear(day = this.today()) { const [y, m] = day.split('-').map(Number); return m >= 4 ? y : y - 1; }
  unitShort(unitId) { const n = (this.s.units || []).find(u => u.id === unitId)?.name || unitId || '不明'; return n.length > 2 ? n.replace(/(課|室)$/, '') : n; }
  issueDocNo(applicantId) {
    const key = `${this.fiscalYear()}-${this.unitShort(this.person(applicantId)?.unit)}`;
    this.s.seq.docNo = this.s.seq.docNo || {};
    const n = (this.s.seq.docNo[key] || 0) + 1;
    this.s.seq.docNo[key] = n;
    return `${key}-${String(n).padStart(5, '0')}`;
  }
  findByDocNo(no) { return this.s.cases.find(c => c.docNo === no) || null; }
  // 検索: 文書番号・件名・起案者・日付(YYYY-MM-DD の一部)
  matches(c, q) {
    if (!q) return true;
    const words = String(q).trim().split(/\s+/).filter(Boolean);
    const hay = [c.docNo, c.title, this.pname(c.applicant), ymd(c.createdAt), c.caseTypeName].join(' ');
    return words.every(w => hay.includes(w));
  }
  // 期間でまとめて1件(例: 毎週金曜のテレワークを1〜2か月分)。型の period = { from, to, maxDays }
  periodCheck(tpl, fields) {
    const p = tpl.period;
    if (!p || !fields?.[p.to]) return;
    const a = fields[p.from], b = fields[p.to];
    if (!a) fail(`${p.label || '期間'}の最初の日を入れてください`);
    if (b < a) fail(`${p.label || '期間'}の最後の日が、最初の日より前になっています`);
    const days = Math.round((new Date(`${b}T00:00:00+09:00`) - new Date(`${a}T00:00:00+09:00`)) / DAY) + 1;
    if (p.maxDays && days > p.maxDays) fail(`${p.label || '期間'}は${p.maxDays}日までです(今は${days}日)。分けて申請してください`);
  }
  // 受付期限(継ぎ目C): 型の applyBy = { field: 日付の項目, daysBefore: 何日前まで }。過ぎても止めず、印を付けて受付へ
  lateCheck(tpl, fields) {
    const rule = tpl.applyBy;
    if (!rule?.daysBefore) return null;
    const key = rule.field || 'from';
    const day = fields?.[key];
    if (!day) return null;
    const left = Math.round((new Date(`${day}T00:00:00+09:00`).getTime() - new Date(`${this.today()}T00:00:00+09:00`).getTime()) / DAY);
    if (left >= rule.daysBefore) return null;
    const label = expandTemplate(tpl).fields.find(f => f.key === key)?.label || '対象の日';
    return { field: key, day, daysBefore: rule.daysBefore, daysLeft: left, text: `${label}(${day})の${rule.daysBefore}日前までの決まりに対し、${left < 0 ? `${-left}日過ぎてから` : left === 0 ? '当日に' : `${left}日前に`}申請` };
  }
  getCase(id) { return this.s.cases.find(c => c.id === id) || fail('案件が見つかりません', 404); }
  _addDoc(c, by, name, stepId) {
    const v = c.docs.filter(d => d.name === name).length + 1;
    c.docs.push({ name, version: v, addedBy: by, step: stepId, at: this.now() });
  }
  hasDoc(c, name) { return c.docs.some(d => d.name === name); }
  requiredUpTo(c, idx) {
    const need = [];
    for (let i = 0; i <= idx && i < c.steps.length; i++) {
      const s = c.steps[i];
      need.push(...s.requiredDocs);
      if (s.collect) need.push(...s.collect.map(x => x.doc));
      if (s.memberDocs) need.push(...Object.values(s.memberDocs));
    }
    return [...new Set(need)];
  }
  missingDocs(c, idx) { return this.requiredUpTo(c, idx).filter(n => !this.hasDoc(c, n)); }

  advance(c, fromIdx) {
    let i = fromIdx + 1;
    while (i < c.steps.length) {
      const s = c.steps[i];
      if (s.state === 'done' || s.state === 'skipped') { i++; continue; }
      if (s.kind === 'notify') {
        const to = s.notifyRoles.flatMap(r => this.holders(r));
        const via = s.via.map(v => ({ mail: 'メール', teams: 'Teams', slack: 'Slack' }[v] || v)).join('・');
        this.notify(to, `【お知らせ】${c.title}`, `${s.label}: ${this.pname(c.applicant)}さんの申請が進んでいます(お知らせのみ、${via})。`, c, { via: s.via });
        s.state = 'done'; s.enteredAt = this.now();
        this.log(c, 'system', 'notify', s, { to }, `${s.label}: ${to.map(p => this.pname(p)).join('・') || '(該当者なし)'}さんにお知らせしました(${via})`);
        i++; continue;
      }
      const hs = this.holders(s.role);
      const who = this.baseAssignees(c, s);
      if (!who.length && !s.override && s.kind === 'reception' && hs.length && hs.every(p => p === c.applicant)) {
        s.state = 'skipped'; s.flags.push('selfSkipped');
        const nextDec = c.steps.slice(i + 1).find(x => x.kind === 'decision');
        if (nextDec) nextDec.flags.push('orderCheck');
        this.log(c, 'system', 'skip', s, {}, `受付の担当が申請者本人しかいないため受付を飛ばしました。${nextDec ? `${nextDec.label}で発注内容まで確かめます` : '決裁がないため注意'}`);
        i++; continue;
      }
      if (!s.override && s.kind === 'decision' && hs.length && hs.every(p => p === c.applicant)) {
        const up = this.proxyRule(s.role).escalateTo;
        if (up && this.holders(up).length) {
          s.override = { type: 'selfAvoid', fromRole: s.role, from: hs, toRole: up, to: this.holders(up), by: 'system', reason: '申請者本人の決裁を避けるため', at: this.now() };
          s.label = `${this.roleName(up)}の決裁(本人の申請のため)`;
          this.log(c, 'system', 'selfAvoid', s, { toRole: up }, `申請者本人が${this.roleName(s.role)}のため、決裁を${this.roleName(up)}へ回しました`);
        }
      }
      c.current = i;
      s.enteredAt = this.now();
      if (s.kind === 'decision' && this.missingDocs(c, i).length) { this.autoReturn(c, i); return; }
      else { s.state = 'current'; this.notifyStep(c, s); }
      return;
    }
    c.current = c.steps.length;
    c.status = 'completed';
    c.completedAt = this.now();
    this.log(c, 'system', 'complete', null, { docNo: c.docNo }, `すべての手続きが終わり、完了しました(文書番号 ${c.docNo})`);
    this.notify([c.applicant], `【完了】${c.title}`, 'すべての手続きが終わりました。', c);
  }

  // ---------- 通知(試作では送信箱にためる) ----------
  notify(to, subject, body, c, extra = {}) {
    for (const p of new Set(to)) this.s.outbox.push({ id: ++this.s.seq.mail, to: p, toName: this.pname(p), subject, body, caseId: c?.id, at: this.now(), ...extra });
  }
  notifyStep(c, s) {
    const a = this.assign(c, s);
    const mailOk = this.s.settings?.allowMailApproval && MAIL_KINDS.has(s.kind);
    for (const p of a.people) {
      let token;
      if (mailOk) { token = randomBytes(6).toString('hex'); this.s.mailTokens[token] = { caseId: c.id, stepId: s.id, person: p, used: false }; }
      const how = token ? `メールの返信で「承認」か「差し戻し 理由」と書けば受け付けます(番号 ${token})。` : '承認画面から処理してください。';
      const px = a.proxyFor ? `(${a.proxyFor.map(q => this.pname(q)).join('・')}さんが予定不在のため代理でお願いします)` : '';
      this.notify([p], `【お願い】${c.title}(${s.label})`, `${this.pname(c.applicant)}さんの申請が届きました${px}。${how}`, c, token ? { token } : {});
    }
    if (!a.people.length) {
      const to = [...this.receptionHolders(c), ...this.admins()];
      this.notify(to, `【止まっています】${c.title}`, `「${s.label}」の担当が不在か0人です。待つか、代理・一つ上へ回してください(自動では回しません)。`, c);
    }
    if (s.cc.length) this.notify(s.cc.flatMap(r => this.holders(r)), `【お知らせ】${c.title}`, `${s.label}に進みました(お知らせのみ)。`, c);
  }
  // 決裁の前の自動チェックで必須書類が欠けていたら、決裁者に回さず申請者へ戻す。受付(と提出物を頼まれた課)にも知らせる
  autoReturn(c, idx) {
    const missing = this.missingDocs(c, idx);
    const s = c.steps[idx];
    c.status = 'returned';
    c.returnedFrom = idx;
    s.state = 'waiting';
    const reason = `書類が足りません: ${missing.join('、')}`;
    this.log(c, 'system', 'return', s, { reason, auto: true, missing, to: 'applicant', shortcut: true }, `自動チェックで申請者へ戻しました(決裁者には回していません)。足りない書類: ${missing.join('、')}`);
    this.notify([c.applicant], `【差し戻し(自動チェック)】${c.title}`, `「${s.label}」の前に必要な書類がそろっていません: ${missing.join('、')}。添付して出し直してください。`, c);
    const to = new Set(this.receptionHolders(c));
    for (let i = 0; i <= idx; i++) for (const col of c.steps[i].collect || []) if (missing.includes(col.doc)) this.holders(col.role).forEach(p => to.add(p));
    to.delete(c.applicant);
    this.notify([...to], `【自動チェックで戻しました】${c.title}`, `書類が足りないため申請者へ戻しました: ${missing.join('、')}`, c);
  }
  notifyMissing(c, idx) {
    const missing = this.missingDocs(c, idx);
    const to = new Set([c.applicant]);
    for (let i = 0; i <= idx; i++) for (const col of c.steps[i].collect || []) if (missing.includes(col.doc)) this.holders(col.role).forEach(p => to.add(p));
    this.notify([...to], `【書類が足りません】${c.title}`, `決裁の前にそろえてください: ${missing.join('、')}`, c);
    this.log(c, 'system', 'blocked', c.steps[idx], { missing }, `書類が足りないため決裁者へ回していません: ${missing.join('、')}`);
  }
  // 作る権限(ルートを組む・表と設定を直す)。2026-11-12 決定: 基本は全員が使う・作るの両方を使える。
  // 人ごとのフラグ person.canBuild を各課の管理者が付け外しする。試作では実際の制限はまだかけない(フラグを見るだけ)。
  canBuild(personId) { return !!this.person(personId); }
  mustBuild(as) { if (!this.canBuild(as)) fail('操作する人が見つかりません', 403); }
  builders() { return this.s.people.filter(p => this.canBuild(p.id)).map(p => p.id); }
  // 課の管理者: その課で一番上の役職(課長など)に今ついている人。事務局の人はどの課も直せる。
  unitManagers(unitId) {
    const roles = this.s.roles.filter(r => r.unit === unitId);
    if (!roles.length) return [];
    const top = Math.max(...roles.map(r => this.rankOf(r.id)));
    return [...new Set(roles.filter(r => this.rankOf(r.id) === top).flatMap(r => this.holders(r.id)))];
  }
  canManageUnit(as, unitId) { return this.isAdmin(as) || this.unitManagers(unitId).includes(as); }
  unitName(unitId) { return (this.s.units || []).find(u => u.id === unitId)?.name || unitId || '所属なし'; }
  setBuildFlag(as, personId, value) {
    if (!this.person(as)) fail('操作する人が見つかりません', 403);
    const p = this.person(personId) || fail('その人が見つかりません', 404);
    if (typeof value !== 'boolean') fail('作る権限は「あり」か「なし」で指定してください');
    if (!this.canManageUnit(as, p.unit)) fail(`作る権限を切り替えられるのは、${this.unitName(p.unit)}の管理者か事務局の人だけです`, 403);
    if (p.canBuild === value) return { person: p, entry: null };
    p.canBuild = value;
    this.s.seq.buildFlag = (this.s.seq.buildFlag || 0) + 1;
    const entry = { id: `B${this.s.seq.buildFlag}`, at: this.now(), by: as, byName: this.pname(as), person: p.id, personName: p.name, unit: p.unit, unitName: this.unitName(p.unit), value,
      text: `${this.pname(as)}さんが${p.name}さん(${this.unitName(p.unit)})の作る権限を${value ? 'あり' : 'なし'}にしました` };
    this.s.buildFlagLog.push(entry);
    return { person: p, entry };
  }
  // 起案で選べる種類: 使う状態で、使うルートが用意されているものだけ
  usableCaseTypes() { return this.caseTypes().filter(t => t.active !== false && this.s.templates.some(x => x.id === t.templateId)); }
  // ---------- 用語辞書 ----------
  glossary() {
    const g = this.s.glossary || { preset: 'standard', terms: {} };
    const preset = GLOSSARY_PRESETS[g.preset] ? g.preset : 'standard'; // 前の版の「試作の言葉のまま」は標準として扱う
    return {
      preset, presetName: GLOSSARY_PRESETS[preset], presets: GLOSSARY_PRESETS,
      rows: GLOSSARY.map(t => ({ ...t, word: g.terms?.[t.base] || t[preset], edited: !!g.terms?.[t.base] })),
    };
  }
  term(base) { return this.glossary().rows.find(r => r.base === base)?.word || base; }
  // 組織の管理者(事務局)だけが切り替える。ひな形を選ぶと1語ずつの直しは消える。直した言葉は terms に残す
  setGlossary(as, { preset, terms } = {}) {
    if (!this.isAdmin(as)) fail('用語辞書を変えられるのは、組織の管理者(事務局)だけです', 403);
    const g = this.s.glossary || { preset: 'standard', terms: {} };
    const before = this.glossary().rows.map(r => `${r.base}=${r.word}`).join(',');
    if (preset !== undefined) {
      if (!GLOSSARY_PRESETS[preset]) fail('用語辞書のひな形が見つかりません');
      g.preset = preset; g.terms = {};
    }
    for (const [base, word] of Object.entries(terms || {})) {
      if (!GLOSSARY.some(t => t.base === base && t.main)) fail(`辞書にない言葉です: ${base}`);
      const w = String(word ?? '').trim();
      if (w.length > 20) fail('言葉は20文字までです');
      if (!w) delete g.terms[base]; else g.terms[base] = w;
    }
    this.s.glossary = g;
    const now = this.glossary();
    const changed = now.rows.filter(r => !before.split(',').includes(`${r.base}=${r.word}`)).map(r => `${r.base}→${r.word}`);
    this.s.glossaryLog = this.s.glossaryLog || [];
    this.s.glossaryLog.push({ at: this.now(), by: as, byName: this.pname(as), preset: now.preset, changed, text: `${this.pname(as)}さんが用語辞書を変えました(${now.presetName}${changed.length ? `: ${changed.join('、')}` : ''})` });
    return now;
  }

  setSettings(as, values = {}) {
    this.mustBuild(as);
    const allowed = ['showReturnReason', 'allowOffCampusApproval', 'allowMailApproval', 'councilMaxMembers'];
    for (const [k, v] of Object.entries(values)) if (allowed.includes(k)) this.s.settings[k] = v;
    return this.s.settings;
  }
  addAbsence(as, { person, from, to, reason = '' }) {
    this.mustBuild(as);
    if (!this.person(person)) fail('不在の人が見つかりません');
    if (!from || !to || from > to) fail('不在の期間(から・まで)を正しく入れてください');
    this.s.seq.absence = (this.s.seq.absence || 0) + 1;
    const a = { id: `A${this.s.seq.absence}`, person, from, to, reason };
    this.s.absences.push(a);
    return a;
  }
  removeAbsence(as, id) {
    this.mustBuild(as);
    const i = this.s.absences.findIndex(a => a.id === id);
    if (i < 0) fail('その不在の予定は見つかりません', 404);
    return this.s.absences.splice(i, 1)[0];
  }
  admins() { return this.s.people.filter(p => this.isAdmin(p.id)).map(p => p.id); }
  receptionHolders(c) { const r = c.steps.find(s => s.kind === 'reception'); return r ? this.holders(r.role) : []; }

  // ---------- 誰が何を押せるか ----------
  canAct(c, as) {
    const acts = [];
    if (!as) return acts;
    const s = c.steps[c.current];
    const manager = this.isAdmin(as) || this.receptionHolders(c).includes(as);
    if (c.status === 'in_progress' && s) {
      const who = this.baseAssignees(c, s);
      const mine = who.includes(as) && !(isGroup(s) && s.votes[as]) && !(s.kind === 'parallel' && this.branchOf(s, as).every(r => s.branchReturns?.[r]));
      if (mine && s.state === 'current') {
        if (s.kind === 'order') acts.push(s.ordered ? 'markDelivered' : 'markOrdered');
        else if (s.kind === 'submit') acts.push('markSubmitted');
        else if (s.kind === 'parallel' && s.gather) acts.push('answer'); // 呼びかけへの返事(希望の数。0=不要)
        else if (s.kind === 'parallel') acts.push('approve', 'return'); // 並行の課は差し戻しだけ(否決で終わらせない)
        else acts.push('approve', 'return', 'reject');
      }
      if (who.includes(as) || (s.collect || []).some(x => this.holders(x.role).includes(as)) || this.requiredUpTo(c, c.current).length && manager) acts.push('addDoc');
      if (manager && ['decision', 'check', 'council', 'parallel'].includes(s.kind)) { if (s.allowProxy) acts.push('delegate'); acts.push('escalate'); }
      if (as === c.applicant && !c.steps.some(x => x.kind === 'decision' && x.state === 'done')) acts.push('withdraw');
      if (who.includes(as) || manager || as === c.applicant) acts.push('memo');
      if (c.style === 'chat' && (who.includes(as) || manager || as === c.applicant)) acts.push('chat');
      if (c.style === 'chat' && as === c.applicant && c.fields && Object.keys(c.fields).length && !c.steps.some(x => x.gather)) acts.push('revise'); // まとめ買いは呼びかけの直しをしない(各課の返事とずれるため)
      if (as === c.applicant && s.kind === 'parallel' && Object.keys(s.branchReturns || {}).length) acts.push('resubmit');
    }
    if (as === c.applicant && (c.status === 'in_progress' || c.status === 'returned')) acts.push('addDoc', 'memo');
    const branchReturned = c.status === 'in_progress' && s?.kind === 'parallel' && Object.keys(s.branchReturns || {}).length;
    if (c.status === 'returned' || branchReturned) {
      const collectors = c.steps.flatMap(x => (x.collect || []).flatMap(cc => this.holders(cc.role)));
      if (manager || collectors.includes(as)) acts.push('addDoc');
    }
    if (as === c.applicant && c.status === 'returned') acts.push('resubmit', 'cancel', 'redraft');
    if (c.style === 'chat' && c.status === 'returned' && s && (as === c.applicant || this.baseAssignees(c, s).includes(as) || manager)) acts.push('chat');
    if (as === c.applicant && c.status === 'withdrawn' && !c.redraftedTo) acts.push('redraft');
    if (c.postReviews.some(r => !r.done && r.people.includes(as))) acts.push('postReview');
    return [...new Set(acts)];
  }

  // ---------- 動き ----------
  act(id, { as, action, reason, doc, twoFA, fields, via = 'web', to, shortcut, memo, visibility, offCampus }) {
    const c = this.getCase(id);
    if (!this.person(as)) fail('操作する人が見つかりません', 403);
    if (REASON_ACTIONS.has(action) && !String(reason || '').trim()) fail('理由を入れてください');
    if (offCampus && !this.s.settings?.allowOffCampusApproval && ['approve', 'return', 'reject'].includes(action)) fail('学外からの承認は使わない設定です。学内から操作してください', 403);
    if (via === 'mail' && !this.s.settings?.allowMailApproval) fail('メールでの承認は使わない設定です', 403);
    // チャットは一度書いたら言いっきり。直す・消す操作は仕組みとして持たない(2026-11-12 決定)
    if (['chatEdit', 'chatDelete', 'editChat', 'deleteChat'].includes(action)) fail('チャットは一度書いたら直せません・消せません', 405, 'chatImmutable');
    if (action === 'approve' && c.steps[c.current]?.gather) action = 'answer';
    const allowed = this.canAct(c, as);
    if (!allowed.includes(action)) {
      if (c.applicant === as && ['approve', 'reject'].includes(action)) fail('自分の申請を自分で承認することはできません', 403);
      if (this.isAbsent(as)) fail('不在の予定が入っているため操作できません', 403);
      if (action === 'reject' && c.steps[c.current]?.kind === 'parallel') fail('並行の入れ物の中では否決できません。直してほしいときは差し戻してください', 403);
      if (action === 'delegate' && c.steps[c.current] && !c.steps[c.current].allowProxy) fail('この箱は代理を認めていません。待つか、一つ上へ回してください', 403);
      fail('この操作はできません(担当ではないか、今は押せない段階です)', 403);
    }
    const s = c.steps[c.current];
    switch (action) {
      case 'approve': return this.approve(c, s, as, { twoFA, via, reason });
      case 'return': return this.returnCase(c, s, as, reason, { via, to, shortcut });
      case 'reject': return this.reject(c, s, as, reason);
      case 'addDoc': {
        if (!doc) fail('書類の名前を入れてください');
        this._addDoc(c, as, doc, s?.id || 'applicant');
        this.log(c, as, 'addDoc', s, { doc }, `${this.pname(as)}さんが「${doc}」を添付しました`);
        if (s?.state === 'blocked' && !this.missingDocs(c, c.current).length) { s.state = 'current'; s.enteredAt = this.now(); this.notifyStep(c, s); }
        return c;
      }
      case 'memo': {
        if (!memo) fail('メモを入れてください');
        const vis = visibility === 'internal' ? 'internal' : 'public';
        c.memos.push({ by: as, at: this.now(), memo, visibility: vis, stepId: s?.id });
        this.log(c, as, 'memo', s, { memo, visibility: vis }, `メモ(${vis === 'internal' ? '内部' : '公開'}): ${memo}`);
        return c;
      }
      case 'withdraw': {
        // 申請者からの引き戻し: 申請者が自分で手元に戻す。それまでに承認した人へCCで知らせる
        c.status = 'returned'; c.returnedFrom = c.current; c.withdrawn = true; s.state = 'waiting';
        this.chatNote(c, s, as, 'withdraw', `申請を手元に戻しました${reason ? `。理由: ${reason}` : ''}`);
        this.log(c, as, 'withdraw', s, { reason: reason || '' }, `${this.pname(as)}さんが申請を引き戻しました(申請者からの引き戻し)${reason ? `。理由: ${reason}` : ''}`);
        this.ccApprovers(c, c.current, `【CC: 申請者からの引き戻し】${c.title}`, `${this.pname(as)}さんが申請を引き戻しました。あなたはこの案件を承認済みのため、お知らせします。${reason ? `理由: ${reason}` : ''}`, '申請者からの引き戻し');
        return c;
      }
      case 'resubmit': return this.resubmit(c, as, fields);
      case 'chat': return this.chat(c, s, as, memo ?? reason);
      case 'answer': return this.answer(c, s, as, fields, memo ?? reason);
      case 'revise': return this.revise(c, s, as, fields, memo ?? reason);
      case 'redraft': {
        const nc = this.createCase({
          as, caseTypeId: c.caseTypeId || undefined, templateId: c.caseTypeId ? undefined : c.templateId,
          title: fields?.title || c.title, purpose: fields?.purpose ?? c.purpose, deadline: c.deadline || undefined,
          fields: Object.fromEntries(Object.entries({ ...c.fields, ...(fields || {}) }).filter(([k]) => !['title', 'purpose'].includes(k))),
          docs: [...new Set(c.docs.map(d => d.name))],
        });
        c.status = 'withdrawn'; c.redraftedTo = nc.id; nc.redraftedFrom = c.id;
        c.redraftedToDocNo = nc.docNo; nc.redraftedFromDocNo = c.docNo;
        this.log(c, as, 'redraft', null, { to: nc.id, toDocNo: nc.docNo }, `起案箱から出し直しました(新しい文書番号 ${nc.docNo})`);
        this.log(nc, as, 'redraftFrom', null, { from: c.id, fromDocNo: c.docNo }, `文書番号 ${c.docNo} を起案し直した案件です`);
        return nc;
      }
      case 'cancel': c.status = 'withdrawn'; this.log(c, as, 'cancel', null, {}, '申請を取り下げました'); return c;
      case 'delegate': return this.handOver(c, s, as, reason, 'delegate');
      case 'escalate': return this.handOver(c, s, as, reason, 'escalate');
      case 'postReview': {
        const r = c.postReviews.find(x => !x.done && x.people.includes(as));
        r.done = true; r.by = as; r.at = this.now();
        this.log(c, as, 'postReview', null, { reviewOf: r.stepLabel, comment: reason || '' }, `${this.pname(as)}さんが「${r.stepLabel}」の代理処理を後から確かめました(後閲)`);
        return c;
      }
      case 'markOrdered': s.ordered = true; s.orderMemo = memo || reason || ''; this.log(c, as, 'markOrdered', s, { memo: s.orderMemo }, `発注しました${s.orderMemo ? `(${s.orderMemo})` : ''}`); return c;
      case 'markDelivered': {
        s.state = 'done'; this.log(c, as, 'markDelivered', s, {}, '物が届きました(納品済み)');
        if (c.gathered) {
          const got = c.gathered.lanes.filter(l => l.qty > 0);
          for (const l of got) this.notify(l.people, `【届きました】${c.title}`, `まとめて購入した「${c.fields.item || c.title}」が届きました。${l.unitName}の分: ${l.qty}${c.fields.unit || '個'}。経理から受け取ってください。`, c);
          if (got.length) this.log(c, 'system', 'notify', s, { to: got.flatMap(l => l.people) }, `届いたことを申し込んだ課(${got.map(l => l.unitName).join('・')})に知らせました`);
        }
        this.advance(c, c.current); return c;
      }
      case 'markSubmitted': {
        if (!this.hasDoc(c, s.receiptDoc)) fail(`「${s.receiptDoc}」(受付印か受付番号の写し)を添付しないと提出済みにできません`);
        s.state = 'done'; this.log(c, as, 'markSubmitted', s, {}, '提出しました(控えあり)'); this.advance(c, c.current); return c;
      }
      default: fail('知らない操作です');
    }
  }

  approve(c, s, as, { twoFA, via, reason }) {
    if (s.kind === 'decision') {
      if (via === 'mail') fail('決裁はメールではできません。学内に戻ってから画面で決裁してください', 403);
      if (!twoFA) fail('決裁には二要素認証が必要です', 403, 'twoFA');
    }
    if (['reception', 'check', 'council', 'parallel'].includes(s.kind)) {
      const missing = this.missingDocs(c, c.current);
      if (missing.length) fail(`書類が足りません: ${missing.join('、')}`);
    }
    const a = this.assign(c, s);
    const viaText = via === 'mail' ? '(メールで)' : '';
    if (isGroup(s)) {
      s.votes[as] = 'approve';
      this.log(c, as, 'vote', s, { vote: 'approve', comment: reason || '', via }, `${this.pname(as)}さんが${s.kind === 'council' ? '合議で賛成しました' : `${s.label}で確認しました`}${viaText}`);
      return this.settleCouncil(c, s);
    }
    s.state = 'done';
    const onBehalf = s.override && s.override.type !== 'selfAvoid' ? s.override.from : a.proxyFor;
    const sameAsDrafter = s.kind === 'reception' && as === c.applicant;
    this.chatNote(c, s, as, 'approve', s.kind === 'decision' ? '決裁して次へ回しました' : '承認して次へ回しました');
    this.log(c, as, 'approve', s, { via, twoFA: !!twoFA, comment: reason || '', onBehalfOf: onBehalf?.map(p => this.pname(p)), sameAsDrafter },
      `${sameAsDrafter ? '起案者と受付が同一(小口のため)。' : ''}${this.pname(as)}さんが${s.label}を${s.kind === 'decision' ? '決裁' : '承認'}しました${c.style === 'chat' ? '(チャットで相談のうえ、承認して次へ回す)' : ''}${viaText}${s.kind === 'decision' ? '(二要素認証あり)' : ''}${onBehalf?.length ? `。${onBehalf.map(p => this.pname(p)).join('・')}さんの代理` : ''}`);
    if (onBehalf?.length && s.kind === 'decision') {
      c.postReviews.push({ stepId: s.id, stepLabel: s.label, people: onBehalf, done: false });
      this.notify(onBehalf, `【後閲のお願い】${c.title}`, `${this.pname(as)}さんが代わりに決裁しました。戻られたら内容を確かめてください。`, c);
    }
    this.advance(c, c.current);
    return c;
  }

  // 合議: 役職ごとに1票
  settleCouncil(c, s) {
    const byRole = s.members.map(role => {
      if (s.branchReturns?.[role]) return null;
      const vs = this.holders(role).filter(p => p !== c.applicant).map(p => s.votes[p]).filter(Boolean);
      return vs.includes('reject') ? 'reject' : vs.includes('approve') ? 'approve' : null;
    });
    const n = byRole.length, yes = byRole.filter(v => v === 'approve').length, no = byRole.filter(v => v === 'reject').length;
    let result = null;
    if (s.rule === 'all') result = no > 0 ? 'reject' : yes === n ? 'approve' : null;
    if (s.rule === 'any') result = yes > 0 ? 'approve' : no === n ? 'reject' : null;
    if (s.rule === 'majority') result = yes > n / 2 ? 'approve' : no >= n / 2 ? 'reject' : null;
    if (result === 'approve' && s.gather) return this.finishGather(c, s, false);
    if (result === 'approve') { s.state = 'done'; this.log(c, 'system', 'councilPassed', s, { yes, no, n }, s.kind === 'parallel' ? `${s.label}: 全員の確認がそろいました(${yes}/${n})` : `合議で可決しました(賛成${yes}・反対${no}/${n})`); this.advance(c, c.current); }
    else if (result === 'reject') {
      c.status = 'rejected'; s.state = 'rejected';
      this.log(c, 'system', 'councilRejected', s, { yes, no, n, reason: s.lastRejectReason || '' }, `合議で否決しました(賛成${yes}・反対${no}/${n})。案件は終わりです`);
      this.notify([c.applicant], `【否決】${c.title}`, s.hideRejectReason ? '否決となりました。' : `否決となりました。理由: ${s.lastRejectReason || ''}`, c);
    }
    return c;
  }

  // ---------- 呼びかけて集める(まとめ買い) ----------
  // 呼びかけ先の課の担当が、希望の数を返す(0=不要)。返すことは承認ではない
  answer(c, s, as, fields, note) {
    if (!s?.gather) fail('この箱は希望を集める箱ではありません');
    const roles = this.branchOf(s, as).filter(r => !s.answers[r]);
    if (!roles.length) fail('この課はもう返事をしています');
    const raw = fields?.[s.gather.key || 'qty'];
    const qty = raw === undefined || raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(qty) || qty < 0) fail('希望の数は0以上の整数で入れてください(0は不要)');
    const unit = c.fields.unit || '個';
    for (const r of roles) { s.answers[r] = { qty, by: as, byName: this.pname(as), at: this.now(), note: note || '' }; s.votes[as] = 'approve'; }
    const names = roles.map(r => this.unitName(this.role(r)?.unit)).join('・');
    this.log(c, as, 'answer', s, { qty, roles }, `${this.pname(as)}さん(${names})が希望を返しました: ${qty ? `${qty}${unit}` : '不要(0)'}${note ? `。${note}` : ''}`);
    this.notify([c.applicant], `【希望の返事】${c.title}`, `${names}: ${qty ? `${qty}${unit}` : '不要'}`, c);
    return this.settleCouncil(c, s);
  }
  // そろった(または締切を過ぎた)ら合計し、合計額で決裁者を決める。返事のない課は「申し込みなし」(承認したことにはしない)
  finishGather(c, s, byDeadline) {
    const unit = c.fields.unit || '個';
    const lanes = s.members.map(r => {
      const a = s.answers[r];
      return { role: r, unitName: this.unitName(this.role(r)?.unit), people: this.holders(r), qty: a ? a.qty : 0, answered: !!a, by: a?.byName || null };
    });
    const none = lanes.filter(l => !l.answered);
    for (const l of none) s.answers[l.role] = { qty: 0, none: true, at: this.now() };
    if (none.length) this.log(c, 'system', 'noReply', s, { roles: none.map(l => l.role) }, `締切までに返事がなかったため「申し込みなし」としました(承認ではありません): ${none.map(l => l.unitName).join('・')}`);
    const totalQty = lanes.reduce((n, l) => n + l.qty, 0);
    const price = Number(c.fields.unitPrice);
    const amount = Number.isFinite(price) && price > 0 ? totalQty * price : Number(c.fields.amount || 0);
    c.fields = { ...c.fields, totalQty, amount };
    c.gathered = { lanes, totalQty, amount, at: this.now(), byDeadline };
    s.state = 'done';
    this.log(c, 'system', 'gathered', s, { totalQty, amount }, `${s.label}: 集計しました。${lanes.map(l => `${l.unitName} ${l.answered ? `${l.qty}${unit}` : '申し込みなし'}`).join('・')}。合計 ${totalQty}${unit}、金額 ${yen(amount)}`);
    if (!totalQty) {
      for (const x of c.steps.slice(c.current + 1)) x.state = 'skipped';
      this.log(c, 'system', 'gatherEmpty', s, {}, '申し込みがなかったため、購入せずに終わります');
      this.advance(c, c.steps.length - 1);
      return c;
    }
    // 仮の決裁の箱を、合計額で金額マスターから選んだ決裁者に置きかえる
    const i = c.steps.findIndex(x => x.pendingTotal);
    if (i >= 0) {
      const ph = c.steps[i];
      const tpl = this.template(c.templateId);
      const table = this.amountTableFor(tpl, ymd(c.createdAt));
      const row = this.pickAmountRow(table.rows, amount);
      const made = row.approvers.map((r, k) => {
        const role = this.resolveRole(r, c.applicant);
        return { ...ph, id: `${ph.rawId}-${k + 1}`, role, label: `${this.roleName(role)}の決裁`, pendingTotal: false, state: 'waiting', flags: [], requiredDocs: k === 0 ? ph.requiredDocs : [] };
      });
      c.steps.splice(i, 1, ...made);
      this.log(c, 'system', 'amountRoute', s, { amount }, made.length
        ? `金額マスター(第${table.version}版)により合計 ${yen(amount)} は ${made.map(x => this.roleName(x.role)).join('→')} の決裁`
        : `金額マスター(第${table.version}版)により合計 ${yen(amount)} は決裁なし`);
      c.signature = this.routeSignature(c.steps);
    }
    this.advance(c, c.current);
    return c;
  }

  // チャット型: 承認・差し戻し・否決・引き戻しを、会話の流れにも1行残す(消せない・直せない)
  chatNote(c, s, as, kind, text) {
    if (c.style !== 'chat' || !s) return;
    c.chat = c.chat || [];
    c.chat.push({ id: `M${c.chat.length + 1}`, at: this.now(), by: as, byName: this.pname(as), stepId: s.id, stepLabel: s.label, kind, text });
  }

  // ---------- チャット型 ----------
  // 箱ごとのチャット。起案者と今の箱の担当が相談する。正式な差し戻しにはしない。中身は記録(history)にも残す
  chat(c, s, as, text) {
    if (c.style !== 'chat') fail('この案件はチャット型ではありません');
    if (!['in_progress', 'returned'].includes(c.status) || !s) fail('進行中か差し戻し中の案件だけチャットできます');
    text = String(text || '').trim();
    if (!text) fail('チャットの文を入れてください');
    if (text.length > 1000) fail('チャットの文は1000文字までです');
    const m = { id: `M${c.chat.length + 1}`, at: this.now(), by: as, byName: this.pname(as), stepId: s.id, stepLabel: s.label, kind: 'message', text };
    c.chat.push(m);
    this.log(c, as, 'chat', s, { message: m.id }, `チャット(${s.label}) ${this.pname(as)}: ${text}`);
    const others = as === c.applicant ? this.baseAssignees(c, s) : [c.applicant];
    this.notify(others.filter(p => p !== as), `【チャット】${c.title}`, `${this.pname(as)}さん(${s.label}): ${text}`, c);
    return c;
  }
  // 起案者がチャットの中で内容(品物・金額など)を直す。ルートが変わる直しはできない(起案し直す)。版を残す
  revise(c, s, as, fields, note) {
    if (c.style !== 'chat') fail('この案件はチャット型ではありません');
    if (as !== c.applicant) fail('内容を直せるのは起案者だけです', 403);
    if (c.status !== 'in_progress' || !s) fail('進行中の案件だけ直せます');
    if (!fields || !Object.keys(fields).length) fail('直す内容を入れてください');
    const next = { ...c.fields, ...fields };
    const tpl = this.template(c.templateId);
    const route = this.buildRoute(tpl, c.applicant, next, ymd(c.createdAt));
    if (this.routeSignature(route.steps) !== c.signature) fail('直した内容でルートが変わります(金額の段や種類が変わるため)。「起案し直す」で起案箱から出し直してください', 400, 'reroute');
    const changes = Object.keys(fields).filter(k => String(c.fields?.[k] ?? '') !== String(fields[k] ?? ''));
    if (!changes.length) fail('前と同じ内容です');
    const label = k => ({ amount: '金額', title: '件名', item: '品物', reason: '理由' }[k] || k);
    const show = (k, v) => k === 'amount' && v !== '' && v != null ? yen(v) : String(v ?? '(なし)');
    const diff = changes.map(k => `${label(k)}: ${show(k, c.fields?.[k])} → ${show(k, fields[k])}`).join('、');
    const version = c.revisions.length + 2; // 第1版は起案したとき
    c.revisions.push({ version, at: this.now(), by: as, stepId: s.id, before: { ...c.fields }, after: next, changes });
    c.fields = next;
    if (fields.title) c.title = fields.title;
    const text = `内容を直しました(第${version}版): ${diff}${note ? `。${note}` : ''}`;
    c.chat.push({ id: `M${c.chat.length + 1}`, at: this.now(), by: as, byName: this.pname(as), stepId: s.id, stepLabel: s.label, kind: 'revise', version, text });
    this.log(c, as, 'revise', s, { version, changes }, `${this.pname(as)}さんがチャットの中で${text}`);
    this.notify(this.baseAssignees(c, s), `【内容の直し】${c.title}`, `${this.pname(as)}さんが${text}`, c);
    return c;
  }

  // それまでに承認した人(idx より前の箱で承認・賛成した人)。申請者本人は除く
  approversBefore(c, idx) {
    const ids = new Set(c.steps.slice(0, idx).map(x => x.id));
    const people = c.history.filter(h => ids.has(h.stepId) && (h.action === 'approve' || (h.action === 'vote' && h.vote === 'approve')) && h.actor !== 'system' && h.actor !== c.applicant).map(h => h.actor);
    return [...new Set(people)];
  }
  // 承認済みの人へCCで知らせ、知らせたことを記録に残す
  ccApprovers(c, idx, subject, body, why) {
    const to = this.approversBefore(c, idx);
    if (!to.length) return [];
    this.notify(to, subject, body, c, { cc: true });
    this.log(c, 'system', 'cc', c.steps[idx] || null, { to, why }, `${why}: 承認済みの${to.map(p => this.pname(p)).join('・')}さんにCCで知らせました`);
    return to;
  }

  // 差し戻し。to: applicant(申請者へ)/ previous(一つ前の箱へ)。
  // shortcut(軽微な修正、既定 true): 申請者が直すと、通過済みの段を飛ばして差し戻した箱へ直接戻る。飛ばした段の人には必ずCCで知らせる
  returnCase(c, s, as, reason, { via = 'web', to = 'applicant', shortcut = true } = {}) {
    if (s.kind === 'parallel' && to !== 'previous') return this.returnBranch(c, s, as, reason, via);
    if (isGroup(s)) s.votes = {};
    const viaText = via === 'mail' ? '(メールで)' : '';
    if (to === 'previous') {
      let j = c.current - 1;
      while (j >= 0 && c.steps[j].state === 'skipped') j--;
      if (j < 0) fail('一つ前の箱がありません');
      s.state = 'waiting';
      c.steps[j].state = 'waiting';
      this.log(c, as, 'return', s, { reason, to, via }, `${this.pname(as)}さんが${c.steps[j].label}へ差し戻しました${viaText}。理由: ${reason}`);
      this.advance(c, j - 1);
      return c;
    }
    c.status = 'returned';
    c.returnedFrom = shortcut === false ? 0 : c.current;
    if (shortcut === false) for (const x of c.steps) if (x.state !== 'skipped') { x.state = 'waiting'; if (x.votes) x.votes = {}; }
    s.state = 'waiting';
    this.chatNote(c, s, as, 'return', `差し戻しました。理由: ${reason}`);
    this.log(c, as, 'return', s, { reason, to, shortcut: shortcut !== false, via }, `${this.pname(as)}さんが申請者へ差し戻しました${viaText}(${shortcut === false ? '出し直したら最初から' : '軽微な修正: 出し直したらこの箱へ直接戻る'})。理由: ${reason}`);
    const show = this.s.settings?.showReturnReason !== false;
    this.notify([c.applicant], `【差し戻し】${c.title}`, show ? `理由: ${reason}` : '差し戻されました。担当に確かめてください。', c);
    return c;
  }

  // 並行の入れ物: 申請者の課の人が属する枝(役職)
  branchOf(s, person) { return (s.members || []).filter(r => this.holders(r).includes(person)); }
  // 並行の入れ物の1つの枝だけ差し戻す。ほかの枝は止まらない(確認済みはそのまま、未確認は続けて確かめられる)
  returnBranch(c, s, as, reason, via = 'web') {
    const roles = this.branchOf(s, as).filter(r => !s.branchReturns[r]);
    for (const r of roles) {
      s.branchReturns[r] = { reason, by: as, byName: this.pname(as), at: this.now() };
      for (const p of this.holders(r)) delete s.votes[p];
    }
    const names = roles.map(r => this.roleName(r)).join('・');
    const viaText = via === 'mail' ? '(メールで)' : '';
    this.chatNote(c, s, as, 'return', `「${names}」の枝を差し戻しました。理由: ${reason}`);
    this.log(c, as, 'return', s, { reason, branch: roles, branchNames: names, via }, `${this.pname(as)}さんが${s.label}の「${names}」の枝を申請者へ差し戻しました${viaText}(ほかの枝はそのまま進みます)。理由: ${reason}`);
    const show = this.s.settings?.showReturnReason !== false;
    this.notify([c.applicant], `【差し戻し(${names})】${c.title}`, show ? `${names}の枝だけ差し戻されました。理由: ${reason}。直したら、その枝だけ出し直してください。` : `${names}の枝だけ差し戻されました。`, c);
    return c;
  }
  resubmitBranches(c, s, as) {
    const roles = Object.keys(s.branchReturns);
    s.branchReturns = {};
    const names = roles.map(r => this.roleName(r)).join('・');
    this.log(c, as, 'resubmit', s, { branch: roles, branchNames: names }, `${this.pname(as)}さんが直して「${names}」の枝だけ出し直しました`);
    this.notify(roles.flatMap(r => this.holders(r)), `【出し直し】${c.title}`, `${s.label}の${names}の枝が出し直されました。もう一度確かめてください。`, c);
    return this.settleCouncil(c, s);
  }

  reject(c, s, as, reason) {
    if (isGroup(s)) {
      s.votes[as] = 'reject'; s.lastRejectReason = reason;
      this.log(c, as, 'vote', s, { vote: 'reject', reason }, `${this.pname(as)}さんが合議で反対しました`);
      return this.settleCouncil(c, s);
    }
    c.status = 'rejected'; s.state = 'rejected';
    this.chatNote(c, s, as, 'reject', `否決しました。理由: ${reason}`);
    this.log(c, as, 'reject', s, { reason }, `${this.pname(as)}さんが否決しました。案件は終わりです。理由: ${reason}`);
    this.notify([c.applicant], `【否決】${c.title}`, s.hideRejectReason ? '否決となりました。' : `否決となりました。理由: ${reason}`, c);
    return c;
  }

  resubmit(c, as, fields) {
    const cur = c.steps[c.current];
    if (c.status === 'in_progress' && cur?.kind === 'parallel' && Object.keys(cur.branchReturns || {}).length) return this.resubmitBranches(c, cur, as);
    if (fields) {
      const tpl = this.template(c.templateId);
      const next = this.buildRoute(tpl, c.applicant, { ...c.fields, ...fields }, ymd(c.createdAt));
      if (this.routeSignature(next.steps) !== c.signature) fail('直した内容でルートが変わります(金額の段や種類が変わるため)。「起案し直す」で起案箱から出し直してください', 400, 'reroute');
      c.fields = { ...c.fields, ...fields };
    }
    c.status = 'in_progress';
    const back = c.returnedFrom;
    const wasWithdrawn = c.withdrawn;
    c.withdrawn = false;
    this.log(c, as, 'resubmit', c.steps[back], {}, `${this.pname(as)}さんが直して出し直しました(${c.steps[back]?.label}から)`);
    // 軽微な修正(または引き戻し)で通過済みの段を飛ばすとき、飛ばした段の人へCC
    if (back > 0) this.ccApprovers(c, back, `【CC: ${wasWithdrawn ? '申請者からの引き戻し後の出し直し' : '軽微な修正'}】${c.title}`,
      `${this.pname(as)}さんが直して出し直しました。あなたが承認した段は飛ばして「${c.steps[back]?.label}」へ直接戻ります。内容を確かめたいときは案件を開いてください。`, wasWithdrawn ? '引き戻し後の出し直し' : '軽微な修正');
    this.advance(c, back - 1);
    return c;
  }

  // 代理へ回す / 一つ上へ回す。人がボタンで押す。理由・本来の承認者・渡した先・押した人・日時を残す。
  handOver(c, s, as, reason, type) {
    const curRole = s.override?.toRole || s.role || (s.members || []).join('+');
    const rule = this.proxyRule(s.override?.toRole || s.role || s.members?.[0]);
    let toRole;
    if (type === 'delegate') {
      if (!s.allowProxy) fail('この箱は代理を認めていません。待つか、一つ上へ回してください');
      for (const px of rule.proxies || []) {
        const pr = typeof px === 'string' ? { role: px } : px;
        if (pr.maxAmount != null && Number(c.fields?.amount || 0) > pr.maxAmount) continue;
        if (this.holders(pr.role).some(p => p !== c.applicant && !this.isAbsent(p))) { toRole = pr.role; break; }
      }
      if (!toRole) fail('代理できる人がいません(代理も不在・申請者本人・金額の上限超え)。一つ上へ回してください');
    } else {
      toRole = rule.escalateTo;
      if (!toRole || !this.holders(toRole).length) fail('一つ上の役職が決められていません');
    }
    const toPeople = this.holders(toRole).filter(p => p !== c.applicant && !this.isAbsent(p));
    if (!toPeople.length) fail('渡す先の人がいません(不在か申請者本人)');
    const from = s.override ? s.override.to : (this.assign(c, s).absent || this.holders(s.role || s.members?.[0]) || []);
    const origLabel = s.label;
    const skipped = type === 'escalate' ? [{ step: origLabel, role: this.roleName(curRole), people: from.map(p => this.pname(p)) }] : [];
    s.override = { type, fromRole: curRole, from, toRole, to: toPeople, by: as, reason, at: this.now(), skipped };
    if (isGroup(s)) { s.kind = 'check'; s.role = toRole; }
    s.label = `${s.label.replace(/(.*)$/, '')}(${type === 'delegate' ? '代理' : '引き上げ'}: ${this.roleName(toRole)})`;
    s.enteredAt = this.now();
    this.log(c, as, type, s, {
      reason, fromRole: curRole, fromRoleName: this.roleName(curRole), from: from.map(p => this.pname(p)),
      toRole, toRoleName: this.roleName(toRole), to: toPeople.map(p => this.pname(p)), by: this.pname(as), skipped,
    }, `${this.pname(as)}さんが${type === 'delegate' ? '代理' : '一つ上'}へ回しました。本来の承認者: ${from.map(p => this.pname(p)).join('・') || this.roleName(curRole)}(${this.roleName(curRole)}) → 渡した先: ${toPeople.map(p => this.pname(p)).join('・')}(${this.roleName(toRole)})。理由: ${reason}${skipped.length ? `。飛ばした段: ${skipped.map(k => `${k.step}(${k.role}: ${k.people.join('・') || '担当なし'})`).join('、')}` : ''}`);
    this.notifyStep(c, s);
    return c;
  }

  // ---------- メール返信の受け取り口 ----------
  inboundMail({ from, token, body }) {
    if (!this.s.settings?.allowMailApproval) fail('メールでの承認は使わない設定です', 403);
    const t = this.s.mailTokens[token];
    if (!t || t.used) fail('番号が正しくないか、もう使われています', 403);
    if (t.person !== from) fail('差出人が担当の人ではありません', 403);
    const c = this.getCase(t.caseId);
    const s = c.steps[c.current];
    if (!s || s.id !== t.stepId || c.status !== 'in_progress') fail('この案件はもうこの段階にありません');
    if (s.kind === 'decision') fail('決裁はメールではできません', 403);
    const text = String(body || '').trim();
    if (text.startsWith('承認')) this.act(c.id, { as: from, action: 'approve', via: 'mail' });
    else if (MAIL_RETURN.test(text)) this.act(c.id, { as: from, action: 'return', reason: text.replace(MAIL_RETURN, '').replace(/^[\s:：]*/, '') || '(理由なし)', via: 'mail' });
    else fail('本文の最初に「承認」か「差し戻し」と書いてください');
    t.used = true;
    this.notify([from], `【受け付けました】${c.title}`, `メールでの「${text.slice(0, 4)}」を受け付けました。`, c);
    return c;
  }
  // 試作・筋書き用: その人あての、まだ使っていない番号
  tokenFor(caseId, person) {
    const c = this.getCase(caseId);
    const s = c.steps[c.current];
    return Object.entries(this.s.mailTokens).find(([, t]) => t.caseId === caseId && t.person === person && t.stepId === s?.id && !t.used)?.[0];
  }

  // ---------- 期限の知らせ(自動では承認しない・回さない) ----------
  tick() {
    for (const c of this.s.cases) {
      if (c.status !== 'in_progress' || !c.deadline) continue;
      const s = c.steps[c.current];
      if (!s) continue;
      if (s.gather && this.today() > c.deadline) { this.finishGather(c, s, true); continue; }
      const left = Math.round((new Date(`${c.deadline}T00:00:00+09:00`).getTime() - new Date(`${this.today()}T00:00:00+09:00`).getTime()) / DAY);
      const key = left < 0 ? `${s.id}:over` : s.id;
      if ((left <= s.switchDaysBefore) && !c.alerts[key]) {
        c.alerts[key] = this.now();
        const to = [...this.receptionHolders(c), ...this.admins()];
        const msg = left < 0 ? `締切を${-left}日過ぎています` : `締切まであと${left}日です`;
        this.notify(to, `【締切】${c.title}`, `${msg}。「${s.label}」で止まっています。必要なら代理か一つ上へ回してください(自動では回しません)。`, c);
        this.log(c, 'system', 'deadlineAlert', s, { daysLeft: left }, `${msg}。受付と事務局に知らせました(自動では通しません)`);
      }
    }
  }

  // ---------- 見る人に合わせて見せる ----------
  view(c, as) {
    const insider = this.isAdmin(as) || c.steps.some(s => this.holders(s.role).includes(as) || (s.members || []).some(r => this.holders(r).includes(as)) || (s.collect || []).some(cc => this.holders(cc.role).includes(as)) || s.override?.to?.includes(as));
    const applicantOnly = as === c.applicant && !insider;
    const outsider = !insider && as !== c.applicant;
    if (outsider) fail('この案件を見る権限がありません', 403);
    const cur = c.steps[c.current];
    const showReturn = this.s.settings?.showReturnReason !== false;
    let history = c.history;
    if (applicantOnly) {
      history = c.history.filter(h => !['vote', 'memo'].includes(h.action) || (h.action === 'memo' && h.visibility === 'public')).map(h => {
        const step = c.steps.find(s => s.id === h.stepId);
        const out = { at: h.at, action: h.action, stepLabel: h.stepLabel, actorName: h.actorName };
        if (h.action === 'return' && showReturn) out.reason = h.reason;
        if ((h.action === 'reject' || h.action === 'councilRejected') && !step?.hideRejectReason) out.reason = h.reason;
        if (h.action === 'memo') out.memo = h.memo;
        out.text = this.applicantText(h, step, showReturn);
        return out;
      });
    }
    const after = c.steps.slice(c.current + 1).find(s => s.state !== 'skipped' && s.state !== 'done');
    return {
      id: c.id, docNo: c.docNo, redraftedFromDocNo: c.redraftedFromDocNo, redraftedToDocNo: c.redraftedToDocNo, late: c.late || null, createdOn: ymd(c.createdAt), title: c.title, templateId: c.templateId, templateName: c.templateName, caseTypeId: c.caseTypeId, caseTypeName: c.caseTypeName, purpose: c.purpose, redraftedTo: c.redraftedTo, redraftedFrom: c.redraftedFrom, status: c.status,
      fields: c.fields, deadline: c.deadline, applicant: this.personBrief(c.applicant),
      steps: c.steps.map(s => ({
        id: s.id, label: s.label, kind: s.kind, box: s.kind === 'check' || s.kind === 'decision' ? 'approval' : s.kind, mark: s.kind === 'decision' ? 'decision' : s.kind === 'check' ? 'confirm' : undefined, state: s.state, flags: s.flags,
        assignees: this.baseAssignees(c, s).map(p => this.personBrief(p)),
        ...(s.kind === 'parallel' ? { branches: this.branchView(c, s, applicantOnly, showReturn) } : {}),
        ...(applicantOnly ? {} : { votes: s.votes ? Object.fromEntries(Object.entries(s.votes).map(([p, v]) => [this.pname(p), v])) : undefined, rule: s.rule, override: s.override }),
      })),
      currentStepId: cur?.id || null, currentStepLabel: cur?.label || null,
      nextStepLabel: c.status === 'in_progress' ? (after?.label || '完了') : null,
      stalledDays: cur?.enteredAt && c.status === 'in_progress' ? Math.floor((this.now() - cur.enteredAt) / DAY) : 0,
      docs: c.docs.map(d => ({ ...d, docNo: c.docNo, addedByName: this.pname(d.addedBy), stepLabel: d.step === 'applicant' ? '申請時' : d.step === 'sim' ? '試し運行' : c.steps.find(x => x.id === d.step)?.label || '' })),
      missingDocs: c.current < c.steps.length ? this.missingDocs(c, c.current) : [],
      history, logIntact: this.verifyLog(c).ok,
      gathered: c.gathered ? { totalQty: c.gathered.totalQty, amount: c.gathered.amount, lanes: c.gathered.lanes.map(l => ({ unitName: l.unitName, qty: l.qty, answered: l.answered, by: l.by })) } : null,
      answers: (() => { const g = c.steps.find(x => x.gather); return g ? g.members.map(r => ({ unitName: this.unitName(this.role(r)?.unit), ...(g.answers[r] ? { qty: g.answers[r].qty, by: g.answers[r].byName || null, none: !!g.answers[r].none } : { waiting: true }) })) : null; })(),
      style: c.style || 'normal', chat: (c.chat || []).map(m => ({ ...m })), revisions: (c.revisions || []).map(r => ({ version: r.version, at: r.at, byName: this.pname(r.by), changes: r.changes, before: r.before, after: r.after })),
      postReviews: applicantOnly ? [] : c.postReviews,
      canAct: this.canAct(c, as),
    };
  }
  // 並行の入れ物の枝ごとの様子(レーン表示用)。state: waiting(まだ) / current(確かめ中) / done(確認済み) / returned(差し戻し中)
  branchView(c, s, applicantOnly, showReturn) {
    const active = c.status === 'in_progress' && c.steps[c.current] === s;
    return (s.members || []).map(role => {
      const people = this.holders(role).filter(p => p !== c.applicant);
      const ret = s.branchReturns?.[role];
      const doneBy = people.filter(p => s.votes?.[p] === 'approve');
      const state = s.state === 'done' || doneBy.length ? 'done' : ret ? 'returned' : active ? 'current' : 'waiting';
      const label = { waiting: 'まだ', current: '確かめ中', done: '確認済み', returned: '差し戻し中' }[state];
      return { role, name: this.roleName(role), people: people.map(p => this.personBrief(p)), state, stateLabel: label,
        doneBy: doneBy.map(p => this.pname(p)), ...(ret ? { returnedBy: ret.byName, reason: applicantOnly && !showReturn ? undefined : ret.reason } : {}) };
    });
  }
  applicantText(h, step, showReturn) {
    switch (h.action) {
      case 'return': { const w = h.auto ? '自動チェックで戻されました(決裁者には回っていません)' : '差し戻されました'; return showReturn || h.auto ? `${w}。理由: ${h.reason}` : w; }
      case 'reject': case 'councilRejected': return step?.hideRejectReason ? '否決となりました' : `否決となりました。理由: ${h.reason || ''}`;
      case 'councilPassed': return `${h.stepLabel}で可決しました`;
      case 'memo': return `メモ: ${h.memo}`;
      default: return h.text;
    }
  }

  list(as, view = 'mine', q = '') {
    this.tick();
    let cs = this.s.cases.filter(c => this.matches(c, q));
    if (view === 'mine') cs = cs.filter(c => c.applicant === as);
    else if (view === 'todo') cs = cs.filter(c => c.applicant !== as && this.canAct(c, as).some(a => ['approve', 'markOrdered', 'markDelivered', 'markSubmitted', 'postReview', 'delegate', 'escalate', 'addDoc'].includes(a)));
    else if (view === 'all') { if (!this.isAdmin(as)) fail('管理の一覧は事務局の人だけが見られます', 403); }
    return cs.map(c => this.view(c, as)).sort((a, b) => b.stalledDays - a.stalledDays);
  }
}

// ---------- 試し運行(シミュレーション) ----------
export function simulate(state, tpl) {
  const items = [];
  const BOX_JA = { draft: '起案箱', reception: '受付箱', input: '入力欄の箱', approval: '承認箱', check: '承認箱(確認)', decision: '承認箱(決裁)', council: '合議箱', notify: '通知箱', parallel: '並行の入れ物' };
  // 結果の行が指す箱。stepId は型の箱のid(金額マスターで増えた決裁は元の承認箱へ)。'end' は終わり方
  const targetOf = id => {
    if (!id) return null;
    if (id === 'end') { const x = expandTemplate(tpl).steps.find(z => z.id === 'end'); return { stepId: 'end', target: `終わり方(${x?.label || '終わり方'})` }; }
    const src = tpl.steps || [];
    let i = src.findIndex(z => z.id === id);
    if (i < 0) { const base = String(id).replace(/-\d+$/, ''); i = src.findIndex(z => z.id === base); }
    if (i < 0) return id === 'draft' ? { stepId: 'draft', target: '起案箱' } : null;
    const z = src[i];
    const box = BOX_JA[z.kind === 'approval' ? (z.mark === 'decision' ? 'decision' : 'check') : z.kind] || '箱';
    return { stepId: z.id, target: z.label && z.kind !== 'draft' ? `「${z.label}」(${box})` : box };
  };
  const add = (level, message, stepId) => {
    if (items.some(x => x.level === level && x.message === message)) return;
    items.push({ level, message, ...(targetOf(stepId) || {}) });
  };
  const base = structuredClone(state);
  base.templates = base.templates.filter(t => t.id !== tpl.id).concat([tpl]);
  base.cases = []; base.outbox = []; base.mailTokens = {}; base.absences = [];
  const eng0 = new Engine(base);
  const units = [...new Set(base.people.map(p => p.unit))];
  const samples = units.map(u => base.people.find(p => p.unit === u && eng0.rolesOf(p.id).some(r => r.endsWith('-kakariin'))) || base.people.find(p => p.unit === u)).filter(Boolean);
  const needsUnit = JSON.stringify(tpl).includes('{unit}');
  const staff = samples.filter(p => eng0.rolesOf(p.id).some(r => r.endsWith('-kakariin')));
  const applicants = needsUnit ? samples.filter(p => eng0.holders(`${p.unit}-kacho`).length) : (staff.length ? staff : samples).slice(0, 1);
  if (!applicants.length) add('error', '試しに申請する人が見つかりません');
  const xsteps = expandTemplate(tpl).steps;
  (tpl.steps || []).forEach(s => {
    if (!KINDS.has(s.kind) && !USER_KINDS.includes(s.kind)) { add('error', '知らない種類の箱が入っています。消して置き直してください', s.id); return; }
    const needsRole = s.kind === 'reception' || s.kind === 'check' || (s.kind === 'approval' && !(s.mark === 'decision' && s.fromAmountTable)) || (s.kind === 'decision' && !s.fromAmountTable);
    if (needsRole && !s.role) add('error', '担当の役職が選ばれていません', s.id);
    if ((s.kind === 'council' || s.kind === 'parallel') && !(s.members || []).length) add('error', s.kind === 'parallel' ? '並行の入れ物に、分かれて確かめる課(役職)が1つもありません' : '合議箱のメンバーがいません', s.id);
    if (s.kind === 'parallel' && (s.members || []).length === 1) add('warn', '並行の入れ物の中が1つだけです。普通の承認箱と同じ動きになります', s.id);
    if (s.kind === 'notify' && !(s.roles || []).length) add('warn', '通知箱の知らせる相手がいません', s.id);
  });
  if (!xsteps.length) add('error', '箱が1つもありません');
  if ((tpl.steps || []).some((s, i) => s.kind === 'draft' && i !== 0)) add('error', '起案箱は先頭に置いてください');
  if (xsteps[1]?.kind !== 'reception') add('error', '起案箱のすぐ後に受付箱を置いてください(書類の不備を確かめる人がいません)', 'draft');
  const endStep = xsteps.find(s => s.id === 'end');
  if (endStep && !xsteps.some(s => s.kind === 'reception')) add('error', `${endStep.label}は受付箱の担当が受け持ちます。受付箱がないため、担当が決まりません`, 'end');
  if (xsteps.filter(s => s.kind === 'reception').length > 1) add('warn', '受付箱が2つ以上あります', xsteps.find(s => s.kind === 'reception')?.id);
  xsteps.filter(s => s.kind === 'council').forEach(s => {
    if (s.rule === 'majority' && (s.members || []).length % 2 === 0) add('warn', '過半数の合議でメンバーが偶数です。同数のときは否決になります', s.id);
  });
  const table = eng0.amountTableFor(tpl, eng0.today());
  const usesTable = xsteps.some(s => s.kind === 'decision' && s.fromAmountTable);
  if (usesTable && !table.rows.length) add('error', '金額マスターがありません');
  const amounts = [];
  if (usesTable) for (const r of table.rows) if (r.upTo != null) amounts.push(r.upTo - 1, r.upTo, r.upTo + 1);
  if (!amounts.length) amounts.push(100000);

  const runOnce = (applicant, amount, mode) => {
    const st = structuredClone(base);
    let t = Date.now();
    const eng = new Engine(st, { now: () => t });
    const c = eng.createCase({ as: applicant.id, templateId: tpl.id, title: '試し運行', fields: { amount }, deadline: tpl.deadline?.required ? ymd(t + 30 * DAY) : undefined });
    let guard = 0, returned = false;
    while (c.status === 'in_progress' && guard++ < 60) {
      const s = c.steps[c.current];
      const who = eng.baseAssignees(c, s);
      if (!who.length) return { stuck: s, c };
      for (const n of eng.missingDocs(c, c.current)) eng._addDoc(c, applicant.id, n, 'sim');
      if (s.state === 'blocked') s.state = 'current';
      const p = who[0];
      if (s.gather) { for (const q of who) if (c.steps[c.current] === s && !s.votes[q]) eng.act(c.id, { as: q, action: 'answer', fields: { [s.gather.key || 'qty']: 1 } }); if (c.steps[c.current] === s) eng.finishGather(c, s, true); continue; }
      if (s.kind === 'order') { eng.act(c.id, { as: p, action: 'markOrdered' }); eng.act(c.id, { as: p, action: 'markDelivered' }); continue; }
      if (s.kind === 'submit') { eng._addDoc(c, p, s.receiptDoc, s.id); eng.act(c.id, { as: p, action: 'markSubmitted' }); continue; }
      if (mode === 'return' && !returned && s.kind !== 'reception' && s.kind !== 'parallel') {
        eng.act(c.id, { as: p, action: 'return', reason: '試し' });
        returned = true;
        const at = c.returnedFrom;
        eng.act(c.id, { as: applicant.id, action: 'resubmit' });
        if (c.current !== at) return { badReentry: true, c };
        continue;
      }
      if (mode === 'reject' && s.kind !== 'reception' && s.kind !== 'parallel') { if (isGroup(s)) { for (const q of who) if (c.status === 'in_progress') eng.act(c.id, { as: q, action: 'reject', reason: '試し' }); } else eng.act(c.id, { as: p, action: 'reject', reason: '試し' }); break; }
      if (isGroup(s)) { for (const q of who) if (c.status === 'in_progress' && c.steps[c.current] === s && !s.votes[q]) eng.act(c.id, { as: q, action: 'approve' }); continue; }
      eng.act(c.id, { as: p, action: 'approve', twoFA: s.kind === 'decision' });
      t += DAY;
    }
    return { c, eng };
  };

  const seenStuck = new Set();
  for (const ap of applicants) {
    for (const amt of [...new Set(amounts)]) {
      let r;
      try { r = runOnce(ap, amt, 'normal'); } catch (e) { add('error', `${ap.name}さんの申請(${yen(amt)})で止まりました: ${e.message}`); continue; }
      if (r.stuck) {
        const key = `${r.stuck.id}:${r.stuck.role}`;
        if (!seenStuck.has(key)) {
          seenStuck.add(key);
          const id = r.stuck.id === 'end' ? 'end' : r.stuck.id;
          if (id === 'end' && !r.stuck.role) { /* 上で「受付箱がない」と出している */ }
          else if (isGroup(r.stuck)) add('error', `「${r.stuck.label}」に、確かめる人が1人もいません(${(r.stuck.members || []).map(m => eng0.roleName(m)).join('・') || '課が未設定'})。役職と人の表を確かめてください`, id);
          else add('error', `「${r.stuck.label}」の担当が0人です(役職: ${eng0.roleName(r.stuck.role)})。役職と人の表を確かめてください`, id);
        }
        continue;
      }
      if (r.c.status !== 'completed') add('error', `完了まで届きませんでした(${{ returned: '差し戻しのまま', rejected: '否決で終わった', withdrawn: '取り下げ' }[r.c.status] || '途中で止まった'}・「${r.c.steps[r.c.current]?.label || '最後'}」)`, r.c.steps[r.c.current]?.id);
      else if (ap === applicants[0] && usesTable) {
        const decs = r.c.steps.filter(s => s.kind === 'decision').map(s => s.label);
        add('ok', `${yen(amt)} → ${decs.length ? decs.join(' → ') : '受付だけで完了(決裁なし)'}`);
      }
    }
  }
  if (applicants[0]) {
    try {
      const amt = amounts[amounts.length - 1];
      const r1 = runOnce(applicants[0], amt, 'return');
      if (r1.badReentry) add('error', '差し戻しのあと、差し戻した箱へ直接戻りませんでした');
      else if (r1.c.steps.some(s => s.kind !== 'reception')) add('ok', '軽微な修正: 差し戻し → 直して出し直し → 差し戻した箱へ直接戻る(飛ばした段の人へCC)');
      const r2 = runOnce(applicants[0], amt, 'reject');
      if (r2.c.status === 'rejected') add('ok', '否決すると、その案件はそこで終わる');
      else if (r2.c.steps.some(s => s.kind !== 'reception' && s.kind !== 'order')) add('error', '否決しても終わりませんでした');
    } catch (e) { add('error', `差し戻し・否決の試しで止まりました: ${e.message}`); }
  }
  for (const s of xsteps.filter(x => x.kind === 'decision')) {
    const roles = s.fromAmountTable ? [...new Set(table.rows.flatMap(r => r.approvers))] : [s.role];
    for (const rt of roles) {
      const role = applicants[0] ? eng0.resolveRole(rt, applicants[0].id) : rt;
      const rule = eng0.proxyRule(role);
      const hasProxy = (rule.proxies || []).some(r => eng0.holders(typeof r === 'string' ? r : r.role).length);
      if (s.allowProxy === false) add('ok', `${eng0.roleName(role)}の決裁は代理を認めない。不在なら戻るまで待つか、受付・事務局が一つ上へ回す`, s.id);
      else if (!hasProxy && !rule.escalateTo) add('warn', `${eng0.roleName(role)}が不在のとき、代理も一つ上も決まっていません。止まったままになります`, s.id);
      else if (!hasProxy) add('ok', `${eng0.roleName(role)}が不在のとき: 代理はいないので、受付・事務局のボタンで${eng0.roleName(rule.escalateTo)}へ引き上げ`, s.id);
      else add('ok', `${eng0.roleName(role)}が予定不在のとき: 代理が処理し、戻ったら後閲`, s.id);
    }
  }
  xsteps.forEach((s, i) => {
    for (const d of s.requiredDocs || []) {
      if (xsteps.slice(i + 1).some(x => (x.collect || []).some(cc => cc.doc === d))) add('error', `「${d}」は${s.label}で必要なのに、集めるのはその後の箱です`, s.id);
    }
  });
  if (!items.some(i => i.level === 'error')) add('ok', 'すべての箱に届き、完了まで進みました');
  const errors = items.filter(i => i.level === 'error').length;
  return { ok: !errors, canSave: !errors, errors, warnings: items.filter(i => i.level === 'warn').length, items };
}
