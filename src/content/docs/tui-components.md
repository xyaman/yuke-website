---
title: UI components
description: How the default yuke-tui UI is built from Lua paint handles, how to reuse or replace a bundled component, and how to write your own.
---

A **component** is the unit the default UI is built from: one Lua file that returns
one paint handle, usable as a layout leaf. The bundled statusline, logo, and footer
are components (`yuke-tui/src/runtime/components/*.lua`); a user config can reuse,
restyle, or replace any of them, and you write your own the same way.

This guide assumes the primitives in [yuke.tui API](tui/): `yuke.tui.paint`
(the `slice`), the `ctx` state table, `yuke.tui.theme` (styles), and
`yuke.tui.layout` (the leaf tree). It only covers the component convention layered
on top.

## The model

A component is a module that registers a paint callback and returns its handle:

```lua
-- mycomponent.lua
return yuke.tui.paint.register(function(slice, ctx)
  slice:clear()
  slice:line(0, { { " hello ", "accent" } })
end)
```

That handle drops into a layout exactly where a built-in widget name would:

```lua
local mine = require("...")           -- or paint.register inline
yuke.tui.layout.leaf(mine, { size = 1 })
```

"State in, view out" still holds: a component only **reads** `ctx` and **draws**
to the `slice`. It never mutates app state; that is what `yuke.tui.actions.*` and
keymaps are for.

## The bundled components

Loaded by the host under `package.preload`, so they are ordinary modules:

| Module | Draws | Reads |
|---|---|---|
| `yuke.tui.components.statusline` | brand, session title/model/reasoning/permission, queued count, or `offline` | `ctx.connected`, `ctx.session`, `ctx.turn.queued` |
| `yuke.tui.components.logo` | the bull, the name, the entry menu (icon, label, key), centered | `ctx.theme` |
| `yuke.tui.components.footer` | a transient notice, then the mode hint and in-progress chord | `ctx.mode`, `ctx.pending_chord`, `ctx.notice` |

```lua
local statusline = require("yuke.tui.components.statusline")
local logo       = require("yuke.tui.components.logo")
local footer     = require("yuke.tui.components.footer")
```

`require` caches, so requiring a component twice returns the **same** handle (the
bundled `init.lua` and your config share one instance, which is fine: a handle can
be placed in more than one leaf).

The transcript, composer, and working indicator are still built-in leaves,
addressed by name (`"transcript"`, `"composer"`, `"working"`); they are not Lua
components yet.

## Using and replacing one

The bundled `init.lua` builds the default screens from the components:

```lua
local L = yuke.tui.layout
yuke.tui.set_root(L.rows {
  L.leaf(statusline,   { size = 1 }),
  L.leaf("transcript", { grow = 1 }),
  L.leaf("working",    { fit  = true }),
  L.leaf("composer",   { fit  = true, border = { sides = "top" } }),
  L.leaf(footer,       { size = 1 }),
})
```

A user `~/.yuke/tui/init.lua` runs **after** the bundle, so to swap a component you
call `set_root` / `set_dashboard` again with your own handle. To keep the existing
layout but replace one region, rebuild the tree with your handle in that slot:

```lua
-- Replace the dashboard centerpiece, keep the bundled statusline and footer.
local statusline = require("yuke.tui.components.statusline")
local footer     = require("yuke.tui.components.footer")

local brand = yuke.tui.paint.register(function(slice, ctx)
  slice:clear()
  slice:put(2, 1, "my yuke", "accent")
  slice:put(2, 3, #ctx.sessions .. " session(s)", "dim")
end)

yuke.tui.set_dashboard(yuke.tui.layout.rows {
  yuke.tui.layout.leaf(statusline, { size = 1 }),
  yuke.tui.layout.leaf(brand,      { grow = 1 }),
  yuke.tui.layout.leaf(footer,     { size = 1 }),
})
```

## Writing your own

A component is just a paint callback plus a layout slot. A worked example, a
right-aligned clock-style status field that also shows the turn state:

```lua
-- A 1-row status field. Read ctx, draw with the slice, return the handle.
return yuke.tui.paint.register(function(slice, ctx)
  slice:clear()

  -- Left: session model (or a placeholder), themed.
  local s = ctx.session
  slice:line(0, { { " " .. (s and s.model or "no session") .. " ", "statusline.model" } })

  -- Right: the turn state, right-aligned by measuring the text.
  if ctx.turn.active then
    local label = ctx.turn.thinking and "thinking" or "streaming"
    local text = "● " .. label .. "  "
    slice:put(slice.width - utf8.len(text), 0, text, "accent")
  end
end)
```

Patterns the bundled components use:

- **Spans on a row**: `slice:line(row, { {text, style}, … })` lays spans left to
  right from column 0. For anything not anchored at the left (centering, right
  alignment), measure with `utf8.len` and place with `slice:put(col, row, …)`.
- **Centering**: compute `col = (slice.width - width) / 2`; see `logo.lua`'s
  `put_centered` for a multi-span row.
- **Styles**: a theme name (`"dim"`, `"error"`, `"accent"`) keeps you themeable; an
  inline table (`{ fg = "#aa0000", bold = true }`) is a one-off. To embolden a
  named style, resolve it and set the flag: `local s = ctx.theme.get("accent"); s.bold = true`.
- **Sizing the leaf**: `{ size = N }` fixed rows, `{ grow = 1 }` flexible,
  `{ fit = true }` natural height (built-in leaves only for now). Add a window
  border with `{ border = { sides = "top", title = " x " } }`.

## Bundling components with a config

`require("yuke.tui.components.<name>")` resolves the **bundled** modules because the
host registers their sources under `package.preload` before any config runs. Your
own files are not on that path; load them however your config is organized, for
example by returning the handle from a file you `dofile`, or by registering your
own `package.preload` entry, then `require` it. The bundled set is the reference
implementation: read `yuke-tui/src/runtime/components/*.lua`.

## What a component cannot do

- It cannot mutate app state (send a turn, switch model, move the cursor): route
  those through `yuke.tui.actions.*` from a keymap or hook, not from paint.
- It only paints its own leaf rectangle; writes are clipped to the slice.
- It runs once per frame while visible, so keep it cheap and pure: read `ctx`,
  draw, return. Do not do I/O or block.