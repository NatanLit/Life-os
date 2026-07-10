import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const PORT = 3301;
const CODE = 'testcode';
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = join(tmpdir(), 'life-os-mcp-test-' + Date.now());
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}

let pass = 0, fail = 0;
const check = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } };
const txt = r => (r.content && r.content[0] && r.content[0].text) || '';
const parse = r => JSON.parse(txt(r));

async function serverState() { return await (await fetch(BASE + '/api/state', { headers: { Authorization: 'Bearer ' + CODE } })).json(); }

// 1) boot a local Life OS server
const srv = spawn('node', ['../server.js'], { env: { ...process.env, PORT: String(PORT), ACCESS_CODE: CODE, DATA_DIR }, stdio: 'ignore' });
await sleep(1500);

// 2) connect MCP client -> spawns our MCP server as subprocess
const transport = new StdioClientTransport({
  command: 'node',
  args: ['server.js'],
  env: { ...process.env, LIFEOS_URL: BASE, LIFEOS_CODE: CODE }
});
const client = new Client({ name: 'test', version: '1.0.0' });
await client.connect(transport);

try {
  const tools = (await client.listTools()).tools;
  console.log('TOOLS (' + tools.length + '):', tools.map(t => t.name).join(', '));
  check('exposes >= 20 tools', tools.length >= 20, String(tools.length));

  const call = (name, args) => client.callTool({ name, arguments: args || {} });

  // HABITS
  const linked = await call('add_habit', { name: 'Train', workoutLinked: true });
  check('add_habit Train', /Added habit/.test(txt(linked)));
  await call('add_habit', { name: 'Read 20 min' });
  await call('add_habit', { name: 'No caffeine after 14:00' });
  let st = await serverState();
  check('server has 3 habits', st.habits.length === 3, String(st.habits.length));

  // dup + limit guards
  const dup = await call('add_habit', { name: 'Read 20 min' });
  check('duplicate habit rejected', !!dup.isError, txt(dup));

  // log habit by name
  await call('log_habit', { habit: 'Read 20 min' });
  st = await serverState();
  const today = new Date().toISOString().slice(0, 10);
  check('log_habit checked today', !!st.habits.find(h => h.name === 'Read 20 min').log[today]);

  // GOAL -> MILESTONE -> TASK -> complete
  const g = await call('add_goal', { title: 'Get 7 in Math', deadline: '2026-10-01', why: 'DP HL' });
  check('add_goal', /Added goal/.test(txt(g)));
  const gid = txt(g).match(/id (\w+)/)[1];
  const m = await call('add_milestone', { goal: 'Get 7 in Math', title: 'Master algebra' });
  const mid = txt(m).match(/id (\w+)/)[1];
  const t1 = await call('add_task', { goal: gid, milestoneId: mid, title: 'Practice set 3' });
  const tid = txt(t1).match(/id (\w+)/)[1];
  await call('add_task', { goal: gid, milestoneId: mid, title: 'Past paper A' });
  await call('complete_task', { goal: gid, taskId: tid });
  st = await serverState();
  const goal = st.goals.find(x => x.id === gid);
  check('goal has 1 milestone / 2 tasks', goal.milestones[0].tasks.length === 2);
  check('one task done', goal.milestones[0].tasks.filter(x => x.done).length === 1);

  // overview reflects 50% milestone
  const ov = parse(await call('get_overview', {}));
  check('overview goal percent = 50', ov.goals.find(x => x.id === gid).percent === 50, JSON.stringify(ov.goals.find(x => x.id === gid)));
  check('overview lists 3 habits', ov.habits.length === 3);
  check('overview nextAction present', !!ov.goals.find(x => x.id === gid).nextAction);

  // DEADLINE linked to goal
  const d = await call('add_deadline', { title: 'Criterion B draft', subject: 'Math', due: '2026-07-15', priority: 'high', goal: 'Get 7 in Math' });
  const did = txt(d).match(/id (\w+)/)[1];
  st = await serverState();
  check('deadline linked to goal', st.deadlines.find(x => x.id === did).goalId === gid);
  await call('complete_deadline', { deadline: 'Criterion B draft' });
  st = await serverState();
  check('deadline completed', st.deadlines.find(x => x.id === did).done === true);

  // WORKOUT auto-checks the linked habit
  await call('log_workout', { type: 'Gym', duration: 60, note: 'push day' });
  st = await serverState();
  check('workout logged', st.workouts.length === 1);
  check('workout-linked habit auto-checked', !!st.habits.find(h => h.name === 'Train').log[today]);

  // SLEEP
  await call('log_sleep', { hours: 7.5, feeling: 4 });
  st = await serverState();
  check('sleep logged today', st.sleep[today] && st.sleep[today].hours === 7.5 && st.sleep[today].feeling === 4);

  // REVIEW
  await call('save_review', { note: 'Sleep earlier next week.' });
  st = await serverState();
  check('review saved', Object.values(st.reviews).some(r => /Sleep earlier/.test(r.note)));

  // DELETE habit -> tombstone
  await call('delete_habit', { habit: 'No caffeine after 14:00' });
  st = await serverState();
  const goneId = Object.keys(st.tombstones || {});
  check('habit deleted', !st.habits.some(h => h.name === 'No caffeine after 14:00'));
  check('tombstone written for delete', goneId.length >= 1, JSON.stringify(st.tombstones));

  // DELETE task (nested, no tombstone)
  const tombsBefore = Object.keys(st.tombstones).length;
  await call('delete_task', { goal: gid, milestoneId: mid, taskId: tid });
  st = await serverState();
  check('task deleted', !st.goals.find(x => x.id === gid).milestones[0].tasks.some(t => t.id === tid));
  check('nested delete adds no tombstone', Object.keys(st.tombstones).length === tombsBefore);

  // error handling: unknown id
  const err = await call('complete_task', { goal: gid, taskId: 'nope' });
  check('unknown task id errors cleanly', !!err.isError && /not found/.test(txt(err)));

} finally {
  await client.close();
  srv.kill('SIGKILL');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
