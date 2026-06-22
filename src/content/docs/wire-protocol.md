---
title: Wire protocol
description: The WebSocket protocol yuke daemon speaks to clients.
---

The daemon exposes a single WebSocket endpoint. Every connected client shares
one live view of the daemon's workspaces, sessions, and engine events. This
page is the human-readable version; the machine-readable contract lives at
[`/asyncapi.json`](https://xyaman.github.io/yuke-website/asyncapi.json) (AsyncAPI 3.0, generated from the Rust
types in [`yuke-core`](https://github.com/xyaman/yuke)).

## Endpoint

```
ws://127.0.0.1:7878/ws
```

The address is configurable on the daemon side with `yuke daemon --addr`. When
the daemon was started with `--token <secret>` or `YUKE_DAEMON_TOKEN`, the
client must present it on the WebSocket upgrade — either as
`Authorization: Bearer <token>` (CLIs) or as a `?token=<secret>` query
parameter (browsers, since they cannot set headers on a `new WebSocket(...)`).
The comparison is constant-time, so a valid-length guess learns nothing from
timing.

## Channel shape

There is one channel (the entire WebSocket). Two message directions:

- **ClientMessage**: what the client sends
- **ServerMessage**: what the daemon sends

All messages are JSON objects. There is no envelope or framing; each WebSocket
text frame is one message.

## Lifecycle

```text
client                                  daemon
  |  ----- WebSocket upgrade --------->  |
  |                                      |
  |  <----- ServerMessage::Hello ------  |   (sent once on connect)
  |                                      |
  |  ----- ClientMessage::* --------->   |   (at any time)
  |  <----- ServerMessage::* ----------  |   (direct reply, fault, or Event broadcast)
  |                                      |
```

After `Hello`, the daemon may send `ServerMessage::Event` at any time to every
connected client. An `Event` is a broadcast: every client sees every event.

## ServerMessage

The daemon's outbound messages.

### Hello (on connect)

A snapshot of the daemon's state, sent once when a client connects so a
fresh client can render the full tree before the first event arrives.

```json
{
  "Hello": {
    "workspaces": [
      { "id": "<workspace id>", "root": "/Users/me/proj", "title": "proj" }
    ],
    "sessions": [
      {
        "id": "a1b2...",
        "workspace": "<workspace id>",
        "model": "openai/gpt-4o",
        "reasoning": "medium",
        "permission": "normal",
        "title": "fix the parser",
        "message_count": 14,
        "created_by": { "name": "yuke-cli", "version": "0.0.1" }
      }
    ],
    "models": [
      {
        "name": "openai/gpt-4o",
        "protocol": "completions",
        "reasoning_levels": ["minimal", "low", "medium", "high"],
        "default_reasoning": "medium"
      }
    ],
    "profiles": ["default", "work", "minimal"]
  }
}
```

`profiles` lists every base Lua config the client may pick when creating a
session: `"default"` (the daemon's `init.lua`) followed by every
`init_<NAME>.lua`. See [Daemon mode → Profiles](daemon-mode/#profiles).

### Created

Direct ack to a `CreateSession` request, naming the session it just created.
The broadcast `Event::SessionCreated` reaches every client and so cannot be
attributed to one creator; this ack goes only to the caller.

```json
{ "Created": { "session": { "id": "a1b2...", "...": "..." } } }
```

### History

Reply to a `ClientMessage::History` request: a list of `Message` objects,
oldest first, plus the durable-message watermark the snapshot reflects.

```json
{
  "History": {
    "session": "a1b2...",
    "messages": [ /* Message objects, oldest first */ ],
    "seq": 14
  }
}
```

`seq` lets a client reconcile the snapshot against the live
`DaemonEvent::Session` tail: apply the broadcast events at or beyond the
watermark, in order, and dedupe by message id. A `seq` lower than the next
broadcast's means the snapshot is stale; the daemon will not re-emit the
overlap, so the client must dedupe on its own.

### Event (broadcast)

A live event from the daemon, wrapped in a `DaemonEvent`:

| variant             | payload                                                                                  | meaning                                    |
|---------------------|------------------------------------------------------------------------------------------|--------------------------------------------|
| `WorkspaceCreated`  | `WorkspaceInfo`                                                                          | a workspace was opened                     |
| `WorkspaceRemoved`  | `WorkspaceId`                                                                            | a workspace was closed                     |
| `SessionCreated`    | `SessionInfo`                                                                            | a session was created                      |
| `SessionRemoved`    | `SessionId`                                                                              | a session was removed                      |
| `SessionUpdated`    | `SessionInfo`                                                                            | title, message count, or other summary changed |
| `Session`           | `{ id: SessionId, seq: u64, event: EngineEvent }`                                        | a content event from one session's engine; `seq` is the session's durable-message index at emit time, so a client can reconcile a `ServerMessage::History` snapshot against the live tail and detect loss on the broadcast bus |

`EngineEvent` is the engine's view of what is happening on a session — see
[Engine events](#engine-events) below.

### Blob

One media blob's bytes, answering `ClientMessage::Blob`. The MIME type
travels on the message's media reference, so only the bytes are returned.

```json
{ "Blob": { "hash": "<content hash>", "data": "<base64 bytes>" } }
```

### Profiles

The current profile list, answering `ClientMessage::ListProfiles`. Same
shape as `Hello`'s `profiles`, sent only to the requesting client.

```json
{ "Profiles": { "profiles": ["default", "work"] } }
```

### Fault

A transport-level failure (unknown id, malformed frame, bad path), distinct
from `EngineEvent::Error`, which is a turn failure already in the event
stream.

```json
{ "Fault": { "session": null, "message": "missing field: path" } }
```

## ClientMessage

What the client sends. Variants:

| variant             | payload                                                                 |
|---------------------|-------------------------------------------------------------------------|
| `CreateWorkspace`   | `{ path: string }`                                                      |
| `CreateSession`     | `{ path: string, config: SessionConfig, client: ClientInfo }`           |
| `History`           | `{ session: SessionId }`                                                |
| `Command`           | `{ session: SessionId, command: EngineCommand }`                        |
| `Blob`              | `{ hash: string }`                                                      |
| `ListProfiles`      | `{}` (refreshes `Hello.profiles` without reconnecting)                  |
| `RemoveSession`     | `{ session: SessionId }`                                                |
| `RemoveWorkspace`   | `{ workspace: WorkspaceId }`                                            |
| `Subscribe`         | `{ sessions: [SessionId] }` (replaces the focused-set for this connection) |

A `CreateSession` followed by a `Command { UserMessage }` is the minimal
flow to start a turn. The turn's progress shows up as a stream of `Session`
events on that session id, ending with `EngineEvent::Agent(Done)` or
`EngineEvent::Error`.

### Subscribing to the content firehose

A connection starts subscribed to **nothing**: the daemon drops the
high-volume content stream (`EngineEvent::Agent` deltas) for every session
unless the connection has named it. A client sends `Subscribe { sessions: [...] }`
when its view changes — typically the attached session, plus the one previewed
in a picker. Each call **replaces** the previous set; pass an empty array to stop
receiving content for all sessions.

Lifecycle events (`WorkspaceCreated`/`WorkspaceRemoved`/`SessionCreated`/
`SessionRemoved`/`SessionUpdated`), permission requests, and turn errors are
always delivered for every session, regardless of the subscription, so a
background session can still surface a prompt or a failure. The gating only
applies to the per-session `Agent` content stream.

### SessionConfig

The optional fields a client sets when creating a session. Any field left out
takes the profile's `yuke.opts` default.

| field         | type            | notes                                                                                  |
|---------------|-----------------|----------------------------------------------------------------------------------------|
| `profile`     | string          | `<NAME>` loads `init_<NAME>.lua`; absent (or `"default"`) loads `init.lua`. Persisted so rehydration restores the same profile. |
| `model`       | string          | catalog name; overrides the profile default                                            |
| `reasoning`   | string          | reasoning level; must be one the active model offers                                   |
| `system`      | string          | system prompt; overrides the profile default                                            |
| `max_rounds`  | integer         | tool-calling rounds per turn cap                                                       |
| `permission`  | string          | `yolo` / `normal` / `strict`; overrides the daemon default                            |

`SessionConfig` carries no credentials: the daemon resolves the endpoint,
auth, and tool set from its own trusted config (`~/.yuke/init.lua`), so a
remote client never ships a key or Lua.

### ClientInfo

Every `CreateSession` carries one. It's persisted with the session and rides
on `SessionInfo.created_by`, so any client (and a restart) can tell which
frontend opened a given session.

```json
{ "name": "yuke-cli", "version": "0.0.1" }
```

## Engine commands

`ClientMessage::Command { session, command }` routes one of these to a
session's engine:

| variant                | payload                                                                  | role                                                       |
|------------------------|--------------------------------------------------------------------------|------------------------------------------------------------|
| `UserMessage`          | `{ content, model?, reasoning? }`                                        | new user message driving a turn; optional model/reasoning switch persists for later turns |
| `PermissionDecision`   | `{ id, allow, remember? }`                                               | reply to a `RequestPermission` engine event                |
| `SetPermissionMode`    | `{ mode }`                                                               | change the session's mode, effective at the next tool gate |
| `Cancel`               | `{}`                                                                     | cancel the in-flight turn                                  |
| `Eval`                 | `{ id, code }`                                                           | evaluate Lua against the session's VM; only enabled when `yuke.opts.allow_eval = true` |

`remember: true` on `PermissionDecision` persists an "allow always" rule for
that exact call, so future calls of the same form skip the prompt entirely.
Eval runs serialized with turns: an `Eval` sent mid-turn waits until the turn
ends, and while an eval runs nothing else on the session is processed.

## Engine events

`EngineEvent` is what arrives inside a `ServerMessage::Event { Session }` (or
as a direct `RequestPermission`). Variants:

| variant                 | payload                                                                | meaning                                                       |
|-------------------------|------------------------------------------------------------------------|---------------------------------------------------------------|
| `UserMessage`           | `Message`                                                              | the user message echoed so every client and the transcript record it through the same path as assistant and tool events |
| `Agent`                 | `AgentEvent`                                                           | an event from the agent loop, forwarded unchanged              |
| `RequestPermission`     | `ToolCall`                                                             | a tool call awaiting the client's approval                     |
| `ModelChanged`          | `string`                                                               | the session switched to a different catalog model              |
| `ReasoningChanged`      | `string`                                                               | the session switched to a different reasoning level            |
| `PermissionModeChanged` | `PermissionMode`                                                       | the session's permission mode changed                          |
| `Queued`                | `{ position }`                                                         | a user message was accepted mid-turn, held to run after it     |
| `Canceled`              | `{ timing }`                                                           | the in-flight turn was canceled by the frontend                |
| `Error`                 | `{ code, message, timing }`                                            | the turn failed; `code` is the machine-readable category       |
| `EvalResult`            | `{ id, outcome }`                                                      | reply to `EngineCommand::Eval`, tagged with the same id        |

`AgentEvent` is the agent loop's stream — the content a client renders in
real time:

| variant              | payload                            | meaning                                                                  |
|----------------------|------------------------------------|--------------------------------------------------------------------------|
| `TextDelta`          | `{ id, delta }`                    | incremental assistant text, tagged with the assistant message id it builds |
| `ReasoningDelta`     | `{ id, delta }`                    | incremental assistant reasoning ("thinking"), tagged with the assistant message id |
| `ReasoningDone`      | `{ id, span }`                     | reasoning finished; the model began answering or calling tools, and the span tells a frontend "thought for Ns" |
| `AssistantMessage`   | `Message`                          | the assistant turn, assembled and appended to the conversation           |
| `ToolCall`           | `ToolCall`                         | a tool call about to run (after approval, if any)                        |
| `ToolResult`         | `{ name, message }`                | a finished (or denied) tool call, with its output fed back               |
| `Done`               | `{ stop_reason, rounds }`          | final answer reached (no more tool calls)                                |

## Message shape

A `Message` (the unit of a session's transcript) looks like:

```json
{
  "role": "assistant",
  "content": "The parser fails on empty input because...",
  "reasoning_content": "",
  "tool_calls": [
    {
      "id": "tc_001",
      "name": "read",
      "arguments": { "path": "src/parse.rs" }
    }
  ]
}
```

`role` is `"system"`, `"user"`, `"assistant"`, or `"tool"`. `tool_calls`
appears on assistant turns; `tool_call_id` (matching a `ToolCall.id`) appears
on `tool` role messages that answer a call. `reasoning_content` is preserved
in the on-disk transcript but never re-sent to the model.

## Reference

For the full schema (every variant, every field, every description), see
[`asyncapi.json`](https://xyaman.github.io/yuke-website/asyncapi.json). It is the same document rendered by the
Rust types in [`yuke-core`](https://github.com/xyaman/yuke), so any mismatch
between this page and the code is a bug in this page; the JSON is the
contract.
