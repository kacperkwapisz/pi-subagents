# pi-subagents

Let Pi hand work to subagents and watch them do it. Each subagent runs in its own Pi process
with a fresh context and your extensions loaded, and you can steer it while it works.

## Install

```bash
pi install git:github.com/kacperkwapisz/pi-subagents
```

Requires Pi 1.x.

## Use

Ask for it in plain words, for example "review the auth module and check the docs, in
parallel". The model starts the agents, and a list above the editor shows each one: what it is
doing right now, its model and account, time, tokens and cost. When they finish, their answers
go back to the model, and each one gets a short summary in the chat (Ctrl+O shows the full
answers).

Agents are one-off: each one closes by itself 30 seconds after it finishes, unless it gets more
work in that time, so finished agents don't pile up. The model can keep one open longer when it
plans follow-ups, and stops agents it no longer needs. Closed agents are cleared from view when
you send your next message.

Agents report what they are working on in their own words ("Reading the auth module", "Found 2
races; checking the tests"), shown next to their name with the current step after it. The model
can also set how much each agent thinks (`off` to `max`), for example little for a quick lookup
and a lot for a hard review.

When the model starts agents in the background and carries on, their results come back on
their own: you get a notification, and the main agent picks up the answer in its next turn.

Press `←` in an empty editor, or run `/agents`, to open the agents view: your agents on the
left, the selected one's live work on the right, and a box to steer it.

| Key | |
|---|---|
| typing, Enter | Steer the agent (or give a finished one more work) |
| Alt+Enter | Queue a follow-up for when it's done |
| ↑ ↓ | Switch agents |
| PgUp PgDn | Scroll; paging back down follows the live output again |
| Ctrl+C | Interrupt its current run (the agent stays) |
| Ctrl+X twice | Stop the agent |
| Esc | Back to the chat |

When an extension inside an agent asks something (a confirmation, a choice), the question
shows up in this view; with the view closed it opens as a normal Pi dialog.

## Agent types

An agent type is a Markdown file with a short header and the agent's instructions:

```markdown
---
name: reviewer
description: Code review for bugs and security issues
tools: read, grep, find, ls, bash
---

You are a code reviewer. ...
```

`tools` limits what the agent can use (all of Pi's defaults otherwise). Add `model:
provider/model` to give a type its own model; without it, agents use the same model and account
as your session, and with [pi-multi-account](https://github.com/kacperkwapisz/pi-multi-account)
they move to your next account on their own when that one hits its limit.

Four types are included (scout, planner, reviewer, worker). Your own go in
`~/.pi/agent/agents/`, and a project can add some in `.pi/agents/` once you trust it. Yours
replace included ones with the same name.

## How it works

Each agent is `pi --mode rpc` started with your Pi, model and thinking level. Its session file
is kept in `~/.pi/agent/subagents/`. Agents end when you stop them or quit Pi.

For the model there are five tools: `agent_start` (one or more agents; waits for their answers
unless told not to; per agent you can set its type, model, thinking level and how long it stays
open after finishing), `agent_wait`, `agent_send`, `agent_list` and `agent_stop`.

## For other extensions

Like bg-jobs, pi-subagents answers on Pi's `pi.events` bus, so for example a goal loop can wait
for background agents:

```ts
pi.events.emit("pi-subagents:query", { reply: (names: string[]) => { /* agents still working */ } });
pi.events.on("pi-subagents:finished", ({ name, status, triggersTurn }) => { /* one finished */ });
```

`triggersTurn` is false when the user stopped the agent; otherwise its result starts the main
agent's next turn.

## Development

```bash
npm install
npm run check
npm test
```

`scripts/visual-check.py` runs the real interactive Pi with a scripted model in a
pseudo-terminal and prints the screen (`SCENARIO=browser` for the agents view), so the UI can be
checked without an account.
