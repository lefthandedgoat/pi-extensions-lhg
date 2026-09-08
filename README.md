# pi-extensions-lhg

Personal [Pi coding agent](https://pi.dev) extensions. Public repo, generic code only —
no personal data lives here (todo contents stay in local JSON files or a separate
private data repo).

## Extensions

| File | Commands / Tools | What |
|------|------------------|------|
| `extensions/my-todo.ts` | `/myday`, `/mytodo`, `my_todo` tool | Personal todo list for **you**, not the agent. Global day-to-day list + per-project lists, interactive TUI panel, agent can read/update on request. |

### my-todo

Two scopes, stored as plain human-editable JSON:

- Global → `~/.pi/agent/my-todo/todos.json` (day-to-day + life)
- Project → `<repo>/.pi/my-todo/todos.json` (per-project)

`/myday` opens the interactive panel (`a` add · `e` edit · `space` done ·
`d` delete · `tab` switch scope · `q` close).
`/mytodo add <text> | done <id> | rm <id> | list [-p]` for quick CLI use
(`-p` = project scope, default is global).

## Install

```bash
git clone git@github.com:lefthandedgoat/pi-extensions-lhg.git ~/pi-extensions-lhg  # or wherever
ln -s ~/projects/pi-extensions-lhg/extensions/my-todo.ts ~/.pi/agent/extensions/my-todo.ts
```

Then `/reload` in Pi. Symlinking (instead of copying) means `git pull` updates
your running Pi extensions directly.
