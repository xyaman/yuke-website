---
title: Lua primitives
description: The yuke.* runtime primitives available to init.lua and tool handlers.
---

The `yuke.*` table is injected into every `init.lua` and tool handler. Every
function that does IO is async and non-blocking; you call them like normal
functions and the runtime drives the `await` for you. String work
(matching, splicing, formatting) stays in Lua's standard library.

The split is deliberate: **Rust provides the IO that Lua can't do safely or
quickly (filesystem, processes, network, search). Lua composes those
primitives into the tools the model calls.**

Relative paths in `yuke.fs` and `yuke.exec` resolve against the session's
**workspace root**; absolute paths are used unchanged.

## yuke.fs

```lua
yuke.fs.read(path)              -- whole file as a string
yuke.fs.read(path, start, end)  -- lines start..end (1-indexed, inclusive)
yuke.fs.write(path, content)    -- create or overwrite
yuke.fs.append(path, content)   -- create or append
yuke.fs.edit(path, old, new)    -- replace the unique occurrence of `old`; returns the count
yuke.fs.edit(path, old, new, { replace_all = true })  -- replace every occurrence
yuke.fs.exists(path)            -- bool
yuke.fs.list(path)              -- array of { name = string, is_dir = bool }
yuke.fs.delete(path)            -- remove a file
yuke.fs.mkdir(path)             -- create a directory and any missing parents
yuke.fs.rename(from, to)        -- move/rename a file or directory
yuke.fs.copy(from, to)          -- copy a file, returns bytes written
yuke.fs.stat(path)              -- { size, is_dir, is_file, modified } or nil if missing
```

`stat.modified` is seconds since the Unix epoch. `stat` returns `nil` for a
missing path rather than erroring, so a handler can branch on it.

`edit` is a literal substring match (no Lua patterns, no regex). `old` must
match exactly once unless `replace_all` is set; a missing, empty, or non-unique
match is an error, so a handler can't silently edit the wrong place. It returns
the number of replacements made.

## yuke.glob

Find files by name pattern. Does **not** respect `.gitignore`.

```lua
yuke.glob("src/**/*.rs")                    -- array of matching paths, sorted
yuke.glob("**/*.lua", { max_results = 50 }) -- cap on results (default 1000)
```

A relative pattern is anchored at the session's workspace root.

## yuke.exec

Run a subprocess and return `{ stdout, stderr, code, timed_out }`. Output is
capped (default 100 KB per stream) so a chatty command can't flood the
model's context; truncated output ends with a `... [truncated N bytes]`
marker.

```lua
-- shell string
local r = yuke.exec("git log --oneline -5")

-- explicit argv (no shell, no quoting hazards)
local r = yuke.exec({ "rg", "--json", pattern })

-- with options
local r = yuke.exec("cargo test", {
    cwd        = "/path/to/repo",
    timeout_ms = 60000,
    env        = { RUST_LOG = "debug" },
    max_output = 200000,
})

r.stdout     -- string
r.stderr     -- string
r.code       -- integer (-1 if killed/timed out)
r.timed_out  -- bool
```

| option       | type                | default     | notes                                                  |
|--------------|---------------------|-------------|--------------------------------------------------------|
| `cwd`        | string              | workspace   | working directory; absolute used as-is                 |
| `timeout_ms` | integer             | none        | kill the child after this many milliseconds            |
| `env`        | table               | empty       | extra environment variables to set on the child        |
| `max_output` | integer             | 100_000     | byte cap per stream before truncation                  |

A timed-out command is killed; `timed_out` is `true` and `code` is `-1`.

## yuke.http

Outbound HTTP. Returns `{ status, body }`. A shared reqwest client backs
both `get` and `post`, so multiple requests reuse connections.

```lua
local r = yuke.http.get("https://example.com/api", {
    headers = { Authorization = "Bearer " .. token },
})

local r = yuke.http.post("https://example.com/api", {
    headers = { ["Content-Type"] = "application/json" },
    json    = { query = "hello" },   -- or: body = "raw string"
    timeout_ms = 30000,
})

r.status  -- integer
r.body    -- string
```

| option       | type                | default     | notes                                                          |
|--------------|---------------------|-------------|----------------------------------------------------------------|
| `headers`    | table               | empty       | extra request headers                                          |
| `body`       | string              | none        | raw request body; takes precedence over `json`                 |
| `json`       | any                 | none        | JSON request body, serialised from the Lua value               |
| `timeout_ms` | integer             | 60_000      | per-request timeout                                            |

## yuke.env

```lua
yuke.env.get("HOME")   -- string, or nil if unset
```

## yuke.json

```lua
yuke.json.encode(value)  -- Lua value -> JSON string
yuke.json.decode(text)   -- JSON string -> Lua value
```

## yuke.log

```lua
yuke.log("message")  -- emits an info-level log line under the "lua" target
```

Routed through the daemon's `tracing` subscriber (to stderr), so it honors
`RUST_LOG` like any other log. `RUST_LOG=lua=info` shows only config logs;
`RUST_LOG=warn,lua=info` silences daemon noise but keeps them.

## yuke.sleep

```lua
yuke.sleep(ms)  -- pause for ms milliseconds (async, non-blocking)
```
