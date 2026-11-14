/* DARK MODE: NOTHING BLENDS INTO THE BACKGROUND (changes 13-11-2026).

   Every module, a handful of forms, a client and a lead, and the DWT slot
   pop-up are drawn after dark, and every piece of text and every field on
   them is measured against what is actually behind it. Anything under 3:1 —
   the floor for large text, generous for small — fails, named by its
   selector, so the next screen that writes a paper colour by hand is caught. */
const {suite} = require('../lib/harness');
const SCAN = () => {
  const parse = c => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if(!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return {r:p[0], g:p[1], b:p[2], a: p.length > 3 ? p[3] : 1}; };
  const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); }; return .2126*f(c.r) + .7152*f(c.g) + .0722*f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
  const blend = (top, under) => ({r: top.r*top.a + under.r*(1-top.a), g: top.g*top.a + under.g*(1-top.a), b: top.b*top.a + under.b*(1-top.a), a:1});
  const bgOf = el => { const stack = []; let e = el; while(e && e.nodeType === 1){ const cs = getComputedStyle(e); if(cs.backgroundImage && cs.backgroundImage !== 'none' && !/url\(/.test(cs.backgroundImage)) return null; const c = parse(cs.backgroundColor); if(c && c.a > 0){ stack.push(c); if(c.a >= 1) break; } e = e.parentElement; }
    let base = {r:7, g:17, b:31, a:1}; for(let i = stack.length - 1; i >= 0; i--) base = blend(stack[i], base); return base; };
  const desc = el => { let s = el.tagName.toLowerCase(); if(el.id) s += '#' + el.id; if(el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0,3).join('.'); const p = el.parentElement; if(p) s = (p.className && typeof p.className === 'string' ? '.' + p.className.trim().split(/\s+/)[0] : p.tagName.toLowerCase()) + ' > ' + s; return s; };
  const out = [];
  const root = document.querySelector('.modal-overlay:not([hidden]) .modal, .modal') && document.querySelector('.modal') && document.querySelector('.modal').offsetParent ? document.querySelector('.modal') : document.getElementById('content') || document.body;
  const scope = [document.getElementById('content'), document.querySelector('.modal')].filter(x=>x && x.offsetParent !== null);
  scope.forEach(r=>r.querySelectorAll('*').forEach(el=>{
    if(!el.offsetParent && getComputedStyle(el).position !== 'fixed') return;
    const cs = getComputedStyle(el);
    if(cs.visibility === 'hidden' || Number(cs.opacity) < .3) return;
    const isField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/hidden|checkbox|radio|file|range|color/.test(el.type);
    const hasText = isField || [...el.childNodes].some(n=>n.nodeType === 3 && n.textContent.trim());
    if(!hasText) return;
    const fg = parse(cs.color); const bg = bgOf(el); if(!fg || !bg) return;
    const rr = ratio(blend(fg, bg), bg);
    const text = isField ? (el.value || el.placeholder || '') : [...el.childNodes].filter(n=>n.nodeType === 3).map(n=>n.textContent).join('').trim();
    if(rr < 3) out.push({sel: desc(el), r: Math.round(rr*100)/100, fg: cs.color, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`, text: text.slice(0, 40)});
    if(isField && el.placeholder){ const pc = parse(getComputedStyle(el, '::placeholder').color); if(pc){ const pr = ratio(blend(pc, bg), bg); if(pr < 2.6) out.push({sel: desc(el) + '::placeholder', r: Math.round(pr*100)/100, fg: getComputedStyle(el, '::placeholder').color, bg:'', text: el.placeholder.slice(0,40)}); } }
    if(isField){ const fb = parse(cs.backgroundColor); if(fb && fb.a > .5 && lum(fb) > .6) out.push({sel: desc(el) + ' [white field]', r: 0, fg: cs.color, bg: cs.backgroundColor, text}); }
  }));
  return out;
};
suite(async t => {
  await t.eval(async ()=>{ if(!darkMode) await toggleDarkMode();
    const today = localDateKey(); const cats = cfgList('dwt.activityTypes');
    cats.forEach((c, i)=>DB.workActivities.push({id: uid('WA'), date: today, plannedStart: (9+i)+':00', plannedEnd: (9+i)+':30', activityType: c.label, title: 'ZZ ' + c.label, userId: currentUser, ownerId: currentUser, createdBy: currentUser, createdAt: new Date().toISOString()}));
    await save('workActivities'); });
  const views = await t.eval(()=>Object.keys(NAV_LABELS).filter(v=>!['allocpdf','planoutput'].includes(v)));
  const report = {};
  for(const v of views){
    try {
      await t.eval(v=>{ closeModal && closeModal(); navigate(v); }, v);
      await t.wait(350);
      report[v] = await t.eval(SCAN);
    } catch(e){ report[v] = [{sel:'ERROR ' + e.message}]; }
  }
  /* some modals */
  const modals = {
    clientForm: ()=>openClientForm(), leadForm: ()=>openLeadForm && openLeadForm(), query: ()=>openQueryForm(), meeting: ()=>openMeetingForm(),
    call: ()=>openCallForm && openCallForm(), txn: ()=>openTransactionForm(),
  };
  for(const [k, fn] of Object.entries(modals)){
    try { await t.eval(`(${fn.toString()})()`); await t.wait(300); report['modal:' + k] = await t.eval(SCAN); await t.eval(()=>closeModal()); } catch(e){ report['modal:' + k] = [{sel:'ERROR ' + e.message}]; }
  }
  try { await t.eval(()=>{ navigate('dwt'); }); await t.wait(400); report['dwt-seeded'] = await t.eval(SCAN);
    await t.eval(()=>openDwtSlotEditor(localDateKey(), '09:00'));
    await t.wait(300); report['modal:dwt'] = await t.eval(SCAN); await t.eval(()=>closeModal()); } catch(e){ report['modal:dwt'] = [{sel:'ERROR ' + e.message}]; }
  for(const [k, fn] of Object.entries({cms: ()=>{ const c = DB.clients.find(x=>!x.deletedAt); if(c) navigate('cms', c.id); }, lead: ()=>{ const l = DB.leads.find(x=>!x.deletedAt); if(l) navigate('lms', l.id); },
      settings: ()=>navigate('settings', 'forms'), setupdwt: ()=>navigate('settings', 'dwt')})){
    try { await t.eval(`(${fn.toString()})()`); await t.wait(400); report['rec:' + k] = await t.eval(SCAN); } catch(e){ report['rec:' + k] = [{sel:'ERROR ' + e.message}]; }
  }
  await t.step('every screen scanned after dark is readable', async () => {
    const bad = [];
    Object.entries(report).forEach(([v, items])=>items.forEach(i=>bad.push(v + ': ' + i.sel + (i.r !== undefined ? ' (' + i.r + ':1 "' + (i.text || '') + '")' : ''))));
    if(bad.length) throw new Error(bad.length + ' problem(s): ' + bad.slice(0, 12).join(' | '));
    return Object.keys(report).length + ' screens, nothing under 3:1';
  });
});
