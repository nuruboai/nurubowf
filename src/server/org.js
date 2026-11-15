// 組織データを読み込み、仕組みの形にそろえる。
// 2つの形を読める: data/seed.json(units/assignments)と data/sample-org.json(sections/roleTable、筋書き用)
import { readFile } from 'node:fs/promises';

export async function loadOrg(file) {
  return normalizeOrg(JSON.parse(await readFile(file, 'utf8')));
}

export function normalizeOrg(d) {
  if (!d.roleTable) return d; // すでに仕組みの形
  const st = d.settings || {};
  const proxyOrder = {};
  const get = r => (proxyOrder[r] ||= { role: r, proxies: [] });
  for (const p of d.roleTable.proxies || []) get(p.role).proxies.push(p.maxAmount != null ? { role: p.proxy, maxAmount: p.maxAmount } : p.proxy);
  for (const s of d.roleTable.superiors || []) get(s.role).escalateTo = s.superior;
  return {
    name: d.name,
    settings: {
      showReturnReason: st.showReturnReason !== false,
      allowOffCampusApproval: !!st.offCampus,
      allowMailApproval: st.emailApproval !== false,
      admins: st.admins || [],
      councilMaxMembers: st.councilMaxMembers,
    },
    units: d.sections,
    roles: d.roles.map(r => ({ id: r.id, name: r.name, unit: r.section, rank: r.rank })),
    people: d.people.map(p => ({ id: p.id, name: p.name, unit: p.section, staffId: p.staffId, canBuild: p.canBuild !== false })),
    assignments: d.roleTable.rows.map(r => ({ role: r.role, person: r.person, from: r.from, to: r.to })),
    roleTableVersion: d.roleTable.version,
    proxyOrder: Object.values(proxyOrder),
    amountTables: d.amountTables || [],
    absences: d.absences || [],
    templates: d.routes,
    caseTypes: d.caseTypes || [],
  };
}
