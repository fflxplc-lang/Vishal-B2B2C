/* PARTNER LEVELS L1–L7 — what a partner opens when they sign in, and whose
   records they see. One file, loaded by the browser (index.html) and by the
   server (access.js), so the rule the screen draws and the rule the server
   enforces are the same rule.

   A partner is a team member carrying partnerPobId (their Partner Onboarding
   record) and partnerLevel. The levels (Freedom LifeX – Dual Platform
   Architecture, section 5):

     L1 Ninja          own data                  no company Ops support
     L2 Super Ninja    own data                  company Ops support
     L3 Sherpa         own + mapped partners     mapped partner visibility
     L4 Master Sherpa  L3                        partner recruitment and onboarding
     L5 Monks          L4                        build and manage their own team
     L6 Zen Monks      L5                        administrative controls assigned to them
     L7 Super Admin    complete access           system-level super admin

   "Mapped partners" are the partners who report to them in the reporting
   line (parentUserId), however deep. L1 and L2 never see anybody else's
   data, whatever is saved in Setup. Company HR, employee records, payout
   administration and Setup stay closed to L1–L6: L6's controls are the ones
   assigned to it, never company-wide access. Only L7 is unrestricted.

   A partner on L5 or above builds a team of their own (RMs and Operations
   staff). Those people are team members carrying partnerTeamOf (the
   partner's member id) and partnerStaffRole; they sign in on the partner
   platform and work inside that partner's book.

   Setup › Partner Levels can change which parts of the rail each level
   opens, the reach of L3–L6, and the controls L6 holds. */
(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else root.PartnerLevels = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  /* The rail groups a level can be given, by NAV_GROUPS id, and the
     permission modules each one needs to be worked rather than looked at. */
  const GROUPS = [
    {k:'pipeline',   l:'Client Journey',  modules:['LMS','CMS','RMS','Meetings','Calls']},
    {k:'operations', l:'Operations (company support)', modules:['DST','Queries','Projects']},
    {k:'business',   l:'Sales (Business)',modules:['Business','Recommendations','Transactions']},
    {k:'advisory',   l:'Communications',  modules:['Meetings','Calls']},
    {k:'blueprint',  l:'Blueprint',       modules:['Recommendations']},
    {k:'forms',      l:'Forms',           modules:[]},
    {k:'insights',   l:'Insights (business monitoring)', modules:[]},
    {k:'hr',         l:'HR',              modules:[]},
    {k:'partnerjourney', l:'Partner Journey (recruit & onboard)', modules:['Partners']},
  ];
  const VERSION = 3;
  const ALL = GROUPS.map(g=>g.k);
  const SCOPES = [['own','Own data only'], ['team','Own + mapped partners'], ['all','Everyone (L7 only)']];
  /* What each level adds on top of the one below it. */
  const CAPS = [
    ['opsSupport',     'Company Ops support'],
    ['mappedPartners', 'Mapped partner visibility'],
    ['recruitPartners','Partner recruitment and onboarding'],
    ['buildTeam',      'Build and manage own team'],
    ['adminControls',  'Assigned administrative controls'],
    ['superAdmin',     'Super Admin (complete access)'],
  ];
  const BASE = ['pipeline', 'advisory', 'blueprint', 'forms', 'insights'];
  const LEVELS = [
    {k:'L1', name:'Ninja',         pobRole:'Ninja',       groups: BASE,                                         scope:'own',
     caps:[]},
    {k:'L2', name:'Super Ninja',   pobRole:'Super Ninja', groups: BASE.concat(['operations']),                  scope:'own',
     caps:['opsSupport']},
    {k:'L3', name:'Sherpa',        pobRole:'Sherpa',      groups: BASE.concat(['operations','business']),       scope:'team',
     caps:['opsSupport','mappedPartners']},
    {k:'L4', name:'Master Sherpa', pobRole:'',            groups: BASE.concat(['operations','business','partnerjourney']), scope:'team',
     caps:['opsSupport','mappedPartners','recruitPartners']},
    {k:'L5', name:'Monks',         pobRole:'',            groups: BASE.concat(['operations','business','partnerjourney']), scope:'team',
     caps:['opsSupport','mappedPartners','recruitPartners','buildTeam']},
    {k:'L6', name:'Zen Monks',     pobRole:'',            groups: BASE.concat(['operations','business','partnerjourney']), scope:'team',
     caps:['opsSupport','mappedPartners','recruitPartners','buildTeam','adminControls']},
    {k:'L7', name:'Super Admin',   pobRole:'',            groups: ALL,                                          scope:'all',
     caps:CAPS.map(c=>c[0])},
  ];
  const KEYS = LEVELS.map(l=>l.k);
  /* The administrative controls Setup may hand L6. Managing company users
     and permissions is not among them: that is company administration. */
  const L6_ADMIN_FLAGS = ['manageFields','manageWorkflows','manageReports','manageModuleSettings','approveAllocations'];
  const ACTIONS = ['view','create','edit','changeStage','changeStatus','upload','download'];
  /* The roles a partner can give the people of their own team. */
  const STAFF_ROLES = [
    {k:'RM',         l:'Relationship Manager', groups:['pipeline','advisory','blueprint','forms'], reach:'own'},
    {k:'Operations', l:'Operations',           groups:['pipeline','operations','forms'],          reach:'partner'},
  ];
  const roleName = lv => lv.name + ' (' + lv.k + ')';
  const num = k => Number(String(k || '').replace(/\D/g, '')) || 0;
  /* The reach a level may have, whatever Setup says: L1 and L2 never more
     than their own data, nobody below L7 everyone. */
  function allowedScope(k, s){
    const n = num(k);
    if(n <= 2) return 'own';
    if(n >= 7) return 'all';
    return s === 'own' ? 'own' : 'team';
  }
  /* The levels as Setup holds them: the defaults, with what was saved over
     them. A save from before this version described a different ladder
     (L1–L6, HR for L5–L6), so it is not carried over. */
  function levels(saved){
    const current = saved && Number(saved.v || 1) >= VERSION;
    const s = (current && saved.levels) || {};
    return LEVELS.map(d=>{
      const o = s[d.k] || {};
      let groups = Array.isArray(o.groups) ? o.groups.filter(g=>ALL.includes(g)) : d.groups.slice();
      // Company HR is not a partner's to open below L7.
      if(d.k !== 'L7') groups = groups.filter(g=>g !== 'hr');
      if(d.k === 'L7') groups = ALL.slice();
      const adminFlags = d.k === 'L6' && Array.isArray(o.adminFlags) ? o.adminFlags.filter(f=>L6_ADMIN_FLAGS.includes(f)) : [];
      return Object.assign({}, d, {
        groups,
        scope: allowedScope(d.k, SCOPES.some(x=>x[0] === o.scope) ? o.scope : d.scope),
        adminFlags,
        caps: d.caps.slice(),
      });
    });
  }
  const level = (saved, k) => levels(saved).find(x=>x.k === k) || null;
  const has = (lv, cap) => !!(lv && lv.caps && lv.caps.includes(cap));
  /* The level a partner starts at, from the role their onboarding confirmed. */
  function levelForRole(role){
    const lv = LEVELS.find(x=>x.pobRole && x.pobRole === role);
    return lv ? lv.k : 'L1';
  }
  function gridFor(groups, allModules, extra){
    const out = {};
    (allModules || []).forEach(m=>{ out[m] = {}; });
    const mods = new Set();
    groups.forEach(g=>{ const x = GROUPS.find(y=>y.k === g); (x ? x.modules : []).forEach(m=>mods.add(m)); });
    mods.forEach(m=>{ out[m] = {}; ACTIONS.forEach(a=>{ out[m][a] = 1; }); });
    return Object.assign(out, extra || {});
  }
  /* The permission grid a level hands its partners: the modules its groups
     need, View on Partners to read their own Partner Journey and
     performance, and PQS — raising queries with the company's Ops team is
     the company support L1 does not have. A level that sees mapped
     partners (L3 up) also works their queries. */
  function perms(lv, allModules){
    const out = gridFor(lv.groups, allModules);
    out.Partners = Object.assign({}, out.Partners, {view: 1});
    const ops = has(lv, 'opsSupport');
    out.PQS = {view: 1, create: ops ? 1 : 0, edit: lv.scope === 'own' || !ops ? 0 : 1};
    if(has(lv, 'superAdmin')) Object.keys(out).forEach(m=>{ ACTIONS.concat(['delete','approve']).forEach(a=>{ out[m][a] = 1; }); });
    return out;
  }
  function staffRole(k){ return STAFF_ROLES.find(r=>r.k === k) || STAFF_ROLES[0]; }
  function staffPerms(k, allModules){ return gridFor(staffRole(k).groups, allModules, {PQS: {view: 1, create: 1, edit: 0}}); }
  return {GROUPS, LEVELS, KEYS, SCOPES, CAPS, ACTIONS, VERSION, L6_ADMIN_FLAGS, STAFF_ROLES,
    roleName, levels, level, has, levelForRole, perms, allowedScope, staffRole, staffPerms, num};
});
