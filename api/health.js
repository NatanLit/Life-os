'use strict';
/* Vercel serverless function: GET /api/health — no auth required, just confirms the
   deployment is live and reports whether an access code is configured. */
const auth = require('../lib/auth');

module.exports = async (req, res) => {
  res.status(200).json({ ok: true, authRequired: auth.required() });
};
