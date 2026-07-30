# Life OS — Integration guide for an AI agent

This document is everything another AI needs to **read and write a Life OS instance on
its own**. Give the agent this file plus the base URL and the access code.

Life OS is a personal system for **goals → milestones → tasks, habits, school deadlines,
workouts, sleep check-ins and weekly reviews**. All of it is one JSON document behind a
tiny HTTP API. Any change written through the API instantly syncs to the owner's phone and
computer.

---

## 1. Connection

- **Base URL:** `https://life-os-brown-five.vercel.app` (replace with your instance)
- **Auth:** every `/api/*` request must send the access code as a Bearer token:
  ```
  Authorization: Bearer <ACCESS_CODE>
  ```
  Without it the API returns `401 {"error":"unauthorized"}`. The access code is supplied
  separately by the owner — never hardcode it in shared text.
- **Content type** for writes: `application/json`.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/health` | Liveness check. Returns `{"ok":true,"authRequired":true}`. No auth needed. |
| `GET`  | `/api/state`  | Read the **entire** state document (see schema below). |
| `PUT`  | `/api/state`  | Write the **entire** state document back. |

---

## 2. The golden rule: PUT replaces the whole document

`PUT /api/state` is **not** a partial update. The body you send **becomes** the state.
Any top-level section you omit is reset to empty. So the only safe way to change anything
is **read → modify → write the whole thing back**:

1. `GET /api/state` → gives you the full document, including its `rev` (an integer).
2. Modify the fields you want *in that object*.
3. `PUT /api/state` with the **entire modified object**, adding a `baseRev` equal to the
   `rev` you read.

### Conflict handling (so you never overwrite the owner's phone)

- Include `"baseRev": <the rev you read>` in the PUT body.
- If the server's current `rev` still equals your `baseRev`, the write succeeds and returns
  `200 {"ok":true,"rev":<new rev>}` (rev is incremented).
- If someone else wrote in between, the server returns
  `409 {"error":"conflict","state":<the current state>}`. **Re-apply your change to that
  returned state and PUT again** (with the new `baseRev`). Retry a few times.
- If you omit `baseRev`, the server writes unconditionally (last-write-wins). Prefer sending
  it.

### Canonical helper (JavaScript, Node 18+)

```js
const BASE = "https://life-os-brown-five.vercel.app";
const CODE = "<ACCESS_CODE>";
const H = { Authorization: "Bearer " + CODE, "Content-Type": "application/json" };

async function readState() {
  const r = await fetch(BASE + "/api/state", { headers: H, cache: "no-store" });
  if (!r.ok) throw new Error("GET " + r.status);
  return r.json();
}

// mutate(state) changes it in place; this handles conflicts + retries
async function mutate(mutateFn) {
  for (let i = 0; i < 6; i++) {
    const state = await readState();
    const baseRev = state.rev || 0;
    mutateFn(state);
    state.updatedAt = Date.now();
    const r = await fetch(BASE + "/api/state", {
      method: "PUT", headers: H, body: JSON.stringify({ ...state, baseRev })
    });
    if (r.status === 409) continue;        // someone raced us — re-read and retry
    if (!r.ok) throw new Error("PUT " + r.status);
    return r.json();                        // { ok:true, rev }
  }
  throw new Error("too many conflicts");
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
```

Equivalent with curl (read, then write the full JSON you got back with your edits):

```sh
curl -s https://life-os-brown-five.vercel.app/api/state \
  -H "Authorization: Bearer $CODE" > state.json
# edit state.json (add your item, set baseRev to its rev) then:
curl -s -X PUT https://life-os-brown-five.vercel.app/api/state \
  -H "Authorization: Bearer $CODE" -H "Content-Type: application/json" \
  --data @state.json
```

---

## 3. State schema

```jsonc
{
  "goals": [
    {
      "id": "string",                 // unique; you generate it for new items
      "title": "string",
      "why": "string",                // one-line motivation, may be ""
      "deadline": "YYYY-MM-DD",
      "status": "active" | "paused" | "done",
      "milestones": [                 // 0..n sub-goals
        {
          "id": "string",
          "title": "string",
          "tasks": [
            { "id": "string", "title": "string", "done": false, "doneAt": null }
            // doneAt = epoch-ms when done, else null
          ]
        }
      ]
    }
  ],

  "habits": [
    {
      "id": "string",
      "name": "string",
      "workoutLinked": false,         // true = auto-checked whenever a workout is logged
      "archived": false,              // archived habits are hidden from the home screen
      "log": { "YYYY-MM-DD": true }   // one key per completed day
    }
  ],

  "workouts": [
    { "id": "string", "date": "YYYY-MM-DD", "type": "string", "duration": 60, "note": "string" }
    // duration in minutes
  ],

  "deadlines": [                      // school tasks
    {
      "id": "string",
      "title": "string",
      "subject": "string",
      "due": "YYYY-MM-DD",
      "priority": "high" | "med" | "low",
      "goalId": "string | null",      // optional link to a goal's id
      "done": false,
      "doneAt": null                  // epoch-ms when done
    }
  ],

  "sleep": {                          // one entry per day
    "YYYY-MM-DD": { "hours": 7.5, "feeling": 4 }   // feeling is 1..5
  },

  "reviews": {                        // one per week
    "YYYY-MM-DD": { "note": "string", "savedAt": 0 }  // key = Monday of that week
  },

  "countdown": { "title": "string", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "updatedAt": 0 },

  "tombstones": { "<deleted item id>": 0 },  // epoch-ms of deletion; see below
  "rev": 0,                           // server-managed; read it, send as baseRev
  "updatedAt": 0                      // epoch-ms; set to Date.now() on write
}
```

### Rules & semantics

- **New ids:** generate any unique string. `Date.now().toString(36)+Math.random().toString(36).slice(2,7)` is fine.
- **Dates** are the owner's local calendar date as `YYYY-MM-DD`. "Today" = the current date.
- **Progress rolls up automatically in the UI:** milestone % = done tasks / total tasks;
  goal % = average of its milestones. You don't compute or store these — just add/complete
  tasks and the app shows the rollup.
- **Habit streak** is derived by the app (soft streak: +1 per done day, −1 per missed day,
  never below 0; an unlogged *today* doesn't count against it). You only write `log` keys.
- **Max 5 active (non-archived) habits** — respect this when adding habits.
- **Workout ⇒ habit:** when you add a workout, also set `log["<that date>"] = true` on every
  habit whose `workoutLinked` is `true` (this is what the app does).
- **Deleting** an item:
  - Top-level (a goal, habit, workout, or deadline): remove it from its array **and** add
    `tombstones[itemId] = Date.now()`. The tombstone stops other devices from resurrecting
    it during sync. **Skipping this can make a delete "come back".**
  - Nested (a milestone or a task inside a goal): just remove it from the goal's
    `milestones` / `tasks` array. No tombstone needed.
- **Completing** a goal task or a deadline: set `done: true` and `doneAt: Date.now()`
  (set back to `false` / `null` to reopen). This also feeds the weekly review stats.

---

## 4. Worked examples (what to change inside `mutate`)

```js
// Add a habit
await mutate(s => {
  if (s.habits.filter(h => !h.archived).length >= 5) throw new Error("max 5 active habits");
  s.habits.push({ id: uid(), name: "Lights out by 22:30", workoutLinked: false, archived: false, log: {} });
});

// Check a habit for today (by name)
await mutate(s => {
  const h = s.habits.find(x => x.name === "Lights out by 22:30");
  h.log[new Date().toISOString().slice(0,10)] = true;
});

// Add a goal with a milestone and a task
await mutate(s => {
  const g = { id: uid(), title: "Get 7 in Math", why: "DP HL", deadline: "2026-10-01", status: "active", milestones: [] };
  const m = { id: uid(), title: "Master algebra", tasks: [] };
  m.tasks.push({ id: uid(), title: "Practice set 3", done: false, doneAt: null });
  g.milestones.push(m);
  s.goals.push(g);
});

// Complete a goal task
await mutate(s => {
  for (const g of s.goals) for (const m of g.milestones) {
    const t = m.tasks.find(x => x.title === "Practice set 3");
    if (t) { t.done = true; t.doneAt = Date.now(); }
  }
});

// Add a school deadline linked to a goal
await mutate(s => {
  const goal = s.goals.find(g => g.title === "Get 7 in Math");
  s.deadlines.push({ id: uid(), title: "Criterion B draft", subject: "Math",
    due: "2026-07-15", priority: "high", goalId: goal ? goal.id : null, done: false, doneAt: null });
});

// Log a workout (and auto-check workout-linked habits)
await mutate(s => {
  const date = new Date().toISOString().slice(0,10);
  s.workouts.push({ id: uid(), date, type: "Gym", duration: 60, note: "push day" });
  for (const h of s.habits) if (!h.archived && h.workoutLinked) h.log[date] = true;
});

// Log sleep
await mutate(s => {
  const date = new Date().toISOString().slice(0,10);
  s.sleep[date] = { ...(s.sleep[date] || {}), hours: 7.5, feeling: 4 };
});

// Delete a habit (top-level ⇒ tombstone)
await mutate(s => {
  const h = s.habits.find(x => x.name === "Old habit");
  if (h) { s.habits = s.habits.filter(x => x.id !== h.id); s.tombstones[h.id] = Date.now(); }
});
```

To **give feedback**, just `GET /api/state` and read it: goals with their milestones/tasks
(compute % if you want), habit `log`s and streaks, `deadlines` sorted by `due`, `sleep`
entries (hours + feeling), recent `workouts`, and past `reviews`.

---

## 5. Alternative: MCP (for Claude-family agents)

If the agent is Claude Desktop / Claude Code, it can use the MCP server in `mcp/` instead of
raw HTTP. It wraps all of the above as ready-made tools (`add_habit`, `add_goal`,
`add_milestone`, `add_task`, `complete_task`, `add_deadline`, `log_workout`, `log_sleep`,
`get_overview`, `delete_*`, …) and handles conflicts and tombstones for you. Setup is in
[`mcp/README.md`](mcp/README.md). Config needs `LIFEOS_URL` and `LIFEOS_CODE`.

---

## 6. Security — read this before sharing

The access code is a **full read/write/delete key** to the owner's entire personal system.
Anyone (or any AI) holding it can add, change, or erase everything. Share it only with an
agent you trust, pass it out-of-band (not in a public document), and rotate it in Vercel
(`Settings → Environment Variables → ACCESS_CODE`) if it leaks. The API has no per-item
permissions and no undo beyond the app's own history.
