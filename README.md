# pi-extensions-lhg

Personal [Pi coding agent](https://pi.dev) extensions. Public repo, generic code only —
no personal data lives here (todo contents stay in local JSON files or a separate
private data repo).

## Extensions

| File | Commands / Tools | What |
| ------ | ------------------ | ------ |
| `extensions/my-todo.ts` | `/myday`, `/mytodo`, `my_todo` tool | Personal todo list for **you**, not the agent. Global day-to-day list + per-project lists, interactive TUI panel, agent can read/update on request. |
| `extensions/current-prompt.ts` | `/context`, footer status | Tab title + footer as `<context> › <label>`: spinner while working, `?` during questions, `✓` idle + `N subagents/jobs running`. First prompt requires a working context. Idle state stays watched (confirmed-zero + slow rescan) so background work re-arms the spinner instead of wedging the ✓. |
| `extensions/jobs.ts` | `job_run`, `job_wait/list/logs/stop` | Background shell jobs with early-exit wait and `::progress` + ETA parsing. Only `job_run` is active until first use. |
| `extensions/lazy-subagent.ts` | `enable_delegation` | Keeps `subagent/*` tools inactive until one explicit call. Saves schema cost. |
| `extensions/augment-quiet-recall.ts` | (hook, no commands) | Silent-on-miss Augment recall. Sets `AUGMENT_PI_AUTO_CONTEXT=off`, injects nothing when no memory is relevant. |
| `extensions/direct-image.ts` | `image_direct` tool | Image gen via OpenRouter `/images/generations` endpoint for image-only models. Returns path only, never inlines bytes. |

### my-todo

Two scopes, stored as plain human-editable JSON:

- Global → `~/projects/pi-extensions-lhg-private/todos.json` (day-to-day + life,
  backed up in the private repo; falls back to `~/.pi/agent/my-todo/todos.json`
  when the private repo isn't checked out)
- Project → `<repo>/.pi/my-todo/todos.json` (per-project)

`/myday` opens the interactive panel (`a` add · `e` edit · `space` done ·
`d` delete · `tab` switch scope · `q` close).
`/mytodo add <text> | done <id> | rm <id> | list [-p]` for quick CLI use
(`-p` = project scope, default is global).

## Install

```bash
git clone git@github.com:lefthandedgoat/pi-extensions-lhg.git ~/projects/pi-extensions-lhg  # or wherever
for f in my-todo current-prompt jobs lazy-subagent augment-quiet-recall direct-image; do
  ln -sf ~/projects/pi-extensions-lhg/extensions/$f.ts ~/.pi/agent/extensions/$f.ts
done
```

Then `/reload` in Pi. Symlinking (instead of copying) means `git pull` updates
your running Pi extensions directly.
