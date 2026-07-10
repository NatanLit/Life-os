# Life OS — MCP server

Gives an AI agent (Claude Desktop, Claude Code, Cursor, …) full read/write access to your
Life OS the same way you have in the app: it can **read everything and give you feedback**,
and **create, edit, complete and delete** habits, goals, milestones (sub-goals), tasks,
school deadlines, workouts, sleep check-ins and weekly reviews.

It talks to your deployment through the same `/api/state` API the web app uses, so every
change instantly syncs to your phone and computer. Writes are conflict-safe (read-merge-write
against the server revision, with retries) and deletions use the same tombstone rules as the
app, so nothing is resurrected across devices.

## Install

```sh
cd mcp
npm install
```

## Configure

Two environment variables:

| Variable | Meaning |
|---|---|
| `LIFEOS_URL` | Your deployment URL. Defaults to the hosted app; set it to your own. |
| `LIFEOS_CODE` | Your access code — the `ACCESS_CODE` you set in Vercel. |

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config) and add:

```json
{
  "mcpServers": {
    "life-os": {
      "command": "node",
      "args": ["/absolute/path/to/Life-os/mcp/server.js"],
      "env": {
        "LIFEOS_URL": "https://your-app.vercel.app",
        "LIFEOS_CODE": "your-access-code"
      }
    }
  }
}
```

Restart Claude Desktop. You'll see the `life-os` tools appear. Then just talk to it:
*"add 3 habits to help me sleep better"*, *"what's stuck this week?"*, *"break my Math goal
into milestones"*, *"delete the old reading habit"*.

### Claude Code (CLI)

```sh
claude mcp add life-os \
  --env LIFEOS_URL=https://your-app.vercel.app \
  --env LIFEOS_CODE=your-access-code \
  -- node /absolute/path/to/Life-os/mcp/server.js
```

## Tools

**Read** — `get_overview` (full digest: goals with %, habit streaks, upcoming deadlines,
workouts, sleep trend, week stats — use this to give feedback), `get_state` (raw JSON).

**Habits** — `add_habit`, `update_habit`, `delete_habit`, `log_habit`.

**Goals & sub-goals** — `add_goal`, `update_goal`, `delete_goal`, `add_milestone`,
`update_milestone`, `delete_milestone`, `add_task`, `complete_task`, `delete_task`.

**School** — `add_deadline`, `update_deadline`, `complete_deadline`, `delete_deadline`.

**Workouts** — `log_workout` (auto-checks any workout-linked habit), `delete_workout`.

**Sleep & review** — `log_sleep`, `save_review`.

Most tools accept either an id or the exact name/title for convenience (e.g.
`delete_habit { "habit": "Read 20 min" }`). Ids are returned by `add_*` and shown by
`get_overview` / `get_state`.

## Test

```sh
node test-e2e.mjs
```

Boots a local Life OS server, drives every tool through a real MCP client, and checks the
resulting state.

## Security

`LIFEOS_CODE` is your write key. Keep it in the MCP client config (local to your machine),
never in the repo. Anyone with the code can read and change your data.
