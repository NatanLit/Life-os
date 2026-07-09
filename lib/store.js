'use strict';
/* Storage layer with two backends, chosen automatically:
   - Upstash Redis over its REST API when the env vars are present (Vercel / production)
   - a local JSON file otherwise (npm start on your machine)
   Both expose the same async read/write pair. */
const fs = require('fs');
const path = require('path');

const REST_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '';
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const STATE_KEY  = process.env.STATE_KEY || 'lifeos:state';
const usingRedis = !!(REST_URL && REST_TOKEN);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

const DEFAULT_STATE = { goals: [], habits: [], workouts: [], deadlines: [], sleep: {}, reviews: {}, updatedAt: 0 };
const withDefaults = obj => Object.assign({}, DEFAULT_STATE, obj);

async function redisCmd(cmd) {
  const r = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}

async function readState() {
  if (usingRedis) {
    const raw = await redisCmd(['GET', STATE_KEY]);
    if (!raw) return withDefaults();
    try { return withDefaults(JSON.parse(raw)); } catch (e) { return withDefaults(); }
  }
  try { return withDefaults(JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch (e) { return withDefaults(); }
}

async function writeState(state) {
  if (usingRedis) { await redisCmd(['SET', STATE_KEY, JSON.stringify(state)]); return; }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state)); // atomic swap so a crash never leaves a half-written db
  fs.renameSync(tmp, DB_FILE);
}

module.exports = { readState, writeState, DEFAULT_STATE, usingRedis };
