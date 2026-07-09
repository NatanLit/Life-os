'use strict';
/* Transport-agnostic request handling, shared by the Express server (local) and the
   Vercel serverless function (production). Each function returns { status, body }. */
const { readState, writeState, DEFAULT_STATE } = require('./store');

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'state must be an object';
  for (const k of ['goals', 'habits', 'workouts', 'deadlines'])
    if (body[k] !== undefined && !Array.isArray(body[k])) return k + ' must be an array';
  for (const k of ['sleep', 'reviews', 'tombstones'])
    if (body[k] !== undefined && (typeof body[k] !== 'object' || Array.isArray(body[k]))) return k + ' must be an object';
  return null;
}

async function handleGet() {
  return { status: 200, body: await readState() };
}

async function handlePut(body) {
  const err = validate(body);
  if (err) return { status: 400, body: { error: err } };
  const current = await readState();
  const currentRev = current.rev || 0;
  // Optimistic concurrency on a SERVER-assigned integer revision (clock-independent, so a
  // device with a skewed clock is never wrongly rejected). If the client based its edit on
  // an older revision, tell it the current state so it can re-merge and retry.
  const baseRev = body.baseRev;
  if (baseRev !== undefined && baseRev !== null && baseRev !== currentRev) {
    return { status: 409, body: { error: 'conflict', state: current } };
  }
  const next = Object.assign({}, DEFAULT_STATE, body);
  delete next.baseRev;
  next.rev = currentRev + 1;
  await writeState(next);
  return { status: 200, body: { ok: true, rev: next.rev } };
}

module.exports = { handleGet, handlePut, validate };
