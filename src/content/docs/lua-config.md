---
title: init.lua
description: Session policy, tools, and hooks for init.lua (the optional Lua config file).
---

`~/.yuke/init.lua` is optional. If it is present, the daemon runs it once per
new session, followed by any workspace `.yuke/init.lua` overlay, to declare
session policy, tools, and hooks. The model catalog lives separately in
[providers.json](/providers/); credentials live in `auth.json`; this file is
for behavior, not data.

This page is the API reference for the four top-level calls available in
`init.lua`:

- `yuke.opts` — session policy
- `yuke.tool` — register a model-facing tool
- `yuke.on` — register lifecycle and tool-gate listeners
- the [runtime primitives](/primitives/) tool handlers use
  (`yuke.fs`, `yuke.exec`, `yuke.http`, `yuke.glob`, `yuke.env`, `yuke.json`,
  `yuke.log`, `yuke.sleep`)

## Standard library sandbox

The runtime loads a curated subset of Lua's standard library:

```text
TABLE | STRING | MATH | COROUTINE | PACKAGE
```

That is the entire list. `os`, `debug`, `utf8`, and the base library's
`io` / `loadfile` / `dofile` are not available. Calling one of them
(`os.time()`, `debug.getinfo()`, `io.open(...)`, `loadfile(...)`) errors at
load time with `attempt to index a nil value` or `attempt to call a nil value`.

The `require` loader from `PACKAGE` resolves modules under the workspace's
`.yuke/` directory (or `<config dir>` for the base layer), so an `init.lua`
can `require("tools.foo")` from `.yuke/tools/foo.lua`.

This is an API-surface choice, not a security boundary: config Lua is
trusted, like a Neovim `init.lua`. The `yuke.*` primitives already grant
full machine access (run processes, read and write files, reach the network),
so this just steers IO onto the single async `yuke.*` surface instead of the
blocking stdlib ones. The point is to keep config on one coherent IO surface,
not to restrict what it can do.

The most common bites:

| you want                        | use                                                              |
|---------------------------------|------------------------------------------------------------------|
| wall-clock time                 | `yuke.env.get("SOURCE_DATE_EPOCH")` or `yuke.exec("date +%s")`   |
| file mtime / metadata           | `yuke.fs.stat(path)` (`.modified` is seconds since epoch)       |
| environment variables           | `yuke.env.get("HOME")`                                           |
| read / write files              | `yuke.fs.read` / `yuke.fs.write` / `yuke.fs.append`             |
| shell out                       | `yuke.exec(cmd)`                                                 |
| HTTP                            | `yuke.http.get` / `yuke.http.post`                               |
| JSON encode / decode            | `yuke.json.encode` / `yuke.json.decode`                          |
| pause                           | `yuke.sleep(ms)`                                                 |
| log line (`lua` target)         | `yuke.log(msg)`                                                  |

`os.time()` has no `yuke.*` equivalent because the daemon has no concept of
"the current time" as a first-class primitive. If you need a timestamp, either
accept that it is the `SOURCE_DATE_EPOCH` env var (set by reproducible-build
tooling) or shell out to `date`.

## Config layers

A session's Lua config is built from two layers, run in one VM in order:

1. **Profile (base)** — a file in the config dir (`~/.yuke` by default). The
   **default** profile is `init.lua`; a **named** profile `foo` is
   `init_foo.lua`.
2. **Workspace (overlay)** — the workspace's own `.yuke/init.lua`, if present,
   run after the profile so it can extend or wrap it (e.g. add a
   project-specific tool or override `yuke.opts{}`).

A second `yuke.opts{}` call (e.g. the workspace layer) merges field-by-field
over the first, so it extends rather than replaces the profile's policy.
Tools and hooks from both layers register into the same VM.

---

## yuke.opts

Sets session policy: which model a new session starts on, the system prompt,
the round cap, and a few session-wide switches. All fields are optional. A
`SessionConfig` from the client overrides these.

```lua
yuke.opts {
    default_model    = "openai/gpt-4o",     -- "provider/model" or bare name
    prompt           = "You are a helpful assistant.",
    max_rounds       = 10,
    reasoning_effort = "medium",            -- session default; applied per model only where its levels include it
    allow_eval       = false,               -- let clients eval against this session's VM (off by default)
}
```

**`default_model`**: pass `"provider/model"` (e.g. `"openai/gpt-4o"`) or a
bare model name when it is unambiguous across all providers. An ambiguous
bare name errors at session-build time with a disambiguation hint.

**`reasoning_effort`**: a per-session default for the reasoning level. The
catalog picks a per-model default (the middle of its `reasoning_levels`),
and this opt overlays it on every model that offers the named level; a model
whose levels exclude it keeps its own default.

**`allow_eval`**: when `true`, a client may send an `Eval` command to run an
arbitrary Lua snippet against this session's live VM (the same VM that loaded
this config, with its tools, hooks, and globals). It returns the snippet's
value as JSON plus any `print` output. Eval runs serialized with turns —
never while a turn is in flight — so it cannot race a tool. **Off by
default**: the snippet has the VM's full machine access (`yuke.exec`,
`yuke.fs`, …), so only enable it where you trust every client that can
reach the daemon. Because it lives in the trusted config, a remote client
cannot turn it on itself.

A second `yuke.opts{}` call (e.g. the workspace layer) merges over the first,
overriding only the fields it sets.

---

## yuke.tool

Registers a tool the model can call.

```lua
yuke.tool {
    name        = "read_file",
    description = "Read a file from disk.",
    params      = { path = "string" },
    handler     = function(args)
        return yuke.fs.read(args.path)
    end,
}
```

### Fields

| field         | type     | notes                                                                                  |
|---------------|----------|----------------------------------------------------------------------------------------|
| `name`        | string   | identifier the model uses                                                              |
| `description` | string   | shown to the model                                                                     |
| `params`      | table    | `{ field = type }` where type is `"string"`, `"number"`, `"integer"`, or `"boolean"`    |
| `params_json` | string   | raw JSON Schema, overrides `params`                                                     |
| `handler`     | function | called with a table of arguments; the return value is sent back to the model           |

### Param types

A `params` field type is one of `"string"`, `"number"`, `"integer"`, or
`"boolean"`. By default every field is **required**. Append `?` to the type to
mark a field optional — e.g. `start = "integer?"` — which drops it from the
schema's `required` list so the model may omit it.

```lua
yuke.tool {
    name        = "read",
    description = "Read a file. Optional 1-indexed line range.",
    params      = { path = "string", start = "integer?", ["end"] = "integer?" },
    handler     = function(args)
        return yuke.fs.read(args.path, args.start, args["end"])
    end,
}
```

If a tool needs a more expressive schema than the simple `params` table
allows, pass a raw JSON Schema string in `params_json` instead; it overrides
`params`.

### Return values

A handler may return:

- a **string** — passed through to the model
- `nil` — empty result
- a **table** — JSON-encoded automatically

Any other return is converted with the runtime's JSON encoder. For a worked
example see [Writing tools](/tools/).

---

## yuke.on

Registers a listener on a point in the agent loop. Many listeners may be
added per event (like Neovim autocmds); they fire in registration order.
Listeners are async, so they can `await` the IO primitives below.

```lua
yuke.on("before_tool", function(call) ... end)
yuke.on("tool_result", function(call, output) ... end)
```

### Events

| event         | handler signature        | role                                                       |
|---------------|--------------------------|------------------------------------------------------------|
| `before_tool` | `function(call)`         | gate: allow / ask / deny / rewrite args, before the call runs |
| `after_tool`  | `function(call, output)` | rewrite the result a tool fed back                         |
| `turn_start`  | `function(round)`        | observe: an assistant round is starting                     |
| `turn_end`    | `function(round)`        | observe: a round's message and tools finished               |
| `tool_call`   | `function(call)`         | observe: a tool is about to run                             |
| `tool_result` | `function(call, output)` | observe: a tool result was fed back                         |
| `done`        | `function(reason, rounds)` | observe: the turn reached a final answer                  |

`call` is `{ id, name, arguments }`, where `arguments` is the decoded
argument table (not a JSON string). An unknown event name is an error at
load time.

### The two gates chain; observers don't

Observer return values are ignored. The gates thread their return value
through each listener in order:

- `before_tool` returns one of:
  - `nil`: no verdict. The session's permission mode and any remembered
    answer decide (in `normal` the call runs; in `strict` it prompts).
  - `{ allow = true }`: run the call without prompting.
  - `{ ask = true }` (a string reason is also accepted): prompt the user
    before running.
  - `{ deny = "reason" }`: skip the call; `reason` is fed back to the model
    as the result.
  - `{ args = <table> }`: replace the arguments. The rewrite is visible to
    the next `before_tool` listener and is what the tool ultimately receives
    (the recorded assistant message keeps the model's original args).
    Combine it with a verdict, e.g. `{ allow = true, args = <table> }`.

  The first listener that returns a verdict (`allow`, `ask`, or `deny`)
  wins and short-circuits; `args` rewrites thread through until then. A
  `deny` is a hard floor: it holds even in `yolo` mode. The session's
  permission mode (`yolo` / `normal` / `strict`, set by the client or the
  daemon's `--permission` default) decides everything a listener leaves as
  `nil`.
- `after_tool` returns a string to replace the output, or `nil` to keep it.
  The (possibly replaced) output threads into the next listener.

A listener that errors is logged to stderr and skipped; `before_tool` then
defers its verdict, so a buggy hook never aborts a turn.

```lua
-- Auto-allow reads, prompt before shell, block writes to secrets.
yuke.on("before_tool", function(call)
  if call.name == "read" then return { allow = true } end
  if call.name == "bash" then return { ask = "shell command" } end
  if call.name == "write" and call.arguments.path and call.arguments.path:find("%.ssh/") then
    return { deny = "refusing to touch ~/.ssh" }
  end
end)

-- Redact a secret from every tool result.
yuke.on("after_tool", function(call, output)
  return (output:gsub("sk%-[%w]+", "[redacted]"))
end)

-- Audit log of every tool the model ran.
yuke.on("tool_result", function(call, output)
  yuke.fs.append("/tmp/yuke-audit.log", call.name .. " -> " .. #output .. " bytes\n")
end)
```

---

## Full example

A worked `init.lua` lives in
[`examples/init.lua`](https://github.com/xyaman/yuke/blob/main/examples/init.lua)
in the yuke repo. It declares session defaults, registers a `now` tool, and
shows `before_tool` denial plus `tool_result` audit logging. Providers and
models are NOT in this file: they live in `providers.json`.
