#!/usr/bin/env node
'use strict';
/*
 * Life OS MCP server.
 *
 * Exposes a Life OS deployment (the same /api/state the web app uses) as a full set of
 * agent tools: read everything (for feedback), and create / update / delete habits, goals,
 * milestones (sub-goals), tasks, school deadlines, workouts, sleep check-ins and weekly
 * reviews — everything a person can do in the UI.
 *
 * Config via environment:
 *   LIFEOS_URL   base URL of your deployment (default: the hosted app)
 *   LIFEOS_CODE  your access code (the ACCESS_CODE you set in Vercel)
 *
 * Every write does a read-merge-write against the server's revision, retrying on conflict,
 * and mirrors the app's tombstone rules so deletions sync correctly across devices.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.LIFEOS_URL || 'https://life-os-brown-five.vercel.app').replace(/\/$/, '');
const CODE = process.env.LIFEOS_CODE || '';

/* ---------------- API client (read-merge-write with rev-based conflict retry) ---------------- */
const DEFAULT_STATE = { goals: [], habits: [], workouts: [], deadlines: [], sleep: {}, reviews: {}, countdown: {}, tombstones: {}, rev: 0, updatedAt: 0 };
const authHeaders = () => (CODE ? { Authorization: 'Bearer ' + CODE } : {});

async function getState() {
  const r = await fetch(BASE + '/api/state', { headers: authHeaders(), cache: 'no-store' });
  if (r.status === 401) throw new Error('unauthorized — check LIFEOS_CODE (your access code).');
  if (!r.ok) throw new Error('GET /api/state failed: ' + r.status);
  return Object.assign({}, DEFAULT_STATE, await r.json());
}

/* fn(state) mutates the state in place and may return a value; that value is returned to the caller */
async function mutate(fn) {
  let lastErr;
  for (let tries = 0; tries < 6; tries++) {
    const state = await getState();
    const baseRev = state.rev || 0;
    const out = fn(state);
    state.updatedAt = Date.now();
    const r = await fetch(BASE + '/api/state', {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(Object.assign({}, state, { baseRev }))
    });
    if (r.status === 401) throw new Error('unauthorized — check LIFEOS_CODE.');
    if (r.status === 409) { lastErr = 'conflict'; continue; } // someone wrote in between — re-read and retry
    if (!r.ok) throw new Error('PUT /api/state failed: ' + r.status);
    return out;
  }
  throw new Error('could not save after several retries (' + lastErr + ')');
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function tombstone(state, id) { state.tombstones = state.tombstones || {}; state.tombstones[id] = Date.now(); }

/* ---------------- date + derived helpers (ported from the web app) ---------------- */
const pad = n => String(n).padStart(2, '0');
const dkey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseKey = k => { const p = k.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
const todayKey = () => dkey(new Date());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayDiff = k => Math.round((parseKey(k) - parseKey(todayKey())) / 864e5);
const monday = d => { const x = new Date(d); const w = (x.getDay() + 6) % 7; x.setDate(x.getDate() - w); return x; };
const weekKey = () => dkey(monday(new Date()));
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const msPct = m => m.tasks.length ? Math.round(100 * m.tasks.filter(t => t.done).length / m.tasks.length) : 0;
const goalPct = g => g.milestones.length ? Math.round(g.milestones.reduce((a, m) => a + msPct(m), 0) / g.milestones.length) : 0;
function nextAction(g) {
  for (const m of g.milestones) for (const t of m.tasks) if (!t.done) return { milestone: m.title, task: t.title };
  return null;
}
function habitStreak(h) {
  const keys = Object.keys(h.log || {}).filter(k => h.log[k]).sort();
  if (!keys.length) return 0;
  let s = 0; const t = todayKey(); let d = parseKey(keys[0]); const end = parseKey(t);
  while (d <= end) { const k = dkey(d); if (h.log[k]) s += 1; else if (k !== t) s = Math.max(0, s - 1); d = addDays(d, 1); }
  return Math.floor(s);
}
const PRI_W = { high: 0, med: 1, low: 2 };
const sortDl = (a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || (PRI_W[a.priority] - PRI_W[b.priority]);

/* ---------------- entity resolvers (accept id, or a name/title for convenience) ---------------- */
function resolve(list, ref, field, kind) {
  if (!ref) throw new Error('missing ' + kind + ' id');
  let item = list.find(x => x.id === ref);
  if (item) return item;
  const matches = list.filter(x => (x[field] || '').toLowerCase() === String(ref).toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error('several ' + kind + 's match "' + ref + '" — use the id instead');
  throw new Error(kind + ' not found: "' + ref + '" (use get_state / list to see ids)');
}

/* ---------------- MCP server ---------------- */
const server = new McpServer({ name: 'life-os', version: '1.0.0' });
const ok = text => ({ content: [{ type: 'text', text }] });
const json = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const wrap = handler => async (args) => { try { return await handler(args || {}); } catch (e) { return { isError: true, content: [{ type: 'text', text: 'Error: ' + (e && e.message || e) }] }; } };

/* ===== READ ===== */
server.tool('get_overview',
  'Read a full digest of the whole Life OS — goals with progress and next action, habits with streaks, upcoming school deadlines, recent workouts, sleep trend and this-week stats. Use this first to understand the situation and give feedback.',
  {},
  wrap(async () => {
    const s = await getState();
    const goals = s.goals.map(g => ({ id: g.id, title: g.title, why: g.why, status: g.status, deadline: g.deadline, daysLeft: dayDiff(g.deadline), percent: goalPct(g), milestones: g.milestones.map(m => ({ id: m.id, title: m.title, percent: msPct(m), tasks: m.tasks.length })), nextAction: nextAction(g) }));
    const habits = s.habits.filter(h => !h.archived).map(h => ({ id: h.id, name: h.name, streak: habitStreak(h), doneToday: !!(h.log && h.log[todayKey()]), workoutLinked: !!h.workoutLinked }));
    const openDl = s.deadlines.filter(d => !d.done).sort(sortDl).map(d => ({ id: d.id, title: d.title, subject: d.subject, due: d.due, daysLeft: dayDiff(d.due), priority: d.priority, goalId: d.goalId || null }));
    const w7 = s.workouts.filter(w => dayDiff(w.date) > -7);
    const recentWorkouts = s.workouts.slice().sort((a, b) => b.date < a.date ? -1 : 1).slice(0, 6);
    const sleep14 = []; for (let i = 13; i >= 0; i--) { const k = dkey(addDays(new Date(), -i)); if (s.sleep[k]) sleep14.push(Object.assign({ date: k }, s.sleep[k])); }
    const hoursArr = sleep14.filter(e => e.hours != null).map(e => e.hours);
    const feelArr = sleep14.filter(e => e.feeling != null).map(e => e.feeling);
    const cutoff = Date.now() - 7 * 864e5;
    let tasks7 = 0; for (const g of s.goals) for (const m of g.milestones) for (const t of m.tasks) if (t.done && t.doneAt && t.doneAt >= cutoff) tasks7++;
    tasks7 += s.deadlines.filter(d => d.done && d.doneAt && d.doneAt >= cutoff).length;
    let habitDone = 0; const activeH = s.habits.filter(h => !h.archived);
    for (const h of activeH) for (let i = 0; i < 7; i++) if (h.log && h.log[dkey(addDays(new Date(), -i))]) habitDone++;
    const sleep7 = []; for (let i = 0; i < 7; i++) { const e = s.sleep[dkey(addDays(new Date(), -i))]; if (e && e.hours != null) sleep7.push(e.hours); }
    const avg = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null;
    return json({
      today: todayKey(),
      goals, habits, openDeadlines: openDl,
      workouts: { last7days: w7.length, last7minutes: w7.reduce((a, w) => a + (w.duration || 0), 0), recent: recentWorkouts },
      sleep: { last14: sleep14, avgHours14: avg(hoursArr), avgFeeling14: avg(feelArr), lastNight: s.sleep[dkey(addDays(new Date(), -1))] || s.sleep[todayKey()] || null },
      weekStats: { tasksCompleted7d: tasks7, habitConsistencyPct: activeH.length ? Math.round(100 * habitDone / (activeH.length * 7)) : null, workouts7d: w7.length, avgSleep7d: avg(sleep7) },
      latestReview: (() => { const ks = Object.keys(s.reviews).sort().reverse(); return ks.length ? Object.assign({ week: ks[0] }, s.reviews[ks[0]]) : null; })()
    });
  }));

server.tool('get_state',
  'Return the raw Life OS state as JSON (goals, habits, workouts, deadlines, sleep, reviews). Use when you need exact ids or fields that get_overview summarizes.',
  { section: z.enum(['goals', 'habits', 'workouts', 'deadlines', 'sleep', 'reviews', 'all']).optional().describe('limit to one section (default all)') },
  wrap(async ({ section }) => {
    const s = await getState();
    if (!section || section === 'all') return json({ goals: s.goals, habits: s.habits, workouts: s.workouts, deadlines: s.deadlines, sleep: s.sleep, reviews: s.reviews });
    return json({ [section]: s[section] });
  }));

/* ===== HABITS ===== */
server.tool('add_habit',
  'Create a habit (max 5 active). One-tap daily check-in in the app.',
  { name: z.string().min(1).max(60), workoutLinked: z.boolean().optional().describe('auto-check this habit whenever a workout is logged') },
  wrap(async ({ name, workoutLinked }) => {
    return await mutate(s => {
      if (s.habits.filter(h => !h.archived).length >= 5) throw new Error('already 5 active habits — archive or delete one first');
      if (s.habits.some(h => !h.archived && h.name.toLowerCase() === name.toLowerCase())) throw new Error('a habit named "' + name + '" already exists');
      const h = { id: uid(), name: name.trim(), workoutLinked: !!workoutLinked, archived: false, log: {} };
      s.habits.push(h); return ok('Added habit "' + h.name + '" (id ' + h.id + ').');
    });
  }));

server.tool('update_habit',
  'Rename a habit, toggle workout-linking, or archive/unarchive it.',
  { habit: z.string().describe('habit id or exact name'), name: z.string().max(60).optional(), workoutLinked: z.boolean().optional(), archived: z.boolean().optional() },
  wrap(async ({ habit, name, workoutLinked, archived }) => {
    return await mutate(s => {
      const h = resolve(s.habits, habit, 'name', 'habit');
      if (archived === false && h.archived && s.habits.filter(x => !x.archived).length >= 5) throw new Error('cannot unarchive — already 5 active habits');
      if (name !== undefined) h.name = name.trim();
      if (workoutLinked !== undefined) h.workoutLinked = workoutLinked;
      if (archived !== undefined) h.archived = archived;
      return ok('Updated habit "' + h.name + '".');
    });
  }));

server.tool('delete_habit',
  'Permanently delete a habit and its history.',
  { habit: z.string().describe('habit id or exact name') },
  wrap(async ({ habit }) => {
    return await mutate(s => {
      const h = resolve(s.habits, habit, 'name', 'habit');
      s.habits = s.habits.filter(x => x.id !== h.id); tombstone(s, h.id);
      return ok('Deleted habit "' + h.name + '".');
    });
  }));

server.tool('log_habit',
  'Mark a habit as done (or not done) for a day. Defaults to today and done=true.',
  { habit: z.string().describe('habit id or exact name'), date: z.string().regex(ISO).optional().describe('YYYY-MM-DD, default today'), done: z.boolean().optional().describe('default true') },
  wrap(async ({ habit, date, done }) => {
    const day = date || todayKey();
    const mark = done !== false;
    return await mutate(s => {
      const h = resolve(s.habits, habit, 'name', 'habit');
      h.log = h.log || {};
      if (mark) h.log[day] = true; else delete h.log[day];
      return ok((mark ? 'Checked' : 'Unchecked') + ' "' + h.name + '" for ' + day + '.');
    });
  }));

/* ===== GOALS ===== */
server.tool('add_goal',
  'Create a goal (a destination with a deadline). Add milestones and tasks under it with add_milestone / add_task.',
  { title: z.string().min(1).max(80), deadline: z.string().regex(ISO).describe('YYYY-MM-DD'), why: z.string().max(120).optional().describe('one-line motivation'), status: z.enum(['active', 'paused', 'done']).optional() },
  wrap(async ({ title, deadline, why, status }) => {
    return await mutate(s => {
      const g = { id: uid(), title: title.trim(), why: (why || '').trim(), deadline, status: status || 'active', milestones: [] };
      s.goals.push(g); return ok('Added goal "' + g.title + '" (id ' + g.id + '), due ' + deadline + '.');
    });
  }));

server.tool('update_goal',
  'Edit a goal\'s title, why, deadline or status (active / paused / done).',
  { goal: z.string().describe('goal id or exact title'), title: z.string().max(80).optional(), why: z.string().max(120).optional(), deadline: z.string().regex(ISO).optional(), status: z.enum(['active', 'paused', 'done']).optional() },
  wrap(async ({ goal, title, why, deadline, status }) => {
    return await mutate(s => {
      const g = resolve(s.goals, goal, 'title', 'goal');
      if (title !== undefined) g.title = title.trim();
      if (why !== undefined) g.why = why.trim();
      if (deadline !== undefined) g.deadline = deadline;
      if (status !== undefined) g.status = status;
      return ok('Updated goal "' + g.title + '".');
    });
  }));

server.tool('delete_goal',
  'Delete a goal with all its milestones and tasks.',
  { goal: z.string().describe('goal id or exact title') },
  wrap(async ({ goal }) => {
    return await mutate(s => {
      const g = resolve(s.goals, goal, 'title', 'goal');
      s.goals = s.goals.filter(x => x.id !== g.id); tombstone(s, g.id);
      return ok('Deleted goal "' + g.title + '".');
    });
  }));

/* ===== MILESTONES (sub-goals) ===== */
server.tool('add_milestone',
  'Add a milestone (sub-goal) under a goal. A goal usually has 3–6.',
  { goal: z.string().describe('goal id or exact title'), title: z.string().min(1).max(80) },
  wrap(async ({ goal, title }) => {
    return await mutate(s => {
      const g = resolve(s.goals, goal, 'title', 'goal');
      const m = { id: uid(), title: title.trim(), tasks: [] };
      g.milestones.push(m); return ok('Added milestone "' + m.title + '" (id ' + m.id + ') to "' + g.title + '".');
    });
  }));

server.tool('update_milestone',
  'Rename a milestone.',
  { goal: z.string(), milestoneId: z.string(), title: z.string().min(1).max(80) },
  wrap(async ({ goal, milestoneId, title }) => {
    return await mutate(s => {
      const g = resolve(s.goals, goal, 'title', 'goal');
      const m = g.milestones.find(x => x.id === milestoneId);
      if (!m) throw new Error('milestone not found: ' + milestoneId);
      m.title = title.trim(); return ok('Renamed milestone to "' + m.title + '".');
    });
  }));

server.tool('delete_milestone',
  'Delete a milestone and its tasks from a goal.',
  { goal: z.string(), milestoneId: z.string() },
  wrap(async ({ goal, milestoneId }) => {
    return await mutate(s => {
      const g = resolve(s.goals, goal, 'title', 'goal');
      const before = g.milestones.length;
      g.milestones = g.milestones.filter(x => x.id !== milestoneId);
      if (g.milestones.length === before) throw new Error('milestone not found: ' + milestoneId);
      return ok('Deleted milestone from "' + g.title + '".');
    });
  }));

/* ===== TASKS ===== */
server.tool('add_task',
  'Add a task under a milestone of a goal. Completing tasks drives the milestone and goal progress.',
  { goal: z.string(), milestoneId: z.string(), title: z.string().min(1).max(100) },
  wrap(async ({ goal, milestoneId, title }) => {
    return await mutate(s => {
      const g = resolve(s.goals, goal, 'title', 'goal');
      const m = g.milestones.find(x => x.id === milestoneId);
      if (!m) throw new Error('milestone not found: ' + milestoneId);
      const t = { id: uid(), title: title.trim(), done: false, doneAt: null };
      m.tasks.push(t); return ok('Added task "' + t.title + '" (id ' + t.id + ').');
    });
  }));

server.tool('complete_task',
  'Mark a goal task done or not done (default done=true).',
  { goal: z.string(), taskId: z.string(), done: z.boolean().optional() },
  wrap(async ({ goal, taskId, done }) => {
    const mark = done !== false;
    return await mutate(s => {
      const g = resolve(s.goals, goal, 'title', 'goal');
      for (const m of g.milestones) { const t = m.tasks.find(x => x.id === taskId); if (t) { t.done = mark; t.doneAt = mark ? Date.now() : null; return ok((mark ? 'Completed' : 'Reopened') + ' task "' + t.title + '".'); } }
      throw new Error('task not found: ' + taskId);
    });
  }));

server.tool('delete_task',
  'Delete a task from a milestone.',
  { goal: z.string(), milestoneId: z.string(), taskId: z.string() },
  wrap(async ({ goal, milestoneId, taskId }) => {
    return await mutate(s => {
      const g = resolve(s.goals, goal, 'title', 'goal');
      const m = g.milestones.find(x => x.id === milestoneId);
      if (!m) throw new Error('milestone not found: ' + milestoneId);
      const before = m.tasks.length;
      m.tasks = m.tasks.filter(x => x.id !== taskId);
      if (m.tasks.length === before) throw new Error('task not found: ' + taskId);
      return ok('Deleted task from "' + m.title + '".');
    });
  }));

/* ===== SCHOOL DEADLINES ===== */
server.tool('add_deadline',
  'Add a school task / deadline. Optionally link it to a goal.',
  { title: z.string().min(1).max(100), subject: z.string().min(1).max(40), due: z.string().regex(ISO).describe('YYYY-MM-DD'), priority: z.enum(['high', 'med', 'low']).optional().describe('default med'), goal: z.string().optional().describe('goal id or title to link') },
  wrap(async ({ title, subject, due, priority, goal }) => {
    return await mutate(s => {
      let goalId = null;
      if (goal) goalId = resolve(s.goals, goal, 'title', 'goal').id;
      const d = { id: uid(), title: title.trim(), subject: subject.trim(), due, priority: priority || 'med', goalId, done: false };
      s.deadlines.push(d); return ok('Added deadline "' + d.title + '" (' + d.subject + ', due ' + due + ', id ' + d.id + ').');
    });
  }));

server.tool('update_deadline',
  'Edit a school deadline.',
  { deadline: z.string().describe('deadline id or exact title'), title: z.string().max(100).optional(), subject: z.string().max(40).optional(), due: z.string().regex(ISO).optional(), priority: z.enum(['high', 'med', 'low']).optional(), goal: z.string().optional().describe('goal id/title to link, or empty string to unlink') },
  wrap(async ({ deadline, title, subject, due, priority, goal }) => {
    return await mutate(s => {
      const d = resolve(s.deadlines, deadline, 'title', 'deadline');
      if (title !== undefined) d.title = title.trim();
      if (subject !== undefined) d.subject = subject.trim();
      if (due !== undefined) d.due = due;
      if (priority !== undefined) d.priority = priority;
      if (goal !== undefined) d.goalId = goal ? resolve(s.goals, goal, 'title', 'goal').id : null;
      return ok('Updated deadline "' + d.title + '".');
    });
  }));

server.tool('complete_deadline',
  'Mark a school deadline done or not done (default done=true).',
  { deadline: z.string().describe('deadline id or exact title'), done: z.boolean().optional() },
  wrap(async ({ deadline, done }) => {
    const mark = done !== false;
    return await mutate(s => {
      const d = resolve(s.deadlines, deadline, 'title', 'deadline');
      d.done = mark; d.doneAt = mark ? Date.now() : null;
      return ok((mark ? 'Completed' : 'Reopened') + ' "' + d.title + '".');
    });
  }));

server.tool('delete_deadline',
  'Delete a school deadline.',
  { deadline: z.string().describe('deadline id or exact title') },
  wrap(async ({ deadline }) => {
    return await mutate(s => {
      const d = resolve(s.deadlines, deadline, 'title', 'deadline');
      s.deadlines = s.deadlines.filter(x => x.id !== d.id); tombstone(s, d.id);
      return ok('Deleted deadline "' + d.title + '".');
    });
  }));

/* ===== WORKOUTS ===== */
server.tool('log_workout',
  'Log a workout. If any habit is workout-linked, it is auto-checked for that day (like the app).',
  { type: z.string().min(1).max(40).describe('e.g. Gym, Run, Football'), duration: z.number().int().min(1).max(600).describe('minutes'), note: z.string().max(120).optional(), date: z.string().regex(ISO).optional().describe('default today') },
  wrap(async ({ type, duration, note, date }) => {
    const day = date || todayKey();
    return await mutate(s => {
      const w = { id: uid(), date: day, type: type.trim(), duration, note: (note || '').trim() };
      s.workouts.push(w);
      let linked = 0;
      for (const h of s.habits) if (!h.archived && h.workoutLinked) { h.log = h.log || {}; h.log[day] = true; linked++; }
      return ok('Logged ' + type + ' ' + duration + ' min on ' + day + (linked ? ' (also checked ' + linked + ' linked habit' + (linked > 1 ? 's' : '') + ')' : '') + '.');
    });
  }));

server.tool('delete_workout',
  'Delete a logged workout by id.',
  { workoutId: z.string() },
  wrap(async ({ workoutId }) => {
    return await mutate(s => {
      const w = s.workouts.find(x => x.id === workoutId);
      if (!w) throw new Error('workout not found: ' + workoutId);
      s.workouts = s.workouts.filter(x => x.id !== workoutId); tombstone(s, workoutId);
      return ok('Deleted ' + w.type + ' from ' + w.date + '.');
    });
  }));

/* ===== SLEEP ===== */
server.tool('log_sleep',
  'Record a daily sleep check-in: hours slept and/or a 1–5 feeling. Defaults to today; updates the existing entry if present.',
  { hours: z.number().min(0).max(24).optional(), feeling: z.number().int().min(1).max(5).optional(), date: z.string().regex(ISO).optional().describe('default today') },
  wrap(async ({ hours, feeling, date }) => {
    if (hours === undefined && feeling === undefined) throw new Error('provide hours and/or feeling');
    const day = date || todayKey();
    return await mutate(s => {
      s.sleep[day] = s.sleep[day] || {};
      if (hours !== undefined) s.sleep[day].hours = hours;
      if (feeling !== undefined) s.sleep[day].feeling = feeling;
      return ok('Sleep for ' + day + ': ' + JSON.stringify(s.sleep[day]) + '.');
    });
  }));

/* ===== WEEKLY REVIEW ===== */
server.tool('save_review',
  'Save the weekly review note (the "what to adjust" reflection). Defaults to the current week.',
  { note: z.string().max(2000), week: z.string().regex(ISO).optional().describe('a Monday date key; default this week') },
  wrap(async ({ note, week }) => {
    const wk = week || weekKey();
    return await mutate(s => {
      s.reviews[wk] = { note: note.trim(), savedAt: Date.now() };
      return ok('Saved review for week of ' + wk + '.');
    });
  }));

/* ---------------- boot ---------------- */
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Life OS MCP server connected — target ' + BASE + (CODE ? ' (authenticated)' : ' (no LIFEOS_CODE set)'));
