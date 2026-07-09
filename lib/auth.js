'use strict';
/* Single-user access gate. When ACCESS_CODE is set, every API request must carry it
   as `Authorization: Bearer <code>` (constant-time compared). When it is unset — e.g.
   local `npm start` — the API is open, so nothing gets in the way on your own machine. */
const crypto = require('crypto');
const CODE = process.env.ACCESS_CODE || '';

function equal(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function ok(req) {
  if (!CODE) return true;
  const h = req.headers['authorization'] || '';
  const provided = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-access-code'] || '');
  return !!provided && equal(provided, CODE);
}

const required = () => !!CODE;

module.exports = { ok, required };
