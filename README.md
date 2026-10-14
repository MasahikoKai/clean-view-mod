# Clean View

Claude Code plugin. Hides tool rows while Claude works and shows a calm, plain-English checklist above the prompt instead. Made for non-technical people who care about *what* is being done, not which file or command.

## Features

- **Checklist band** above the prompt: job title, elapsed time, overall progress bar, one row per step with its own meter and status (`Done`, `Working`, `42%`, `Next`, `Up next`).
- **Tool rows hidden**: `ToolUse`, `ToolResult` and `ToolGroup` render nothing while on; tool progress hints are blanked.
- **Plain English only**: step names are sanitised (code spans, file paths and file names are stripped, capped at 40 characters).
- **Phases**: working, `Needs you` (permission prompt, question, waiting for reply), `Stuck` (denied step, repeated failures, error, refusal), `Stopped` (Esc), `All done` (green, shows total time).
- **Friendly errors**: rate limit, overload, auth, context too long and network drops become one-line hints (`/login`, `/compact`, ...).
- **Auto title**: a short job name is generated with Haiku from your prompt.
- **Toggle**: button in the UI or `/simple`. The choice is persisted across sessions.

## How it works

On `session.start` the plugin registers two tools and a command:

| Name | Purpose |
| --- | --- |
| `plan_steps` | Claude lays out 2 to 8 short steps up front. |
| `report_progress` | Claude reports `task` + `percent` (0-100); `100` finishes the step. |
| `/simple [on\|off]` | Turn Clean View on or off (no argument toggles). |

A system-prompt section instructs Claude to call `plan_steps` first for every request and to keep step names jargon-free. Any other tool call is denied until a real plan exists (except `ToolSearch`, `TodoWrite`, `TaskCreate`, `TaskUpdate`, `AskUserQuestion`).

`TodoWrite` and `TaskCreate`/`TaskUpdate` also feed the checklist, so existing to-do flows work without `plan_steps`.

Sub-agent tool calls (`agentId` set) are ignored.

## Install

```
/plugin marketplace add MasahikoKai/clean-view-mod
/plugin install clean-view@clean-view-mod
```

Requires a Claude Code build with the plugin hooks/UI API (`claude-code` module: `atom`, `ui.render`, `tool.register`, `command.register`, `clock`, `store`, `model.complete`).

## Layout

```
.claude-plugin/
  plugin.json        plugin manifest
  marketplace.json   single-plugin marketplace (clean-view-mod)
hooks/
  hooks.json         module list
  register.tsx       entry point
  clean-view.tsx     all logic: state, helpers, rendering, event hooks
types/index.d.ts     checklist state types
clean-view.test.ts   tests
tsconfig.json
```

## Development

Pure helpers are exported from `hooks/clean-view.tsx` (`cleanName`, `planSteps`, `reportProgress`, `overallPercent`, `meterCells`, `barCells`, `fmtDuration`, `errorSentence`) and covered in `clean-view.test.ts`, which uses `claude-code/testing`.

## Notes

- Title generation tries the `haiku` alias, then `claude-haiku-5-5`; if neither answers, the placeholder title `Working on it` stays.
- While Clean View is on, tool output is invisible by design. Turn it off with `/simple off` to debug.

## License

None specified yet.
