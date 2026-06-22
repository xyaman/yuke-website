---
title: Local mode
description: Run a one-turn yuke session in-process, no daemon.
---

Local mode is the oneshot CLI: a single assistant turn in-process, no daemon,
no WebSocket. The session is persisted under `~/.yuke/workspaces/` so you can
resume it later.

## Start

```sh
yuke -p "summarize the files in this directory"
```

The session is saved automatically. Continue it with `--resume` and the same
session id:

```sh
yuke -p "now write tests for them" --resume <session-id>
```

`--output-format json` prints one JSON object (`session_id`, `model`, `result`,
`stop_reason`), which makes the resume loop scriptable:

```sh
id=$(yuke -p "start" --output-format json | jq -r .session_id)
yuke -p "keep going" --resume "$id"
```

A bare `yuke` with no prompt and an interactive stdin prints help. With piped
input the prompt is the stdin text:

```sh
echo "what is in Cargo.toml?" | yuke
```

## Pick a profile directory

By default yuke reads `~/.yuke/providers.json`, `~/.yuke/auth.json`, and the
profile scripts (`init.lua`, `init_<NAME>.lua`) from `~/.yuke`. Override with
`--config-dir`:

```sh
yuke --config-dir ./my-profile
```

yuke looks for `./my-profile/providers.json` (and `./my-profile/auth.json` plus
profile scripts) and treats that directory as the profile root. Relative paths
in `yuke.fs` and `yuke.exec` resolve against the **session workspace**, not
the profile directory.

## Pick a model

The session starts on the `default_model` from `init.lua` (if set) or the
first model in the catalog. Override per invocation:

```sh
yuke --model openai/gpt-4o
yuke --model openai/o3
```

The argument is the catalog key `"provider/model"` (see [Provider
catalog](/providers/)). A bare model name works when it is unambiguous across
all providers in the catalog; an ambiguous bare name errors at session-build
time with a disambiguation hint.

## Pick a reasoning level

Override the model's default effort for a new session:

```sh
yuke --reasoning high
```

The level must be one the chosen model offers (clamped to the model's set
otherwise). Applied to a new session; a resumed session keeps the level it was
saved with.

## Override the system prompt

```sh
yuke --system "You only answer in haiku."
```

This overrides the `prompt` from `yuke.opts { ... }` for this session only.

## Auto-approval in oneshot

A oneshot is headless, so it **auto-approves every tool call** the model
makes (including `yuke.exec` and `yuke.fs.write`); there is no interactive
approval prompt. Only run prompts you are willing to let your `init.lua` tools
act on. For interactive approval, run [daemon mode](/daemon-mode/) and connect
a client that handles `RequestPermission`.

## Built-in primitives

The `yuke.*` table is injected into `init.lua` and every tool handler. Local
mode and daemon mode share the same primitives; the table below is the short
version. The full reference is in [Lua primitives](/primitives/).

| Primitive                          | Description                                  |
|------------------------------------|----------------------------------------------|
| `yuke.fs.read(path[, from, to])`   | Read a file, optionally a line range         |
| `yuke.fs.write(path, content)`     | Write a file                                 |
| `yuke.fs.append(path, content)`    | Create or append                             |
| `yuke.fs.exists(path)`             | Check if a path exists                       |
| `yuke.fs.list(path)`               | Array of `{ name, is_dir }`                  |
| `yuke.fs.delete(path)`             | Remove a file                                |
| `yuke.fs.mkdir(path)`              | Create a directory and any missing parents   |
| `yuke.fs.rename(from, to)`         | Move or rename                               |
| `yuke.fs.copy(from, to)`           | Copy a file, returns bytes written           |
| `yuke.fs.stat(path)`               | `{ size, is_dir, is_file, modified }` or nil |
| `yuke.glob(pattern[, opts])`       | List of matching paths (no `.gitignore`)     |
| `yuke.exec(cmd[, opts])`           | Run a subprocess; opts: `cwd`, `timeout_ms`, `env`, `max_output` |
| `yuke.http.get(url[, opts])`       | Outbound GET; returns `{ status, body }`     |
| `yuke.http.post(url[, opts])`      | Outbound POST; `body` or `json`              |
| `yuke.env.get(name)`               | Read an environment variable                 |
| `yuke.json.encode(value)`          | Encode a Lua value as JSON                   |
| `yuke.log(message)`                | Emit a log line under the `lua` target       |
| `yuke.sleep(ms)`                   | Async sleep                                  |

## Next

- [Daemon mode](/daemon-mode/) for long-lived sessions over WebSocket.
- [Lua configuration](/lua-config/) for the full `init.lua` API.
