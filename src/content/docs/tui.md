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
| `yuke.tui.*` (this) | inside the TUI client | `~/.yuke/tui/init.lua` | layout, paint, input scopes, theme, events, client commands |

The TUI VM has **no** `fs` / `exec` / `http` / `tool` and no agent hooks; it is
a view layer. The two share only the `mlua` dependency.

## The model: state in, actions out

Every paint callback, hook, and input handler receives a read-only **`ctx`**
describing current state. The only way to change anything (send a turn, scroll,
switch model, edit the composer, answer a prompt) is to call a
**`yuke.tui.actions.*`** verb. Paint callbacks must be pure: read `ctx`, write
cells, no side effects.

```lua
-- declare a key binding, read state from ctx, mutate state through actions
yuke.tui.input.scope("insert", {
  inherit = "global",
  text    = "composer",
  keys = {
    ["<CR>"] = function(ctx)
      if ctx.input.text ~= "" then
        yuke.tui.actions.send()      -- sends the composer as a user turn
      end
    end,
  },
})
```

A buggy config can therefore garble the *view* but can never corrupt a turn or
desync the protocol: every state change goes through `yuke.tui.actions.*`.

## Layers and boot

The TUI's Lua config is built from two layers, run in one VM in order:

1. **Bundled default** — embedded in the binary, sets the theme, the root
   layouts (the dashboard with the bull logo, the session view with the
   statusline / transcript / composer), the standard input scopes, the bundled
   pickers, and the built-in client commands. Ships so the TUI is fully
   usable with no user config.
2. **User overlay** — `~/.yuke/tui/init.lua` (optional), runs after the default
   and can extend it (add a sidebar, rebind keys, register commands, add
   custom pickers) or replace it wholesale (`yuke.tui.set_root(...)` with a
   fresh tree).

The bundled default boots in `dashboard` scope (the startup screen) and
transitions to `insert` on attach. Setting `yuke.tui.opts.vim = true` loads
the bundled `runtime/vim.lua`, which adds a `normal` scope reachable with
`<Esc>`, with vim motions, operators, and edits on the composer. Every binding
is plain `input.scope`/`input.extend`, so vim is just the bundled default,
not a hardcoded mode.

---

## yuke.tui.opts

Client-level options. Set each field with a single assignment; an unknown
field errors at that line, mirroring the daemon's `yuke.opts`. The bundled
default sets values first, so a user file only overrides what it cares about.
Calling `yuke.tui.opts{ ... }` is no longer supported.

```lua
yuke.tui.opts.daemon         = "127.0.0.1:7878"
yuke.tui.opts.vim            = false                      -- modal composer + vim motions
yuke.tui.opts.start_scope    = "insert"
yuke.tui.opts.working_label  = "working…"
yuke.tui.opts.working_frames = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }
yuke.tui.opts.scroll_lines   = 2                          -- rows per mouse-wheel notch
yuke.tui.opts.border         = "rounded"                  -- inherited window-border style
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `daemon` | string | `"127.0.0.1:7878"` | `host:port` or a full `ws://` / `wss://` URL. A CLI positional argument overrides this. |
| `vim` | bool | `false` | when `true`, loads the bundled vim bindings (`runtime/vim.lua`); the composer is modal with vim motions and edits |
| `start_scope` | string | `"insert"` | the input scope the session view boots in (the dashboard always uses `"dashboard"`) |
| `working_label` | string | `"working…"` | label of the built-in `working` leaf |
| `working_frames` | string[] | the Braille dots | the spinner frames the `working` leaf cycles over time |
| `scroll_lines` | integer | `2` | rows one mouse-wheel notch scrolls; a small step stays smooth on trackpads that emit a burst per gesture. Raise it for a click wheel that emits one event per notch. |
| `border` | string \| table | `"rounded"` | the inherited window-border style every bordered node starts from; a charset name (`"rounded"` \| `"double"` \| `"thick"` \| `"single"`) or a `{ type, sides, style, title }` table. See [`yuke.tui.layout`](#yuketuilayout) for the table form. |

---

## The `ctx` state table

Handed to every paint callback, hook, input handler, and command handler.
**Read-only.** Read it, but mutate state only through `yuke.tui.actions.*`.

| Field | Type | Notes |
|---|---|---|
| `ctx.connected` | bool | daemon socket up |
| `ctx.scope` | string | active input scope after modal / overlay / focus routing (e.g. `"global"`, `"insert"`, `"picker"`, an overlay's `input`) |
| `ctx.base_scope` | string | the input scope the session or dashboard selected (the "real" mode, before an overlay pushes its own) |
| `ctx.pending_chord` | string | the in-progress multi-key chord (e.g. `"g"` after a bare `g`), for the footer's showcmd; `""` when none |
| `ctx.notice` | string | the transient footer notice (a fault or hint), `""` when none |
| `ctx.focus` | string | id of the focused region (`"composer"`, an overlay id, ...) |
| `ctx.size` | table | screen dimensions `{ width, height }` |
| `ctx.input` | table | composer: `{ text = <string>, lines = <string[]>, cursor = { row, col } }` — `text` is the full buffer joined by `\n`; `lines` is the logical lines; `cursor` is the logical (0-based) position |
| `ctx.scroll` | table | `{ offset, at_bottom }` — `offset` is rows above the bottom, `at_bottom` is `true` when the transcript is pinned to the latest |
| `ctx.turn` | table | `{ active, queued, elapsed_ms, tokens, spinner, thinking }`: whether a turn is in flight, queued user messages behind it, milliseconds elapsed, token count, the spinner frame counter, and whether the model is in a reasoning ("thinking") block |
| `ctx.session` | table? | focused session: `{ id, model, reasoning, permission, title, workspace, message_count }`; `nil` before attach |
| `ctx.workspace` | table? | focused session's workspace: `{ id, root, title }`; `nil` before attach or when the workspace is unknown |
| `ctx.sessions` | `Session[]` | every live session, for a Lua `picker(spec)` source |
| `ctx.workspaces` | `Workspace[]` | every open workspace, for a Lua `picker(spec)` source |
| `ctx.profiles` | `string[]` | profile names advertised by the daemon, for a Lua `picker(spec)` source |
| `ctx.models` | `Model[]` | advertised catalog, for a Lua `picker(spec)` source: `{ name, protocol, reasoning_levels, default_reasoning }` |
| `ctx.commands` | `Command[]` | every registered client command, for a command-palette picker: `{ name, desc }` |
| `ctx.theme.get(name)` | function | resolves a named style to a `{ fg, bg, bold, italic, ... }` table (the same as `yuke.tui.theme.get`); mirrors `style` lookups so a paint callback can read styles |
| `ctx.message_count` | integer | (paint only) the number of messages available to this paint call |
| `ctx.messages()` | function | (paint only) returns an array of message view-models: `{ id, role, text, reasoning, tool_calls, tool_call_id, streaming }` |
| `ctx.message(i)` | function | (paint only) returns the 1-based indexed message, or `nil` |

The `ctx.message_count` / `ctx.messages()` / `ctx.message(i)` triplet is only
attached to a paint callback's `ctx`; other handlers do not see it. A paint
leaf that does not read messages pays nothing: the arrays are built on the
first call, not eagerly.

---

## yuke.tui.actions

The verbs. Every state change goes through one of these. They are safe to call
from input handlers, commands, and hooks; they update local UI state and / or
send a `ClientMessage` / `EngineCommand` to the daemon.

### Conversation

| Action | Maps to | Notes |
|---|---|---|
| `actions.send(text?)` | `EngineCommand::UserMessage` | sends the given text, or the composer's contents when omitted; queues if a turn is in flight. The first message on a new session also carries a `ClientInfo` (taken from the bundled `init` table) and the `SessionInit` on the wire. Explicit text leaves the composer untouched. |
| `actions.cancel()` | `EngineCommand::Cancel` | interrupt the in-flight turn |
| `actions.set_model(name)` | model switch on next send | sticky; an identical value clears any staged switch |
| `actions.set_reasoning(level)` | reasoning switch | must be offered by the active model |
| `actions.set_permission_mode(mode)` | `EngineCommand::SetPermissionMode` | `"strict"` \| `"normal"` \| `"yolo"`; an unknown mode errors at the call site |
| `actions.set_max_rounds(n?)` | `EngineCommand::SetMaxRounds` | `n > 0` sets the per-turn round cap live; `nil` or non-positive means unlimited |
| `actions.eval(code)` | `EngineCommand::Eval` | run an arbitrary Lua snippet against the session's engine VM (requires the session's `allow_eval` opt); the result returns as an `eval_result` event |
| `actions.permit(id, allow, remember?)` | answers the pending tool-permission prompt | `id` is accepted for forward compatibility; the app tracks one prompt at a time, so it answers that one. `remember` defaults to `false`. |
| `actions.attach(id)` | focus a session by id | fetch `History`, start reconciling its firehose |
| `actions.new_session(opts?)` | opens a new session | `opts`: `{ path?, profile?, model?, reasoning?, system?, permission? }`. The client mints the session id; the daemon materializes the session on the first `UserMessage`. Missing fields fall back to the launch workspace and current defaults. |
| `actions.remove_session(id)` | `RemoveSession` | close the session on the daemon side |
| `actions.run_command(name, args?)` | run a registered client command | invokes the command registered via `yuke.tui.cmd.register`; `args` is a Lua array of positional strings, each surfaced as `args[i]` to the handler |
| `actions.browse()` | open the filesystem browser | a directory-picker overlay on the daemon host; the chosen folder is passed to `actions.new_session({ path = ... })` (or whichever hook the bundled default installs) |
| `actions.copy(text?)` | copy to the clipboard | copies `text` to the local clipboard via OSC 52 (works over SSH and inside tmux). With no argument, copies the current transcript selection |
| `actions.select_clear()` | drop the transcript selection | cancels the in-progress mouse drag, if any |

### Composer (local edits)

The composer's cursor and buffer are local UI state — no daemon round-trip.

| Action | Effect |
|---|---|
| `actions.composer.newline()` | insert a literal newline (the composer is multiline) |
| `actions.composer.insert(text)` | insert text at the cursor, honoring embedded newlines (a paste) |
| `actions.composer.set(text)` | replace the composer buffer with `text`, cursor at the end |
| `actions.composer.clear()` | empty the composer buffer and drop any in-flight history recall |
| `actions.composer.move(where)` | `"left"` \| `"right"` \| `"word_left"` \| `"word_right"` \| `"home"` \| `"end"` \| `"up"` \| `"down"` (readline-style) |
| `actions.composer.delete(kind)` | `"char_back"` \| `"char"` \| `"word_back"` \| `"word"` \| `"line"` \| `"to_end"` \| `"to_start"` (readline-style) |
| `actions.composer.motion(m)` | vim motion: `"h"` \| `"l"` \| `"j"` \| `"k"` \| `"0"` \| `"^"` \| `"$"` \| `"w"` \| `"W"` \| `"b"` \| `"B"` \| `"e"` \| `"E"` \| `"gg"` \| `"G"` (the modal editor's cursor, only used under `opts.vim = true`) |
| `actions.composer.op(operator, motion)` | vim operator over a motion: `operator` in `"d"` \| `"c"` \| `"y"`, e.g. `op("d", "w")`; doubled (`"dd"`, `"cc"`, `"yy"`) operates on the line. The `c` operator leaves the cursor in insert mode. |
| `actions.composer.edit(e)` | one-key vim edits: `"x"` \| `"X"` \| `"D"` \| `"p"` \| `"P"` \| `"u"`, `"redo"`, plus the insert-entry keys `"a"` \| `"A"` \| `"I"` \| `"o"` \| `"O"` \| `"C"` (which enter insert). `"u"` undoes; `"redo"` re-applies a previously undone edit. |
| `actions.composer.history(dir)` | recall submitted inputs: `"prev"` \| `"next"` |

The motion / op / edit verbs exist so a custom `normal` input scope can drive
the built-in modal editor; the bundled vim bindings are just these wired to the
usual keys. They are no-ops when `opts.vim = false`.

### View / navigation

| Action | Effect |
|---|---|
| `actions.scroll(delta)` | scroll the transcript by `delta` rows (negative = up) |
| `actions.scroll_to(where)` | `"top"` \| `"bottom"` |
| `actions.notify(text)` | transient footer notice (the same as `yuke.tui.notify`) |
| `actions.back()` | return to the dashboard / session picker |
| `actions.redraw()` | request a repaint (a no-op; a redraw follows every event) |
| `actions.quit()` | tear down and exit |
| `actions.reload()` | re-run bundled + user `init.lua`, rebuilding the Lua runtime |

### Input scope, focus, and overlays

These live on sub-tables so the top-level `actions.*` namespace stays free of
naming collisions with a user's verbs. A buggy handler is treated as a
non-fatal notice (like Neovim) — it never tears down the runtime.

| Action | Effect |
|---|---|
| `actions.input.set_base(name)` | switch the base input scope (the equivalent of the old top-level `actions.mode(name)`) |
| `actions.input.focus(id)` | focus a layout leaf by its `focus.id` |
| `actions.input.focus_next()` | cycle to the next focusable leaf |
| `actions.input.focus_prev()` | cycle to the previous focusable leaf |
| `actions.picker.move(delta)` | move the picker highlight by `delta` rows |
| `actions.picker.accept()` | confirm the current row (`Enter`) |
| `actions.picker.close()` | dismiss the picker (`Esc`) |
| `actions.picker.delete()` | delete the filter character under the cursor |
| `actions.browser.move(delta)` | move the browser highlight by `delta` rows |
| `actions.browser.descend()` | enter the highlighted directory |
| `actions.browser.parent()` | go up one level |
| `actions.browser.open()` | open the highlighted directory as a workspace |
| `actions.browser.close()` | dismiss the browser (`Esc`) |
| `actions.browser.delete()` | delete a filter character |

---

## yuke.tui.input

Declarative input scopes. Each scope is a self-contained bundle of
key bindings plus the rules for handling text input, mouse capture, and
parent inheritance. A bound key in a scope shadows that scope's default
text handling; an unbound printable key in a text-input scope (`text = "composer"`)
falls through to the composer.

```lua
yuke.tui.input.scope("insert", {
  inherit = "global",
  text    = "composer",
  paste   = "composer",
  keys = {
    ["<CR>"] = function(ctx)
      if ctx.input.text ~= "" then yuke.tui.actions.send() end
    end,
    ["<C-c>"] = { run = function() yuke.tui.actions.cancel() end, desc = "cancel turn" },
  },
})
```

| Function | Notes |
|---|---|
| `input.scope(name, spec)` | declare or replace a scope. `spec` keys: `inherit` (a parent scope name), `chords` (bool, accumulate multi-key bindings), `capture` (bool, intercept lower mouse so the root layout does not steal it), `text` / `paste` (target: a built-in name like `"composer"` / `"picker_filter"` / `"browser_filter"`, a function, or `false` to disable), and `keys` (the `{ [chord] = fn | { run, desc } }` table). |
| `input.extend(name, bindings)` | add bindings to an existing scope. Errors if the scope is unknown — declare it with `input.scope` first. |
| `input.bindings(scope?)` | discovery: return an array of `{ scope, lhs, desc }` rows for one scope, or every scope when `scope` is `nil` |

**Scopes** at boot: the app starts in `"dashboard"`, transitions to
`opts.start_scope` (default `"insert"`) on attach. `"normal"` is reachable
with `<Esc>` under `opts.vim = true`. The bundled default declares `global`,
`dashboard`, `picker`, `browser`, `permission`, and `insert`; the vim layer
adds `normal`. Lua may define more and switch with
`actions.input.set_base(name)`.

**Inheritance** is single-parent: a scope with `inherit = "global"` looks up
unbound chords in `global`. The validator rejects cycles at load.

**Chord syntax** matches the daemon-adjacent convention: printable keys bare
(`j`, `G`), modifiers bracketed (`<C-x>`, `<M-x>`, `<S-Tab>`, `<CR>`, `<Esc>`,
`<BS>`, `<Tab>`, `<Up>`, `<F5>`). Multi-key chords (`gg`, `<leader>q`) require
`chords = true` on the scope and use a pending-chord timeout; insert mode
defaults to `chords = false` so a literal `<` typed into the composer is
never read as the start of a `<C-x>` chord.

---

## yuke.tui.layout

Declare the region tree for a view. A leaf's `widget` is a **component
handle** — a paint handle returned by `yuke.tui.paint.register`, or one of
the bundled modules registered under `package.preload`. Bare name strings
are no longer accepted: there is one home for "the transcript leaf" and it
is `require("yuke.tui.components.transcript")`.

Install the session-view tree with `set_root` and the dashboard tree with
`set_dashboard`.

```lua
local L = yuke.tui.layout
local statusline = require("yuke.tui.components.statusline")
local footer     = require("yuke.tui.components.footer")
local transcript = require("yuke.tui.components.transcript")
local working    = require("yuke.tui.components.working")
local composer   = require("yuke.tui.components.composer")

yuke.tui.set_root(
  L.rows {
    L.leaf(statusline, { size = 1 }),
    L.leaf(transcript, { grow = 1 }),
    L.leaf(working,    { fit = true }),
    L.leaf(composer,   { fit = true, border = { sides = "top" }, focus = { id = "composer" } }),
    L.leaf(footer,     { size = 1 }),
  }
)
```

| Node | Signature | Notes |
|---|---|---|
| `L.rows{ ... }` | children stacked top-to-bottom | a.k.a. vertical split |
| `L.cols{ ... }` | children left-to-right | a.k.a. horizontal split |
| `L.leaf(handle, opts?)` | `handle: ComponentHandle` | a paint handle from `yuke.tui.paint.register` or a module required from `yuke.tui.components.*` |
| `yuke.tui.set_root(node)` | install / replace the session view | call again to swap the whole UI |
| `yuke.tui.set_dashboard(node)` | install / replace the dashboard | the screen shown before a session is attached; defaults to the bull-logo layout |

**Sizing opts** on any child: `size` (fixed rows / cols), `grow` (flex weight,
default `1` when no `size`), `min`, `max`, `fit` (collapse to a natural
content extent, queried from the app).

**Border opts** on any child: a charset string (`"rounded"` \| `"double"` \|
`"thick"` \| `"single"`), `true` / `false` to inherit / drop, or a
`{ type, sides, style, title }` table. Each field is optional; missing fields
inherit from `opts.border` (the global default).

| Border field | Type | Notes |
|---|---|---|
| `type` | string | one of `"rounded"` (default), `"double"`, `"thick"`, `"single"` |
| `sides` | string | `"all"` (default), `"top"`, `"bottom"`, `"left"`, `"right"`, `"none"` |
| `style` | string | a theme style name for the line; defaults to the `"border"` style |
| `title` | string | a title shown in the top edge |

**Padding opts** on any child: a scalar (all four sides), or a
`{ top, right, bottom, left }` table with `x` / `y` shorthands.

**Focus opts**: a `L.leaf` may declare `{ focus = { id = "...", scope = "..." } }`
to make it a focus target. `id` is required; `scope` (optional) ties the
leaf to an input scope, so a scope that is active while the leaf is
focused delivers its text events here. A leaf without `focus` is never
focused and the focus keys (`<M-h>` / `<M-l>`) skip it.

**Bundled components** — six require-able modules, all usable as leaves,
indistinguishable from a `paint.register` handle:

| Module | Renders |
|---|---|
| `yuke.tui.components.statusline` | brand, session title / model / reasoning / permission, queued count, or `offline` |
| `yuke.tui.components.transcript` | the scrolling conversation: user / assistant / tool blocks, **live token streaming** (text and reasoning), tool calls and results, mouse selection |
| `yuke.tui.components.working` | the spinner + `opts.working_label` + elapsed time while a turn runs; collapses to zero height when idle (give it `{ fit = true }`) |
| `yuke.tui.components.composer` | the multiline input box: soft-wrap, logical-line cursor, up / down history recall of submitted inputs |
| `yuke.tui.components.logo` | the bull, the name, the entry menu (icon, label, key), centered |
| `yuke.tui.components.footer` | a transient notice, then the scope hint and in-progress chord |

The statusline, logo, and footer are painted in Lua; the transcript,
working indicator, and composer are rendered in Rust, but the bundled
`init.lua` and a user config treat them identically. A user config can
reuse, restyle, or replace any of them. See [UI components](tui-components/)
for the convention and how to write your own.

---

## yuke.tui.paint

Register a callback that paints a leaf. The callback runs once per frame
while its leaf is visible, receiving a **slice** (the leaf's cell rectangle)
and `ctx`. The default statusline, logo, and footer are built this way;
see [UI components](tui-components/) for the component convention and
how to write or replace one.

```lua
local hud = yuke.tui.paint.register(function(slice, ctx)
  slice:clear()
  local s = ctx.session
  slice:line(0, {
    { " " .. (s and s.model or "no session") .. " ", "statusline.model" },
    { ctx.turn.active and "  ● streaming" or "", "accent" },
  })
end)

-- a paint handle is a leaf handle; place it in the layout:
yuke.tui.set_root(yuke.tui.layout.rows {
  yuke.tui.layout.leaf(hud,      { size = 1 }),
  yuke.tui.layout.leaf(require("yuke.tui.components.transcript"), { grow = 1 }),
  yuke.tui.layout.leaf(require("yuke.tui.components.composer"),   { size = 3, focus = { id = "composer" } }),
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
| `slice:line(row, spans)` | a styled line: `spans` is `{ { text, style }, ... }`. Each span may be a positional `{ text, style }` (1-based) or a `{ text = ..., style = ... }` table. |
| `slice:fill(rect?, ch?, style?)` | fill a sub-rect (or the whole leaf) with `ch` (default `" "`) and `style` |
| `slice:clear()` | reset the leaf to the theme background |

`style` is either a **theme style name** (string, e.g. `"assistant"`,
`"border"`) or an inline `{ fg, bg, bold, italic, ... }` table (see
`yuke.tui.theme`). `rect` is `{ col, row, width, height }`.

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
| `theme.set(spec)` | `spec`: `{ palette, styles }`; merges over the current theme. Unknown color specs are ignored, so a typo doesn't blow away the palette. |
| `theme.use(name)` | switch to a bundled colorscheme: `"default"` (the shipped look) or `"yuke-dark"`. Unknown names error with the available list. |
| `theme.list()` | the bundled colorscheme names |
| `theme.get(name)` | resolve a named style to a concrete `{ fg, bg, bold, ... }` table (or `nil` for unset fields) |

**Style table** fields: `fg`, `bg` (a `#rrggbb`, a palette key, a named
terminal color, or `"none"` to clear), and the booleans `bold`, `italic`,
`underline`, `reverse`, `dim`, `strikethrough`.

---

## yuke.tui.transcript

Settings for the built-in `transcript` widget. Set each field with a single
assignment; an unknown field errors at that line, mirroring `yuke.tui.opts`.

```lua
yuke.tui.transcript.gap       = 1                  -- blank rows between messages
yuke.tui.transcript.labels    = { user = "you", assistant = "assistant" }
yuke.tui.transcript.reasoning = "show"             -- "show" | "collapse" | "hide"
yuke.tui.transcript.highlight = function(message)
  -- return a theme style name (or nil) to paint the message's card background
  if message.streaming then return "selection" end
end
```

| Field | Type | Notes |
|---|---|---|
| `gap` | integer | blank separator rows between messages (default `1`) |
| `labels` | table | `{ user = <string>, assistant = <string> }`; either side may be omitted to keep the current label |
| `reasoning` | string | `"show"` (label + body, default), `"collapse"` (label only), or `"hide"` |
| `highlight` | function \| nil | called per message with `{ role, text, streaming }`; return a theme style name (or `nil`) to paint that message's full-width card background. A broken hook is ignored for the line. |

---

## yuke.tui.format

Override how the transcript renders tool-call lines and tool-result bodies.
Assign a function to one of the two fields; the built-in summary returns when
the field is `nil` or the function returns `nil`. A formatter error renders
as a visible notice (`⚠ format.tool_call error: ...`) in place of the line,
so a broken formatter is obvious without spamming the action queue on every
redraw.

```lua
yuke.tui.format.tool_call = function(call)
  -- call: { id, name, arguments, running }
  return string.format("[%s] %s(%s)", call.name, call.name, call.arguments)
end

yuke.tui.format.tool_result = function(result)
  -- result: { name, content, lines, chars }
  return string.format("⮑ %s (%d lines)", result.name, result.lines)
end
```

| Field | Signature | Default | Notes |
|---|---|---|---|
| `tool_call` | `(call) -> string?` | `"→ name(args…)"` with a blinking `"●"` while running | `call`: `{ id, name, arguments, running }` |
| `tool_result` | `(result) -> string?` | `⮑ name first-line (+N more lines)` | `result`: `{ name, content, lines, chars }`; `name` is the originating tool when known |

---

## yuke.tui.on

Subscribe to events. Handlers receive `(payload, ctx)` and may call actions.
The bundled default surfaces failures and connection loss as transient
notices; a user config can replace or supplement them.

```lua
yuke.tui.on("turn_error", function(payload)
  yuke.tui.notify(payload.message)
end)
```

The full event catalogue:

| Event | Payload | Source |
|---|---|---|
| `connect` | `{}` | `ServerMessage::Hello` — first connect, or after a reconnect |
| `disconnect` | `{}` | the daemon socket dropped (the manager reconnects in the background) |
| `message` | `{ role, text, client? }` | a committed user, assistant, or tool message. `client` is the originating client name on user messages. |
| `tool_call` | `{ id, name, arguments }` | the model invoked a tool |
| `permission_request` | `{ id, name, arguments }` | a tool is asking the user for approval; the bundled default draws a modal |
| `turn_done` | `{ rounds }` | the turn ended (assistant produced `Done`) |
| `turn_canceled` | `{}` | the turn was canceled mid-flight |
| `turn_error` | `{ message, code }` | `EngineEvent::Error`; the bundled default notifies |
| `model_changed` | `{ model }` | the session's model switched |
| `reasoning_changed` | `{ reasoning }` | the session's reasoning level switched |
| `permission_mode_changed` | `{ permission }` | the session's permission mode switched |
| `max_rounds_changed` | `{ max_rounds }` | the per-turn round cap was set; `0` means unlimited |
| `queued` | `{ position }` | a queued user message was added |
| `queue_canceled` | `{ id }` | a queued user message was canceled before it ran |

High-frequency events (per-token text deltas, per-tool-call lifecycle
internals) are not surfaced to Lua — the per-message hooks fire once per
committed message.

`yuke.tui.on(event, fn)` accepts any event name and records the handler;
unknown events still fire the handler at the next opportunity. Handlers
are scoped to the session, there is no unsubscribe (a `reload` re-runs
`init.lua` in a fresh VM, so handlers never accumulate).

---

## yuke.tui.cmd

Client-side command-palette commands. A `yuke.tui.cmd` runs in the TUI client
and drives the UI; it is not the daemon's `yuke.on` (the lifecycle hooks that
run in the engine, between turns). Invoke from an input scope (e.g. `:` in the
vim default), from `yuke.tui.actions.run_command(name, args?)`, or from the
bundled command palette (`yuke.tui.pickers.command(ctx)`).

```lua
yuke.tui.cmd.register("new", {
  desc    = "new session",
  handler = function(args, _ctx)
    yuke.tui.actions.new_session()
  end,
})
```

| Field | Type | Notes |
|---|---|---|
| `desc` | string | shown in the command picker |
| `handler` | `function(args, ctx)` | `args` is the array of positional strings the caller passed to `actions.run_command` (a 1-based Lua array; an empty table when called from an input handler); `ctx` is the read-only state table |

Every registered command shows up in `ctx.commands` (as `{ name, desc }`),
which the bundled command-palette picker uses as its source.

---

## yuke.tui.picker

A picker is a Telescope-style spec: a fuzzy-filtered list on the left with
a preview on the right or below. Rust runs the filter, selection, overlay,
and the live conversation preview; Lua owns the data, formatting, preview,
and the action. Built-in picker specs live on `yuke.tui.pickers.*`; a user
config can reuse them, override any field, or write its own.

### Bundled: `yuke.tui.pickers.*`

| Spec | Source | On select |
|---|---|---|
| `pickers.session(ctx)` | `ctx.sessions` (fuzzy on `workspace + title`), rows prefixed with the session's workspace shortened to its last two path components (`"projects/yuke > title"`), with a live conversation preview | attach |
| `pickers.model(ctx)` | `ctx.models` (fuzzy on the full `name`) | stage a model switch for the next send |
| `pickers.reasoning(ctx)` | the active model's `reasoning_levels` | stage a reasoning switch for the next send; notifies if the model has no reasoning knob |
| `pickers.command(ctx)` | `ctx.commands` with the command's `desc` as preview | run the command |

```lua
yuke.tui.input.extend("global", {
  ["<C-o>"] = function(ctx) yuke.tui.pickers.model(ctx) end,
  ["<C-p>"] = function(ctx) yuke.tui.pickers.command(ctx) end,
})
```

### Custom: `yuke.tui.picker(spec)`

```lua
yuke.tui.input.extend("dashboard", {
  s = function(ctx)
    yuke.tui.picker {
      title     = " sessions ",
      layout    = "default",
      source    = ctx.sessions,
      format    = function(s) return s.title .. "  " .. s.model end,
      match     = function(s) return s.title end,
      preview   = "conversation",
      on_select = function(s) yuke.tui.actions.attach(s.id) end,
    }
  end,
})
```

| Field | Type | Notes |
|---|---|---|
| `source` | array \| `function() -> array` | the items; built-in data comes off `ctx` (e.g. `ctx.sessions`, `ctx.models`, `ctx.workspaces`, `ctx.profiles`, `ctx.commands`) |
| `format` | `function(item) -> string` | the row label; defaults to `tostring(item)` |
| `match` | `function(item) -> string` | the fuzzy-match key; defaults to `format` |
| `preview` | `true` \| `"conversation"` \| `function(item, slice, ctx)` \| `false` / `nil` | the preview content: `true` / `"conversation"` stream `item.id`'s live conversation (the item must be a table with an `id`); a function paints the pane (a `slice`, as in `paint`); `false` / `nil` shows none |
| `on_select` | `function(item, ctx)` | runs on `Enter`; call `actions.*` to act |
| `title` | string | overlay title |
| `layout` | preset name \| table | the layout (see below); defaults to `"default"` |

Keys inside a picker: type to filter, `↑` / `↓` / `^p` / `^n` move, `Enter`
selects, `Esc` dismisses, `Backspace` deletes a filter character. The
bundled `picker` input scope (`capture = true`, `text = "picker_filter"`)
delivers the filter and the movement actions, so a custom picker with no
explicit `keys` is fully usable. The mouse wheel also moves the highlight
while a picker is open.

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

The renderer adapts the preview placement to the box size: a side preview
that is too narrow flips below (or drops), a bottom preview that is too short
flips beside (or drops), so neither pane becomes unusable at small terminal
sizes.

---

## yuke.tui.overlay

Overlays are floating nodes drawn over the root, for modals, pickers, and
the permission prompt. A custom picker is just an `overlay.open` over a
`paint` leaf.

```lua
local ov = yuke.tui.overlay.open(
  yuke.tui.layout.leaf(my_paint_handle),
  { anchor = "center", width = 60, height = 12, border = true, title = "Details", input = "modal" }
)
-- ov:close()
```

| Function | Notes |
|---|---|
| `overlay.open(node, opts) -> handle` | `opts`: `anchor` (`"center"` \| `"top"` \| `"bottom"`, default `"center"`), `width`, `height` (cells; default to 60% of the screen width and half the height), `border` (bool), `title` (string), `input` (string; a previously-declared input scope that becomes the active scope while the overlay is open, restored on close) |
| `handle:close()` | dismiss the overlay |

---

## yuke.tui.notify and small helpers

| Function | Notes |
|---|---|
| `yuke.tui.notify(text)` | transient footer notice (the same as `actions.notify`) |
| `yuke.tui.redraw()` | request a repaint (a no-op; a redraw follows every event) |
| `yuke.tui.reload()` | re-run bundled + user `init.lua` (the same as `actions.reload`) |
| `yuke.tui.log(...)` | append a line to the TUI's debug log (`~/.yuke/tui.log`). A full-screen app cannot log to stderr, so it goes to a file; failures are swallowed since this is a best-effort diagnostic. Multiple arguments are joined with spaces. |
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
  yuke.tui.layout.leaf(status,                          { size = 1 }),
  yuke.tui.layout.leaf(require("yuke.tui.components.transcript"), { grow = 1 }),
  yuke.tui.layout.leaf(require("yuke.tui.components.composer"),   { size = 3, min = 1, max = 8, focus = { id = "composer" } }),
})

yuke.tui.input.extend("global", {
  ["<C-o>"] = function(ctx) yuke.tui.pickers.model(ctx) end,
})

yuke.tui.on("turn_error", function(payload)
  yuke.tui.notify(payload.message)
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
UI connected and fires the `connect` event.
