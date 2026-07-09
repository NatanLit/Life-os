'use strict';
/* Vercel serverless function: GET/PUT /api/state, behind the access gate. */
const { handleGet, handlePut } = require('../lib/api');
const auth = require('../lib/auth');

async function getBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
}

module.exports = async (req, res) => {
  // never let a CDN/proxy cache state responses — every device must see live data
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (!auth.ok(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
  try {
    if (req.method === 'GET') {
      const { status, body } = await handleGet();
      res.status(status).json(body); return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const { status, body } = await handlePut(await getBody(req));
      res.status(status).json(body); return;
    }
    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
};
