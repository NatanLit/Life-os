'use strict';
/* Local server (npm start). On Vercel the app/ functions are used instead; this file
   is only for running on your own machine. Both share lib/api.js and lib/auth.js. */
const express = require('express');
const path = require('path');
const { handleGet, handlePut } = require('./lib/api');
const auth = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

function gate(req, res, next) {
  if (auth.ok(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/health', (req, res) => res.json({ ok: true, authRequired: auth.required() }));

app.get('/api/state', gate, async (req, res) => {
  const { status, body } = await handleGet();
  res.status(status).json(body);
});

app.put('/api/state', gate, async (req, res) => {
  const { status, body } = await handlePut(req.body);
  res.status(status).json(body);
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () =>
  console.log('Life OS running at http://localhost:' + PORT + (auth.required() ? ' (access code required)' : '')));
