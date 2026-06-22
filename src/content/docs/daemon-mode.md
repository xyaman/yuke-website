---
title: Daemon mode
description: Run yuke as a long-lived WebSocket server.
---

Daemon mode splits yuke into a server (the daemon) and any number of clients
that speak the wire protocol. The daemon binds a WebSocket on `127.0.0.1`, holds
sessions open across reconnects, persists their state, and broadcasts every
event to every connected client so all frontends see the same picture.

## Start the daemon

```sh
yuke daemon
```

Defaults:

- binds `ws://127.0.0.1:7878/ws`
- reads `~/.yuke/providers.json` and `~/.yuke/auth.json` on demand
- runs `~/.yuke/init.lua` per new session (plus any workspace
  `.yuke/init.lua` overlay)
- persists sessions under `~/.yuke/workspaces/`
- per-session VM evicts after 15 minutes idle (override with `--idle-ttl`,
  `0` disables)

Override bind address, add a bearer token, or change the reaper cadence:

```sh
yuke daemon --addr 127.0.0.1:7878 --token secret --idle-ttl 0
```

A token, when set, is required on every client connection. The daemon accepts
it from `--token` or, if unset there, the `YUKE_DAEMON_TOKEN` environment
variable. A client presents it on the WebSocket upgrade as
`Authorization: Bearer <token>` (CLIs) or as a `?token=<secret>` query
parameter (browsers, since they cannot set headers on a `new WebSocket(...)`).
The comparison is constant-time.

## Profiles

A profile is a base Lua config the daemon picks per session. The **default**
profile is `~/.yuke/init.lua`; a named profile `foo` is `~/.yuke/init_foo.lua`.
Profiles share `auth.json`, `providers.json`, and saved sessions; only the base
Lua differs.

```text
~/.yuke/
  init.lua            profile "default"
  init_work.lua       profile "work"
  init_minimal.lua    profile "minimal"
  providers.json      shared catalog
  auth.json           shared credentials
  workspaces/         shared session history
```

Clients pick a profile when they create a session (`SessionConfig.profile`);
the daemon advertises the available profiles in its `Hello` snapshot. The
choice is persisted, so a rehydrated session rebuilds on the same profile. If
that named profile has since been removed, the session falls back to the
default profile and permanently updates its saved choice to `default`. The
base script is read **fresh on each new session**, so editing a profile (or
dropping in a new `init_<name>.lua`) takes effect on the next session with no
daemon restart.

The oneshot picks a profile with `--profile`:

```sh
yuke -p "hello" --profile work
```

## Workspaces and sessions

A **workspace** is a folder on disk, and every session belongs to one. The
daemon canonicalises the path and uses a stable 64-bit hash of it as the
workspace id, so the same folder maps to the same workspace across daemon
restarts. A **session** is a conversation; its id is 16 lowercase hex
characters and doubles as the on-disk JSONL transcript file name.

Clients create a workspace (or find one that already exists) and create a
session inside it. The full flow lives in the [Wire
protocol](wire-protocol/); the short version is in [Wire protocol →
ClientMessage](wire-protocol/#clientmessage) below.

## Permission modes and the approval loop

Sessions run in one of three permission modes: `yolo` (auto-approve except a
hard `deny`), `normal` (default; approve unless Lua denies or asks), or
`strict` (ask for anything not explicitly allowed).

A client receives a `RequestPermission` engine event whenever the agent loop
escalates a call to `Ask`. It replies with an `EngineCommand::PermissionDecision`
carrying `{ allow, remember }`. A `remember: true` answer is persisted as a
standing "allow always" rule for that exact call, so future calls of the same
form skip the prompt entirely. A Lua `deny` is a hard floor that holds even in
`yolo`; see [init.lua → yuke.on](lua-config/#yukueon) for the hook side.

The daemon's `--permission` flag sets the default mode for sessions whose
client names none; each session can override at create time.

## What is on the wire

The daemon speaks a JSON-over-WebSocket protocol described in [Wire
protocol](wire-protocol/). The short version: one persistent channel, two
message directions (`ServerMessage` from daemon, `ClientMessage` from client).
Implementations in any language that can hold a WebSocket open can talk to the
daemon.

## When to use which

- **Local mode** ([oneshot](local-mode/)): one terminal, one turn at a time,
  fastest startup. Auto-approves every tool call.
- **Daemon mode**: long-lived session, multiple clients, custom frontends
  (TUIs, IDE plugins) that connect over WebSocket, interactive approval.

## Next

- [Provider catalog](providers/) for the catalog format and reload semantics.
- [init.lua](lua-config/) for session policy, tools, hooks, and the permission
  gates.
- [Wire protocol](wire-protocol/) to integrate a non-yuke client.
