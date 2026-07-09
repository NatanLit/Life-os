'use strict';

/* ================= theme (BoW / WoB) ================= */
const THEME_KEY = 'lifeos.theme';
function setTheme(t){
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
  document.getElementById('theme-toggle').setAttribute('aria-pressed', String(t === 'dark'));
  document.getElementById('meta-theme').content = t === 'dark' ? '#000000' : '#ffffff';
}
setTheme(localStorage.getItem(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
document.getElementById('theme-toggle').addEventListener('click', () =>
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

/* ================= state + server sync ================= */
const KEY = 'lifeos.v1';
const DEFAULT_STATE = { goals:[], habits:[], workouts:[], deadlines:[], sleep:{}, reviews:{}, updatedAt:0 };
let S = Object.assign({}, DEFAULT_STATE);
try { Object.assign(S, JSON.parse(localStorage.getItem(KEY)) || {}); } catch(e){ /* corrupt local cache — start clean */ }

const HAS_API = location.protocol.startsWith('http');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

let ACCESS = localStorage.getItem('lifeos.code') || '';
const authHeaders = () => ACCESS ? { 'Authorization': 'Bearer ' + ACCESS } : {};

function setOffline(off){ document.getElementById('sync').hidden = !off; }

let pushTimer = null;
function pushSoon(){ if(!HAS_API) return; clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 500); }
async function pushNow(){
  if(!HAS_API) return 'ok';
  try {
    const r = await fetch('/api/state', {
      method:'PUT',
      headers: Object.assign({'Content-Type':'application/json'}, authHeaders()),
      body: JSON.stringify(S)
    });
    if(r.status === 401){ showGate(!!ACCESS); return 'unauthorized'; }
    if(r.status === 409){
      const j = await r.json();
      if(j.state){ S = Object.assign({}, DEFAULT_STATE, j.state); localStorage.setItem(KEY, JSON.stringify(S)); render(); }
    }
    setOffline(!r.ok && r.status !== 409);
    return (r.ok || r.status === 409) ? 'ok' : 'offline';
  } catch(e){ setOffline(true); return 'offline'; }
}
async function pullRemote(){
  if(!HAS_API) return 'ok';
  try {
    const r = await fetch('/api/state', { cache:'no-store', headers: authHeaders() });
    if(r.status === 401){ showGate(!!ACCESS); return 'unauthorized'; }
    if(!r.ok) throw new Error('bad status');
    const remote = await r.json();
    if((remote.updatedAt || 0) > (S.updatedAt || 0)){
      S = Object.assign({}, DEFAULT_STATE, remote);
      localStorage.setItem(KEY, JSON.stringify(S));
      render();
    } else if((S.updatedAt || 0) > (remote.updatedAt || 0)){
      pushNow();
    }
    setOffline(false);
    hideGate();
    return 'ok';
  } catch(e){ setOffline(true); return 'offline'; }
}
function save(){
  S.updatedAt = Date.now();
  localStorage.setItem(KEY, JSON.stringify(S));
  pushSoon();
}

/* ================= access gate ================= */
function showGate(withError){
  const g = document.getElementById('gate');
  document.getElementById('gate-err').hidden = !withError;
  g.hidden = false;
  setTimeout(()=>document.getElementById('gate-input').focus(), 40);
}
function hideGate(){ document.getElementById('gate').hidden = true; }
document.getElementById('gate-form').addEventListener('submit', async e=>{
  e.preventDefault();
  ACCESS = document.getElementById('gate-input').value.trim();
  localStorage.setItem('lifeos.code', ACCESS);
  const res = await pullRemote();
  if(res === 'unauthorized'){ showGate(true); }
  else { hideGate(); document.getElementById('gate-input').value = ''; }
});

let view = 'today';
let habitEditMode = false;
const openGoals = new Set();
let calView = { y: new Date().getFullYear(), m: new Date().getMonth() };
let calSelected = '';

/* ================= dates ================= */
const pad = n => String(n).padStart(2,'0');
const dkey = d => d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const parseKey = k => { const p = k.split('-').map(Number); return new Date(p[0], p[1]-1, p[2]); };
const todayKey = () => dkey(new Date());
const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const dayDiff = k => Math.round((parseKey(k) - parseKey(todayKey())) / 864e5);
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const shortDate = k => { const d = parseKey(k); return MONTHS[d.getMonth()]+' '+d.getDate(); };
const monday = d => { const x = new Date(d); const w = (x.getDay()+6)%7; x.setDate(x.getDate()-w); return x; };
const weekKey = () => dkey(monday(new Date()));

const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ================= derived ================= */
const msPct = m => m.tasks.length ? Math.round(100 * m.tasks.filter(t=>t.done).length / m.tasks.length) : 0;
const goalPct = g => g.milestones.length ? Math.round(g.milestones.reduce((a,m)=>a+msPct(m),0) / g.milestones.length) : 0;
function nextAction(g){
  for(const m of g.milestones) for(const t of m.tasks) if(!t.done) return {milestone:m, task:t};
  return null;
}
function goalLastMove(g){
  let last = 0;
  for(const m of g.milestones) for(const t of m.tasks) if(t.done && t.doneAt) last = Math.max(last, t.doneAt);
  return last;
}
/* soft streak: +1 per done day, −1 per missed day (never below 0); an unlogged today doesn't count against you */
function habitStreak(h){
  const keys = Object.keys(h.log||{}).filter(k=>h.log[k]).sort();
  if(!keys.length) return 0;
  let s = 0;
  const t = todayKey();
  let d = parseKey(keys[0]);
  const end = parseKey(t);
  while(d <= end){
    const k = dkey(d);
    if(h.log[k]) s += 1;
    else if(k !== t) s = Math.max(0, s - 1);
    d = addDays(d, 1);
  }
  return Math.floor(s);
}
const activeHabits = () => S.habits.filter(h=>!h.archived);

/* ================= tiny components ================= */
/* SVG progress ring — two circles, stroke-dashoffset (shadcn-ecosystem pattern); r≈15.915 → circumference≈100 */
function ring(pct){
  return '<svg class="ring" viewBox="0 0 36 36" role="progressbar" aria-valuenow="'+pct+'" aria-valuemin="0" aria-valuemax="100">'
    +'<circle class="track" cx="18" cy="18" r="15.915" fill="none" stroke-width="2.6"/>'
    +'<circle class="fill" cx="18" cy="18" r="15.915" fill="none" stroke-width="2.6" stroke-linecap="round" '
    +'stroke-dasharray="100" stroke-dashoffset="'+(100-pct)+'" transform="rotate(-90 18 18)"/>'
    +'<text x="18" y="21.5" text-anchor="middle">'+pct+'</text></svg>';
}
function bar(pct){ return '<div class="bar" role="progressbar" aria-valuenow="'+pct+'"><i style="width:'+pct+'%"></i></div>'; }
function checkbox(checked, attrs, round){
  return '<label class="cb'+(round?' round':'')+'"><input type="checkbox" '+attrs+(checked?' checked':'')+'>'
    +'<span class="box"><svg viewBox="0 0 16 16"><path d="M2.5 8.5 6 12 13.5 4"/></svg></span></label>';
}

/* 8-week habit calendar: month labels + Mon/Wed/Fri rail + contribution grid */
function calGrid(h){
  const start = addDays(monday(new Date()), -49); // 8 columns of 7 days ending this week
  const t = todayKey();
  let months = '', prevMonth = -1, lastLabelCol = -9;
  for(let c=0;c<8;c++){
    const d = addDays(start, c*7);
    if(d.getMonth() !== prevMonth){
      if(c - lastLabelCol >= 2 && c <= 6){
        months += '<span style="grid-column:'+(c+1)+'">'+MONTHS[d.getMonth()]+'</span>';
        lastLabelCol = c;
      }
      prevMonth = d.getMonth();
    }
  }
  let cells = '';
  for(let i=0;i<56;i++){
    const d = addDays(start, i);
    const k = dkey(d);
    const future = k > t;
    const on = !!(h.log && h.log[k]);
    cells += '<i class="'+(on?'on ':'')+(future?'future ':'')+(k===t?'tc':'')+'" data-tip="'
      + shortDate(k) + (future ? '' : ' — ' + (on ? 'done' : 'missed')) + '"></i>';
  }
  return '<div class="cal" aria-label="last 8 weeks">'
    + '<div class="cal-months">'+months+'</div>'
    + '<div class="cal-row"><div class="cal-days"><i>M</i><i></i><i>W</i><i></i><i>F</i><i></i><i></i></div>'
    + '<div class="heat">'+cells+'</div></div></div>';
}

/* ================= sleep chart (single axis: bars for hours, shade strip for feeling) ================= */
function sleepChart(){
  const days = []; for(let i=13;i>=0;i--) days.push(dkey(addDays(new Date(),-i)));
  const W=560, slot=W/14, barW=16, base=100, top=8, maxH=12, ph=(base-top)/maxH;
  let svg = '<svg viewBox="0 0 560 150" aria-label="Sleep, last 14 days">';
  const refY = base - 8*ph;
  svg += '<line class="c-ref" x1="0" y1="'+refY+'" x2="'+W+'" y2="'+refY+'" stroke-width="1" stroke-dasharray="3 4"/>';
  svg += '<text class="c-lab" x="'+W+'" y="'+(refY-4)+'" text-anchor="end" font-size="9">8h</text>';
  days.forEach((k,i)=>{
    const e = S.sleep[k];
    const x = i*slot + (slot-barW)/2;
    if(e && e.hours != null){
      const hh = Math.min(e.hours, maxH), bh = Math.max(hh*ph, 3), y = base-bh, r = Math.min(3, bh/2);
      /* rounded top, flat baseline */
      svg += '<path class="c-bar" d="M'+x+' '+base+' L'+x+' '+(y+r)+' Q'+x+' '+y+' '+(x+r)+' '+y
           + ' L'+(x+barW-r)+' '+y+' Q'+(x+barW)+' '+y+' '+(x+barW)+' '+(y+r)
           + ' L'+(x+barW)+' '+base+' Z" data-tip="'+shortDate(k)+' — '+e.hours+'h'
           + (e.feeling?(' · feeling '+e.feeling+'/5'):'')+'"/>';
    } else {
      svg += '<rect class="c-none" x="'+x+'" y="'+(base-2)+'" width="'+barW+'" height="2" rx="1" data-tip="'+shortDate(k)+' — not logged"/>';
    }
    if(e && e.feeling){
      svg += '<rect class="fq'+e.feeling+'" x="'+(x+1)+'" y="110" width="14" height="14" rx="3" data-tip="'+shortDate(k)+' — feeling '+e.feeling+'/5"/>';
    } else {
      svg += '<rect class="fq0" x="'+(x+1)+'" y="110" width="14" height="14" rx="3"/>';
    }
    if(i%2===1) svg += '<text class="c-lab" x="'+(i*slot+slot/2)+'" y="142" text-anchor="middle" font-size="9">'+parseKey(k).getDate()+'</text>';
  });
  svg += '</svg>';
  const logged = days.map(k=>S.sleep[k]).filter(Boolean);
  const hoursArr = logged.filter(e=>e.hours!=null).map(e=>e.hours);
  const feelArr = logged.filter(e=>e.feeling).map(e=>e.feeling);
  const avgH = hoursArr.length ? (hoursArr.reduce((a,b)=>a+b,0)/hoursArr.length).toFixed(1) : '—';
  const avgF = feelArr.length ? (feelArr.reduce((a,b)=>a+b,0)/feelArr.length).toFixed(1) : '—';
  return '<div class="sub" style="margin-bottom:10px">14-day average: <b style="color:var(--ink)">'+avgH+'h</b> sleep · <b style="color:var(--ink)">'+avgF+'</b>/5 feeling</div>'
    + '<div class="chart-wrap">'+svg+'</div>'
    + '<div class="legend">Bars — hours slept · squares — feeling (stronger = better)</div>';
}

/* ================= render: today ================= */
function renderToday(){
  const now = new Date(), t = todayKey();
  let html = '<section><h1 class="day">'+WEEKDAYS[now.getDay()]+', '+MONTHS[now.getMonth()]+' '+now.getDate()+'</h1>';
  if(now.getDay()===0) html += '<div class="sub">It’s Sunday — a good day for your <button class="linkish" data-action="go-review">weekly review</button>.</div>';
  html += '</section>';

  /* habits */
  const habits = activeHabits();
  html += '<section><div class="micro"><span>Habits</span><span style="display:flex;gap:12px">'
    + (habitEditMode && habits.length<5 ? '<button class="linkish" data-action="habit-add">+ add</button>' : '')
    + '<button class="linkish" data-action="habit-editmode">'+(habitEditMode?'done':'edit')+'</button></span></div>';
  if(!habits.length){
    html += '<div class="empty">No habits yet. <button class="linkish" data-action="habit-add">Add your first habit</button> (max 5 active).</div>';
  } else {
    html += '<div class="row-list">';
    for(const h of habits){
      const done = !!(h.log && h.log[t]);
      const streak = habitStreak(h);
      html += '<div class="habit'+(done?' done':'')+'">'
        + checkbox(done, 'data-habit="'+h.id+'" aria-label="'+esc(h.name)+'"', true)
        + '<div class="hmeta"><div class="hname">'+esc(h.name)+'</div>'
        + '<div class="hstreak">streak '+streak+(h.workoutLinked?' · linked to workouts':'')+'</div></div>'
        + (habitEditMode ? '<button class="linkish" data-action="habit-edit" data-id="'+h.id+'">edit</button>' : calGrid(h))
        + '</div>';
    }
    html += '</div>';
    if(habitEditMode){
      const archived = S.habits.filter(h=>h.archived);
      if(archived.length){
        html += '<div class="sub" style="margin-top:10px">Archived: '
          + archived.map(h=>'<button class="linkish" data-action="habit-edit" data-id="'+h.id+'">'+esc(h.name)+'</button>').join(' · ')
          + '</div>';
      }
    }
  }
  html += '</section>';

  /* sleep quick check-in */
  const se = S.sleep[t] || {};
  html += '<section><div class="micro"><span>Sleep check-in</span></div><div class="card">';
  html += '<div class="sleep-row"><span class="lab">Hours</span><div class="seg">';
  for(let hv=4; hv<=10; hv++) html += '<button data-action="sleep-hours" data-v="'+hv+'" class="'+(se.hours===hv?'sel':'')+'">'+(hv===4?'≤4':hv===10?'10+':hv)+'</button>';
  html += '</div></div>';
  html += '<div class="sleep-row"><span class="lab">Feeling</span><div class="seg">';
  for(let f=1; f<=5; f++) html += '<button data-action="sleep-feel" data-v="'+f+'" class="'+(se.feeling===f?'sel':'')+'" aria-label="feeling '+f+' of 5">'+f+'</button>';
  html += '</div></div>';
  html += '</div></section>';

  /* sleep 2-week trend */
  html += '<section><div class="micro"><span>Sleep · 2-week trend</span></div>' + sleepChart() + '</section>';

  /* due now: overdue + today + tomorrow */
  const due = S.deadlines.filter(d=>!d.done && dayDiff(d.due) <= 1).sort(sortDl);
  html += '<section><div class="micro"><span>Due now</span><button class="linkish" data-action="go-school">all deadlines</button></div>';
  html += due.length ? '<div class="row-list">'+due.map(dlRow).join('')+'</div>'
    : '<div class="empty">Nothing due today or tomorrow.</div>';
  html += '</section>';

  /* next actions per active goal */
  const actives = S.goals.filter(g=>g.status==='active');
  html += '<section><div class="micro"><span>Next actions</span><button class="linkish" data-action="go-goals">all goals</button></div>';
  const nas = actives.map(g=>({g, na:nextAction(g)})).filter(x=>x.na);
  if(nas.length){
    html += '<div class="row-list">';
    for(const {g,na} of nas){
      html += '<div class="na">'
        + checkbox(false, 'data-task="'+na.task.id+'" data-goal="'+g.id+'"')
        + '<div style="flex:1;min-width:0"><div style="font-size:14px">'+esc(na.task.title)+'</div>'
        + '<div class="nag">'+esc(g.title)+' · '+goalPct(g)+'%</div></div>'
        + '</div>';
    }
    html += '</div>';
  } else {
    html += '<div class="empty">'+(actives.length?'All goal tasks done — add the next ones in Goals.':'No active goals. <button class="linkish" data-action="goal-add">Create one</button>.')+'</div>';
  }
  html += '</section>';
  return html;
}

/* ================= render: calendar ================= */
function calItemsForDay(iso){
  const items = [];
  for(const d of S.deadlines) if(!d.done && d.due === iso) items.push({type:'task', ref:d});
  for(const g of S.goals) if(g.status !== 'done' && g.deadline === iso) items.push({type:'goal', ref:g});
  items.sort((a,b)=>{
    const pa = a.type==='task' ? PRI_W[a.ref.priority] : 3;
    const pb = b.type==='task' ? PRI_W[b.ref.priority] : 3;
    return pa - pb;
  });
  return items;
}
function renderCalendar(){
  const { y: vy, m: vm } = calView;
  const t = todayKey();
  const selDay = calSelected || t;
  const start = monday(new Date(vy, vm, 1));
  let cells = '';
  for(let i=0;i<42;i++){
    const d = addDays(start, i);
    const iso = dkey(d);
    const items = calItemsForDay(iso);
    const shown = items.slice(0,2);
    let inner = '<span class="mcal-num">'+d.getDate()+'</span>';
    for(const it of shown){
      const hi = it.type==='task' && it.ref.priority==='high';
      inner += '<span class="mcal-chip'+(it.type==='goal'?' goal':'')+(hi?' hi':'')+'">'+esc(it.ref.title)+'</span>';
    }
    if(items.length > shown.length) inner += '<span class="mcal-more">+'+(items.length-shown.length)+' more</span>';
    cells += '<button type="button" class="mcal-day'+(d.getMonth()!==vm?' out':'')+(iso===t?' today':'')+(iso===selDay?' sel':'')
      + '" data-action="cal-day" data-day="'+iso+'" aria-label="'+shortDate(iso)+(items.length?', '+items.length+' item'+(items.length===1?'':'s'):'')+'">'+inner+'</button>';
  }
  let html = '<section><div class="mcal-head">'
    + '<button type="button" class="dp-nav" data-action="cal-prev" aria-label="Previous month">‹</button>'
    + '<h1 class="day" style="margin:0">'+MONTHS_FULL[vm]+' '+vy+'</h1>'
    + '<button type="button" class="dp-nav" data-action="cal-next" aria-label="Next month">›</button>'
    + '<button class="linkish" data-action="cal-today" style="margin-left:auto">today</button></div>';
  html += '<div class="mcal-wd">'+['Mo','Tu','We','Th','Fr','Sa','Su'].map(w=>'<span>'+w+'</span>').join('')+'</div>';
  html += '<div class="mcal-grid">'+cells+'</div></section>';

  const items = calItemsForDay(selDay);
  html += '<section><div class="micro"><span>'+(selDay===t?'Today · '+shortDate(selDay):shortDate(selDay))
    + '</span><button class="linkish" data-action="cal-add-here">+ add task due here</button></div>';
  if(items.length){
    html += '<div class="row-list">' + items.map(it => it.type==='task'
      ? '<div class="dl" data-action="cal-open-task" data-id="'+it.ref.id+'">'
        + '<span class="mcal-dot square'+(it.ref.priority==='high'?' hi':'')+'"></span>'
        + '<div class="dmeta"><div class="dtitle">'+esc(it.ref.title)+'</div>'
        + '<div class="dtags"><span class="chip">'+esc(it.ref.subject)+'</span>'
        + '<span class="chip '+(it.ref.priority==='high'?'solid':it.ref.priority==='low'?'faint':'')+'">'+it.ref.priority+'</span></div></div></div>'
      : '<div class="dl" data-action="cal-open-goal" data-id="'+it.ref.id+'">'
        + '<span class="mcal-dot circle"></span>'
        + '<div class="dmeta"><div class="dtitle">'+esc(it.ref.title)+'</div>'
        + '<div class="dtags"><span class="chip faint">goal deadline</span></div></div></div>'
    ).join('') + '</div>';
  } else {
    html += '<div class="empty">Nothing due on this day.</div>';
  }
  html += '</section>';
  return html;
}

/* ================= render: goals ================= */
function goalCard(g){
  const pct = goalPct(g);
  const open = openGoals.has(g.id);
  const dleft = dayDiff(g.deadline);
  const dtxt = g.status==='done' ? 'completed' : dleft < 0 ? Math.abs(dleft)+'d past deadline' : dleft+'d left · '+shortDate(g.deadline);
  let html = '<div class="goal-card'+(open?' open':'')+'" data-goalcard="'+g.id+'">';
  html += '<div class="goal-head" data-action="goal-toggle-open" data-id="'+g.id+'">'+ring(pct)
    + '<div style="flex:1;min-width:0"><div class="goal-title">'+esc(g.title)+'</div>'
    + '<div class="goal-why">'+(g.why?esc(g.why)+' · ':'')+dtxt+'</div></div>'
    + (g.status!=='active'?'<span class="chip faint">'+g.status+'</span>':'')
    + '</div>';
  html += '<div class="goal-body">';
  if(!g.milestones.length) html += '<div class="empty" style="padding-top:0">Break it down: 3–6 milestones, then tasks under each.</div>';
  for(const m of g.milestones){
    html += '<div class="ms"><div class="ms-head"><span class="ms-title">'+esc(m.title)+'</span>'+bar(msPct(m))
      + '<span class="ms-pct">'+msPct(m)+'%</span>'
      + '<button class="x" data-action="ms-del" data-goal="'+g.id+'" data-id="'+m.id+'" aria-label="delete milestone">×</button></div>';
    for(const tk of m.tasks){
      html += '<div class="task'+(tk.done?' done':'')+'">'
        + checkbox(tk.done, 'data-task="'+tk.id+'" data-goal="'+g.id+'"')
        + '<span style="flex:1">'+esc(tk.title)+'</span>'
        + '<button class="x" data-action="task-del" data-goal="'+g.id+'" data-ms="'+m.id+'" data-id="'+tk.id+'" aria-label="delete task">×</button></div>';
    }
    html += '<form class="inline-add" data-form="task-add" data-goal="'+g.id+'" data-ms="'+m.id+'">'
      + '<input name="title" placeholder="Add a task" maxlength="100" autocomplete="off" required><button>+ add</button></form></div>';
  }
  html += '<form class="inline-add" data-form="ms-add" data-goal="'+g.id+'" style="margin-top:12px">'
    + '<input name="title" placeholder="Add a milestone" maxlength="80" autocomplete="off" required><button>+ milestone</button></form>';
  html += '<div class="goal-foot"><button class="linkish" data-action="goal-edit" data-id="'+g.id+'">edit</button>'
    + (g.status!=='done'?'<button class="linkish" data-action="goal-done" data-id="'+g.id+'">mark done</button>':'<button class="linkish" data-action="goal-reopen" data-id="'+g.id+'">reopen</button>')
    + '<button class="linkish" data-action="goal-del" data-id="'+g.id+'">delete</button></div>';
  html += '</div></div>';
  return html;
}
function renderGoals(){
  let html = '<section><div class="micro"><span>Goals</span><button class="linkish" data-action="goal-add">+ new goal</button></div>';
  const act = S.goals.filter(g=>g.status==='active');
  const paused = S.goals.filter(g=>g.status==='paused');
  const done = S.goals.filter(g=>g.status==='done');
  if(!S.goals.length) html += '<div class="empty">A goal is a destination with a deadline. Milestones are the route, tasks are the steps. Start with one goal that matters.</div>';
  html += act.map(goalCard).join('');
  if(paused.length) html += '<div class="micro" style="margin-top:24px"><span>Paused</span></div>' + paused.map(goalCard).join('');
  if(done.length) html += '<div class="micro" style="margin-top:24px"><span>Done</span></div>' + done.map(goalCard).join('');
  html += '</section>';
  return html;
}

/* ================= render: school ================= */
const PRI_W = {high:0, med:1, low:2};
function sortDl(a,b){ return (a.due<b.due?-1:a.due>b.due?1:0) || (PRI_W[a.priority]-PRI_W[b.priority]); }
function dueBadge(k){
  const d = dayDiff(k);
  if(d < 0) return '<span class="due over">'+(-d)+'d overdue</span>';
  if(d === 0) return '<span class="due soon">Today</span>';
  if(d === 1) return '<span class="due soon">Tomorrow</span>';
  if(d <= 7) return '<span class="due later">'+d+'d</span>';
  return '<span class="due later">'+shortDate(k)+'</span>';
}
function dlRow(d){
  const g = d.goalId ? S.goals.find(x=>x.id===d.goalId) : null;
  return '<div class="dl'+(d.done?' done':'')+'">'
    + checkbox(d.done, 'data-deadline="'+d.id+'"')
    + '<div class="dmeta"><div class="dtitle">'+esc(d.title)+'</div>'
    + '<div class="dtags"><span class="chip">'+esc(d.subject)+'</span>'
    + '<span class="chip '+(d.priority==='high'?'solid':d.priority==='low'?'faint':'')+'">'+d.priority+'</span>'
    + (g?'<span class="chip faint">goal: '+esc(g.title)+'</span>':'')
    + '</div></div>'
    + (d.done?'':dueBadge(d.due))
    + '<button class="x" data-action="dl-del" data-id="'+d.id+'" aria-label="delete">×</button></div>';
}
function renderSchool(){
  let html = '<section><div class="micro"><span>School deadlines</span><button class="linkish" data-action="dl-add">+ new task</button></div>';
  const openDl = S.deadlines.filter(d=>!d.done).sort(sortDl);
  const doneDl = S.deadlines.filter(d=>d.done).sort((a,b)=>(b.doneAt||0)-(a.doneAt||0)).slice(0,10);
  html += openDl.length ? '<div class="row-list">'+openDl.map(dlRow).join('')+'</div>'
    : '<div class="empty">No open deadlines. Add homework, assessments and IAs as they land.</div>';
  if(doneDl.length) html += '<div class="micro" style="margin-top:24px"><span>Recently done</span></div><div class="row-list">'+doneDl.map(dlRow).join('')+'</div>';
  html += '</section>';
  return html;
}

/* ================= render: workouts ================= */
function renderWorkouts(){
  const week = S.workouts.filter(w => dayDiff(w.date) > -7);
  const wkMin = week.reduce((a,w)=>a+(w.duration||0),0);
  let html = '<section><div class="micro"><span>Quick log</span></div><div class="card">'
    + '<form class="wo-form" data-form="wo-add">'
    + '<input name="type" list="wotypes" placeholder="Type — e.g. Gym" required maxlength="40" autocomplete="off">'
    + '<datalist id="wotypes"><option>Gym</option><option>Run</option><option>Football</option><option>Basketball</option><option>Swim</option><option>Boxing</option><option>Stretch</option></datalist>'
    + '<input name="duration" type="number" min="1" max="600" placeholder="min" required>'
    + '<input class="full" name="note" placeholder="Note (optional) — e.g. bench 60×5, felt strong" maxlength="120" autocomplete="off">'
    + '<button class="btn full">Log workout</button>'
    + '</form></div>'
    + '<div class="legend" style="margin-top:10px">Last 7 days: <b style="color:var(--ink)">'+week.length+'</b> workout'+(week.length===1?'':'s')+' · '+wkMin+' min'
    + (activeHabits().some(h=>h.workoutLinked)?' · logging also checks your linked habit':'')+'</div></section>';

  const rec = S.workouts.slice().sort((a,b)=>b.date<a.date?-1:b.date>a.date?1:0).slice(0,30);
  html += '<section><div class="micro"><span>Recent</span></div>';
  html += rec.length ? '<div class="row-list">' + rec.map(w =>
      '<div class="wo"><span class="wdate">'+shortDate(w.date)+'</span>'
      + '<b>'+esc(w.type)+'</b><span class="sub">'+(w.duration||0)+' min</span>'
      + '<span class="wnote">'+esc(w.note||'')+'</span>'
      + '<button class="x" data-action="wo-del" data-id="'+w.id+'" aria-label="delete">×</button></div>').join('') + '</div>'
    : '<div class="empty">No workouts logged yet.</div>';
  html += '</section>';
  return html;
}

/* ================= render: review ================= */
function renderReview(){
  const wkStart = monday(new Date());
  const cutoff = Date.now() - 7*864e5;
  /* moved */
  const movedGoal = [];
  for(const g of S.goals) for(const m of g.milestones) for(const t of m.tasks)
    if(t.done && t.doneAt && t.doneAt >= cutoff) movedGoal.push({title:t.title, ctx:g.title, at:t.doneAt});
  const movedSchool = S.deadlines.filter(d=>d.done && d.doneAt && d.doneAt >= cutoff)
    .map(d=>({title:d.title, ctx:d.subject, at:d.doneAt}));
  const moved = movedGoal.concat(movedSchool).sort((a,b)=>b.at-a.at);
  const habits = activeHabits();
  let habitDone = 0;
  for(const h of habits) for(let i=0;i<7;i++) if(h.log && h.log[dkey(addDays(new Date(),-i))]) habitDone++;
  const habitPct = habits.length ? Math.round(100*habitDone/(habits.length*7)) : null;
  const wo7 = S.workouts.filter(w=>dayDiff(w.date) > -7).length;
  /* stuck */
  const stuckGoals = S.goals.filter(g=>g.status==='active' && goalLastMove(g) < cutoff);
  const overdue = S.deadlines.filter(d=>!d.done && dayDiff(d.due) < 0).sort(sortDl);
  const sleepAvg = (()=>{ const v=[]; for(let i=0;i<7;i++){const e=S.sleep[dkey(addDays(new Date(),-i))]; if(e&&e.hours!=null)v.push(e.hours);} return v.length?(v.reduce((a,b)=>a+b,0)/v.length).toFixed(1):null; })();

  let html = '<section><h1 class="day">Weekly review</h1><div class="sub">Week of '+shortDate(dkey(wkStart))+' — what moved, what’s stuck, what to adjust.</div></section>';

  html += '<section><div class="micro"><span>1 · What moved</span></div>';
  html += '<div class="stat-line">'
    + '<div class="stat"><b>'+moved.length+'</b><span>tasks completed</span></div>'
    + (habitPct!=null?'<div class="stat"><b>'+habitPct+'%</b><span>habit consistency</span></div>':'')
    + '<div class="stat"><b>'+wo7+'</b><span>workouts</span></div>'
    + (sleepAvg?'<div class="stat"><b>'+sleepAvg+'h</b><span>avg sleep</span></div>':'')
    + '</div>';
  html += moved.length ? moved.slice(0,12).map(m=>'<div class="rv-item"><span class="when">'+shortDate(dkey(new Date(m.at)))+'</span><span>'+esc(m.title)+' <span class="sub">· '+esc(m.ctx)+'</span></span></div>').join('')
    : '<div class="empty">Nothing completed in the last 7 days.</div>';
  html += '</section>';

  html += '<section><div class="micro"><span>2 · What’s stuck</span></div>';
  if(!stuckGoals.length && !overdue.length) html += '<div class="empty">Nothing stuck. Keep going.</div>';
  html += stuckGoals.map(g=>{
    const na = nextAction(g);
    return '<div class="rv-item"><span class="when">goal</span><span>'+esc(g.title)+' — no progress in 7+ days.'
      + (na?' <span class="sub">Next: '+esc(na.task.title)+'</span>':' <span class="sub">No tasks defined.</span>')+'</span></div>';
  }).join('');
  html += overdue.map(d=>'<div class="rv-item"><span class="when">overdue</span><span>'+esc(d.title)+' <span class="sub">· '+esc(d.subject)+' · due '+shortDate(d.due)+'</span></span></div>').join('');
  html += '</section>';

  const wk = weekKey();
  const note = (S.reviews[wk] && S.reviews[wk].note) || '';
  html += '<section><div class="micro"><span>3 · What to adjust</span></div>'
    + '<textarea id="review-note" placeholder="One or two concrete adjustments for next week…">'+esc(note)+'</textarea>'
    + '<div style="margin-top:10px;display:flex;gap:10px;align-items:center"><button class="btn" data-action="review-save">Save review</button>'
    + '<span class="sub" id="review-saved">'+(S.reviews[wk]?'Saved '+shortDate(dkey(new Date(S.reviews[wk].savedAt))):'')+'</span></div></section>';

  const past = Object.keys(S.reviews).filter(k=>k!==wk).sort().reverse().slice(0,8);
  if(past.length){
    html += '<section><div class="micro"><span>Past reviews</span></div>'
      + past.map(k=>'<div class="rv-item"><span class="when">'+shortDate(k)+'</span><span>'+esc(S.reviews[k].note)+'</span></div>').join('')
      + '</section>';
  }
  return html;
}

/* ================= render root ================= */
function render(){
  document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active', b.dataset.nav===view));
  const main = document.getElementById('main');
  main.innerHTML = view==='today' ? renderToday()
    : view==='calendar' ? renderCalendar()
    : view==='goals' ? renderGoals()
    : view==='school' ? renderSchool()
    : view==='workouts' ? renderWorkouts()
    : renderReview();
}
/* delayed render so check animations can play before the DOM is rebuilt */
const renderSoon = () => setTimeout(render, 320);

/* ================= dialogs ================= */
const dlgGoal = document.getElementById('dlg-goal');
const dlgHabit = document.getElementById('dlg-habit');
const dlgDeadline = document.getElementById('dlg-deadline');
document.querySelectorAll('dialog [data-close]').forEach(b=>b.addEventListener('click', ()=>b.closest('dialog').close()));

/* ================= date picker (adapted from the shadcn/ui Calendar pattern, monochrome) ================= */
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function datePicker(rootId){
  const root = document.getElementById(rootId);
  const input = root.querySelector('.dp-display');
  const pop = root.querySelector('.dp-pop');
  let vy = 0, vm = 0; // viewed year / month
  const fmt = iso => { const d = parseKey(iso); return MONTHS[d.getMonth()]+' '+d.getDate()+', '+d.getFullYear(); };
  function renderCal(){
    const sel = input.dataset.iso || '';
    const t = todayKey();
    const start = monday(new Date(vy, vm, 1));
    let cells = '';
    for(let i=0;i<42;i++){
      const d = addDays(start, i);
      const iso = dkey(d);
      cells += '<button type="button" class="dp-day'+(d.getMonth()!==vm?' out':'')+(iso===t?' today':'')
        +(iso===sel?' sel':'')+'" data-day="'+iso+'">'+d.getDate()+'</button>';
    }
    pop.innerHTML = '<div class="dp-head">'
      + '<button type="button" class="dp-nav" data-cal="prev" aria-label="Previous month">‹</button>'
      + '<span class="dp-title">'+MONTHS_FULL[vm]+' '+vy+'</span>'
      + '<button type="button" class="dp-nav" data-cal="next" aria-label="Next month">›</button></div>'
      + '<div class="dp-grid">'
      + ['Mo','Tu','We','Th','Fr','Sa','Su'].map(w=>'<span class="dp-wd">'+w+'</span>').join('')
      + cells + '</div>';
  }
  function open(){
    const base = parseKey(input.dataset.iso || todayKey());
    vy = base.getFullYear(); vm = base.getMonth();
    renderCal(); pop.hidden = false;
  }
  const close = () => { pop.hidden = true; };
  input.addEventListener('click', ()=> pop.hidden ? open() : close());
  pop.addEventListener('click', e=>{
    const nav = e.target.closest('[data-cal]');
    if(nav){
      vm += nav.dataset.cal==='next' ? 1 : -1;
      if(vm < 0){ vm = 11; vy--; } else if(vm > 11){ vm = 0; vy++; }
      renderCal(); return;
    }
    const day = e.target.closest('[data-day]');
    if(day){ api.value = day.dataset.day; close(); }
  });
  const api = {
    get value(){ return input.dataset.iso || ''; },
    set value(iso){ input.dataset.iso = iso || ''; input.value = iso ? fmt(iso) : ''; },
    flagEmpty(){
      input.classList.add('shake'); input.focus();
      setTimeout(()=>input.classList.remove('shake'), 500);
    },
    close
  };
  return api;
}
const DP = { goal: datePicker('dp-goal'), due: datePicker('dp-due') };
document.addEventListener('click', e=>{
  /* month-nav clicks re-render the popover, detaching the click target — a detached
     node has no .dp ancestor and would falsely read as an outside click */
  if(!(e.target instanceof Element) || !e.target.isConnected) return;
  if(!e.target.closest('.dp')){ DP.goal.close(); DP.due.close(); }
});
[dlgGoal, dlgDeadline].forEach(d=>{
  /* Esc closes an open calendar first, the dialog second */
  d.addEventListener('cancel', e=>{
    const openPop = d.querySelector('.dp-pop:not([hidden])');
    if(openPop){ e.preventDefault(); openPop.hidden = true; }
  });
  d.addEventListener('close', ()=>{ DP.goal.close(); DP.due.close(); });
});

function openGoalDlg(g){
  const f = document.getElementById('form-goal');
  f.reset();
  f.id.value = g ? g.id : '';
  document.getElementById('dlg-goal-title').textContent = g ? 'Edit goal' : 'New goal';
  document.getElementById('goal-status-field').hidden = !g;
  DP.goal.value = g ? g.deadline : '';
  if(g){ f.title.value=g.title; f.why.value=g.why||''; f.status.value=g.status; }
  dlgGoal.showModal();
}
function openHabitDlg(h){
  const f = document.getElementById('form-habit');
  f.reset();
  f.id.value = h ? h.id : '';
  document.getElementById('dlg-habit-title').textContent = h ? 'Edit habit' : 'New habit';
  document.getElementById('habit-arch-field').hidden = !h;
  document.getElementById('habit-delete').hidden = !h;
  if(h){ f.name.value=h.name; f.workoutLinked.checked=!!h.workoutLinked; f.archived.checked=!!h.archived; }
  dlgHabit.showModal();
}
function openDeadlineDlg(d, presetDue){
  const f = document.getElementById('form-deadline');
  f.reset();
  f.id.value = d ? d.id : '';
  document.getElementById('dlg-deadline-title').textContent = d ? 'Edit school task' : 'New school task';
  const sel = f.goalId;
  sel.innerHTML = '<option value="">—</option>' + S.goals.filter(g=>g.status!=='done')
    .map(g=>'<option value="'+g.id+'">'+esc(g.title)+'</option>').join('');
  DP.due.value = d ? d.due : (presetDue || '');
  if(d){ f.title.value=d.title; f.subject.value=d.subject; f.priority.value=d.priority; f.goalId.value=d.goalId||''; }
  dlgDeadline.showModal();
}

document.getElementById('form-goal').addEventListener('submit', e=>{
  e.preventDefault();
  const f = e.target;
  const deadline = DP.goal.value;
  if(!deadline){ DP.goal.flagEmpty(); return; }
  if(f.id.value){
    const g = S.goals.find(x=>x.id===f.id.value);
    if(g){ g.title=f.title.value.trim(); g.why=f.why.value.trim(); g.deadline=deadline; g.status=f.status.value; }
  } else {
    S.goals.push({id:uid(), title:f.title.value.trim(), why:f.why.value.trim(), deadline, status:'active', milestones:[]});
  }
  save(); dlgGoal.close(); view='goals'; render();
});
document.getElementById('form-habit').addEventListener('submit', e=>{
  e.preventDefault();
  const f = e.target;
  if(f.id.value){
    const h = S.habits.find(x=>x.id===f.id.value);
    if(h){
      if(!f.archived.checked && h.archived && activeHabits().length>=5){ alert('Max 5 active habits — archive another first.'); return; }
      h.name=f.name.value.trim(); h.workoutLinked=f.workoutLinked.checked;
      h.archived=f.archived.checked;
    }
  } else {
    if(activeHabits().length>=5){ alert('Max 5 active habits.'); return; }
    S.habits.push({id:uid(), name:f.name.value.trim(), workoutLinked:f.workoutLinked.checked, archived:false, log:{}});
  }
  save(); dlgHabit.close(); render();
});
document.getElementById('habit-delete').addEventListener('click', ()=>{
  const id = document.getElementById('form-habit').id.value;
  if(id && confirm('Delete this habit and its history?')){
    S.habits = S.habits.filter(h=>h.id!==id);
    save(); dlgHabit.close(); render();
  }
});
document.getElementById('form-deadline').addEventListener('submit', e=>{
  e.preventDefault();
  const f = e.target;
  const due = DP.due.value;
  if(!due){ DP.due.flagEmpty(); return; }
  if(f.id.value){
    const d = S.deadlines.find(x=>x.id===f.id.value);
    if(d){ d.title=f.title.value.trim(); d.subject=f.subject.value.trim(); d.due=due; d.priority=f.priority.value; d.goalId=f.goalId.value||null; }
  } else {
    S.deadlines.push({id:uid(), title:f.title.value.trim(), subject:f.subject.value.trim(), due, priority:f.priority.value, goalId:f.goalId.value||null, done:false});
  }
  save(); dlgDeadline.close(); render();
});

/* ================= event delegation ================= */
document.getElementById('nav').addEventListener('click', e=>{
  const b = e.target.closest('[data-nav]');
  if(b){ view = b.dataset.nav; render(); window.scrollTo(0,0); }
});

document.getElementById('main').addEventListener('click', e=>{
  const el = e.target.closest('[data-action]');
  if(!el) return;
  const a = el.dataset.action;
  if(a==='go-school'){ view='school'; render(); }
  else if(a==='go-goals'){ view='goals'; render(); }
  else if(a==='go-review'){ view='review'; render(); }
  else if(a==='cal-prev'){ calView.m--; if(calView.m<0){ calView.m=11; calView.y--; } render(); }
  else if(a==='cal-next'){ calView.m++; if(calView.m>11){ calView.m=0; calView.y++; } render(); }
  else if(a==='cal-today'){ const now=new Date(); calView={y:now.getFullYear(), m:now.getMonth()}; calSelected=''; render(); }
  else if(a==='cal-day'){
    calSelected = el.dataset.day;
    const d = parseKey(calSelected);
    calView = { y: d.getFullYear(), m: d.getMonth() };
    render();
  }
  else if(a==='cal-add-here'){ openDeadlineDlg(null, calSelected || todayKey()); }
  else if(a==='cal-open-task'){ openDeadlineDlg(S.deadlines.find(x=>x.id===el.dataset.id)); }
  else if(a==='cal-open-goal'){ openGoalDlg(S.goals.find(x=>x.id===el.dataset.id)); }
  else if(a==='habit-editmode'){ habitEditMode=!habitEditMode; render(); }
  else if(a==='habit-add'){ openHabitDlg(null); }
  else if(a==='habit-edit'){ openHabitDlg(S.habits.find(h=>h.id===el.dataset.id)); }
  else if(a==='goal-add'){ openGoalDlg(null); }
  else if(a==='goal-edit'){ openGoalDlg(S.goals.find(g=>g.id===el.dataset.id)); }
  else if(a==='goal-toggle-open'){
    const id = el.dataset.id;
    if(openGoals.has(id)) openGoals.delete(id); else openGoals.add(id);
    el.closest('.goal-card').classList.toggle('open');
  }
  else if(a==='goal-done'){ const g=S.goals.find(x=>x.id===el.dataset.id); if(g){g.status='done'; save(); render();} }
  else if(a==='goal-reopen'){ const g=S.goals.find(x=>x.id===el.dataset.id); if(g){g.status='active'; save(); render();} }
  else if(a==='goal-del'){
    if(confirm('Delete this goal, its milestones and tasks?')){
      S.goals = S.goals.filter(g=>g.id!==el.dataset.id); save(); render();
    }
  }
  else if(a==='ms-del'){
    const g = S.goals.find(x=>x.id===el.dataset.goal);
    if(g && confirm('Delete this milestone and its tasks?')){
      g.milestones = g.milestones.filter(m=>m.id!==el.dataset.id); save(); render();
    }
  }
  else if(a==='task-del'){
    const g = S.goals.find(x=>x.id===el.dataset.goal);
    const m = g && g.milestones.find(x=>x.id===el.dataset.ms);
    if(m){ m.tasks = m.tasks.filter(t=>t.id!==el.dataset.id); save(); render(); }
  }
  else if(a==='dl-add'){ openDeadlineDlg(null); }
  else if(a==='dl-del'){ S.deadlines = S.deadlines.filter(d=>d.id!==el.dataset.id); save(); render(); }
  else if(a==='wo-del'){ S.workouts = S.workouts.filter(w=>w.id!==el.dataset.id); save(); render(); }
  else if(a==='sleep-hours' || a==='sleep-feel'){
    const t = todayKey();
    S.sleep[t] = S.sleep[t] || {};
    if(a==='sleep-hours') S.sleep[t].hours = Number(el.dataset.v);
    else S.sleep[t].feeling = Number(el.dataset.v);
    save(); render();
  }
  else if(a==='review-save'){
    const note = document.getElementById('review-note').value.trim();
    S.reviews[weekKey()] = {note, savedAt: Date.now()};
    save(); render();
  }
});

/* checkboxes: habits, goal tasks, school deadlines */
document.getElementById('main').addEventListener('change', e=>{
  const input = e.target;
  if(input.dataset.habit){
    const h = S.habits.find(x=>x.id===input.dataset.habit);
    if(h){
      h.log = h.log || {};
      const t = todayKey();
      if(input.checked) h.log[t] = true; else delete h.log[t];
      save(); renderSoon();
    }
  } else if(input.dataset.task){
    const g = S.goals.find(x=>x.id===input.dataset.goal);
    if(g){
      for(const m of g.milestones){
        const tk = m.tasks.find(t=>t.id===input.dataset.task);
        if(tk){ tk.done = input.checked; tk.doneAt = input.checked ? Date.now() : null; break; }
      }
      save(); if(input.checked) renderSoon(); else render();
    }
  } else if(input.dataset.deadline){
    const d = S.deadlines.find(x=>x.id===input.dataset.deadline);
    if(d){ d.done = input.checked; d.doneAt = input.checked ? Date.now() : null; save(); if(input.checked) renderSoon(); else render(); }
  }
});

/* inline add forms (milestones, tasks, workouts) */
document.getElementById('main').addEventListener('submit', e=>{
  const f = e.target.closest('[data-form]');
  if(!f) return;
  e.preventDefault();
  const kind = f.dataset.form;
  if(kind==='ms-add'){
    const g = S.goals.find(x=>x.id===f.dataset.goal);
    const v = f.title.value.trim();
    if(g && v){ g.milestones.push({id:uid(), title:v, tasks:[]}); openGoals.add(g.id); save(); render(); }
  } else if(kind==='task-add'){
    const g = S.goals.find(x=>x.id===f.dataset.goal);
    const m = g && g.milestones.find(x=>x.id===f.dataset.ms);
    const v = f.title.value.trim();
    if(m && v){ m.tasks.push({id:uid(), title:v, done:false, doneAt:null}); openGoals.add(g.id); save(); render(); }
  } else if(kind==='wo-add'){
    const type = f.type.value.trim(), dur = Number(f.duration.value), note = f.note.value.trim();
    if(type && dur){
      const t = todayKey();
      S.workouts.push({id:uid(), date:t, type, duration:dur, note});
      /* a workout doubles as a habit check-in */
      for(const h of activeHabits()) if(h.workoutLinked){ h.log = h.log || {}; h.log[t] = true; }
      save(); render();
    }
  }
});

/* ================= tooltip ================= */
const tip = document.getElementById('tooltip');
document.addEventListener('mouseover', e=>{
  const t = e.target.closest('[data-tip]');
  if(!t || !t.dataset.tip){ tip.style.opacity = 0; return; }
  tip.textContent = t.dataset.tip;
  tip.style.opacity = 1;
  const r = t.getBoundingClientRect();
  tip.style.left = Math.max(6, Math.min(window.innerWidth - tip.offsetWidth - 6, r.left + r.width/2 - tip.offsetWidth/2)) + 'px';
  tip.style.top = Math.max(6, r.top - tip.offsetHeight - 8) + 'px';
});
document.addEventListener('scroll', ()=>{ tip.style.opacity = 0; }, true);

/* ================= boot ================= */
/* hairline under the header only once content scrolls beneath it */
const headerEl = document.querySelector('header');
addEventListener('scroll', ()=> headerEl.classList.toggle('scrolled', scrollY > 4), {passive:true});

render();
pullRemote();
/* re-sync when the tab comes back to the foreground */
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) pullRemote(); });
