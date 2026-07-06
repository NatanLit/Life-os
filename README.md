# Life OS

A personal system for goals, habits, workouts, school deadlines and sleep — built for a high school student (IB MYP). Strict monochrome design with two themes: black-on-white and white-on-black (toggle in the header, ◐).

## Structure

- `server.js` — Express backend: REST API (`GET/PUT /api/state`, `GET /api/health`) with atomic JSON-file persistence in `data/db.json`, serves the frontend.
- `public/` — frontend: vanilla JS + CSS, no build step.

## Run

```sh
npm install
npm start          # http://localhost:3000
```

`PORT` and `DATA_DIR` environment variables are respected.

## Offline

The frontend keeps a full copy of state in `localStorage` and syncs with the server (last-write-wins with conflict detection). Opening `public/index.html` directly from disk also works — it then runs on `localStorage` alone.
