---
title: CLI options
description: Command-line flags for yuke and yuke daemon.
---

## yuke (oneshot)

Run a single turn in-process and exit. The prompt comes from `-p` or from
piped stdin. With neither, `yuke` opens the TUI client against the daemon
configured in `~/.yuke/tui/init.lua` (or, failing that, the default
`127.0.0.1:7878`).

```
yuke [OPTIONS]
```

| Flag                    | Description                                                                                              |
|-------------------------|----------------------------------------------------------------------------------------------------------|
| `-p`, `--print <PROMPT>` | Run one turn and exit. The prompt may also come from piped stdin.                                       |
| `--resume <ID>`         | Continue the saved session with this id, in its original workspace, instead of starting a new one.      |
| `--output-format <FMT>` | `text` (streamed, default) or `json` (one result object with `session_id`/`model`/`result`/`stop_reason`). |
| `--model <NAME>`        | Catalog model to run on (overrides the profile default). Applied to a new session; a resumed session keeps the model it was saved with. |
| `--reasoning <LEVEL>`   | Reasoning level (e.g. `low`, `medium`, `high`); clamped to the model's supported levels. Applied to a new session; a resumed session keeps the level it was saved with. |
| `--system <PROMPT>`     | System prompt override for a new session.                                                                |
| `--profile <NAME>`      | Base Lua config for a new session: `init_<NAME>.lua`. The default profile is `init.lua`. Persisted with the session so `--resume` rebuilds on the same profile. |
| `--config-dir <DIR>`    | Config dir holding `providers.json`, `auth.json`, profile scripts, and `workspaces/` (default: `~/.yuke`). Shared by oneshot and daemon. |

`--output-format json` is the scriptable form:

```sh
id=$(yuke -p "start" --output-format json | jq -r .session_id)
yuke -p "keep going" --resume "$id"
```

## yuke login

```
yuke login [PROVIDER]
```

Run the OAuth flow and write the resulting tokens to `<config dir>/auth.json`
under the provider name (default: `openai`). Token refreshes happen
transparently on use; you log in once.

## yuke daemon

```
yuke daemon [--addr <HOST:PORT>] [--token <TOKEN>]
            [--idle-ttl <SECS>] [--reap-interval <SECS>]
            [--permission <MODE>]
```

Start the session daemon, binding a WebSocket server.

| Flag                  | Description                                                                                   |
|-----------------------|-----------------------------------------------------------------------------------------------|
| `--addr <ADDR>`       | Bind address (default: `127.0.0.1:7878`).                                                     |
| `--token <TOKEN>`     | Require this bearer token on every client connection (else `YUKE_DAEMON_TOKEN`; unset = no auth). |
| `--idle-ttl <SECS>`   | Seconds a session may sit idle before its VM is evicted; `0` keeps every session resident. Default: 900. |
| `--reap-interval <SECS>` | Seconds between reaper sweeps for idle sessions. Default: 30. Floored at 1.                |
| `--permission <MODE>` | Default permission mode (`yolo`, `normal`, `strict`) for sessions whose client names none. Default: `normal`. |

The daemon binds the WebSocket on the given address and starts the
session-management loop. It reads `init.lua` once per new session (re-running
it on each), and indexes `~/.yuke/workspaces/` at startup so it picks up
sessions the oneshot created.

## Permission modes

Every session runs in one of three permission modes. The mode controls how a
tool call resolves when no Lua hook has spoken:

| Mode     | What it does                                                                                  |
|----------|-----------------------------------------------------------------------------------------------|
| `yolo`   | Approve every call except a hard `deny` from Lua. Skips any `ask`.                            |
| `normal` | Approve unless Lua denies or asks. The default.                                                |
| `strict` | Ask for anything not explicitly allowed by Lua or remembered by an "always" answer.            |

A Lua `deny` is a hard floor that holds even in `yolo`. A remembered "allow
always" suppresses an `ask` in every mode. See [init.lua](lua-config/#yukueon)
for the hook side of this and [Wire protocol](wire-protocol/) for how a
client answers a `RequestPermission` event.

## Environment variables

| Variable                                  | Used by                 | Purpose                                                                                  |
|-------------------------------------------|-------------------------|------------------------------------------------------------------------------------------|
| `OPENAI_API_KEY`, `MINIMAX_API_KEY`, etc. | oneshot + daemon        | API keys, read by yuke, not Lua. Each provider's `auth.json` entry names its variable.   |
| `YUKE_DAEMON_TOKEN`                       | `yuke daemon`           | Bearer token, alternative to `--token` on the daemon side.                                |
| `RUST_LOG`                                | daemon                  | Standard `tracing` filter (`RUST_LOG=lua=info` shows config logs only).                  |
| `SOURCE_DATE_EPOCH`                       | `init.lua`              | Conventional reproducible-build timestamp; the only "wall clock" Lua can see.            |

## Exit codes

| Code | Meaning                                              |
|------|------------------------------------------------------|
| 0    | Clean exit (turn completed, or no prompt given).     |
| 1    | Unspecified error.                                   |
| 2    | Usage error (bad flag, missing config, etc.).        |

(Exact codes beyond `0` are not part of the API; rely on them for scripting
only with caution.)
