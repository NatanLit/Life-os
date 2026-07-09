'use strict';
/* Storage layer with three backends, chosen automatically by whichever env vars exist:
   1. Standard Redis over TCP via REDIS_URL / KV_URL — what Vercel's "Redis" Marketplace
      integration (redis-cli / node-redis quickstart) actually provisions.
   2. Upstash-style REST API (KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN) — kept
      for anyone using that integration instead.
   3. A local JSON file — used when neither is set (npm start on your machine).
   All three expose the same async read/write pair. */
const fs = require('fs');
const path = require('path');

const REDIS_URL  = process.env.REDIS_URL || process.env.KV_URL || '';
const REST_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '';
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const STATE_KEY  = process.env.STATE_KEY || 'lifeos:state';

const usingRedisRest = !!(REST_URL && REST_TOKEN);
const usingRedisTcp  = !!REDIS_URL && !usingRedisRest;
const usingRedis = usingRedisRest || usingRedisTcp;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

const DEFAULT_STATE = { goals: [], habits: [], workouts: [], deadlines: [], sleep: {}, reviews: {}, tombstones: {}, updatedAt: 0 };
const withDefaults = obj => Object.assign({}, DEFAULT_STATE, obj);

/* ---- Upstash-style REST client ---- */
async function redisRestCmd(cmd) {
  const r = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}

/* ---- standard TCP Redis client (node-redis), kept warm across serverless invocations ---- */
let clientPromise = null;
async function getTcpClient() {
  if (!clientPromise) {
    const { createClient } = require('redis');
    const client = createClient({ url: REDIS_URL });
    client.on('error', err => console.error('redis client error:', err.message));
    clientPromise = client.connect().then(() => client).catch(err => { clientPromise = null; throw err; });
  }
  return clientPromise;
}

async function readState() {
  if (usingRedisRest) {
    const raw = await redisRestCmd(['GET', STATE_KEY]);
    if (!raw) return withDefaults();
    try { return withDefaults(JSON.parse(raw)); } catch (e) { return withDefaults(); }
  }
  if (usingRedisTcp) {
    const client = await getTcpClient();
    const raw = await client.get(STATE_KEY);
    if (!raw) return withDefaults();
    try { return withDefaults(JSON.parse(raw)); } catch (e) { return withDefaults(); }
  }
  try { return withDefaults(JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch (e) { return withDefaults(); }
}

async function writeState(state) {
  if (usingRedisRest) { await redisRestCmd(['SET', STATE_KEY, JSON.stringify(state)]); return; }
  if (usingRedisTcp) { const client = await getTcpClient(); await client.set(STATE_KEY, JSON.stringify(state)); return; }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state)); // atomic swap so a crash never leaves a half-written db
  fs.renameSync(tmp, DB_FILE);
}

module.exports = { readState, writeState, DEFAULT_STATE, usingRedis };
