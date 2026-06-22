---
title: yuke-tui
description: The interactive terminal client for the yuke daemon, and the yuke.tui.* Lua API.
---

`yuke-tui` is an interactive terminal client for the yuke daemon. The Rust core
owns state and the cell grid; Lua owns the view (what each region paints), the
bindings (which keys invoke which actions), the theme, and client-side
commands. The whole UI is `~/.yuke/tui/init.lua`-scriptable: rebind keys,
add sidebars, replace the statusline, register a custom command palette —
without rebuilding the binary.

This page is the API reference for the `yuke.tui.*` surface.

## Two different `yuke`s

`yuke-tui` and the daemon's `init.lua` are different processes, different VMs,
and different files. They share none of the same surface.

| Surface | Where it runs | File | What it does |
|---|---|---|---|
| `yuke.*` (daemon) | inside the engine | `~/.yuke/init.lua` | tools, hooks, `yuke.opts`, `fs`/`exec`/`http`, `yuke.cmd` |
| `yuke.tui.*` (this) | inside the TUI client | `~/.yuke/tui/init.lua` | layout, paint, keymap, theme, events, client commands |

The TUI VM has **no** `fs` / `exec` / `http` / `tool` and no agent hooks; it is
a view layer. The two share only the `mlua` dependency.

## The model: state in, actions out

Every paint callback, hook, and command handler receives a read-only **`ctx`**
describing current state. The only way to change anything (send a turn, scroll,
switch model, edit the composer, answer a prompt) is to call a
**`yuke.tui.actions.*`** verb. Paint callbacks must be pure: read `ctx`, write
cells, no side effects.

```lua
-- read state from ctx; mutate state through actions
yuke.tui.keymap.set("insert", "<CR>", function(ctx)
  if ctx.input.text ~= "" then
    yuke.tui.actions.send()      -- sends the composer as a user turn
  end
end)
```

A buggy config can therefore garble the *view* but can never corrupt a turn or
desync the protocol: every state change goes through `yuke.tui.actions.*`.

## Layers and boot

The TUI's Lua config is built from two layers, run in one VM in order:

1. **Bundled default** — embedded in the binary, sets the theme, the root
   layout (statusline / transcript / composer), the standard keymaps, and the
   built-in commands. Ships so the TUI is fully usable with no user config.
2. **User overlay** — `~/.yuke/tui/init.lua` (optional), runs after the default
   and can extend it (add a sidebar, rebind keys, register commands) or
   replace it wholesale (`yuke.tui.set_root(...)` with a fresh tree).

The bundled default boots in `insert` mode with emacs / readline editing
keys. Setting `opts.vim = true` loads the bundled `runtime/vim.lua`, which
adds a `normal` mode reachable with `<Esc>`, with vim motions, operators, and
edits on the composer. Either way, every binding is plain `keymap.set`, so vim
is just the bundled default, not a hardcoded mode.

---

## yuke.tui.opts

Client-level options. Call once at the top of `init.lua`; the bundled default
sets values first, so a user file only overrides what it cares about.

```lua
yuke.tui.opts {
  daemon          = "127.0.0.1:7878",
  vim             = false,                      -- modal composer + vim motions
  start_mode      = "insert",
  working_label   = "working…",
  working_frames  = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" },
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `daemon` | string | `"127.0.0.1:7878"` | `host:port` or a full `ws://` / `wss://` URL. A CLI positional argument overrides this. |
| `vim` | bool | `false` | when `true`, loads the bundled vim bindings (`runtime/vim.lua`); the composer is modal with vim motions and edits |
| `start_mode` | string | `"insert"` | the key mode the app boots in |
| `working_label` | string | `"working…"` | label of the built-in `working` leaf |
| `working_frames` | string[] | the Braille dots | the spinner frames the `working` leaf cycles over time |

---

## The `ctx` state table

Handed to every paint callback, hook, keymap, and command handler.
**Read-only.** Read it, but mutate state only through `yuke.tui.actions.*`.

| Field | Type | Notes |
|---|---|---|
| `ctx.connected` | bool | daemon socket up |
| `ctx.mode` | string | active key mode (`"insert"`, `"normal"`, ...) |
| `ctx.size` | table | screen dimensions `{ width, height }` |
| `ctx.input` | table | composer: `{ text = <string> }` |
| `ctx.turn` | table | `{ active, queued, elapsed_ms, tokens, spinner, thinking }`: whether a turn is in flight, queued user messages behind it, milliseconds elapsed, token count, the spinner frame counter, and whether the model is in a reasoning ("thinking") block |
| `ctx.session` | table? | focused session: `{ id, model, reasoning, permission, title }`; `nil` before attach |
| `ctx.sessions` | `Session[]` | every live session, for a Lua `picker(spec)` source |
| `ctx.models` | `Model[]` | advertised catalog, for a Lua `picker(spec)` source: `{ name, protocol, reasoning_levels, default_reasoning }` |
| `ctx.commands` | `Command[]` | every registered client command, for a command-palette picker: `{ name, desc }` |

---

## yuke.tui.actions

The verbs. Every state change goes through one of these. They are safe to call
from keymaps, commands, and hooks; they update local UI state and / or send a
`ClientMessage` / `EngineCommand` to the daemon.

### Conversation

| Action | Maps to | Notes |
|---|---|---|
| `actions.send()` | `EngineCommand::UserMessage` | sends the composer as a user turn; queues if a turn is in flight |
| `actions.cancel()` | `EngineCommand::Cancel` | interrupt the in-flight turn |
| `actions.set_model(name)` | model switch on next `UserMessage` | sticky; errors surface as a `turn_error` event |
| `actions.set_reasoning(level)` | reasoning switch | must be offered by the active model |
| `actions.set_permission_mode(mode)` | `EngineCommand::SetPermissionMode` | `"strict"` \| `"normal"` \| `"yolo"`; an unknown mode surfaces a notice |
| `actions.notify(message)` | transient footer notice | the same as `yuke.tui.notify` |
| `actions.attach(id)` | focus a session by id | fetch `History`, start reconciling its firehose |
| `actions.new_session()` | `CreateSession` | a session in the launch workspace |
| `actions.run_command(name)` | run a registered client command | invokes the command registered via `yuke.tui.cmd.register` |

### Composer (local edits)

The composer's cursor and buffer are local UI state — no daemon round-trip.

| Action | Effect |
|---|---|
| `actions.composer.newline()` | insert a literal newline (the composer is multiline) |
| `actions.composer.move(where)` | `"left"` \| `"right"` \| `"word_left"` \| `"word_right"` \| `"home"` \| `"end"` \| `"up"` \| `"down"` (readline-style) |
| `actions.composer.delete(kind)` | `"char_back"` \| `"char"` \| `"word_back"` \| `"word"` \| `"line"` \| `"to_end"` \| `"to_start"` (readline-style) |
| `actions.composer.motion(m)` | vim motion: `"h"` \| `"l"` \| `"j"` \| `"k"` \| `"0"` \| `"^"` \| `"$"` \| `"w"` \| `"W"` \| `"b"` \| `"B"` \| `"e"` \| `"E"` \| `"gg"` \| `"G"` (the modal editor's cursor, only used under `opts.vim = true`) |
| `actions.composer.op(operator, motion)` | vim operator over a motion: `operator` in `"d"` \| `"c"` \| `"y"`, e.g. `op("d", "w")`; doubled (`"dd"`, `"cc"`, `"yy"`) operates on the line |
| `actions.composer.edit(e)` | one-key vim edits: `"x"` \| `"X"` \| `"D"` \| `"p"` \| `"P"` \| `"u"`, plus the insert-entry keys `"a"` \| `"A"` \| `"I"` \| `"o"` \| `"O"` \| `"C"` (which enter insert) |
| `actions.composer.history(dir)` | recall submitted inputs: `"prev"` \| `"next"` |

The motion / op / edit verbs exist so a custom `normal`-mode keymap can drive
the built-in modal editor; the bundled vim bindings are just these wired to the
usual keys. They are no-ops when `opts.vim = false`.

### View / navigation

| Action | Effect |
|---|---|
| `actions.scroll(delta)` | scroll the transcript by `delta` rows (negative = up) |
| `actions.scroll_to(where)` | `"top"` \| `"bottom"` |
| `actions.mode(name)` | switch key mode |
| `actions.picker(kind)` | open a built-in picker: `"model"` \| `"reasoning"` \| `"session"` \| `"command"` |
| `actions.back()` | return to the dashboard / session picker |
| `actions.redraw()` | request a repaint (a no-op; a redraw follows every event) |
| `actions.quit()` | tear down and exit |

### Stub verbs (load without error)

The bundled default and common configs reference a few verbs that the current
build accepts as no-ops so configs load without error. They are reserved for
upcoming increments:

`eval`, `open_workspace`, `remove_session`, `remove_workspace`, `permit`,
`focus`, `run_daemon_command`.

---

## yuke.tui.keymap

nvim-style chord bindings, dispatched per key mode. A bound key in a mode
shadows that mode's default text handling; an unbound printable key in
`"insert"` mode falls through to the composer.

```lua
yuke.tui.keymap.set("insert", "<CR>",  function(ctx)
  if ctx.input.text ~= "" then yuke.tui.actions.send() end
end)

yuke.tui.keymap.set("*",      "<C-q>", function() yuke.tui.actions.quit() end)   -- "*" = all modes
```

| Function | Signature | Notes |
|---|---|---|
| `keymap.set(mode, lhs, rhs, opts?)` | `mode: string, lhs: string, rhs: function, opts?: table` | `rhs` receives `ctx` |
| `keymap.del(mode, lhs)` | | remove a binding |
| `keymap.list(...)` | | stub (returns an empty table) |

**Modes**: at least `"insert"` (typing into the composer) and `"normal"`
(navigation). `"*"` binds in all modes. The bundled default uses a `dashboard`
mode for the startup screen. Lua may define more modes and switch with
`actions.mode(name)`.

**Chord syntax** matches the daemon-adjacent convention: printable keys bare
(`j`, `G`), modifiers bracketed (`<C-x>`, `<M-x>`, `<S-Tab>`, `<CR>`, `<Esc>`,
`<BS>`, `<Tab>`, `<Up>`, `<F5>`). Multi-key chords (`gg`, `<leader>q`) are
supported with a pending-chord timeout.

---

## yuke.tui.layout

Declare the region tree for the single-session view. Leaves are built-in
widgets (by name) or paint handles. Install the tree with `set_root`.

```lua
local L = yuke.tui.layout
yuke.tui.set_root(
  L.rows {
    L.leaf("statusline", { size = 1 }),
    L.leaf("transcript", { grow = 1 }),
    L.leaf("composer",   { size = 3, min = 1, max = 10 }),
  }
)
```

| Node | Signature | Notes |
|---|---|---|
| `L.rows{ ... }` | children stacked top-to-bottom | a.k.a. horizontal split |
| `L.cols{ ... }` | children left-to-right | a.k.a. vertical split |
| `L.leaf(widget, opts?)` | `widget: string \| PaintHandle` | a built-in name or a `paint.register` handle |
| `yuke.tui.set_root(node)` | install / replace the root | call again to swap the whole UI |

**Sizing opts** on any child: `size` (fixed rows / cols), `grow` (flex weight,
default `1` when no `size`), `min`, `max`, `fit` (collapse when content is
empty).

**Built-in widgets** (Rust-implemented leaves; each is replaceable by a paint
handle):

| Name | Renders |
|---|---|
| `"transcript"` | the scrolling conversation: user / assistant / tool blocks, **live token streaming** (text and reasoning), tool calls and results |
| `"composer"` | the multiline input box: soft-wrap, logical-line cursor, up / down history recall of submitted inputs |
| `"statusline"` | session title, model, reasoning, permission mode, turn / queued / connection state |
| `"working"` | the spinner + `opts.working_label` + elapsed time while a turn runs; collapses to zero height when idle (give it `{ fit = true }`) |
| `"footer"` | the mode / hint line plus any transient notice |

---

## yuke.tui.paint

Register a callback that paints a leaf. The callback runs once per frame
while its leaf is visible, receiving a **slice** (the leaf's cell rectangle)
and `ctx`.

```lua
local hud = yuke.tui.paint.register(function(slice, ctx)
  slice:clear()
  local s = ctx.session
  slice:line(0, {
    { " " .. (s and s.model or "no session") .. " ", "statusline.model" },
    { ctx.turn.active and "  ● streaming" or "", "accent" },
  })
end, { /* options reserved for future use */ })

-- a paint handle is usable anywhere a widget name is:
yuke.tui.set_root(yuke.tui.layout.rows {
  yuke.tui.layout.leaf(hud,            { size = 1 }),
  yuke.tui.layout.leaf("transcript",   { grow = 1 }),
  yuke.tui.layout.leaf("composer",     { size = 3 }),
})
```

### Slice methods

The slice writes into the ratatui frame buffer for this leaf only. It is valid
**only during the callback**; storing it and using it later raises a clean Lua
error.

| Method | Notes |
|---|---|
| `slice.width`, `slice.height` | leaf dimensions in cells |
| `slice:set(col, row, ch, style?)` | one cell; `ch` is a string (only the first character is used) |
| `slice:put(col, row, text, style?) -> width` | text from `(col, row)`, returns columns advanced (unicode-width aware), clipped to the leaf |
| `slice:line(row, spans)` | a styled line: `spans` is `{ { text, style }, ... }` |
| `slice:fill(rect?, ch?, style?)` | fill a sub-rect (or the whole leaf) |
| `slice:clear()` | reset the leaf to the theme background |

`style` is either a **theme style name** (string, e.g. `"assistant"`,
`"border"`) or an inline table (see `yuke.tui.theme`). `rect` is
`{ col, row, width, height }`.

### Handle

`paint.register` returns a handle with one method:

| Method | Notes |
|---|---|
| `handle:remove()` | unregister the callback; the leaf is empty until the layout drops the handle |

---

## yuke.tui.theme

Named styles plus a palette. A **style name** used in `slice` calls is
resolved through the theme, so restyling restyles every widget that
referenced the name.

```lua
yuke.tui.theme.set {
  palette = {
    bg     = "#11131a",
    fg     = "#c8d0e0",
    accent = "#7aa2f7",
    dim    = "#5a627a",
  },
  styles = {
    ["user"]            = { fg = "fg", bold = true },
    ["assistant"]       = { fg = "fg" },
    ["reasoning"]       = { fg = "dim", italic = true },
    ["tool.name"]       = { fg = "accent" },
    ["statusline"]      = { fg = "fg", bg = "#1a1d28" },
    ["statusline.model"]= { fg = "accent", bold = true },
    ["selection"]       = { bg = "#283457" },
    ["cursor"]          = { reverse = true },
  },
}
```

| Function | Notes |
|---|---|
| `theme.set(spec)` | `spec`: `{ palette, styles }`; merges over the current theme |
| `theme.use(name)` | stub (loads a bundled colorscheme when the surface lands) |
| `theme.get(name)` | stub |
| `theme.list()` | stub |

**Style table** fields: `fg`, `bg` (a `#rrggbb`, a palette key, a named
terminal color, or `"none"` to clear), and the booleans `bold`, `italic`,
`underline`, `reverse`, `dim`, `strikethrough`.

---

## yuke.tui.on

Subscribe to events. Handlers receive `(payload, ctx)` and may call actions.
The `turn_error` and `disconnect` events are surfaced by the bundled default
as transient notices.

```lua
yuke.tui.on("turn_error", function(payload)
  yuke.tui.notify(payload.message)
end)
```

| Event | Payload | Source |
|---|---|---|
| `turn_error` | `{ code, message, timing }` | `EngineEvent::Error` |
| `disconnect` | `{}` | the daemon socket dropped (the manager reconnects in the background) |

The full event catalogue (text deltas, tool calls, paste, focus, resize, etc.)
is on the design plan; the current build wires the two the bundled default
listens to. `yuke.tui.on(event, fn)` accepts any event name and records the
handler; unknown events still fire the handler at the next opportunity.

---

## yuke.tui.cmd

Client-side command-palette commands. A `yuke.tui.cmd` runs in the TUI client
and drives the UI; it is not the daemon's `yuke.on` (the lifecycle hooks that
run in the engine, between turns). Invoke from a keymap (e.g. `:` in the
vim default) or from your own picker.

```lua
yuke.tui.cmd.register("new", {
  desc    = "new session",
  handler = function(_args, _ctx)
    yuke.tui.actions.new_session()
  end,
})
```

| Field | Type | Notes |
|---|---|---|
| `desc` | string | shown in the command picker |
| `handler` | `function(args, ctx)` | `args` is an empty table in the current build; `ctx` is the read-only state table |

Every registered command shows up in `ctx.commands` (as `{ name, desc }`),
which the bundled command-palette picker uses as its source.

---

## yuke.tui.picker

A Telescope-style picker: a fuzzy-filtered list on the left, a preview on
the right. Rust runs the filter, selection, overlay, and the live
conversation preview; Lua owns the data, formatting, preview, and the action.

```lua
yuke.tui.keymap.set("dashboard", "s", function(ctx)
  yuke.tui.picker {
    title     = " sessions ",
    layout    = "default",
    source    = ctx.sessions,
    format    = function(s) return s.title .. "  " .. s.model end,
    match     = function(s) return s.title end,
    preview   = "conversation",
    on_select = function(s) yuke.tui.actions.attach(s.id) end,
  }
end)
```

| Field | Type | Notes |
|---|---|---|
| `source` | array \| `function() -> array` | the items; built-in data comes off `ctx` (e.g. `ctx.sessions`, `ctx.models`, `ctx.commands`) |
| `format` | `function(item) -> string` | the row label; defaults to `tostring(item)` |
| `match` | `function(item) -> string` | the fuzzy-match key; defaults to `format` |
| `preview` | `true` \| `"conversation"` \| `function(item, slice, ctx)` \| `false` / `nil` | the preview content: `true` / `"conversation"` stream `item.id`'s live conversation; a function paints the pane (a `slice`, as in `paint`); `false` / `nil` shows none |
| `on_select` | `function(item, ctx)` | runs on Enter; call `actions.*` to act |
| `title` | string | overlay title |
| `layout` | preset name \| table | the layout (see below); defaults to `"default"` |

Keys inside a picker: type to filter, `↑` / `↓` / `^p` / `^n` move, `Enter`
selects, `Esc` dismisses.

### Layouts

The `layout` field positions and sizes the picker box and places the preview
pane. Every preset supports a preview; whether it shows is the spec's
`preview` field. Pass a preset name, or a table to customize.

| Preset | Geometry |
|---|---|
| `"default"` | centered, 0.8 × 0.8, preview right |
| `"ivy"` | docked to the bottom, full width, height 0.4, preview right |
| `"vertical"` | centered, narrow (0.6 wide, 0.85 tall), preview below |
| `"simple"` / `"select"` | small centered box (0.6 × 0.5), preview right |
| `"vscode"` / `"dropdown"` | docked to the top, 0.6 × 0.45, preview below (a command-palette dropdown) |

A table either starts from a `preset` and overrides fields, or sets them from
the `"default"` base:

```lua
layout = { preset = "ivy", height = 0.5, preview_ratio = 0.6 }
layout = { position = "bottom", width = 1.0, height = 0.3, preview = false }
```

| Layout field | Type | Notes |
|---|---|---|
| `preset` | string | a base preset to start from (default `"default"`) |
| `position` | `"center"` \| `"top"` \| `"bottom"` | screen anchor |
| `width`, `height` | number (0..1) | box size as a fraction of the screen |
| `preview` | `true` \| `false` \| `"right"` \| `"below"` | preview placement, or `false` to hide the pane regardless of content |
| `preview_ratio` | number (0..1) | fraction of the box given to the preview pane |
| `prompt` | `"top"` \| `"bottom"` | filter-line position within the results pane |

---

## yuke.tui.overlay

Overlays are floating nodes drawn over the root, for modals, pickers, and
the permission prompt. A custom picker is just an `overlay.open` over a
`paint` leaf.

```lua
local ov = yuke.tui.overlay.open(
  yuke.tui.layout.leaf(my_paint_handle),
  { anchor = "center", width = 60, height = 12, border = true, title = "Details" }
)
-- ov:close()
```

| Function | Notes |
|---|---|
| `overlay.open(node, opts) -> handle` | `opts`: `anchor` (`"center"` \| `"top"` \| `"bottom"`), `width`, `height`, `border`, `title` |
| `handle:close()` | dismiss the overlay |

---

## yuke.tui.notify and small helpers

| Function | Notes |
|---|---|
| `yuke.tui.notify(text)` | transient footer notice (the same as `actions.notify`) |
| `yuke.tui.redraw()` | request a repaint (a no-op; a redraw follows every event) |
| `yuke.tui.reload()` | stub (re-run bundled + user `init.lua`) |
| `yuke.tui.version` | the TUI version string |

---

## Worked example: a minimal user overlay

A user file that keeps the bundled transcript / composer but replaces the
statusline with a custom paint leaf and rebinds a couple of keys.

```lua
-- ~/.yuke/tui/init.lua  (runs after the bundled default)

local status = yuke.tui.paint.register(function(slice, ctx)
  slice:fill(nil, " ", "statusline")
  local s = ctx.session
  local left = s and (" " .. s.title .. " ") or " (no session) "
  slice:put(0, 0, left, "statusline")
  local right = s and string.format("%s · %s · %s ", s.model, s.reasoning, s.permission) or ""
  slice:put(slice.width - #right, 0, right, "statusline.model")
  if ctx.turn.active then slice:put(slice.width // 2, 0, "● streaming", "accent") end
end)

yuke.tui.set_root(yuke.tui.layout.rows {
  yuke.tui.layout.leaf(status,         { size = 1 }),
  yuke.tui.layout.leaf("transcript",   { grow = 1 }),
  yuke.tui.layout.leaf("composer",     { size = 3, min = 1, max = 8 }),
})

yuke.tui.keymap.set("*", "<C-o>", function(ctx)
  yuke.tui.picker {
    title     = " model ",
    layout    = "simple",
    source    = ctx.models,
    format    = function(m) return (m.name:gsub("^.*/", "")) end,
    match     = function(m) return m.name end,
    on_select = function(m) yuke.tui.actions.set_model(m.name) end,
  }
end)
```

## Running it

```sh
yuke-tui                                  # connect to 127.0.0.1:7878
yuke-tui 192.168.1.10:7878                # connect to a remote daemon
yuke-tui ws://host:port/ws                # full URL form
```

The CLI argument overrides `opts.daemon`. The client never blocks on
connection: if the daemon is down, the manager retries in the background and
the UI runs in a disconnected state. The first successful connect marks the
UI connected.
