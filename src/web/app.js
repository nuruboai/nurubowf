const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const e = escapeHtml;
const clone = (value) => structuredClone(value);
const words = (value) => String(value ?? '').split(/[\n,、]/).map((item) => item.trim()).filter(Boolean);
const list = (value, ...keys) => Array.isArray(value) ? value : keys.map((key) => value?.[key]).find(Array.isArray) ?? [];
const kinds = {
  draft: { label: '起案箱', description: '案件の種類・件名・目的が入る出発点。どのルートでも先頭に1つ' },
  reception: { label: '受付箱', description: '書類を受け付け、取りまとめる' },
  input: { label: '入力欄', description: '申請者が書く項目を決める' },
  approval: { label: '承認箱', description: '確認か決裁の印を選ぶ' },
  council: { label: '合議箱', description: '委員会など、複数人で1つの判定をする' },
  notify: { label: '通知', description: '知らせて、次へ進む' },
  parallel: { label: '並行の入れ物', description: '複数の課が同時に確かめる。全員そろうまで進まない' },
};
const endingLabels = { none: 'なし', order: '発注メモ→納品で完了', submit: '控えを添付して提出済み' };
const statuses = { in_progress: '進行中', returned: '差し戻し中', rejected: '否決で終了', withdrawn: '取り下げ', completed: '完了' };
const stepStates = { done: '済み', current: '今', waiting: 'これから', skipped: '省略' };
const actions = {
  approve: '承認する', return: '差し戻す', reject: '否決する', withdraw: '引き戻す',
  addDoc: '書類を追加', delegate: '代理へ回す', escalate: '一つ上へ回す',
  postReview: '後閲する', resubmit: '直して出し直す', redraft: '起案し直す', cancel: '取り下げる', memo: 'メモを残す', markOrdered: '発注メモを残す', markDelivered: '納品済みにする', markSubmitted: '提出済みにする',
  chat: '相談を送りました', revise: '内容を直す', answer: '希望の数を返す',
};
const reasonActions = new Set(['return', 'reject', 'delegate', 'escalate']);
const state = {
  ready: false, busy: false, org: { people: [], roles: [], units: [], settings: {} }, actor: '', mode: 'use', tab: 'apply',
  templates: [], draft: null, dirty: false, selectedStep: '', simulation: null, dirtySteps: new Set(), saveMessage: '',
  cases: [], selectedCase: null, outbox: [], applyCaseType: '', applyValues: {}, applyTitle: '', applyPurpose: '', applyDocs: '',
  caseQueries: { mine: '', todo: '', admin: '' }, caseSearchDrafts: { mine: '', todo: '', admin: '' },
  caseTypes: [], caseTypesDraft: [], caseTypesDirty: false, caseTypesError: '',
  settingsDraft: null, settingsDirty: false, settingsError: '', absenceDraft: { person: '', from: '', to: '', reason: '' },
  mail: { from: '', token: '', body: '承認' },
};
const temporarilyDisabled = new Set();
let dialogContext = null;

const kindIcons = {
  draft: 'images/draft.svg',
  reception: 'images/reception.svg', check: 'images/approval-confirm.svg', decision: 'images/approval-decide.svg',
  input: 'images/input.svg', council: 'images/committee.svg', parallel: 'images/parallel.svg', notify: 'images/notify.svg',
  order: 'icons/order.svg', submit: 'icons/submit.svg',
};
function boxKind(step) {
  if (step.box) return step.box;
  return ['check', 'decision'].includes(step.kind) ? 'approval' : step.kind;
}

function approvalMark(step) {
  return step.mark ?? (step.kind === 'decision' ? 'decision' : 'confirm');
}

function icon(step) {
  const box = typeof step === 'string' ? step : boxKind(step);
  const kind = box === 'approval' ? (approvalMark(step) === 'decision' ? 'decision' : 'check') : box;
  return kindIcons[kind] ? `<img class="kind-icon" src="${kindIcons[kind]}" width="56" height="56" alt="">` : '<span class="kind-icon" aria-hidden="true">□</span>';
}

function option(value, text, selected) {
  return `<option value="${e(value)}"${String(value) === String(selected) ? ' selected' : ''}>${e(text)}</option>`;
}

function roleName(id) {
  if (!id) return '担当の指定なし';
  return roleChoices().find((item) => item.id === id)?.name ?? '役職を選び直してください';
}

function personName(value) {
  if (!value) return '—';
  if (value === 'system') return '仕組み';
  if (typeof value === 'object') return value.name ?? personName(value.id);
  return state.org.people.find((person) => person.id === value || person.name === value)?.name ?? '名前の登録なし';
}

// 2026-11-12 決定: 使う・作るはセットで、基本は全員が両方使える。人ごとの「作る権限」フラグはあるが、試作ではまだ制限に使わない。
function canBuild() {
  return state.org.people.some((person) => person.id === state.actor);
}

function isAdminActor() {
  return (state.org.admins ?? []).includes(state.actor);
}

// 課の管理者(課で一番上の役職の人)か事務局の人だけが、その課の人の作る権限を切り替えられる
function canManageUnit(unitId) {
  return isAdminActor() || (state.org.unitManagers?.[unitId] ?? []).includes(state.actor);
}

function workspaceTabs() {
  return state.mode === 'build' ? ['builder', 'settings', ...(isAdminActor() ? ['admin'] : [])] : ['apply', 'mine', 'todo'];
}

function updateWorkspace() {
  if (!canBuild()) state.mode = 'use';
  if (!workspaceTabs().includes(state.tab)) state.tab = workspaceTabs()[0];
  document.body.dataset.mode = state.mode;
  $('#workspace-title').textContent = state.mode === 'build' ? 'ワークフローを作る' : 'ワークフローを使う';
  const me = state.org.people.find((person) => person.id === state.actor);
  const meUnit = me ? (state.org.units ?? []).find((unit) => unit.id === me.unit)?.name : '';
  if ($('#current-person')) $('#current-person').textContent = me ? `いまの人：${me.name}${meUnit ? `（${meUnit}）` : ''}` : '';
  // 使う・作るの切り替えは全員に出す(作る権限のフラグでの制限はまだかけない)
  $('.mode-switch').hidden = !canBuild();
  $$('.mode-switch button').forEach((button) => {
    button.hidden = button.dataset.mode === 'build' && !canBuild();
    button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
  });
  $$('.tabs [data-tab]').forEach((button) => { button.hidden = button.dataset.workspace !== state.mode || !workspaceTabs().includes(button.dataset.tab); });
  $('meta[name="theme-color"]').content = state.mode === 'build' ? '#243957' : '#173e43';
}

function dateText(value) {
  if (!value) return '日時の記録なし';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '日時の形式を確認してください' : new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function badge(status, step = false) {
  const labels = step ? stepStates : statuses;
  const safeClass = Object.hasOwn(labels, status) ? status : '';
  return `<span class="badge ${safeClass}">${e(labels[status] ?? '状態を確認してください')}</span>`;
}

function stalledDays(item) {
  const days = Number(item.stalledDays ?? 0);
  return Number.isFinite(days) ? Math.max(0, days) : 0;
}

function currentStep(item) {
  return (item.steps ?? []).find((step) => step.id === item.currentStepId) ?? (item.steps ?? []).find((step) => step.state === 'current');
}

function currentLabel(item) {
  return currentStep(item)?.label ?? (['completed', 'rejected', 'withdrawn'].includes(item.status) ? '終了' : '現在の箱の情報なし');
}

function permitted(item) {
  return Array.isArray(item.canAct) ? item.canAct : [];
}

function notice(message, type = 'success') {
  const element = $('#notice');
  element.className = `notice ${type}`;
  element.setAttribute('role', type === 'error' ? 'alert' : 'status');
  element.textContent = message;
  element.hidden = false;
  if (type === 'error') element.focus();
}

function clearNotice() {
  $('#notice').hidden = true;
}

function lockControls() {
  if (!state.busy) return;
  $$('button, input, select, textarea').forEach((control) => {
    if (!control.disabled) {
      temporarilyDisabled.add(control);
      control.disabled = true;
    }
  });
}

function setBusy(busy) {
  state.busy = busy;
  $('#main').setAttribute('aria-busy', String(busy));
  $('#progress').hidden = !busy;
  if (busy) lockControls();
  else {
    for (const control of temporarilyDisabled) if (control.isConnected) control.disabled = false;
    temporarilyDisabled.clear();
    $('#actor').disabled = !state.org.people.length;
    const dialog = $('#action-dialog');
    if (dialog.open && (document.activeElement === dialog || !dialog.contains(document.activeElement))) {
      $('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)', dialog)?.focus();
    }
  }
}

async function runTask(task) {
  if (state.busy) return;
  clearNotice();
  setBusy(true);
  try {
    await task();
  } catch (error) {
    notice(error.message || '処理を完了できませんでした。もう一度お試しください。', 'error');
  } finally {
    setBusy(false);
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const url = new URL(path, window.location.href);
  if (state.actor) url.searchParams.set('as', state.actor);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('応答に時間がかかっています。しばらくしてから、もう一度お試しください。');
    throw new Error('サーバーに接続できません。サーバーの準備ができてから「再接続」を押してください。');
  }
  let data = null;
  let text;
  try { text = await response.text(); }
  catch { throw new Error('応答の受信が途切れました。一覧を更新して、処理の結果を確かめてください。'); }
  if (text) {
    try { data = JSON.parse(text); }
    catch { throw new Error(response.ok ? 'サーバーの応答を読み取れませんでした。応答形式を確認してください。' : `処理を完了できませんでした（HTTP ${response.status}）。`); }
  }
  if (!response.ok || data?.error) {
    const error = new Error(typeof data?.error === 'string' ? data.error : `処理を完了できませんでした（HTTP ${response.status}）。`);
    error.code = data?.code;
    throw error;
  }
  return data;
}

function ensureDraftStep(template) {
  const draft = (template.steps ?? []).find((step) => boxKind(step) === 'draft') ?? { id: 's0', kind: 'draft', label: '起案' };
  template.steps = [draft, ...(template.steps ?? []).filter((step) => boxKind(step) !== 'draft')];
}

function selectDraft(template) {
  state.draft = template ? clone(template) : null;
  if (state.draft) {
    state.draft.steps ??= [];
    state.draft.amountTable ??= [];
    const legacyEnding = state.draft.steps.find((step) => ['order', 'submit'].includes(step.kind));
    state.draft.ending ??= legacyEnding ? { type: legacyEnding.kind, ...(legacyEnding.receiptDoc ? { receiptDoc: legacyEnding.receiptDoc } : {}) } : { type: 'none' };
    if (state.draft.ending.type === 'submit') state.draft.ending.receiptDoc ??= '提出控え';
    state.draft.steps = state.draft.steps.filter((step) => !['order', 'submit'].includes(step.kind)).map((step) => {
      if (['check', 'decision'].includes(step.kind)) {
        step.mark = approvalMark(step);
        step.kind = 'approval';
      }
      return step;
    });
    ensureDraftStep(state.draft);
  }
  state.selectedStep = state.draft?.steps[0]?.id ?? '';
  state.dirty = false;
  state.dirtySteps.clear();
  state.saveMessage = '';
  state.simulation = null;
}

function updateHeader() {
  const actor = $('#actor');
  actor.innerHTML = state.org.people.length ? state.org.people.map((person) => {
    const unit = state.org.units.find((item) => item.id === person.unit);
    return option(person.id, `${person.name}${unit ? `（${unit.name}）` : ''}`, state.actor);
  }).join('') : '<option value="">操作できる人が登録されていません</option>';
  actor.disabled = !state.org.people.length;
  $('#connection-label').textContent = state.ready ? '接続済み' : '接続を待っています';
  $('#reconnect').textContent = state.ready ? '情報を再読込' : '再接続';
}

async function initialize() {
  const [org, templates] = await Promise.all([api('/api/org'), api('/api/templates')]);
  if (!org || !Array.isArray(org.people)) throw new Error('組織の応答に「people」がありません。組織情報の形式を確認してください。');
  state.org = { settings: {}, roles: [], units: [], ...org };
  refreshGlossary();
  state.settingsError = '';
  if (!state.settingsDirty) state.settingsDraft = clone(state.org.settings);
  if (!org.people.some((person) => person.id === state.actor)) state.actor = org.people[0]?.id ?? '';
  state.templates = list(templates, 'templates', 'items');
  if (!state.dirty) selectDraft(state.templates.find((template) => template.id === state.draft?.id) ?? state.templates[0]);
  await loadCaseTypes();
  state.ready = true;
  updateHeader();
  state.cases = [];
  state.selectedCase = null;
  state.outbox = [];
  render();
  await loadTab();
}

function heading(number, title, description, tools = '') {
  return `<div class="page-heading"><div><p class="step-number">${e(number)}</p><h2>${e(title)}</h2><p>${e(description)}</p></div>${tools}</div>`;
}

function empty(message, description = '') {
  return `<div class="empty-state"><h3>${e(message)}</h3>${description ? `<p>${e(description)}</p>` : ''}</div>`;
}

function roleChoices() {
  return state.org.roleChoices ?? state.org.roles ?? [];
}

function roleOptions(selected) {
  const choices = roleChoices();
  return option('', '役職を選んでください', selected)
    + (selected && !choices.some((role) => role.id === selected) ? option(selected, '役職を選び直してください', selected) : '')
    + choices.map((role) => option(role.id, role.name, selected)).join('');
}

function boxKinds() {
  const configured = state.org.boxKinds;
  const order = Array.isArray(configured) ? configured.map((item) => typeof item === 'string' ? item : item.kind ?? item.id) : [];
  return [...new Set([...order.filter((kind) => Object.hasOwn(kinds, kind)), ...Object.keys(kinds)])].filter((kind) => kind !== 'draft');
}

function roleListTarget(owner) {
  if (dialogContext?.type !== 'builder') return null;
  if (owner === 'step') return editorStep();
  return dialogContext.template.amountTable[Number(owner)];
}

function renderRoleList(owner, key, label, values = []) {
  const ordered = owner !== 'step';
  return `<fieldset class="role-list"><legend>${e(label)}</legend>${values.map((value, index) => {
    const attrs = `data-role-owner="${e(owner)}" data-role-key="${e(key)}" data-role-index="${index}"`;
    return `<div class="role-row"><label class="visually-hidden" for="role-${e(owner)}-${e(key)}-${index}">${e(label)} ${index + 1}</label><select id="role-${e(owner)}-${e(key)}-${index}" ${attrs}>${roleOptions(value)}</select><div class="button-row">${ordered ? `<button type="button" data-command="role-up" ${attrs} aria-label="${index + 1}番目の役職を前へ"${index === 0 ? ' disabled' : ''}>↑</button><button type="button" data-command="role-down" ${attrs} aria-label="${index + 1}番目の役職を後へ"${index === values.length - 1 ? ' disabled' : ''}>↓</button>` : ''}<button type="button" class="danger" data-command="delete-role" ${attrs} aria-label="${index + 1}番目の役職を削除">削除</button></div></div>`;
  }).join('')}${values.length ? '' : '<p class="hint">指定なし</p>'}<button type="button" data-command="add-role" data-role-owner="${e(owner)}" data-role-key="${e(key)}">＋ 役職を追加</button></fieldset>`;
}

function render() {
  updateWorkspace();
  $$('.tabs [data-tab]').forEach((button) => {
    const selected = button.dataset.tab === state.tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  $('#main').setAttribute('aria-labelledby', `tab-${state.tab}`);
  if (!state.ready) {
    $('#main').innerHTML = empty('サーバーへの接続を待っています', '準備ができたら、上の「再接続」を押してください。');
    lockControls();
    return;
  }
  if (!state.actor) {
    $('#main').innerHTML = empty('操作する人がいません', '組織情報に人が登録されてから、情報を再読込してください。');
    lockControls();
    return;
  }
  const pages = { builder: renderBuilder, settings: renderSettings, apply: renderApply, mine: renderCases, todo: renderCases, admin: renderAdmin };
  $('#main').innerHTML = pages[state.tab]();
  lockControls();
}

function renderBuilder() {
  const template = state.draft;
  return `${heading('01 / ルートを組む', '仕事の流れを組み替える', '箱を左から右へ並べます。「編集」または箱のダブルクリックで、担当や必要な書類を直せます。')}
    <section class="panel"><div class="toolbar"><div class="field"><label for="template-select">ルートの型</label><select id="template-select"${state.templates.length ? '' : ' disabled'}>${state.templates.length ? state.templates.map((item) => option(item.id, item.name, template?.id)).join('') : option('', '登録された型がありません')}</select></div>
    <div class="button-row"><span id="dirty-badge" class="badge dirty"${state.dirty ? '' : ' hidden'}>未保存の変更</span><button type="button" data-command="simulate"${template ? '' : ' disabled'}>試し運行</button><button type="button" class="primary" data-command="save-template"${template ? '' : ' disabled'}>この型を保存</button><span id="save-message" class="save-message" role="status">${e(state.saveMessage)}</span></div></div><p class="hint">型の変更は、これから申請する案件に使われます。進行中の案件のルートは申請時のままです。</p></section>
    ${template ? `<section class="panel" aria-labelledby="route-title"><div class="panel-heading"><div><h3 id="route-title">${e(template.name)}</h3>${renderShape(template)}</div><span class="badge">${template.steps.length}個の箱</span></div>
    <p class="hint">起案箱は先頭に1つ固定です。受付箱は、起案箱のすぐ後に置きます。</p><div class="route-scroll" tabindex="0" aria-label="ルートの箱。横にスクロールできます"><ol class="route-track">${template.steps.map(renderRouteBox).join('')}${renderEndingTag()}</ol>${template.steps.length ? '' : empty('箱を追加してください', '下で種類を選び、最初の箱を置きましょう。')}</div>
    <div class="add-step"><div class="field"><label for="add-kind">追加する箱の種類</label><select id="add-kind">${boxKinds().map((kind) => option(kind, `${kinds[kind].label} — ${kinds[kind].description}`)).join('')}</select></div><button type="button" data-command="add-step">＋ 箱を追加</button></div></section>
    ${renderSimulation()}` : empty('ルートの型がありません', '型が登録されてから、情報を再読込してください。')}`;
}

function renderAmountTable(template) {
  const shared = template.steps.filter(usesAmountTable).length > 1;
  return `${shared ? '<p class="notice warning">この表はほかの箱とも共通です</p>' : ''}<section class="panel" aria-labelledby="amount-title"><div class="panel-heading"><h3 id="amount-title">金額で決まる決裁者</h3><button type="button" data-command="add-amount">＋ 金額の段を追加</button></div>
    <p>上限金額は「その金額以下」です。空欄は上限なし。役職は上から順に通ります。</p>
    <div class="table-scroll"><table class="amount-table"><thead><tr><th scope="col">上限金額（円）</th><th scope="col">決裁する役職（順番に）</th><th scope="col">段の操作</th></tr></thead><tbody>${template.amountTable.map((row, index) => `<tr><td><label class="muted" for="amount-${index}">第${index + 1}段</label><input id="amount-${index}" type="number" min="0" step="1" inputmode="numeric" placeholder="上限なし" value="${e(row.upTo ?? '')}" data-amount="${index}" data-key="upTo"></td><td>${renderRoleList(String(index), 'approvers', `第${index + 1}段の決裁する役職`, row.approvers)}</td><td><div class="button-row"><button type="button" data-command="amount-left" data-index="${index}" aria-label="第${index + 1}段を上へ"${index === 0 ? ' disabled' : ''}>↑</button><button type="button" data-command="amount-right" data-index="${index}" aria-label="第${index + 1}段を下へ"${index === template.amountTable.length - 1 ? ' disabled' : ''}>↓</button><button type="button" class="danger" data-command="delete-amount" data-index="${index}" aria-label="第${index + 1}段を削除">削除</button></div></td></tr>`).join('')}</tbody></table></div>
    ${template.amountTable.length ? '' : '<p class="hint">金額の段はありません。金額マスターを使う決裁の箱がある場合は、段を追加してください。</p>'}<p class="hint">役職を追加し、矢印で決裁の順番を変えられます。役職を指定しない段は決裁者なしです。</p></section>`;
}

function usesAmountTable(step) {
  return boxKind(step) === 'approval' && approvalMark(step) === 'decision' && step.fromAmountTable;
}

function renderTemplateSettings() {
  const ending = dialogContext.template.ending;
  return `<section class="panel" aria-labelledby="template-settings-title"><h3 id="template-settings-title">終わり方の設定</h3><div class="field-grid"><div class="field"><label for="template-ending">終わり方</label><select id="template-ending">${Object.entries(endingLabels).map(([type, label]) => option(type, label, ending.type)).join('')}</select></div>${ending.type === 'submit' ? `<div class="field"><label for="ending-receipt">控えの書類名</label><input id="ending-receipt" value="${e(ending.receiptDoc ?? '提出控え')}"><p class="hint">同じ名前の控えを添付してから、提出済みにします。</p></div>` : ''}</div></section>`;
}

function simulationStepId(id) {
  return id === 'draft' ? state.draft?.steps.find((step) => boxKind(step) === 'draft')?.id : id;
}

function boxIssues(id) {
  return list(state.simulation, 'items').filter((item) => simulationStepId(item.stepId) === id && ['error', 'warn'].includes(item.level));
}

function issueClass(id) {
  const issues = boxIssues(id);
  return issues.some((item) => item.level === 'error') ? ' has-error' : issues.length ? ' has-warning' : '';
}

function boxBadges(id) {
  const issues = boxIssues(id);
  return `${state.dirtySteps.has(id) ? '<span class="badge dirty">未保存</span>' : ''}${issues.length ? `<span class="badge ${issues.some((item) => item.level === 'error') ? 'rejected' : 'returned'}">${issues.some((item) => item.level === 'error') ? '要修正' : '注意'} ${issues.length}件</span>` : ''}`;
}

function renderEndingTag() {
  const ending = state.draft.ending;
  return `<li class="ending-tag${issueClass('end')}" data-box-id="end">${boxBadges('end')}<button type="button" class="box-select" data-command="edit-step" data-step="end"><span class="badge">終わり方</span><strong>${e(endingLabels[ending.type] ?? endingLabels.none)}</strong>${ending.type === 'submit' ? `<span>控え：${e(ending.receiptDoc ?? '提出控え')}</span>` : ''}<span class="edit-label">編集</span></button></li>`;
}

function boxSummary(step) {
  const kind = boxKind(step);
  if (kind === 'draft') return kinds.draft.description;
  if (kind === 'input') return `${step.fields?.length ?? 0}項目の入力欄`;
  if (kind === 'approval' && approvalMark(step) === 'decision' && step.fromAmountTable) return '決裁・金額マスターから決定';
  const roles = kind === 'notify' ? step.roles : ['council', 'parallel'].includes(kind) ? step.members : [step.role];
  const names = (roles ?? []).filter(Boolean).map(roleName).join('、') || '担当の指定なし';
  return kind === 'approval' ? `${approvalMark(step) === 'decision' ? '決裁' : '確認'}・${names}` : names;
}

function renderRouteBox(step, index) {
  const kind = boxKind(step);
  const parallel = kind === 'parallel';
  return `<li class="route-box${parallel ? ' parallel-frame' : ''}${state.selectedStep === step.id ? ' selected' : ''}${issueClass(step.id)}" data-box-id="${e(step.id)}">${boxBadges(step.id)}<button type="button" class="box-select" data-command="select-step" data-step="${e(step.id)}" aria-pressed="${state.selectedStep === step.id}"><span class="box-top">${icon(step)}<span class="muted">${index + 1} / ${e(kinds[kind]?.label ?? '箱')}</span></span><strong data-box-label>${e(step.label || '名前のない箱')}</strong>${parallel ? '<span class="parallel-caption">並行の入れ物 — 全部そろったら次へ</span>' : `<span class="box-meta">${e(boxSummary(step))}</span>`}</button>
    ${parallel ? `<ul class="parallel-members" aria-label="同時に確かめる課">${(step.members ?? []).map((role) => `<li class="parallel-member">${e(roleName(role))}</li>`).join('') || '<li class="parallel-member muted">課を追加してください</li>'}</ul>` : ''}
    <div class="box-tools"><button type="button" data-command="edit-step" data-step="${e(step.id)}" aria-label="${e(step.label)}を編集">編集</button>${kind === 'draft' ? '<span class="hint">先頭に固定</span>' : `<button type="button" data-command="step-left" data-step="${e(step.id)}" aria-label="${e(step.label)}を左へ"${index <= 1 ? ' disabled' : ''}>← 左</button><button type="button" data-command="step-right" data-step="${e(step.id)}" aria-label="${e(step.label)}を右へ"${index === state.draft.steps.length - 1 ? ' disabled' : ''}>右 →</button><button type="button" class="danger" data-command="delete-step" data-step="${e(step.id)}" aria-label="${e(step.label)}を削除">削除</button>`}</div></li>`;
}

function stepInput(step, key, label, { textarea = false, hint = '', type = 'text', roles = false } = {}) {
  const value = Array.isArray(step[key]) ? step[key].join('\n') : step[key] ?? '';
  const attrs = `id="step-${key}" data-step-field="${key}"`;
  return `<div class="field"><label for="step-${key}">${label}</label>${roles ? `<select ${attrs}>${roleOptions(step[key])}</select>` : textarea ? `<textarea ${attrs}>${e(value)}</textarea>` : `<input ${attrs} type="${type}"${type === 'number' ? ' min="0" step="1"' : ''} value="${e(value)}">`}${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;
}

function renderInputFields(step) {
  return `<div class="full-width input-fields"><div class="panel-heading"><h4>申請者が書く項目</h4><button type="button" data-command="add-input-field">＋ 項目を追加</button></div>${(step.fields ?? []).map((field, index) => `<div class="input-field-row"><div class="field"><label for="input-label-${index}">項目名</label><input id="input-label-${index}" data-input-field="${index}" data-field-key="label" value="${e(field.label)}"></div><div class="field"><label for="input-content-${index}">入力する内容</label><select id="input-content-${index}" data-input-field="${index}" data-field-key="key">${option('amount', '金額（決裁者を選ぶ金額）', field.key)}${option('deadline', '締切日', field.key)}${option('reason', '理由', field.key)}${option(['amount', 'deadline', 'reason'].includes(field.key) ? '__custom' : field.key, 'その他の入力', field.key)}</select></div><div class="field"><label for="input-type-${index}">種類</label><select id="input-type-${index}" data-input-field="${index}" data-field-key="type">${option('number', '数値', field.type)}${option('date', '日付', field.type)}${option('text', '文字', field.type ?? 'text')}</select></div><button type="button" class="danger" data-command="delete-input-field" data-index="${index}" aria-label="${index + 1}番目の項目を削除">削除</button></div>`).join('')}${step.fields?.length ? '' : '<p class="hint">項目を追加して、起案画面に出す入力欄を決めてください。</p>'}</div>`;
}

function renderStepEditor() {
  const step = editorStep();
  if (!step) return '';
  const kind = boxKind(step);
  const decision = kind === 'approval' && approvalMark(step) === 'decision';
  if (kind === 'draft') {
    const types = state.caseTypes.filter((item) => item.templateId === state.draft.id);
    return `<p class="step-description">この型を使う案件の種類</p>${state.caseTypesError ? `<p class="notice error">案件の種類を読み込めませんでした。${e(state.caseTypesError)}</p>` : types.length ? `<ul>${types.map((item) => `<li>${e(item.name)}${item.active === false ? '（使わない）' : ''}</li>`).join('')}</ul>` : '<p class="hint">この型を使う案件の種類はありません。</p>'}`;
  }
  return `<section aria-label="箱の入力"><p class="step-description">${e(kinds[kind]?.description ?? '')}</p><div class="field-grid">
    ${stepInput(step, 'label', '箱の名前')}
    ${kind === 'approval' ? `<div class="field"><label for="step-mark">印</label><select id="step-mark" data-step-field="mark">${option('confirm', '確認', approvalMark(step))}${option('decision', '決裁', approvalMark(step))}</select></div>` : ''}
    ${['reception', 'approval'].includes(kind) ? stepInput(step, 'role', '担当する役職', { roles: true, hint: decision && step.fromAmountTable ? '金額マスターで選ばれる役職を優先します。' : '' }) : ''}
    ${decision ? `<div class="full-width"><div class="field"><label class="checkbox"><input id="step-from-amount-table" type="checkbox" data-step-field="fromAmountTable"${step.fromAmountTable ? ' checked' : ''}>金額マスターで決裁者を決める</label></div><div class="field"><label class="checkbox"><input type="checkbox" data-step-field="allowProxy"${step.allowProxy ? ' checked' : ''}>代理を認める</label></div></div>` : ''}
    ${kind === 'input' ? renderInputFields(step) : ''}
    ${kind === 'notify' ? `<div class="full-width">${renderRoleList('step', 'roles', '知らせる相手の役職', step.roles)}<fieldset class="notification-via"><legend>手段</legend>${[['mail', 'メール'], ['teams', 'Teams'], ['slack', 'Slack']].map(([via, label]) => `<label class="checkbox"><input type="checkbox" data-notify-via="${via}"${step.via?.includes(via) ? ' checked' : ''}>${label}</label>`).join('')}</fieldset></div>` : ''}
    ${['council', 'parallel'].includes(kind) ? `<div class="full-width">${renderRoleList('step', 'members', kind === 'council' ? 'メンバーの役職' : '確かめる課の役職', step.members)}</div>` : ''}
    ${kind === 'council' ? `<div class="field"><label for="council-rule">決め方</label><select id="council-rule" data-step-field="rule">${option('all', '全員', step.rule ?? 'all')}${option('majority', '過半数', step.rule)}${option('any', '誰か1人', step.rule)}</select></div>${stepInput(step, 'maxMembers', '人数の上限', { type: 'number', hint: '空欄なら上限を指定しません。' })}<div class="full-width"><label class="checkbox"><input type="checkbox" data-step-field="allowExternal"${step.allowExternal ? ' checked' : ''}>社外のメンバー可</label></div>` : ''}
    ${['reception', 'approval'].includes(kind) ? `<div class="full-width">${stepInput(step, 'requiredDocs', '必要な書類', { textarea: true, hint: '1行に1つ、書類名を書いてください。カンマ・読点でも区切れます。' })}</div>` : ''}</div>
    <details><summary>この箱の詳しい設定</summary><div class="field-grid"><div class="full-width">${renderRoleList('step', 'cc', '通知先の役職（CC）', step.cc)}</div>${stepInput(step, 'switchDaysBefore', '切り替えの知らせ（締切の何日前）', { type: 'number' })}</div>
    ${['approval', 'council'].includes(kind) ? `<label class="checkbox"><input type="checkbox" data-step-field="hideRejectReason"${step.hideRejectReason ? ' checked' : ''}>申請者には否決理由を見せない</label>` : ''}</details>${decision && step.fromAmountTable ? renderAmountTable(dialogContext.template) : ''}</section>`;
}

function renderSimulation() {
  const result = state.simulation;
  if (!result) return '';
  const items = list(result, 'items');
  const levels = { error: '要修正', warn: '注意', ok: '確認済み' };
  return `<section class="panel" aria-labelledby="simulation-title"><div class="panel-heading"><h3 id="simulation-title">試し運行の結果</h3><span class="badge${result.ok ? ' completed' : ' returned'}">${result.ok ? '通過しました' : '結果を確認してください'}</span></div><p>現在編集中の型で確かめた結果です。対象の行を押すと、その箱を直せます。</p><ul class="simulation-list">${items.map((item) => {
    const level = Object.hasOwn(levels, item.level) ? item.level : 'warn';
    const id = simulationStepId(item.stepId);
    const editable = id === 'end' || state.draft?.steps.some((step) => step.id === id);
    const content = `<strong>${levels[level]}</strong><span>${e(item.message)}${item.target ? `<br><span>対象：${e(item.target)}</span>` : ''}</span>`;
    return `<li class="simulation-item ${level}">${editable ? `<button type="button" class="simulation-link" data-command="edit-step" data-step="${e(id)}">${content}</button>` : content}</li>`;
  }).join('')}</ul>${items.length ? '' : '<p class="hint">個別の結果はありません。</p>'}</section>`;
}

function markDirty(id) {
  state.dirty = true;
  if (id) state.dirtySteps.add(id);
  state.simulation = null;
  state.saveMessage = '';
}

function editorStep() {
  return dialogContext?.type === 'builder' ? dialogContext.template.steps.find((step) => step.id === dialogContext.stepId) : null;
}

function openStepEditor(id) {
  id = simulationStepId(id);
  if (!state.draft || (id !== 'end' && !state.draft.steps.some((step) => step.id === id))) return;
  state.selectedStep = id;
  const context = { type: 'builder', stepId: id, template: clone(state.draft) };
  openDialog('', context);
  renderEditorDialog();
}

function renderEditorDialog() {
  const { stepId, template } = dialogContext;
  const step = editorStep();
  const draft = step && boxKind(step) === 'draft';
  const title = stepId === 'end' ? `${template.steps.length + 1} / 終わり方` : `${template.steps.findIndex((box) => box.id === stepId) + 1} / ${kinds[boxKind(step)]?.label ?? '箱'}`;
  const detailsOpen = !!$('#dialog-content details[open]');
  $('#dialog-content').innerHTML = `<form id="builder-form"><h2 id="dialog-title" tabindex="-1">${e(title)}</h2>${step ? `<p class="dialog-context">${e(step.label || '名前のない箱')}</p>` : ''}${stepId === 'end' ? renderTemplateSettings() : renderStepEditor()}<p id="dialog-error" class="notice error" role="alert" hidden></p><div class="dialog-footer"><button type="button" data-command="close-dialog">閉じる</button>${draft ? '' : '<button type="submit" class="primary">この箱に反映</button>'}</div></form>`;
  if (detailsOpen) $('#dialog-content details')?.setAttribute('open', '');
  $('#dialog-title').focus();
}

function applyBoxEdits(form) {
  if (dialogContext?.type !== 'builder' || !form.reportValidity()) return;
  const { stepId, template } = dialogContext;
  const step = editorStep();
  if (step && boxKind(step) === 'draft') return;
  if (step && !step.label?.trim()) { dialogError('箱の名前を入力してください。'); return; }
  if (stepId === 'end') state.draft.ending = clone(template.ending);
  else {
    const index = state.draft.steps.findIndex((box) => box.id === stepId);
    state.draft.steps[index] = clone(step);
    if (usesAmountTable(step) && JSON.stringify(template.amountTable) !== JSON.stringify(state.draft.amountTable)) {
      state.draft.amountTable = clone(template.amountTable);
      state.draft.steps.filter(usesAmountTable).forEach((box) => state.dirtySteps.add(box.id));
    }
  }
  markDirty(stepId);
  closeDialog();
  render();
  focusStep(stepId);
}

function editBoxInput(input) {
  const step = editorStep();
  const template = dialogContext.template;
  let redraw = false;
  if (input.matches('[data-step-field]') && step) {
    const key = input.dataset.stepField;
    input.setCustomValidity('');
    if (input.type === 'number' && input.value !== '' && (!input.validity.valid || !Number.isSafeInteger(Number(input.value)))) {
      input.setCustomValidity('0以上の整数を入力してください。');
      return;
    }
    step[key] = input.type === 'checkbox' ? input.checked : key === 'requiredDocs' ? words(input.value) : input.type === 'number' ? (input.value === '' ? undefined : Number(input.value)) : input.value;
    if (key === 'mark' && input.value === 'confirm') { step.fromAmountTable = false; step.allowProxy = false; }
    redraw = ['mark', 'fromAmountTable'].includes(key);
  } else if (input.matches('select[data-role-owner]')) {
    const target = roleListTarget(input.dataset.roleOwner);
    if (target) target[input.dataset.roleKey][Number(input.dataset.roleIndex)] = input.value;
  } else if (input.matches('[data-input-field]')) {
    const field = step?.fields?.[Number(input.dataset.inputField)];
    if (field) {
      const key = input.dataset.fieldKey;
      field[key] = key === 'key' && input.value === '__custom' ? `field${crypto.randomUUID().replaceAll('-', '')}` : input.value;
      if (key === 'key' && input.value === '__custom') $('option[value="__custom"]', input).value = field.key;
    }
  } else if (input.matches('[data-notify-via]') && step) step.via = $$('[data-notify-via]:checked', $('#dialog-content')).map((checkbox) => checkbox.dataset.notifyVia);
  else if (input.id === 'ending-receipt') template.ending.receiptDoc = input.value;
  else if (input.matches('[data-amount]')) {
    input.setCustomValidity('');
    if (input.value !== '' && (!input.validity.valid || !Number.isSafeInteger(Number(input.value)))) input.setCustomValidity('0以上の整数を入力してください。');
    template.amountTable[Number(input.dataset.amount)][input.dataset.key] = input.value === '' ? null : Number(input.value);
  }
  if (redraw) { const id = input.id; renderEditorDialog(); if (id) document.getElementById(id)?.focus(); }
}

function validateTemplate() {
  const template = state.draft;
  if (!template) throw new Error('ルートの型を選んでください。');
  if (!template.steps.length) throw new Error('箱を1つ以上追加してください。');
  if (template.steps.some((step) => !step.label?.trim())) throw new Error('すべての箱に名前を入力してください。');
  for (const step of template.steps) {
    if (boxKind(step) === 'input') {
      const keys = new Set();
      for (const field of step.fields ?? []) {
        if (!field.label?.trim() || !field.key?.trim()) throw new Error('入力欄の項目名を入力してください。項目を読み込めない場合は追加し直してください。');
        if (keys.has(field.key)) throw new Error('同じ入力欄の項目が重複しています。重複した項目を追加し直してください。');
        keys.add(field.key);
      }
    }
    if (['cc', 'members', 'roles'].some((key) => step[key]?.some((role) => !role))) throw new Error('追加した役職を選ぶか、使わない行を削除してください。');
  }
  if (template.ending.type === 'submit' && !template.ending.receiptDoc?.trim()) throw new Error('控えの書類名を入力してください。');
  let previous = -1;
  template.amountTable.forEach((row, index) => {
    if (row.approvers?.some((role) => !role)) throw new Error('金額マスターの役職を選ぶか、使わない行を削除してください。');
    if (row.upTo === null) {
      if (index !== template.amountTable.length - 1) throw new Error('「上限なし」の段は、金額マスターの最後に置いてください。');
    } else {
      if (!Number.isSafeInteger(row.upTo) || row.upTo < 0) throw new Error('金額マスターの上限は、0以上の整数で入力してください。');
      if (row.upTo <= previous) throw new Error('金額マスターの上限は、小さい金額から重複しない順に並べてください。');
      previous = row.upTo;
    }
  });
}

function applicationFields(template) {
  const fields = new Map();
  const definitions = [...(template?.fields ?? []), ...(template?.steps ?? []).filter((step) => boxKind(step) === 'input').flatMap((step) => step.fields ?? [])];
  for (const field of definitions) {
    if (field.key) fields.set(field.key, { ...fields.get(field.key), ...field });
  }
  return [...fields.values()];
}

function activeCaseTypes() {
  return state.caseTypes.filter((item) => item.active !== false && state.templates.some((template) => template.id === item.templateId));
}

function renderShape(template) {
  return template?.shape ? `<p class="hint example-shape">この例の形: ${e(template.shape)}</p>` : '';
}

async function loadCaseTypes() {
  try {
    const response = await api('/api/case-types');
    state.caseTypes = list(response, 'caseTypes', 'items');
    state.caseTypesError = '';
    if (!state.caseTypesDirty) state.caseTypesDraft = clone(state.caseTypes);
    if (!activeCaseTypes().some((item) => item.id === state.applyCaseType)) {
      state.applyCaseType = activeCaseTypes()[0]?.id ?? '';
      state.applyValues = {};
    }
  } catch (error) {
    state.caseTypes = [];
    state.caseTypesError = error.message;
  }
}

function renderApply() {
  const types = activeCaseTypes();
  const caseType = types.find((item) => item.id === state.applyCaseType);
  const template = state.templates.find((item) => item.id === caseType?.templateId);
  const fields = applicationFields(template).filter((field) => field.key !== 'reason');
  const reason = applicationFields(template).find((field) => field.key === 'reason') ?? { key: 'reason', label: '理由', type: 'textarea' };
  return `${heading('01 / 起案する', '新しい案件を起案する', '案件の種類を選び、件名・目的・理由と必要な情報を入力してください。')}
    ${state.caseTypesError ? `<p class="notice error" role="alert">案件の種類を読み込めませんでした。${e(state.caseTypesError)} 上の「情報を再読込」で読み直してください。</p>` : types.length ? `<form id="application-form" class="panel">
    <fieldset class="application-section"><legend>1. 案件の種類を選ぶ</legend><div class="field"><label for="apply-case-type">案件の種類</label><select id="apply-case-type" required>${types.map((item) => option(item.id, item.name, state.applyCaseType)).join('')}</select></div>${caseType?.style === 'chat' ? `<div class="field chat-start"><label for="apply-message">担当へのひとこと（チャットの最初のメッセージ・なくてもよい）</label><textarea id="apply-message" maxlength="1000" placeholder="例：部の資料印刷用にプリンタを買いたいです">${e(state.applyMessage ?? '')}</textarea><p class="hint">起案すると、この案件の「担当との相談」（チャット）が始まります。担当と相談しながら進め、話がまとまったら担当が承認して次へ回します。</p></div>` : ''}${renderShape(template)}</fieldset>
    <fieldset class="application-section"><legend>2. 件名・目的・理由を書く</legend><div class="field"><label for="apply-title">件名<span class="required">必須</span></label><input id="apply-title" name="title" required maxlength="200" value="${e(state.applyTitle)}" placeholder="例：電動ドリルの購入"></div><div class="field"><label for="apply-purpose">目的</label><textarea id="apply-purpose">${e(state.applyPurpose)}</textarea></div>${renderApplicationField(reason, 'reason')}</fieldset>
    <fieldset class="application-section"><legend>3. 必要な項目を入力する</legend>${template ? `<div class="field-grid">${fields.map((field, index) => renderApplicationField(template.deadline?.required && field.key === 'deadline' ? { ...field, label: '締切日', type: 'date', required: true } : field, index)).join('')}${template.deadline?.required && !fields.some((field) => field.key === 'deadline') ? renderApplicationField({ key: 'deadline', label: '締切日', type: 'date', required: true }) : ''}</div>${fields.length || template.deadline?.required ? '' : '<p class="hint">この種類には追加の入力項目はありません。</p>'}` : '<p class="notice error">この種類は現在起案できません。事務局にお問い合わせください。</p>'}</fieldset>
    <fieldset class="application-section"><legend>4. 添付する書類名を書く</legend><div class="field"><label for="apply-docs">添付する書類名</label><textarea id="apply-docs" placeholder="見積書&#10;購入理由書">${e(state.applyDocs)}</textarea><p class="hint">試作版では、ファイルの代わりに書類名を記録します。1行に1つ入力してください。</p></div></fieldset><div class="subtle-box"><p>起案時のルートが案件に保存されます。「起案した案件」で進み具合を見られます。</p></div><div class="button-row application-submit"><button class="primary" type="submit"${template ? '' : ' disabled'}>起案する</button></div></form>` : empty('起案できる案件の種類がまだありません。事務局にお問い合わせください。')}`;
}

function renderApplicationField(field, index = 'extra', values = state.applyValues) {
  const id = `application-field-${index}`;
  const value = values[field.key] ?? field.default ?? '';
  const required = field.required === true;
  const common = `id="${e(id)}" data-application-field="${e(field.key)}"${required ? ' required' : ''}`;
  let input;
  if (field.type === 'select' && Array.isArray(field.options)) {
    input = `<select ${common}>${option('', '選んでください', value)}${field.options.map((item) => typeof item === 'object' ? option(item.value ?? item.id, item.label ?? item.name, value) : option(item, item, value)).join('')}</select>`;
  } else if (field.type === 'textarea') input = `<textarea ${common}>${e(value)}</textarea>`;
  else if (field.type === 'boolean' || field.type === 'checkbox') input = `<input ${common} type="checkbox"${value === true ? ' checked' : ''}>`;
  else {
    const type = ['number', 'date', 'email', 'text'].includes(field.type) ? field.type : 'text';
    input = `<input ${common} type="${type}" value="${e(value)}"${type === 'number' ? ` min="${e(field.min ?? 0)}" step="${e(field.step ?? 'any')}"${field.max === undefined ? '' : ` max="${e(field.max)}"`}` : ''}>`;
  }
  return `<div class="field"><label for="${e(id)}">${e(field.label || '入力項目')}${required ? '<span class="required">必須</span>' : ''}</label>${input}</div>`;
}

function readApplicationFields(form) {
  const fields = {};
  $$('[data-application-field]', form).forEach((input) => {
    const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value.trim();
    if (input.required && (value === '' || value === null || value === false)) throw new Error('必須の項目を入力してください。');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('数値を正しく入力してください。');
    fields[input.dataset.applicationField] = value;
  });
  return fields;
}

function caseDocNo(item) {
  return item.docNo || '未設定';
}

function renderCaseSearch() {
  return `<form id="case-search-form" class="panel case-search" role="search" aria-label="案件を探す"><div class="case-search-row"><div class="field"><label for="case-search">案件を探す</label><input id="case-search" name="q" type="search" value="${e(state.caseSearchDrafts[state.tab])}" placeholder="例：2026-総務-00012" aria-describedby="case-search-hint"></div><button type="submit" class="primary">探す</button></div><p id="case-search-hint" class="hint">文書番号・件名・起案者の名前・起案日（日付の一部、例：2026-11）で探せます。空欄で探すと全件を表示します。</p></form>`;
}

function renderLateNotice(item) {
  if (!item.late) return '';
  return `<div class="late-notice"><span class="badge late">期限を過ぎた申請</span><p>${e(item.late.text)}</p><p class="hint">期限超過だけでは止めずに受付へ回します。受け付けるか戻すかは受付が決めます。</p></div>`;
}

function caseProgress(item) {
  const steps = item.steps ?? [];
  const passed = steps.filter((step) => ['done', 'skipped'].includes(step.state)).length;
  return steps.length ? `${passed} / ${steps.length}箱を通過` : '進み具合の記録なし';
}

function renderCaseList() {
  if (!state.cases.length) return state.caseQueries[state.tab] ? empty('条件に合う案件はありません', '検索語を変えるか、空欄で「探す」を押してください。') : empty(state.tab === 'todo' ? '今、操作が必要な案件はありません' : state.tab === 'mine' ? 'まだ起案した案件がありません' : '案件がありません');
  return `<div class="case-list">${state.cases.map((item) => `<article class="case-card${state.selectedCase?.id === item.id ? ' selected' : ''}"><p class="case-id">文書番号 <strong>${e(caseDocNo(item))}</strong></p>${badge(item.status)}<h3>${e(item.title)}</h3><p class="muted">起案日：${e(item.createdOn || '記録なし')}</p>${renderLateNotice(item)}<p>今の箱：<strong>${e(currentLabel(item))}</strong></p><p class="case-progress">進み具合：${e(caseProgress(item))}</p><p>この箱で <span class="stalled-count">${stalledDays(item)}日</span></p>${state.tab === 'mine' ? '' : `<p class="muted">申請者：${e(personName(item.applicant))}</p>`}<button type="button" class="case-open" data-command="open-case" data-case="${e(item.id)}" aria-label="文書番号 ${e(caseDocNo(item))} ${e(item.title)}の詳細を開く">${state.selectedCase?.id === item.id ? '表示中の案件' : '詳しく見る'}</button>${state.tab === 'admin' ? `<div class="button-row">${renderActionButtons(item, ['delegate', 'escalate'])}</div>` : ''}</article>`).join('')}</div>`;
}

function renderCases() {
  const mine = state.tab === 'mine';
  return `${heading(mine ? '02 / 起案した案件' : '03 / わたしの番', mine ? '起案した案件' : 'わたしの番', mine ? '今どこにあるか、次にどこへ進むかを確かめられます。' : '承認・確認・受付など、あなたの判断を待つ案件です。止まっている日数が長い順に並びます。', '<button type="button" data-command="refresh-cases">一覧を更新</button>')}
    ${renderCaseSearch()}
    <div class="case-workspace"><aside aria-label="案件の一覧">${renderCaseList()}</aside><div id="case-detail">${state.selectedCase ? renderCaseDetail(state.selectedCase) : empty('案件を選んでください', '一覧の「詳しく見る」から、流れと書類を確認できます。')}</div></div>`;
}

function visibleReason(item, action) {
  if (action === 'return' && state.org.settings.showReturnReason === false) return '';
  if (action === 'reject' && currentStep(item)?.hideRejectReason) return '';
  const direct = action === 'return' ? item.returnReason : item.rejectReason;
  if (typeof direct === 'string') return direct;
  // Detail responses have already been filtered by the API for the selected person.
  const names = action === 'reject' ? ['reject', 'councilRejected'] : [action];
  const event = [...(item.history ?? [])].reverse().find((entry) => names.includes(entry.action) && typeof entry.reason === 'string' && entry.reason);
  return event?.reason ?? '';
}

function renderCaseDetail(item) {
  const mine = state.tab === 'mine';
  const activeStep = currentStep(item);
  const reasonAction = item.status === 'returned' ? 'return' : item.status === 'rejected' ? 'reject' : null;
  const reason = reasonAction ? visibleReason(item, reasonAction) : '';
  const next = item.nextStepLabel || (['completed', 'rejected', 'withdrawn'].includes(item.status) ? '終了' : '案内なし');
  const allowed = mine ? ['withdraw', 'resubmit', 'redraft', 'cancel', 'addDoc', 'memo', 'postReview'] : null;
  return `<article class="panel"><div class="panel-heading"><p class="case-id">文書番号 <strong>${e(caseDocNo(item))}</strong></p>${badge(item.status)}</div><h3 class="case-title">${e(item.title)}</h3><p class="hint">申請者：${e(personName(item.applicant))}<br>起案日：${e(item.createdOn || '記録なし')}</p>
    ${renderLateNotice(item)}
    <p class="case-metadata">種類: ${e(item.caseTypeName || '記録なし')}<br>目的: ${e(item.purpose || '記載なし')}</p>
    ${item.redraftedFrom ? `<p class="case-relation"><button type="button" data-command="open-case" data-case="${e(item.redraftedFrom)}">文書番号 ${e(item.redraftedFromDocNo || '未設定')} から起案し直した案件</button></p>` : ''}
    ${item.redraftedTo ? `<p class="case-relation"><button type="button" data-command="open-case" data-case="${e(item.redraftedTo)}">文書番号 ${e(item.redraftedToDocNo || '未設定')} として起案し直しました</button></p>` : ''}
    <dl class="case-summary"><div class="summary-stat"><dt>この箱で止まっている日数</dt><dd class="stalled-count">${stalledDays(item)}日</dd></div><div class="summary-stat"><dt>次の箱</dt><dd>${e(next)}</dd></div><div class="summary-stat"><dt>結果</dt><dd>${e(statuses[item.status] ?? '確認中')}</dd></div></dl>
    ${reason ? `<div class="reason-box"><strong>${reasonAction === 'return' ? '差し戻し理由' : '否決理由'}</strong><p>${e(reason)}</p></div>` : ''}
    ${renderGathering(item)}
    ${item.style === 'chat' ? renderCaseChat(item) : ''}
    <h3>申請の進み具合</h3><ol class="case-steps">${(item.steps ?? []).map((step, index) => {
      if (boxKind(step) === 'parallel') return renderParallelProgress(step, index, item);
      const stepState = step.state ?? (step.id === item.currentStepId ? 'current' : 'waiting');
      const safeClass = Object.hasOwn(stepStates, stepState) ? stepState : 'waiting';
      return `<li class="case-step ${safeClass}"${stepState === 'current' ? ' aria-current="step"' : ''}>${icon(step)}<div class="step-content">${badge(stepState, true)}<h4>${index + 1}. ${e(step.label ?? kinds[boxKind(step)]?.label ?? '箱')}</h4>${step.assignees?.length ? `<p class="muted">担当：${step.assignees.map((person) => e(personName(person))).join('、')}</p>` : ''}${step.flags?.includes('orderCheck') ? '<p>発注内容まで確かめる箱です。</p>' : ''}</div></li>`;
    }).join('')}</ol>
    ${item.missingDocs?.length ? `<div class="notice warning"><strong>足りない書類</strong><p>${item.missingDocs.map((doc) => e(typeof doc === 'string' ? doc : doc.name ?? doc.doc ?? '書類')).join('、')}</p></div>` : ''}
    <h3>書類の束（文書番号 ${e(item.docs?.find((doc) => doc?.docNo)?.docNo || caseDocNo(item))}）</h3>${item.docs?.length ? `<ul class="doc-list">${item.docs.map((doc) => `<li><strong>${e(typeof doc === 'string' ? doc : doc.name)}</strong>${typeof doc === 'string' ? '' : `<span class="badge">第${e(doc.version ?? 1)}版</span><span class="muted">追加した人：${e(personName(doc.addedBy))}<br>箱：${e(doc.stepLabel ?? (doc.step === 'applicant' ? '申請時' : (item.steps ?? []).find((step) => step.id === doc.step)?.label) ?? '記録なし')}<br>${e(dateText(doc.at))}</span>`}</li>`).join('')}</ul>` : '<p class="hint">書類はまだありません。</p>'}
    ${activeStep?.kind === 'submit' && activeStep.receiptDoc ? `<p class="hint">提出の控えとして「${e(activeStep.receiptDoc)}」が必要です。</p>` : ''}
    <h3>記録${item.logIntact === false ? ' <span class="badge">書き換えの疑いあり</span>' : ''}</h3>${item.history?.length ? `<ol class="history-list">${item.history.map((h) => `<li><span class="muted">${e(dateText(h.at))}</span> ${e(h.text || `${h.actorName ?? ''} ${actions[h.action] ?? '操作を記録しました'}`)}</li>`).join('')}</ol>` : '<p class="hint">記録はまだありません。</p>'}
    <div class="action-area"><h3>この案件でできる操作</h3><div class="button-row">${renderActionButtons(item, allowed) || '<p class="muted">今、操作できることはありません。</p>'}</div></div></article>`;
}

function caseFieldLabel(item, key) {
  const template = state.templates.find((template) => template.id === item.templateId);
  return applicationFields(template).find((field) => field.key === key)?.label
    || ({ amount: '金額', item: '品名', reason: '理由', unit: '数える単位', unitPrice: '単価', qty: '希望の数', totalQty: '合計の数', deadline: '締切日' })[key]
    || '入力項目';
}

function renderCaseChat(item) {
  const groups = new Map();
  for (const message of item.chat ?? []) {
    const key = message.stepId || message.stepLabel || '';
    if (!groups.has(key)) groups.set(key, { label: message.stepLabel || (item.steps ?? []).find((step) => step.id === message.stepId)?.label || '相談', messages: [] });
    groups.get(key).messages.push(message);
  }
  const history = [...groups.values()].map((group) => `<section class="chat-group"><h4>${e(group.label)}</h4><ol class="chat-messages">${group.messages.map((message) => {
    const revised = message.kind === 'revise';
    const event = ['approve', 'return', 'reject', 'withdraw'].includes(message.kind);
    const version = Number(message.version);
    const versionLabel = Number.isSafeInteger(version) && version > 0 ? `第${version}版` : '最新版';
    return `<li class="chat-message${revised ? ' chat-revision' : event ? ` chat-event chat-${message.kind}` : message.by === state.actor ? ' chat-own' : ''}"><p class="chat-meta">${e(message.byName || personName(message.by))} · ${e(dateText(message.at))}</p>${revised ? `<strong>内容を直しました(${e(versionLabel)})</strong>` : ''}${message.text ? `<p class="chat-text">${e(message.text)}</p>` : ''}</li>`;
  }).join('')}</ol></section>`).join('');
  return `<section class="case-chat" aria-labelledby="case-chat-title"><h3 id="case-chat-title">担当との相談</h3><p class="hint">相談はここで。相談しただけでは、案件は戻りも止まりもしません。話がまとまったら担当が承認して次へ回します。</p>${history || '<p class="hint">相談はまだありません。</p>'}
    ${(() => { const other = counterpartOf(item); return other ? `<p class="two-person-hint"><button type="button" data-command="open-other-tab" data-as="${e(other.id)}" data-case="${e(item.id)}" data-open-tab="${other.id === item.applicant?.id ? 'mine' : 'todo'}">相手（${e(other.name)}）のタブを開く</button><span class="hint">1台で2人分を試すとき用。新しいタブが相手の立場で開き、書いたことはすぐお互いの画面に出ます。</span></p>` : ''; })()}
    ${permitted(item).includes('chat') ? `<form id="chat-form" data-case="${e(item.id)}"><div class="field"><label for="chat-text">相談の文<span class="required">必須</span></label><textarea id="chat-text" name="memo" required maxlength="1000"></textarea></div><div class="button-row"><button type="submit" class="primary">送る</button></div></form>` : ''}
    ${permitted(item).includes('revise') ? `<div class="button-row"><button type="button" data-command="case-action" data-case="${e(item.id)}" data-action="revise">内容を直す</button></div>` : ''}
    ${(() => { const buttons = renderActionButtons(item, ['approve', 'return', 'reject']); return buttons ? `<div class="button-row chat-actions" aria-label="チャットからの操作">${buttons}</div>` : ''; })()}</section>`;
}

// チャットの相手: 起案者なら今の箱の担当、担当なら起案者
function counterpartOf(item) {
  const step = currentStep(item);
  const applicant = item.applicant?.id ? item.applicant : null;
  if (!applicant) return null;
  if (state.actor !== applicant.id) return applicant;
  const people = [...(step?.assignees ?? []), ...((step?.branches ?? []).flatMap((branch) => branch.people ?? []))].map((p) => (typeof p === 'object' ? p : { id: p, name: personName(p) })).filter((p) => p?.id && p.id !== state.actor);
  return people[0] ?? null;
}

// ---------- 1台で2人分を試す ----------
const startParams = new URLSearchParams(location.search);
function otherTabUrl(params) {
  const url = new URL(location.href);
  url.search = new URLSearchParams(params).toString();
  url.hash = '';
  return url.href;
}
function openOtherTab(button) {
  const as = button.dataset.as || (state.actor === 'p01' ? 'p02' : 'p01');
  const params = { as };
  if (button.dataset.openTab) params.tab = button.dataset.openTab;
  if (button.dataset.case) params.case = button.dataset.case;
  window.open(otherTabUrl(params), '_blank');
}
function renderPairView() {
  const left = otherTabUrl({ as: 'p01', embed: '1' });
  const right = otherTabUrl({ as: 'p02', tab: 'todo', embed: '1' });
  document.body.innerHTML = `<div class="pair-view"><header class="pair-head"><strong>2人で試す（並べて表示）</strong><span>左と右は別の人です。左で書いたことは右に、右で書いたことは左に、すぐ出ます。人はそれぞれの画面の「操作する人」で替えられます。</span><a href="${e(otherTabUrl({}))}">ふつうの表示に戻る</a></header><div class="pair-frames"><iframe title="左の人（起案する側）" src="${e(left)}"></iframe><iframe title="右の人（受ける側）" src="${e(right)}"></iframe></div></div>`;
}

// ほかのタブ(や並べた画面の相手)がデータを書いたら、入力中の文を残したまま読み直す
let syncTimer = null;
async function refreshFromOtherTab() {
  if (state.busy) { clearTimeout(syncTimer); syncTimer = setTimeout(refreshFromOtherTab, 400); return; }
  const active = document.activeElement?.id;
  const draft = $('#chat-text')?.value ?? '';
  try {
    if (['mine', 'todo', 'admin'].includes(state.tab)) {
      const view = { mine: 'mine', todo: 'todo', admin: 'all' }[state.tab];
      const response = await api(`/api/cases?${new URLSearchParams({ view, q: state.caseQueries[state.tab] })}`);
      state.cases = [...list(response, 'cases', 'items')];
      if (view !== 'mine') state.cases.sort((a, b) => stalledDays(b) - stalledDays(a));
      if (state.selectedCase?.id) state.selectedCase = await getCase(state.selectedCase.id).catch(() => state.selectedCase);
    } else return;
    render();
    if ($('#chat-text')) { $('#chat-text').value = draft; if (active === 'chat-text') $('#chat-text').focus(); }
  } catch { /* 読み直しに失敗しても、次の書き込みでまた試す */ }
}
window.addEventListener('proto-data-changed', () => { clearTimeout(syncTimer); syncTimer = setTimeout(refreshFromOtherTab, 150); });
// サーバー版(npm start)では、案件を開いている間だけ5秒ごとに読み直す
if (!window.__protoSingleFile) setInterval(() => { if (state.selectedCase && !document.hidden) refreshFromOtherTab(); }, 5000);

function renderGathering(item) {
  if (!Array.isArray(item.answers) && !item.gathered && !permitted(item).includes('answer')) return '';
  const unit = item.fields?.unit || '個';
  const answers = Array.isArray(item.answers) ? item.answers : item.gathered?.lanes ?? [];
  const rows = answers.map((answer) => `<tr><th scope="row">${e(answer.unitName || '課名の記録なし')}</th><td>${answer.waiting ? 'まだ' : answer.none || answer.qty === 0 ? '申し込みなし' : answer.qty == null ? '記録なし' : `${e(answer.qty)}${e(unit)}`}</td><td>${answer.waiting ? 'まだ' : answer.by ? e(personName(answer.by)) : '—'}</td></tr>`).join('');
  return `<section class="case-gathering" aria-labelledby="gathering-title"><h3 id="gathering-title">各課の希望</h3><div class="table-scroll"><table class="gathering-table"><thead><tr><th scope="col">課名</th><th scope="col">希望の数</th><th scope="col">返した人</th></tr></thead><tbody>${rows || '<tr><td colspan="3">希望はまだありません。</td></tr>'}</tbody></table></div>
    ${item.gathered ? `<dl class="gathered-totals"><div><dt>合計の数</dt><dd>${e(Number(item.gathered.totalQty ?? 0).toLocaleString('ja-JP'))}${e(unit)}</dd></div><div><dt>合計の金額</dt><dd>${e(Number(item.gathered.amount ?? 0).toLocaleString('ja-JP'))}円</dd></div></dl>` : ''}
    ${permitted(item).includes('answer') ? `<form id="answer-form" data-case="${e(item.id)}"><h4>希望の数を返す</h4><div class="field"><label for="answer-qty">希望の数（${e(unit)}）<span class="required">必須</span></label><input id="answer-qty" type="number" name="qty" required min="0" step="1" inputmode="numeric" aria-describedby="answer-hint"><p class="hint" id="answer-hint">0以上の整数で入力してください。0は不要です。</p></div><div class="field"><label for="answer-memo">ひとこと（任意）</label><textarea id="answer-memo" name="memo"></textarea></div><button type="submit" class="primary">希望の数を返す</button></form>` : ''}</section>`;
}

async function submitCaseMessage(form, action) {
  const id = form.dataset.case;
  const memo = $('[name="memo"]', form).value.trim();
  const payload = { as: state.actor, action, memo };
  if (action === 'chat' && !memo) throw new Error('相談の文を入力してください。空白だけでは送れません。');
  if (action === 'answer') {
    const value = $('[name="qty"]', form).value;
    const qty = Number(value);
    if (value === '' || !Number.isSafeInteger(qty) || qty < 0) throw new Error('希望の数は0以上の整数で入力してください。');
    payload.fields = { qty };
  }
  await api(`/api/cases/${encodeURIComponent(id)}/actions`, { method: 'POST', body: payload });
  const message = action === 'chat' ? '相談を送りました。' : '希望の数を返しました。';
  form.reset();
  state.selectedCase = null;
  state.cases = [];
  render();
  try {
    await loadCases({ selectFirst: false });
    state.selectedCase = await getCase(id);
    if (state.tab === 'admin') await loadOutbox();
    render();
    notice(message);
  } catch (error) {
    render();
    notice(`${message}表示の更新に失敗しました。「一覧を更新」を押してください。\n${error.message}`, 'warning');
  }
}

function hasReturnedBranches(item) {
  return boxKind(currentStep(item) ?? {}) === 'parallel' && (currentStep(item)?.branches ?? []).some((branch) => branch.state === 'returned');
}

function actionLabel(item, action) {
  if (action === 'approve' && item.style === 'chat') return approvalMark(currentStep(item) ?? {}) === 'decision' ? '決裁して次へ回す' : '承認して次へ回す';
  return action === 'resubmit' && hasReturnedBranches(item) ? 'この枝を直して出し直す' : actions[action];
}

function renderParallelProgress(step, index, item) {
  const labels = { waiting: 'まだ', current: '確かめ中', done: '確認済み', returned: '差し戻し中' };
  const branches = step.branches ?? [];
  return `<li class="case-step parallel-progress"${step.id === item.currentStepId ? ' aria-current="step"' : ''}><div class="step-content"><h4>${index + 1}. ${e(step.label || '並行の入れ物')}</h4><p class="hint">全部そろったら次へ</p>${branches.some((branch) => branch.state === 'returned') ? '<p class="branch-note">差し戻しはこの枝だけ。ほかの枝はそのまま進みます</p>' : ''}<ul class="branch-lanes">${branches.map((branch) => {
    const status = Object.hasOwn(labels, branch.state) ? branch.state : 'waiting';
    return `<li class="branch-lane ${status}"><div class="branch-heading"><strong>${e(roleName(branch.role))}</strong><span class="badge ${status}">${e(branch.stateLabel || labels[status])}</span></div><p>担当：${(branch.people ?? []).map((person) => e(personName(person))).join('、') || '担当の指定なし'}</p>${branch.doneBy?.length ? `<p>確認した人：${branch.doneBy.map((person) => e(personName(person))).join('、')}</p>` : ''}${status === 'returned' ? `<p>差し戻した人：${e(personName(branch.returnedBy))}</p><p>理由：${e(branch.reason || '理由の表示はありません')}</p>` : ''}</li>`;
  }).join('')}</ul>${branches.length ? '' : '<p class="hint">確かめる課はありません。</p>'}</div></li>`;
}

function renderActionButtons(item, allowed = null) {
  return permitted(item).filter((action) => !['chat', 'revise', 'answer'].includes(action) && Object.hasOwn(actions, action) && (!allowed || allowed.includes(action))).map((action) => `<button type="button" class="${action === 'approve' ? 'primary' : ['reject', 'withdraw'].includes(action) ? 'danger' : ''}" data-command="case-action" data-case="${e(item.id)}" data-action="${action}">${e(actionLabel(item, action))}</button>`).join('');
}

async function getCase(id) {
  const response = await api(`/api/cases/${encodeURIComponent(id)}`);
  const item = response?.case ?? response;
  if (!item?.id) throw new Error('案件の詳細を読み取れませんでした。');
  return item;
}

async function loadCases({ selectFirst = true } = {}) {
  const view = { mine: 'mine', todo: 'todo', admin: 'all' }[state.tab];
  if (!view) return;
  const params = new URLSearchParams({ view, q: state.caseQueries[state.tab] });
  const response = await api(`/api/cases?${params}`);
  state.cases = [...list(response, 'cases', 'items')];
  if (view === 'todo' || view === 'all') state.cases.sort((a, b) => stalledDays(b) - stalledDays(a));
  const id = state.cases.some((item) => item.id === state.selectedCase?.id) ? state.selectedCase.id : selectFirst ? state.cases[0]?.id : null;
  state.selectedCase = null;
  render();
  if (id) {
    state.selectedCase = await getCase(id);
    render();
  }
}

async function loadOutbox() {
  const response = await api('/api/outbox');
  state.outbox = list(response, 'outbox', 'messages', 'items');
}

async function loadTab() {
  if (!state.actor) { render(); return; }
  if (['apply', 'settings'].includes(state.tab)) await loadCaseTypes();
  if (state.tab === 'settings') await loadOrgSettings();
  if (['mine', 'todo', 'admin'].includes(state.tab)) {
    if (state.tab === 'admin') await loadOutbox();
    await loadCases();
  }
  render();
}

function tableSection(id, title, description, columns, rows, emptyText) {
  return `<section class="panel settings-section" aria-labelledby="${id}"><h3 id="${id}">${e(title)}</h3><p class="hint">${e(description)}</p>${rows.length ? `<div class="table-scroll"><table class="settings-table"><thead><tr>${columns.map((column) => `<th scope="col">${e(column)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p>${e(emptyText)}</p>`}</section>`;
}

function dayText(value, fallback = '指定なし') {
  if (!value) return fallback;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : '日付を確認してください';
}

function renderSettings() {
  const assignments = state.org.assignments ?? [];
  // 担当と代理は職員IDで持つ。名前は表示用に添える
  const staffId = (personId) => state.org.people.find((person) => person.id === personId)?.staffId ?? '未登録';
  const today = state.org.today ?? '';
  const holdersOf = (roleId) => assignments.filter((item) => item.role === roleId && (!item.from || item.from <= today) && (!item.to || today <= item.to)).map((item) => item.person);
  const proxyText = (roleId) => {
    const rule = (state.org.proxyOrder ?? []).find((item) => item.role === roleId);
    const list = (rule?.proxies ?? []).map((proxy) => {
      const role = typeof proxy === 'string' ? proxy : proxy.role;
      const limit = typeof proxy === 'object' && proxy.maxAmount != null ? `（${Number(proxy.maxAmount).toLocaleString('ja-JP')}円まで）` : '';
      const people = holdersOf(role).map((id) => `${staffId(id)} ${personName(id)}`).join('・') || '担当者なし';
      return `${roleName(role)}：${people}${limit}`;
    });
    return list.join(' ／ ') || '代理なし';
  };
  const rows = assignments.map((assignment) => `<tr><td>${e(roleName(assignment.role))}</td><td><code class="staff-id">${e(staffId(assignment.person))}</code></td><td>${e(personName(assignment.person))}</td><td>${e(proxyText(assignment.role))}</td><td>${e(dayText(assignment.from))}</td><td>${e(dayText(assignment.to, '期限なし'))}</td></tr>`);
  for (const role of state.org.roles ?? []) {
    if (!assignments.some((assignment) => assignment.role === role.id)) rows.push(`<tr><td>${e(role.name)}</td><td>—</td><td>担当者の登録なし</td><td>${e(proxyText(role.id))}</td><td>—</td><td>—</td></tr>`);
  }
  const amounts = (state.org.amountTables ?? []).flatMap((table) => (table.rows ?? []).map((row) => `<tr><td>第${e(table.version ?? '—')}版</td><td>${e(dayText(table.from))}</td><td>${row.upTo == null ? '上限なし' : `${e(Number(row.upTo).toLocaleString('ja-JP'))}円以下`}</td><td>${(row.approvers ?? []).map((role) => e(roleName(role))).join(' → ') || '決裁者なし'}</td></tr>`));
  const absence = state.absenceDraft;
  const settings = state.settingsDraft ?? state.org.settings;
  const flags = [['showReturnReason', '差し戻しの理由を申請者に見せる'], ['allowOffCampusApproval', '学外からの承認を認める'], ['allowMailApproval', 'メールの返信で承認できる']];
  return `${heading('02 / 表と設定', '表と設定', '案件の種類から組織全体の決まりまで、順に確かめられます。', '<button type="button" data-command="refresh-settings">表と設定を更新</button>')}
    ${renderCaseTypesTable()}
    ${state.settingsError ? `<p class="notice error" role="alert">表と設定を読み込めませんでした。${e(state.settingsError)} 「表と設定を更新」で読み直してください。</p>` : ''}
    ${renderGlossary()}
    ${renderBuildFlags()}
    ${tableSection('assignments-title', '役職と人の対応表', '誰がどの役職かの表です。担当と代理は職員ID（職員番号など、組織で使っている番号）で持ち、名前は表示用に添えています。異動の切り替え日もここで分かります(試作では見るだけ)。', ['役職名', '担当の職員ID', '担当の名前', '代理（職員ID・名前）', 'いつから', 'いつまで'], rows, '役職と人の対応はまだありません。')}
    ${tableSection('org-amount-title', '金額マスター', '金額で決裁者が決まる表です。直すときは、ルートを組む画面で決裁の箱を開いてください。', ['版', 'いつから', '上限金額', '決裁する役職'], amounts, '金額マスターはまだありません。')}
    <section class="panel settings-section" aria-labelledby="absences-title"><h3 id="absences-title">不在の予定</h3><p class="hint">予定された不在です。期間中、その人の箱は代理へ回ります。</p>
    ${(state.org.absences ?? []).length ? `<div class="table-scroll"><table class="settings-table"><thead><tr><th scope="col">人</th><th scope="col">から</th><th scope="col">まで</th><th scope="col">理由</th><th scope="col">操作</th></tr></thead><tbody>${state.org.absences.map((item) => `<tr><td>${e(personName(item.person))}</td><td>${e(dayText(item.from))}</td><td>${e(dayText(item.to))}</td><td>${e(item.reason || '記載なし')}</td><td><button type="button" class="danger" data-command="delete-absence" data-absence="${e(item.id)}" aria-label="${e(personName(item.person))}の${e(dayText(item.from))}からの不在予定を削除"${state.settingsError ? ' disabled' : ''}>削除</button></td></tr>`).join('')}</tbody></table></div>` : '<p>不在の予定はありません。</p>'}
    <hr class="section-divider"><form id="absence-form"><h4>不在の予定を追加</h4><div class="field-grid"><div class="field"><label for="absence-person">人<span class="required">必須</span></label><select id="absence-person" data-absence-field="person" required>${option('', '人を選んでください', absence.person)}${state.org.people.map((person) => option(person.id, person.name, absence.person)).join('')}</select></div><div class="field"><label for="absence-from">から<span class="required">必須</span></label><input id="absence-from" data-absence-field="from" type="date" required value="${e(absence.from)}"></div><div class="field"><label for="absence-to">まで<span class="required">必須</span></label><input id="absence-to" data-absence-field="to" type="date" required min="${e(absence.from)}" value="${e(absence.to)}"></div><div class="field"><label for="absence-reason">理由</label><input id="absence-reason" data-absence-field="reason" value="${e(absence.reason)}"></div></div><button type="submit" class="primary"${state.settingsError ? ' disabled' : ''}>不在の予定を追加</button></form></section>
    <section class="panel settings-section" aria-labelledby="settings-title"><h3 id="settings-title">組織の設定</h3><p class="hint">組織全体の決まりです。</p><form id="settings-form"><div class="settings-options">${flags.map(([key, label]) => `<label class="checkbox"><input type="checkbox" data-setting="${key}"${settings[key] === true ? ' checked' : ''}>${e(label)}</label>`).join('')}</div><div class="field"><label for="council-max">合議の人数の上限</label><input id="council-max" type="number" min="1" step="1" data-setting="councilMaxMembers" value="${e(settings.councilMaxMembers ?? '')}" placeholder="指定なし"><p class="hint">空欄は組織での上限指定なしです。</p></div><div class="button-row"><span id="settings-dirty" class="badge dirty"${state.settingsDirty ? '' : ' hidden'}>未保存の変更</span><button type="submit" class="primary"${state.settingsError ? ' disabled' : ''}>組織の設定を保存</button></div></form></section>`;
}

// ---------- 用語辞書: 画面に出る言葉だけを組織ごとに切り替える(中の仕組みは同じ) ----------
let glossaryPattern = null;
let glossaryMap = new Map();
function refreshGlossary() {
  const rows = (state.org.glossary?.rows ?? []).filter((row) => row.word && row.word !== row.base);
  glossaryMap = new Map(rows.map((row) => [row.base, row.word]));
  const keys = [...glossaryMap.keys()].sort((a, b) => b.length - a.length).map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  glossaryPattern = keys.length ? new RegExp(keys.join('|'), 'g') : null;
}
const GLOSSARY_SKIP = 'script, style, textarea, input, .chat-messages, .no-glossary, code';
function applyGlossary(root = document.body) {
  if (!glossaryPattern || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (node) => (node.parentElement?.closest(GLOSSARY_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    glossaryPattern.lastIndex = 0;
    if (glossaryPattern.test(node.data)) { glossaryPattern.lastIndex = 0; node.data = node.data.replace(glossaryPattern, (word) => glossaryMap.get(word) ?? word); }
  }
}
new MutationObserver((records) => {
  if (!glossaryPattern) return;
  for (const record of records) for (const node of record.addedNodes) {
    if (node.nodeType === Node.TEXT_NODE) applyGlossary(node.parentElement);
    else if (node.nodeType === Node.ELEMENT_NODE) applyGlossary(node);
  }
}).observe(document.documentElement, { childList: true, subtree: true });

function renderGlossary() {
  const g = state.org.glossary;
  if (!g) return '';
  const admin = isAdminActor();
  const draft = state.glossaryDraft ?? {};
  const presetOptions = Object.entries(g.presets ?? {}).map(([id, name]) => option(id, name, state.glossaryPreset ?? g.preset)).join('');
  const rows = g.rows.filter((row) => row.main !== false).map((row, index) => `<tr><th scope="row">${e(row.standard)}</th><td><label class="visually-hidden" for="glossary-${index}">「${e(row.standard)}」をこの組織で何と呼ぶか</label><input id="glossary-${index}" data-glossary-term="${e(row.base)}" maxlength="20" value="${e(draft[row.base] ?? row.word)}"${admin ? '' : ' disabled'}></td><td>${e(row.company)}</td><td>${e(row.university)}</td><td>${row.checked ? '<span class="badge">一般的</span>' : `<span class="badge dirty" title="${e(row.note || '')}">未確認</span>`}${row.note ? `<p class="hint">${e(row.note)}</p>` : ''}</td></tr>`).join('');
  const log = (state.org.glossaryLog ?? []).slice(0, 10).map((item) => `<li><span class="muted">${e(dateText(item.at))}</span> ${e(item.text)}</li>`).join('');
  return `<section class="panel settings-section no-glossary" aria-labelledby="glossary-title"><h3 id="glossary-title">用語辞書（画面に出る言葉）</h3>
    <p class="hint">画面の言葉は、だれでも分かる動きの言葉（標準）が基本です。組織に合わせて業界の言葉に切り替えられます。箱の種類や動きは変わりません。「未確認」は、出典の規程でまだ確かめていない言葉です。変えられるのは組織の管理者（事務局）だけです。</p>
    <p>今のひな形：<strong>${e(g.presetName)}</strong></p>
    <div class="button-row"><label for="glossary-preset">ひな形</label><select id="glossary-preset"${admin ? '' : ' disabled'}>${presetOptions}</select><button type="button" data-command="apply-glossary-preset"${admin ? '' : ' disabled'}>ひな形を当てる</button></div>
    <div class="table-scroll"><table class="settings-table glossary-table"><thead><tr><th scope="col">わかりやすい言葉（標準）</th><th scope="col">この組織での言葉</th><th scope="col">会社向け</th><th scope="col">大学・役所向け</th><th scope="col">確かめ</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="button-row"><button type="button" class="primary" data-command="save-glossary"${admin ? '' : ' disabled'}>言葉を保存</button></div>
    ${log ? `<h4>辞書を変えた記録</h4><ol class="build-flag-log">${log}</ol>` : ''}</section>`;
}

async function saveGlossary(body, message) {
  const saved = await api('/api/glossary', { method: 'PUT', body: { as: state.actor, ...body } });
  state.glossaryDraft = {};
  state.glossaryPreset = null;
  // 前の言葉に置きかえ済みの文字を元に戻すため、画面を読み直す(作る画面の「表と設定」に戻る)
  try { sessionStorage.setItem('glossary-notice', message ?? `用語辞書を保存しました（${saved.presetName}）。`); sessionStorage.setItem('glossary-return', JSON.stringify({ actor: state.actor })); } catch {}
  location.reload();
}

function renderBuildFlags() {
  const people = state.org.people ?? [];
  const units = [...(state.org.units ?? [])];
  for (const person of people) if (!units.some((unit) => unit.id === person.unit)) units.push({ id: person.unit, name: '所属なし' });
  const today = state.org.today ?? '';
  const roleText = (personId) => (state.org.assignments ?? []).filter((item) => item.person === personId && (!item.from || item.from <= today) && (!item.to || today <= item.to)).map((item) => roleName(item.role)).join('・') || '役職なし';
  const groups = units.map((unit) => {
    const members = people.filter((person) => person.unit === unit.id);
    if (!members.length) return '';
    const manageable = canManageUnit(unit.id);
    const managers = (state.org.unitManagers?.[unit.id] ?? []).map(personName);
    const who = managers.length ? `${managers.join('・')}・事務局` : '事務局';
    return `<div class="build-flag-unit"><h4>${e(unit.name)} <span class="muted">（切り替えられる人：${e(who)}）</span></h4><div class="table-scroll"><table class="settings-table build-flag-table"><thead><tr><th scope="col">職員ID</th><th scope="col">人</th><th scope="col">役職</th><th scope="col">作る権限</th></tr></thead><tbody>${members.map((person) => {
      const on = person.canBuild !== false;
      return `<tr data-person="${e(person.id)}"><td><code class="staff-id">${e(person.staffId ?? '未登録')}</code></td><td>${e(person.name)}</td><td>${e(roleText(person.id))}</td><td><button type="button" class="flag-toggle${on ? ' on' : ''}" data-command="toggle-can-build" data-person="${e(person.id)}" aria-pressed="${on}" aria-label="${e(person.name)}の作る権限（今は${on ? 'あり' : 'なし'}）"${manageable && !state.settingsError ? '' : ' disabled'}>${on ? 'あり' : 'なし'}</button></td></tr>`;
    }).join('')}</tbody></table></div></div>`;
  }).join('');
  const log = state.org.buildFlagLog ?? [];
  const logRows = log.slice(0, 30).map((item) => `<li><span class="muted">${e(dateText(item.at))}</span> ${e(item.text)}</li>`).join('');
  return `<section class="panel settings-section" aria-labelledby="build-flags-title"><h3 id="build-flags-title">作る権限（課ごとの人）</h3><p class="hint">基本は全員が「使う」と「作る」の両方を使えます。各課の管理者が、人ごとに作る権限を付け外しできます。試作では、なしにしても作る画面はまだ使えます（見え方の確認用）。</p>${groups}
    <h4 id="build-flag-log-title">切り替えの記録</h4>${log.length ? `<ol class="build-flag-log" aria-labelledby="build-flag-log-title">${logRows}</ol>` : '<p class="hint">まだ切り替えた記録はありません。</p>'}</section>`;
}

async function toggleCanBuild(personId) {
  if (state.settingsError) throw new Error('表と設定を読み直してから切り替えてください。');
  const person = state.org.people.find((item) => item.id === personId);
  if (!person) throw new Error('その人が見つかりません。');
  const value = person.canBuild === false;
  await api(`/api/people/${encodeURIComponent(personId)}/can-build`, { method: 'PUT', body: { as: state.actor, value } });
  await loadOrgSettings();
  render();
  notice(`${person.name}さんの作る権限を${value ? 'あり' : 'なし'}にしました。切り替えの記録に残しました。`);
}

async function loadOrgSettings() {
  try {
    const org = await api('/api/org');
    if (!org || !Array.isArray(org.people)) throw new Error('組織情報の形式を確認してください。');
    state.org = { settings: {}, roles: [], units: [], ...org };
    refreshGlossary();
    state.settingsError = '';
    if (!state.settingsDirty) state.settingsDraft = clone(state.org.settings);
  } catch (error) {
    state.settingsError = error.message;
  }
}

async function saveSettings() {
  if (!canBuild() || state.settingsError) throw new Error('表と設定を読み直してから保存してください。');
  const draft = state.settingsDraft;
  const max = draft.councilMaxMembers;
  const councilMaxMembers = max === '' || max == null ? null : Number(max);
  if (councilMaxMembers !== null && (!Number.isInteger(councilMaxMembers) || councilMaxMembers < 1)) throw new Error('合議の人数の上限は1以上の整数で入力してください。');
  const values = { showReturnReason: draft.showReturnReason === true, allowOffCampusApproval: draft.allowOffCampusApproval === true, allowMailApproval: draft.allowMailApproval === true, councilMaxMembers };
  const saved = await api('/api/settings', { method: 'PUT', body: { as: state.actor, values } });
  state.org.settings = saved;
  state.settingsDraft = clone(saved);
  state.settingsDirty = false;
  render();
  notice('組織の設定を保存しました。');
}

async function addAbsence() {
  if (!canBuild() || state.settingsError) throw new Error('表と設定を読み直してから追加してください。');
  const draft = state.absenceDraft;
  if (!draft.person || !draft.from || !draft.to || draft.from > draft.to) throw new Error('不在の人と期間を正しく入力してください。');
  const saved = await api('/api/absences', { method: 'POST', body: { as: state.actor, ...draft, reason: draft.reason.trim() } });
  state.org.absences = [...(state.org.absences ?? []), saved];
  state.absenceDraft = { person: '', from: '', to: '', reason: '' };
  render();
  notice('不在の予定を追加しました。');
}

async function deleteAbsence(id) {
  if (!canBuild() || state.settingsError) throw new Error('表と設定を読み直してから削除してください。');
  await api(`/api/absences/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.org.absences = (state.org.absences ?? []).filter((item) => item.id !== id);
  render();
  notice('不在の予定を削除しました。');
}

function renderAdmin() {
  return `${heading('03 / 全体の見守り', '流れ全体を見守る', '止まっている箱を確かめ、必要なときだけ代理や上位の役職へ回します。', '<button type="button" data-command="refresh-admin">見守り情報を更新</button>')}
    ${renderCaseSearch()}
    <div class="case-workspace"><aside aria-label="全案件の一覧">${renderCaseList()}</aside><div id="case-detail">${state.selectedCase ? renderCaseDetail(state.selectedCase) : empty('全案件の流れ', '案件を選ぶと、止まっている箱と操作を確認できます。')}</div></div><hr class="section-divider">
    <div class="admin-grid"><section class="panel" aria-labelledby="outbox-title"><div class="panel-heading"><h3 id="outbox-title">送信箱</h3><span class="badge">${state.outbox.length}件</span></div><p class="hint">実際のメールは送信せず、送ったことにした知らせを表示します。</p>${renderOutbox()}</section>
    <div><form id="mail-form" class="panel"><h3>メール返信の試し</h3><p class="hint">送信箱の番号と、その知らせを受け取った人を指定します。</p><div class="field"><label for="mail-from">差出人<span class="required">必須</span></label><select id="mail-from" required>${option('', '選んでください', state.mail.from)}${state.org.people.map((person) => option(person.id, person.name, state.mail.from)).join('')}</select></div><div class="field"><label for="mail-token">使い捨ての番号<span class="required">必須</span></label><input id="mail-token" required value="${e(state.mail.token)}" autocomplete="off"></div><div class="field"><label for="mail-body">返信の本文<span class="required">必須</span></label><textarea id="mail-body" required>${e(state.mail.body)}</textarea><p class="hint">例：承認 ／ 差し戻し：見積書を追加してください。決裁の箱はメールでは決められません。</p></div><button type="submit" class="primary">返信を受け取らせる</button></form>
    <section class="panel danger-zone"><h3>試作データを最初に戻す</h3><p>案件や送信箱などを初期状態に戻します。実行前に、確認を表示します。</p><button type="button" class="danger" data-command="reset">データを最初に戻す</button></section></div></div>`;
}

function renderCaseTypesTable() {
  return `<section class="panel" aria-labelledby="case-types-title"><div class="panel-heading"><h3 id="case-types-title">案件の種類(起案で選ぶ名前と使うルート)</h3><div class="button-row"><span id="case-types-dirty" class="badge dirty"${state.caseTypesDirty ? '' : ' hidden'}>未保存の変更</span><button type="button" data-command="add-case-type"${state.caseTypesError ? ' disabled' : ''}>＋ 行を追加</button><button type="button" class="primary" data-command="save-case-types"${state.caseTypesError ? ' disabled' : ''}>案件の種類を保存</button></div></div><p class="hint">起案するときに選ぶ名前と、その案件が通るルートを決めます。</p>${state.caseTypesError ? `<p class="notice error" role="alert">案件の種類を読み込めませんでした。${e(state.caseTypesError)}</p>` : `<div class="table-scroll"><table class="case-types-table"><thead><tr><th scope="col">名前</th><th scope="col">使う型</th><th scope="col">型</th><th scope="col">使う／使わない</th><th scope="col">行の操作</th></tr></thead><tbody>${state.caseTypesDraft.map((item, index) => `<tr><td><label class="visually-hidden" for="case-type-name-${index}">${index + 1}行目の名前</label><input id="case-type-name-${index}" data-case-type-index="${index}" data-case-type-field="name" value="${e(item.name)}" required></td><td><label class="visually-hidden" for="case-type-template-${index}">${index + 1}行目の使う型</label><select id="case-type-template-${index}" data-case-type-index="${index}" data-case-type-field="templateId">${option('', '型を選んでください', item.templateId)}${item.templateId && !state.templates.some((template) => template.id === item.templateId) ? option(item.templateId, '型を選び直してください', item.templateId) : ''}${state.templates.map((template) => option(template.id, template.name, item.templateId)).join('')}</select></td><td><label class="visually-hidden" for="case-type-style-${index}">${index + 1}行目の型</label><select id="case-type-style-${index}" data-case-type-index="${index}" data-case-type-field="style">${option('chat', 'チャット型', item.style ?? 'normal')}${option('normal', 'ふつうの型', item.style ?? 'normal')}</select></td><td><label class="visually-hidden" for="case-type-active-${index}">${index + 1}行目を使うか</label><select id="case-type-active-${index}" data-case-type-index="${index}" data-case-type-field="active">${option('true', '使う', item.active !== false)}${option('false', '使わない', item.active !== false)}</select></td><td><button type="button" class="danger" data-command="delete-case-type" data-index="${index}" aria-label="${index + 1}行目を削除">削除</button></td></tr>`).join('')}</tbody></table></div>${state.caseTypesDraft.length ? '' : '<p class="hint">種類がありません。「行を追加」で登録できます。</p>'}`}</section>`;
}

async function saveCaseTypes() {
  if (state.caseTypesError) throw new Error('案件の種類を読み直してから保存してください。');
  const items = state.caseTypesDraft.map((item) => ({ id: item.id, name: item.name.trim(), templateId: item.templateId, style: item.style === 'chat' ? 'chat' : 'normal', active: item.active !== false }));
  if (items.some((item) => !item.name)) throw new Error('すべての行に名前を入力してください。');
  if (items.some((item) => !state.templates.some((template) => template.id === item.templateId))) throw new Error('すべての行で使う型を選んでください。');
  await api('/api/case-types', { method: 'PUT', body: { as: state.actor, items } });
  state.caseTypes = clone(items);
  state.caseTypesDraft = clone(items);
  state.caseTypesDirty = false;
  if (!activeCaseTypes().some((item) => item.id === state.applyCaseType)) { state.applyCaseType = activeCaseTypes()[0]?.id ?? ''; state.applyValues = {}; }
  render();
  notice('案件の種類の表を保存しました。これからの起案に使われます。');
}

function renderOutbox() {
  if (!state.outbox.length) return '<p class="hint">まだ知らせはありません。</p>';
  return `<ol class="outbox-list">${[...state.outbox].reverse().map((message) => {
    const recipients = Array.isArray(message.to) ? message.to : message.to ? [message.to] : [];
    const from = recipients.map((person) => typeof person === 'object' ? person.id : person).find((id) => state.org.people.some((person) => person.id === id));
    const index = state.outbox.indexOf(message);
    return `<li class="outbox-message"><h4>${e(message.subject ?? message.title ?? 'お知らせ')}</h4><p class="muted">宛先：${recipients.map((person) => e(personName(person))).join('、') || '宛先の情報なし'}<br>${e(dateText(message.at ?? message.createdAt))}</p><p class="message-body">${e(message.body ?? message.text ?? message.message ?? '')}</p>${message.token ? `<span class="muted">返信に使う番号</span><code class="token">${e(message.token)}</code><button type="button" data-command="use-token" data-index="${index}" data-from="${e(from ?? '')}">この番号で返信を試す</button>` : ''}</li>`;
  }).join('')}</ol>`;
}

function openDialog(content, context) {
  dialogContext = context;
  $('#action-dialog').classList.toggle('builder-dialog', context.type === 'builder');
  $('#dialog-content').innerHTML = content;
  lockControls();
  $('#action-dialog').showModal();
}

function closeDialog() {
  $('#action-dialog').close();
  dialogContext = null;
}

async function prepareAction(id, action, revisedFields = {}) {
  const item = await getCase(id);
  if (!permitted(item).includes(action)) throw new Error('この操作は、今選ばれている人には許可されていません。一覧を更新してください。');
  const activeStep = currentStep(item);
  const twoFA = action === 'approve' && activeStep && boxKind(activeStep) === 'approval' && approvalMark(activeStep) === 'decision';
  const reasonRequired = reasonActions.has(action);
  const docRequired = action === 'addDoc';
  const title = twoFA ? '二要素認証（試作）' : actionLabel(item, action);
  const template = state.templates.find((template) => template.id === item.templateId);
  if (action === 'redraft' && !template) throw new Error('この案件で使う型を読み込めませんでした。「情報を再読込」で読み直してください。');
  const redraftValues = { deadline: item.deadline ?? '', ...item.fields, ...revisedFields };
  openDialog(`<form id="action-form"><h2 id="dialog-title">${e(title)}</h2><p class="dialog-context">文書番号 ${e(caseDocNo(item))} · ${e(item.title)}<br>今の箱：${e(currentLabel(item))}</p>
    ${action === 'revise' ? `<div class="field-grid">${Object.entries(item.fields ?? {}).map(([key, value], index) => `<div class="field"><label for="revision-field-${index}">${e(caseFieldLabel(item, key))}</label><input id="revision-field-${index}" data-revision-field="${e(key)}" type="${key === 'amount' ? 'number' : 'text'}"${key === 'amount' ? ' required min="0" step="any"' : ''} value="${e(value)}"></div>`).join('')}</div><div class="field"><label for="revision-memo">ひとこと（任意）</label><textarea id="revision-memo"></textarea></div>` : ''}
    ${action === 'redraft' ? `<p class="hint">元の案件を取り下げ、新しい案件を起案箱から始めます。書類名は引き継ぎます。</p><div class="field"><label for="redraft-title">件名<span class="required">必須</span></label><input id="redraft-title" required maxlength="200" value="${e(revisedFields.title ?? item.title)}"></div><div class="field"><label for="redraft-purpose">目的</label><textarea id="redraft-purpose">${e(revisedFields.purpose ?? item.purpose ?? '')}</textarea></div>${applicationFields(template).filter((field) => !['title', 'purpose'].includes(field.key)).map((field, index) => renderApplicationField(field, `redraft-${index}`, redraftValues)).join('')}` : ''}
    ${twoFA ? '<div class="subtle-box" style="margin-top:1rem"><p>決裁の前に、本人が操作していることを確認します。</p><p>試作版では確認の印を記録します。</p></div><div class="field"><label class="checkbox"><input type="checkbox" id="two-fa" required>私本人が、内容を確認して決裁します</label></div>' : ''}
    ${reasonRequired || action === 'markOrdered' ? `<div class="field"><label for="action-reason">${action === 'markOrdered' ? '発注メモ' : '理由'}${reasonRequired ? '<span class="required">必須</span>' : ''}</label><textarea id="action-reason"${reasonRequired ? ' required' : ''} placeholder="${action === 'markOrdered' ? '発注先や発注内容を記入できます' : '相手に伝わるよう、理由を入力してください'}"></textarea></div>` : ''}
    ${docRequired ? '<div class="field"><label for="action-doc">追加する書類名<span class="required">必須</span></label><input id="action-doc" required placeholder="例：見積書"><p class="hint">同じ書類名を追加したときの版は、サーバー側で記録します。</p></div>' : ''}
    ${action === 'return' ? `<p class="hint">${boxKind(activeStep ?? {}) === 'parallel' ? 'この枝だけ申請者へ差し戻します。ほかの枝はそのまま進みます。' : '申請者へ差し戻します（軽微な修正）。直して出すと、通過済みの段を飛ばしてこの箱へ直接戻ります。飛ばした段の人にはCCで知らせます。'}</p>` : ''}
    ${action === 'withdraw' ? '<p>申請者からの引き戻し: この申請を手元に戻しますか？ これまでに承認した人にはCCで知らせます。直したら「直して出し直す」を押してください。金額の段が変わるときは、起案からやり直しになります。</p>' : ''}
    ${action === 'resubmit' && !hasReturnedBranches(item) && item.fields && 'amount' in item.fields ? `<div class="field"><label for="action-amount">金額(直すときだけ)</label><input id="action-amount" type="number" value="${e(item.fields.amount)}"></div>` : ''}
    ${action === 'cancel' ? '<p>この申請を取り下げて終わりにしますか？</p>' : ''}
    ${action === 'memo' ? '<div class="field"><label for="action-memo">メモ<span class="required">必須</span></label><textarea id="action-memo" required></textarea></div><div class="field"><label for="action-visibility">見せる範囲</label><select id="action-visibility"><option value="public">申請者にも見せる</option><option value="internal">内部だけ</option></select></div>' : ''}
    ${action === 'markSubmitted' ? '<p class="hint">控えの書類を追加済みか確認してください。足りない場合はサーバー側で操作が止まります。</p>' : ''}
    ${action === 'resubmit' && hasReturnedBranches(item) ? '<p class="branch-note">差し戻された枝だけ出し直します。ほかの枝の確認はそのまま残ります。</p>' : ''}<p id="dialog-error" class="notice error" role="alert" hidden></p><div class="button-row"><button type="button" data-command="close-dialog">やめる</button><button type="submit" class="${['reject', 'withdraw'].includes(action) ? 'danger' : 'primary'}">${e(action === 'revise' ? '直して知らせる' : actionLabel(item, action))}</button></div></form>`, { type: 'action', item, action, twoFA, reasonRequired, docRequired });
}

async function saveTemplate(simulate = false) {
  if (!state.draft) throw new Error('ルートの型を選んでください。');
  ensureDraftStep(state.draft);
  const draft = clone(state.draft);
  const path = `/api/templates/${encodeURIComponent(draft.id)}`;
  state.simulation = await api(`${path}/simulate`, { method: 'POST', body: draft });
  const errors = Number(state.simulation.errors) || list(state.simulation, 'items').filter((item) => item.level === 'error').length;
  const warnings = Number(state.simulation.warnings) || list(state.simulation, 'items').filter((item) => item.level === 'warn').length;
  state.saveMessage = '';
  if (simulate) {
    render();
    $('#simulation-title')?.scrollIntoView({ block: 'start', behavior: 'instant' });
    return;
  }
  if (state.simulation.canSave === false || errors > 0) {
    state.saveMessage = `要修正が${errors}件あるため保存できません。赤い箱を直してください`;
    render();
    return;
  }
  try { validateTemplate(); }
  catch (error) { state.saveMessage = error.message; render(); return; }
  try { await api(path, { method: 'PUT', body: { ...draft, as: state.actor } }); }
  catch (error) {
    if (error.code !== 'needsFix') throw error;
    state.simulation = await api(`${path}/simulate`, { method: 'POST', body: draft });
    state.saveMessage = `要修正が${state.simulation.errors || 1}件あるため保存できません。赤い箱を直してください`;
    render();
    return;
  }
  const index = state.templates.findIndex((template) => template.id === draft.id);
  if (index >= 0) state.templates[index] = clone(draft);
  state.dirty = false;
  state.dirtySteps.clear();
  state.saveMessage = warnings ? `注意が${warnings}件あります` : '保存しました';
  render();
  notice(`ルートの型を保存しました。これからの申請に使われます。${warnings ? `注意が${warnings}件あります。` : ''}`);
}

async function submitApplication(form) {
  const title = $('#apply-title', form).value.trim();
  if (!title) throw new Error('件名を入力してください。空白だけでは起案できません。');
  if (state.caseTypesError) throw new Error('案件の種類を読み直してから起案してください。');
  const caseType = activeCaseTypes().find((item) => item.id === state.applyCaseType);
  if (!caseType) throw new Error('案件の種類を選んでください。');
  const template = state.templates.find((item) => item.id === caseType.templateId);
  if (!template) throw new Error('この種類は現在起案できません。事務局にお問い合わせください。');
  const purpose = $('#apply-purpose', form).value.trim();
  const fields = readApplicationFields(form);
  const deadline = fields.deadline;
  if (template.deadline?.required && !deadline) throw new Error('締切日を入力してください。');
  const message = caseType.style === 'chat' ? ($('#apply-message', form)?.value ?? '').trim() : '';
  const response = await api('/api/cases', { method: 'POST', body: { as: state.actor, caseTypeId: caseType.id, title, purpose, fields, docs: words($('#apply-docs', form).value), ...(deadline ? { deadline } : {}), ...(message ? { message } : {}) } });
  const created = response?.case ?? response;
  state.applyTitle = '';
  state.applyPurpose = '';
  state.applyDocs = '';
  state.applyValues = {};
  state.applyMessage = '';
  state.tab = 'mine';
  state.selectedCase = created?.id ? created : null;
  state.cases = [];
  render();
  notice(`起案を受け付けました${created?.id ? `（${created.id}）` : ''}。`);
  try {
    await loadCases({ selectFirst: false });
    // 起案したら、その案件を開いてチャットの欄へ
    if (created?.id) { state.selectedCase = await getCase(created.id); render(); $('#case-chat-title')?.scrollIntoView({ block: 'start' }); }
  } catch (error) { notice(`起案は受け付けました。一覧の再読込に失敗しました。「一覧を更新」を押してください。\n${error.message}`, 'warning'); }
}

function dialogError(message) {
  const element = $('#dialog-error');
  if (element) { element.textContent = message; element.hidden = false; }
}

async function performAction(form) {
  const context = dialogContext;
  if (!context || context.type !== 'action') return;
  const reason = $('#action-reason', form)?.value.trim() ?? '';
  const doc = $('#action-doc', form)?.value.trim() ?? '';
  if (context.reasonRequired && !reason) { dialogError('理由を入力してください。空白だけでは実行できません。'); return; }
  if (context.docRequired && !doc) { dialogError('書類名を入力してください。'); return; }
  if (context.twoFA && !$('#two-fa', form)?.checked) { dialogError('本人による確認にチェックを入れてください。'); return; }
  const payload = { as: state.actor, action: context.action };
  if (context.action === 'revise') {
    const fields = {};
    for (const input of $$('[data-revision-field]', form)) {
      const value = input.type === 'number' ? Number(input.value) : input.value.trim();
      if (input.type === 'number' && (input.value === '' || !Number.isFinite(value) || value < 0)) { dialogError('金額は0以上の数値で入力してください。'); return; }
      fields[input.dataset.revisionField] = value;
    }
    payload.fields = fields;
    payload.memo = $('#revision-memo', form).value.trim();
  }
  if (reason) payload.reason = reason;
  if (doc) payload.doc = doc;
  if (context.action === 'return') payload.to = 'applicant';
  if (context.action === 'memo') {
    payload.memo = $('#action-memo', form)?.value.trim() ?? '';
    if (!payload.memo) { dialogError('メモを入力してください。'); return; }
    payload.visibility = $('#action-visibility', form)?.value || 'public';
  }
  if (context.action === 'markOrdered' && reason) payload.memo = reason;
  if (context.action === 'resubmit') {
    const amount = $('#action-amount', form)?.value;
    if (amount !== undefined && amount !== '' && Number(amount) !== Number(context.item.fields?.amount)) payload.fields = { amount: Number(amount) };
  }
  if (context.action === 'redraft') {
    const title = $('#redraft-title', form).value.trim();
    if (!title) { dialogError('件名を入力してください。空白だけでは起案できません。'); return; }
    try {
      const values = readApplicationFields(form);
      payload.fields = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== context.item.fields?.[key]));
    } catch (error) { dialogError(error.message); return; }
    payload.fields.title = title;
    payload.fields.purpose = $('#redraft-purpose', form).value.trim();
  }
  if (context.twoFA) payload.twoFA = true;
  let result;
  try {
    result = await api(`/api/cases/${encodeURIComponent(context.item.id)}/actions`, { method: 'POST', body: payload });
  } catch (error) {
    if (context.action === 'resubmit' && error.code === 'reroute') {
      dialogError('ルートが変わるので、起案し直してください。下の「起案し直す」で、直した内容を引き継げます。');
      context.rerouteFields = payload.fields ?? {};
      if (!$('#reroute-redraft', form)) {
        const button = document.createElement('button');
        button.type = 'button'; button.id = 'reroute-redraft'; button.className = 'primary';
        button.dataset.command = 'reroute-redraft'; button.textContent = '起案し直す';
        $('#dialog-error', form).after(button);
        lockControls();
      }
      return;
    }
    dialogError(error.message);
    return;
  }
  closeDialog();
  const label = actions[context.action];
  if (context.action === 'revise') {
    state.selectedCase = null;
    state.cases = [];
    render();
    try {
      await loadCases({ selectFirst: false });
      state.selectedCase = await getCase(context.item.id);
      if (state.tab === 'admin') await loadOutbox();
      render();
      notice('内容を直して知らせました。');
    } catch (error) {
      render();
      notice(`内容は直しました。表示の更新に失敗しました。「一覧を更新」を押してください。\n${error.message}`, 'warning');
    }
    return;
  }
  if (context.action === 'redraft') {
    const created = result?.case ?? result;
    state.tab = 'mine';
    state.cases = [];
    state.selectedCase = created?.id ? created : null;
    render();
    notice(`起案し直しました${created?.id ? `（${created.id}）` : ''}。`);
    try {
      await loadCases({ selectFirst: false });
      if (created?.id) state.selectedCase = await getCase(created.id);
      render();
      $('#case-detail')?.scrollIntoView({ block: 'start', behavior: 'instant' });
    } catch (error) {
      state.selectedCase = created?.id ? created : null;
      render();
      notice(`起案し直しました。詳細の再読込に失敗しました。「一覧を更新」を押してください。\n${error.message}`, 'warning');
    }
    return;
  }
  // Clear old capabilities immediately, even if reloading the list fails.
  state.selectedCase = null;
  state.cases = [];
  render();
  notice(`「${label}」を記録しました。`);
  try {
    if (state.tab === 'admin') await loadOutbox();
    await loadCases();
  } catch (error) {
    notice(`操作は記録しました。一覧を更新して、現在の状態を確かめてください。\n${error.message}`, 'warning');
  }
}

async function submitMail(form) {
  const payload = { from: $('#mail-from', form).value, token: $('#mail-token', form).value.trim(), body: $('#mail-body', form).value.trim() };
  if (!payload.from || !payload.token || !payload.body) throw new Error('差出人・番号・返信の本文をすべて入力してください。');
  await api('/api/mail/inbound', { method: 'POST', body: payload });
  state.mail = { from: payload.from, token: '', body: '承認' };
  state.selectedCase = null;
  state.cases = [];
  render();
  notice('メール返信を受け付けました。送信箱に処理結果の知らせが届きます。');
  try {
    await loadOutbox();
    await loadCases();
  } catch (error) {
    notice(`返信は受け付けました。見守り情報を更新して、処理結果を確かめてください。\n${error.message}`, 'warning');
  }
}

function prepareReset() {
  openDialog('<form id="reset-form"><h2 id="dialog-title">試作データを最初に戻しますか？</h2><p>案件・送信箱・保存した型などが初期状態に戻ります。編集中の内容も破棄します。</p><div class="field"><label class="checkbox"><input id="confirm-reset" type="checkbox" required>初期状態に戻すことを確認しました</label></div><p id="dialog-error" class="notice error" role="alert" hidden></p><div class="button-row"><button type="button" data-command="close-dialog">やめる</button><button type="submit" class="danger">最初に戻す</button></div></form>', { type: 'reset' });
}

async function performReset() {
  if (!$('#confirm-reset')?.checked) return;
  try { await api('/api/reset', { method: 'POST', body: { as: state.actor } }); }
  catch (error) { dialogError(error.message); return; }
  closeDialog();
  state.dirty = false;
  state.draft = null;
  state.simulation = null;
  state.applyValues = {};
  state.applyTitle = '';
  state.applyPurpose = '';
  state.applyDocs = '';
  state.caseTypesDirty = false;
  state.caseTypesDraft = [];
  state.settingsDirty = false;
  state.settingsDraft = null;
  state.settingsError = '';
  state.absenceDraft = { person: '', from: '', to: '', reason: '' };
  state.cases = [];
  state.selectedCase = null;
  state.outbox = [];
  state.mail = { from: '', token: '', body: '承認' };
  state.caseQueries = { mine: '', todo: '', admin: '' };
  state.caseSearchDrafts = { mine: '', todo: '', admin: '' };
  state.ready = false;
  updateHeader();
  render();
  try { await initialize(); notice('試作データを最初の状態に戻しました。'); }
  catch (error) { notice(`データは初期状態に戻りました。再接続して情報を読み込んでください。\n${error.message}`, 'warning'); }
}

function changeStepOrder(id, delta) {
  const steps = state.draft.steps;
  const index = steps.findIndex((step) => step.id === id);
  const next = index + delta;
  if (index <= 0 || next <= 0 || next >= steps.length || boxKind(steps[index]) === 'draft' || boxKind(steps[next]) === 'draft') return;
  [steps[index], steps[next]] = [steps[next], steps[index]];
  markDirty(id);
  render();
  focusStep(id);
}

function focusStep(id) {
  const box = $$('[data-box-id]').find((element) => element.dataset.boxId === id);
  if (box) { $('.box-select', box)?.focus(); box.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); }
}

async function switchTab(tab) {
  if (!workspaceTabs().includes(tab) || (state.mode === 'build' && !canBuild())) return;
  state.tab = tab;
  state.cases = [];
  state.selectedCase = null;
  state.outbox = [];
  clearNotice();
  render();
  await loadTab();
}

document.addEventListener('click', (event) => {
  const mode = event.target.closest('button[data-mode]');
  if (mode && !state.busy) {
    if (!['use', 'build'].includes(mode.dataset.mode) || (mode.dataset.mode === 'build' && !canBuild())) return;
    if (state.mode === mode.dataset.mode) return;
    state.mode = mode.dataset.mode;
    void runTask(() => switchTab(workspaceTabs()[0]));
    return;
  }
  const tab = event.target.closest('[data-tab]');
  if (tab && !state.busy) { void runTask(() => switchTab(tab.dataset.tab)); return; }
  const button = event.target.closest('button[data-command]');
  if (!button || button.disabled || state.busy) return;
  const { command, step: id, index: rawIndex } = button.dataset;
  const index = Number(rawIndex);
  if (command === 'close-dialog') { closeDialog(); return; }
  if (command === 'reroute-redraft') {
    const context = dialogContext;
    if (context?.action !== 'resubmit') return;
    closeDialog();
    void runTask(() => prepareAction(context.item.id, 'redraft', context.rerouteFields)); return;
  }
  if (command === 'save-case-types') { void runTask(saveCaseTypes); return; }
  if (command === 'refresh-settings') { void runTask(async () => { await loadCaseTypes(); await loadOrgSettings(); render(); }); return; }
  if (command === 'open-other-tab') { openOtherTab(button); return; }
  if (command === 'open-pair-view') { window.open(otherTabUrl({ pair: '1' }), '_blank'); return; }
  if (command === 'apply-glossary-preset') { const preset = $('#glossary-preset')?.value; void runTask(() => saveGlossary({ preset }, 'ひな形を当てました。画面の言葉が変わります。')); return; }
  if (command === 'save-glossary') { const terms = {}; for (const input of $$('[data-glossary-term]')) terms[input.dataset.glossaryTerm] = input.value.trim(); void runTask(() => saveGlossary({ terms })); return; }
  if (command === 'toggle-can-build') { void runTask(() => toggleCanBuild(button.dataset.person)); return; }
  if (command === 'delete-absence') { void runTask(() => deleteAbsence(button.dataset.absence)); return; }
  if (command === 'add-case-type' || command === 'delete-case-type') {
    if (state.caseTypesError) return;
    if (command === 'add-case-type') state.caseTypesDraft.push({ id: `ct${crypto.randomUUID().replaceAll('-', '')}`, name: '', templateId: state.templates[0]?.id ?? '', style: 'normal', active: true });
    else state.caseTypesDraft.splice(index, 1);
    state.caseTypesDirty = true;
    render();
    if (command === 'add-case-type') $(`#case-type-name-${state.caseTypesDraft.length - 1}`)?.focus();
    return;
  }
  if (command === 'save-template' || command === 'simulate') { void runTask(() => saveTemplate(command === 'simulate')); return; }
  if (command === 'edit-step') { openStepEditor(id); return; }
  if (command === 'select-step') {
    state.selectedStep = id;
    $$('[data-box-id]').forEach((box) => {
      box.classList.toggle('selected', box.dataset.boxId === id);
      $('[aria-pressed]', box)?.setAttribute('aria-pressed', String(box.dataset.boxId === id));
    });
    return;
  }
  if (command === 'step-left' || command === 'step-right') { changeStepOrder(id, command === 'step-left' ? -1 : 1); return; }
  if (command === 'add-step') {
    const kind = $('#add-kind').value;
    if (kind === 'draft' || !Object.hasOwn(kinds, kind)) return;
    const step = { id: `s-${crypto.randomUUID()}`, kind, label: kinds[kind].label };
    if (['reception', 'approval'].includes(kind)) Object.assign(step, { role: '', requiredDocs: [] });
    if (kind === 'approval') Object.assign(step, { mark: 'confirm', fromAmountTable: false, allowProxy: false });
    if (kind === 'input') step.fields = [];
    if (kind === 'notify') Object.assign(step, { roles: [], via: ['mail'] });
    if (kind === 'council') Object.assign(step, { members: [], rule: 'all', allowExternal: false });
    if (kind === 'parallel') step.members = [];
    state.draft.steps.push(step);
    state.selectedStep = step.id;
    markDirty(step.id); render(); openStepEditor(step.id); return;
  }
  if (command === 'delete-step') {
    const step = state.draft.steps.find((item) => item.id === id);
    if (!step || boxKind(step) === 'draft' || !window.confirm(`「${step.label}」の箱を削除しますか？ 保存するまでは型を選び直すと元に戻せます。`)) return;
    const position = state.draft.steps.findIndex((item) => item.id === id);
    state.draft.steps.splice(position, 1);
    state.selectedStep = state.draft.steps[Math.min(position, state.draft.steps.length - 1)]?.id ?? '';
    markDirty(); render(); return;
  }
  if (command === 'add-input-field' || command === 'delete-input-field') {
    const step = editorStep();
    if (!step) return;
    step.fields ??= [];
    if (command === 'add-input-field') step.fields.push({ label: '', key: `field${crypto.randomUUID().replaceAll('-', '')}`, type: 'text' });
    else step.fields.splice(index, 1);
    renderEditorDialog();
    if (command === 'add-input-field') $(`#input-label-${step.fields.length - 1}`)?.focus();
    return;
  }
  if (['add-role', 'delete-role', 'role-up', 'role-down'].includes(command)) {
    const { roleOwner: owner, roleKey: key, roleIndex } = button.dataset;
    const target = roleListTarget(owner);
    if (!target) return;
    const roles = target[key] ??= [];
    let position = Number(roleIndex);
    if (command === 'add-role') { position = roles.length; roles.push(''); }
    else if (command === 'delete-role') roles.splice(position, 1);
    else {
      const next = position + (command === 'role-up' ? -1 : 1);
      if (next < 0 || next >= roles.length) return;
      [roles[position], roles[next]] = [roles[next], roles[position]];
      position = next;
    }
    renderEditorDialog();
    $(`#role-${owner}-${key}-${Math.min(position, roles.length - 1)}`)?.focus();
    return;
  }
  if (command === 'add-amount') {
    dialogContext.template.amountTable.push({ upTo: null, approvers: [] });
    renderEditorDialog();
    $(`#amount-${dialogContext.template.amountTable.length - 1}`)?.focus(); return;
  }
  if (command === 'delete-amount') { dialogContext.template.amountTable.splice(index, 1); renderEditorDialog(); return; }
  if (command === 'amount-left' || command === 'amount-right') {
    const rows = dialogContext.template.amountTable;
    const next = index + (command === 'amount-left' ? -1 : 1);
    if (next < 0 || next >= rows.length) return;
    [rows[index], rows[next]] = [rows[next], rows[index]];
    renderEditorDialog(); $(`#amount-${next}`)?.focus(); return;
  }
  if (command === 'open-case') {
    void runTask(async () => { state.selectedCase = await getCase(button.dataset.case); render(); $('#case-detail')?.scrollIntoView({ block: 'start', behavior: 'instant' }); }); return;
  }
  if (command === 'case-action') { void runTask(() => prepareAction(button.dataset.case, button.dataset.action)); return; }
  if (command === 'refresh-cases') { void runTask(() => loadCases()); return; }
  if (command === 'refresh-admin') { void runTask(async () => { await loadOutbox(); await loadCases(); }); return; }
  if (command === 'use-token') {
    state.mail.token = String(state.outbox[index]?.token ?? '');
    state.mail.from = button.dataset.from || state.mail.from;
    render(); $('#mail-token')?.focus(); return;
  }
  if (command === 'reset') prepareReset();
});

document.addEventListener('input', (event) => {
  const input = event.target;
  if (state.busy) return;
  if (input.matches('[data-setting]')) {
    state.settingsDraft ??= clone(state.org.settings);
    state.settingsDraft[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.value;
    state.settingsDirty = true;
    $('#settings-dirty').hidden = false;
  }
  if (input.matches('[data-absence-field]')) {
    state.absenceDraft[input.dataset.absenceField] = input.value;
    if (input.dataset.absenceField === 'from') $('#absence-to').min = input.value;
  }
  if (input.id === 'case-search') state.caseSearchDrafts[state.tab] = input.value;
  if (input.matches('[data-case-type-index]')) {
    const item = state.caseTypesDraft[Number(input.dataset.caseTypeIndex)];
    if (item) {
      item[input.dataset.caseTypeField] = input.dataset.caseTypeField === 'active' ? input.value === 'true' : input.value;
      state.caseTypesDirty = true;
      $('#case-types-dirty').hidden = false;
    }
  }
  if (input.closest('#builder-form') && dialogContext?.type === 'builder') { editBoxInput(input); return; }
  if (input.id === 'apply-title') state.applyTitle = input.value;
  if (input.id === 'apply-purpose') state.applyPurpose = input.value;
  if (input.id === 'apply-docs') state.applyDocs = input.value;
  if (input.id === 'apply-message') state.applyMessage = input.value;
  if (input.matches('[data-application-field]') && input.closest('#application-form')) state.applyValues[input.dataset.applicationField] = input.type === 'checkbox' ? input.checked : input.value;
  if (input.id === 'mail-from') state.mail.from = input.value;
  if (input.id === 'mail-token') state.mail.token = input.value;
  if (input.id === 'mail-body') state.mail.body = input.value;
});

document.addEventListener('change', (event) => {
  const input = event.target;
  if (state.busy) return;
  if (input.id === 'template-ending') {
    if (dialogContext?.type !== 'builder') return;
    dialogContext.template.ending.type = input.value;
    if (input.value === 'submit') dialogContext.template.ending.receiptDoc ??= '提出控え';
    renderEditorDialog(); $('#template-ending')?.focus();
  }
  if (input.id === 'template-select') {
    if (state.dirty && !window.confirm('保存していない変更を破棄して、別の型を開きますか？')) { input.value = state.draft.id; return; }
    selectDraft(state.templates.find((template) => template.id === input.value));
    render();
  }
  if (input.id === 'apply-case-type') {
    state.applyCaseType = input.value;
    state.applyValues = {};
    render();
  }
  if (input.id === 'actor') {
    state.actor = input.value;
    try { sessionStorage.setItem('proto-actor', state.actor); } catch {}
    // 人を替えたら、まず「使う」画面から始める(全員が作る画面にも入れるので、前の人の作る画面を引き継がない)
    state.mode = 'use';
    if (!workspaceTabs().includes(state.tab)) state.tab = workspaceTabs()[0];
    state.caseTypes = [];
    state.caseTypesError = '';
    state.caseTypesDraft = [];
    state.caseTypesDirty = false;
    state.settingsDraft = clone(state.org.settings);
    state.settingsDirty = false;
    state.absenceDraft = { person: '', from: '', to: '', reason: '' };
    state.applyCaseType = '';
    state.applyValues = {};
    if ($('#action-dialog').open) closeDialog();
    void runTask(async () => {
      // Never leave the previous person's details visible during a failed refresh.
      state.cases = []; state.selectedCase = null; state.outbox = [];
      render(); await loadTab();
    });
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (form.id === 'case-search-form') {
    event.preventDefault();
    if (state.busy) return;
    state.caseQueries[state.tab] = $('#case-search', form).value.trim();
    state.caseSearchDrafts[state.tab] = state.caseQueries[state.tab];
    state.cases = []; state.selectedCase = null;
    void runTask(async () => { render(); await loadCases(); }).then(() => $('#case-search')?.focus());
    return;
  }
  if (form.id === 'builder-form') { event.preventDefault(); if (!state.busy) applyBoxEdits(form); return; }
  if (!['application-form', 'action-form', 'mail-form', 'reset-form', 'settings-form', 'absence-form', 'chat-form', 'answer-form'].includes(form.id)) return;
  event.preventDefault();
  if (state.busy || !form.reportValidity()) return;
  const handlers = { 'application-form': () => submitApplication(form), 'action-form': () => performAction(form), 'mail-form': () => submitMail(form), 'reset-form': performReset, 'settings-form': saveSettings, 'absence-form': addAbsence, 'chat-form': () => submitCaseMessage(form, 'chat'), 'answer-form': () => submitCaseMessage(form, 'answer') };
  void runTask(handlers[form.id]);
});

document.addEventListener('dblclick', (event) => {
  if (state.busy || event.target.closest('.box-tools')) return;
  const box = event.target.closest('[data-box-id]');
  if (box && !$('#action-dialog').open) openStepEditor(box.dataset.boxId);
});

$('.tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || state.busy) return;
  const tabs = $$('.tabs [data-tab]').filter((button) => !button.hidden);
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  void runTask(() => switchTab(tabs[next].dataset.tab)).then(() => tabs[next].focus());
});

$('#action-dialog').addEventListener('cancel', (event) => {
  if (state.busy) event.preventDefault();
  else dialogContext = null;
});
$('#reconnect').addEventListener('click', () => { void runTask(initialize); });
window.addEventListener('beforeunload', (event) => {
  if (state.dirty || state.caseTypesDirty || state.settingsDirty || Object.values(state.absenceDraft).some(Boolean) || state.applyTitle || state.applyPurpose || state.applyDocs || state.busy) { event.preventDefault(); event.returnValue = ''; }
});

render();
if (startParams.get('pair') === '1') renderPairView();
else void runTask(async () => {
  try { const keep = startParams.get('as') || sessionStorage.getItem('proto-actor'); if (keep) state.actor = keep; } catch {}
  if (startParams.get('as')) { try { sessionStorage.setItem('proto-actor', startParams.get('as')); } catch {} }
  if (startParams.get('embed') === '1') document.body.classList.add('embedded');
  let back = null;
  try { back = JSON.parse(sessionStorage.getItem('glossary-return') || 'null'); sessionStorage.removeItem('glossary-return'); } catch {}
  if (back?.actor) state.actor = back.actor;
  await initialize();
  applyGlossary();
  if (back) { state.mode = 'build'; state.tab = 'settings'; await loadTab(); render(); }
  else if (['apply', 'mine', 'todo'].includes(startParams.get('tab')) || startParams.get('case')) {
    state.mode = 'use'; state.tab = startParams.get('tab') || 'mine';
    await loadTab();
    if (startParams.get('case')) { try { state.selectedCase = await getCase(startParams.get('case')); render(); $('#case-chat-title')?.scrollIntoView({ block: 'start' }); } catch {} }
  }
  let msg = null;
  try { msg = sessionStorage.getItem('glossary-notice'); sessionStorage.removeItem('glossary-notice'); } catch {}
  if (msg) notice(msg);
});
