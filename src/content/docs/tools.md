---
title: Writing tools
description: Worked examples of model-facing tools built from yuke primitives.
---

These are the tools you'd actually register, built from the
[primitives](/primitives/). Drop them in `init.lua`, or split them across
files and `require` them. The model can call them like any other tool.

## edit (string replacement)

The canonical "update" tool. There is no `yuke.fs.edit` primitive on
purpose: finding `old` and splicing in `new` is pure string work, so it lives
in Lua.

> **Footgun:** don't use `string.gsub` here. `gsub` treats its pattern as a
> Lua pattern (so `.`, `%`, `-`, `(` are special) and its replacement has `%`
> escaping. For literal source-code edits use `string.find(s, old, 1, true)`
> (the `true` means a plain/literal search) and splice with `string.sub`.

```lua
-- Replace the single occurrence of `old` with `new`. Errors if `old` is
-- missing or appears more than once, unless replace_all is set.
local function replace(s, old, new, replace_all)
  local i, j = s:find(old, 1, true)
  if not i then return nil, "old_string not found" end
  if not replace_all and s:find(old, j + 1, true) then
    return nil, "old_string is not unique; add more context or set replace_all"
  end
  if replace_all then
    -- Literal replace of every occurrence, without Lua-pattern surprises.
    local out, pos = {}, 1
    while true do
      local a, b = s:find(old, pos, true)
      if not a then out[#out + 1] = s:sub(pos); break end
      out[#out + 1] = s:sub(pos, a - 1)
      out[#out + 1] = new
      pos = b + 1
    end
    return table.concat(out)
  end
  return s:sub(1, i - 1) .. new .. s:sub(j + 1)
end

yuke.tool {
  name        = "edit",
  description = "Replace an exact string in a file. old_string must be unique "
             .. "unless replace_all is true.",
  params = {
    path        = "string",
    old_string  = "string",
    new_string  = "string",
    replace_all = "boolean?",
  },
  handler = function(args)
    local content = yuke.fs.read(args.path)
    local updated, err = replace(content, args.old_string, args.new_string, args.replace_all)
    if not updated then return "error: " .. err end
    yuke.fs.write(args.path, updated)
    return "ok"
  end,
}
```

## read (with line numbers)

Line-numbered reads make `edit` targets unambiguous for the model.

```lua
yuke.tool {
  name        = "read",
  description = "Read a file. Optional 1-indexed line range.",
  params = { path = "string", start = "integer?", ["end"] = "integer?" },
  handler = function(args)
    local text = yuke.fs.read(args.path, args.start, args["end"])
    local out, n = {}, (args.start or 1)
    for line in (text .. "\n"):gmatch("(.-)\n") do
      out[#out + 1] = string.format("%6d  %s", n, line)
      n = n + 1
    end
    return table.concat(out, "\n")
  end,
}
```

## write

```lua
yuke.tool {
  name        = "write",
  description = "Create or overwrite a file with the given content.",
  params      = { path = "string", content = "string" },
  handler     = function(args)
    yuke.fs.write(args.path, args.content)
    return "wrote " .. #args.content .. " bytes"
  end,
}
```

## find (glob)

```lua
yuke.tool {
  name        = "find",
  description = "Find files by glob pattern, e.g. src/**/*.rs.",
  params      = { pattern = "string" },
  handler     = function(args)
    return table.concat(yuke.glob(args.pattern), "\n")
  end,
}
```

## bash

```lua
yuke.tool {
  name        = "bash",
  description = "Run a shell command and return its output.",
  params      = { command = "string" },
  handler     = function(args)
    local r = yuke.exec(args.command, { timeout_ms = 120000 })
    local out = r.stdout
    if r.stderr ~= "" then out = out .. "\n[stderr]\n" .. r.stderr end
    if r.timed_out then out = out .. "\n[timed out]" end
    return out
  end,
}
```

## Composing tools

Split larger setups across files and `require` them from `init.lua`:

```lua
-- ~/.yuke/init.lua
require("tools.read")
require("tools.edit")
require("tools.write")
require("tools.find")
require("tools.bash")
```

`require("tools.read")` resolves to `~/.yuke/tools/read.lua` (the workspace's
`.yuke/` for the workspace layer, or the config dir for the profile layer).
This keeps `init.lua` short and lets you version each tool's tests and
history independently.

## Hooks on top

The `yuke.on` listeners in [Lua configuration](/lua-config/#yukueon) gate or
audit these tools. A common pair:

```lua
-- refuse destructive shell commands.
yuke.on("before_tool", function(call)
    if call.name == "bash" and call.arguments.command:find("rm %-rf") then
        return { deny = "refusing to run 'rm -rf'" }
    end
end)

-- log every tool call.
yuke.on("tool_result", function(call, output)
    yuke.log(call.name .. " -> " .. #output .. " bytes")
end)
```
