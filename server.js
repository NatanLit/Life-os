'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_STATE = { goals: [], habits: [], workouts: [], deadlines: [], sleep: {}, reviews: {}, updatedAt: 0 };

function readState() {
  try {
    return Object.assign({}, DEFAULT_STATE, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {
    return Object.assign({}, DEFAULT_STATE);
  }
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DB_FILE); // atomic swap so a crash never leaves a half-written db
}

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/state', (req, res) => res.json(readState()));

app.put('/api/state', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'state must be an object' });
  }
  for (const k of ['goals', 'habits', 'workouts', 'deadlines']) {
    if (body[k] !== undefined && !Array.isArray(body[k])) {
      return res.status(400).json({ error: k + ' must be an array' });
    }
  }
  for (const k of ['sleep', 'reviews']) {
    if (body[k] !== undefined && (typeof body[k] !== 'object' || Array.isArray(body[k]))) {
      return res.status(400).json({ error: k + ' must be an object' });
    }
  }
  const current = readState();
  // last-write-wins, but never let a stale client silently clobber newer data
  if (current.updatedAt && body.updatedAt && body.updatedAt < current.updatedAt) {
    return res.status(409).json({ error: 'conflict', state: current });
  }
  const next = Object.assign({}, DEFAULT_STATE, body);
  writeState(next);
  res.json({ ok: true, updatedAt: next.updatedAt });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log('Life OS running at http://localhost:' + PORT));
