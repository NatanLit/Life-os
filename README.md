# Life OS

A personal system for goals, habits, workouts, school deadlines and sleep — built for a
high school student (IB MYP). Strict monochrome design with two themes: black-on-white and
white-on-black (toggle ◐ in the header).

Works on phone and computer at the same time: the frontend keeps a local copy in
`localStorage` and syncs it with the backend, so any device with the access code sees the
same, always-current data.

## Structure

- `api/state.js` — Vercel serverless function: `GET`/`PUT /api/state`, behind the access gate.
- `server.js` — local Express server (same API + serves the frontend) for `npm start`.
- `lib/` — shared logic: `store.js` (Redis **or** local file), `api.js` (validation +
  conflict handling), `auth.js` (access-code check).
- `public/` — frontend: vanilla JS + CSS, no build step.

## Run locally

```sh
npm install
npm start          # http://localhost:3000
```

Locally there is no access code and data is stored in `data/db.json`. `PORT`, `DATA_DIR`
and `ACCESS_CODE` environment variables are respected.

## Deploy to Vercel (multi-device sync)

You do **not** need a login/account system — you are the only user. A single **access
code** protects the public URL, and a free Redis database holds the data.

1. **Push the repo to GitHub** (already done) and import it at
   [vercel.com/new](https://vercel.com/new).
2. **Add storage:** in the project's **Storage** tab, add a **Redis** database
   (Marketplace, free tier — 30 MB is enormous overkill for this app's data). When
   connecting it to the project, leave **Custom Prefix** blank so the variable keeps its
   default name. Vercel injects `REDIS_URL` automatically.
3. **Set the access code:** project **Settings → Environment Variables**, add
   `ACCESS_CODE` = any private string you'll remember.
4. **Deploy.** Open the URL, enter your code once per device — phone and laptop then stay
   in sync. Re-syncs on every change and whenever a tab regains focus.

Storage is chosen automatically: with `REDIS_URL` present it connects to Redis over a
standard TCP connection (production); an Upstash-style REST API (`KV_REST_API_URL`/
`KV_REST_API_TOKEN`) also works if that's what you connected instead; without either it
falls back to the local file (your machine).

## Let an AI agent read & write it for you

`mcp/` is an MCP server that gives an agent (Claude Desktop, Claude Code, …) the same
powers you have: read everything and give feedback, and create / edit / complete / delete
habits, goals, milestones (sub-goals), tasks, deadlines, workouts, sleep and reviews — all
synced to every device. It authenticates with your access code and is conflict-safe. See
[`mcp/README.md`](mcp/README.md) for setup. Then you just say *"add 3 habits to sleep
better"* or *"what's stuck this week?"* and it does it in your live app.

To let **any** AI (not just Claude) drive it over plain HTTP, hand it
[`INTEGRATION.md`](INTEGRATION.md) — a complete REST API + data-model reference plus the
read-modify-write recipe — together with the base URL and access code.
