---
title: Getting started
description: Install yuke, configure the model catalog, and run your first session.
---

yuke is a minimal CLI for running LLM agents against any OpenAI-compatible
endpoint. Configuration splits across three files in `~/.yuke/`:

- `providers.json`: the model catalog. JSON, edited with any tool, reloaded by
  the daemon on demand. No credentials.
- `auth.json`: the credential store, keyed by provider name. API keys,
  environment-variable names, or OAuth tokens written by `yuke login`. Mode
  `0600`.
- `init.lua` (optional): session policy, tools, hooks. Runs per session; merged
  with any workspace `.yuke/init.lua` overlay.

`providers.json` and `auth.json` are enough to start a session. `init.lua`
adds tools, a default model, and lifecycle hooks when you want them.

## Install

Build from source with Cargo:

```sh
cargo install yuke
```

This drops a `yuke` binary on your `PATH`.

## Configure the catalog

Create `~/.yuke/providers.json`:

```json
{
  "providers": [
    {
      "name": "openai",
      "base_url": "https://api.openai.com/v1",
      "models": [
        { "name": "gpt-4o" },
        { "name": "o3", "protocol": "codex" }
      ]
    }
  ]
}
```

## Configure credentials

Create `~/.yuke/auth.json` with one entry per provider you want to use:

```json
{
  "providers": {
    "openai": { "type": "api_key_env", "env": "OPENAI_API_KEY" }
  }
}
```

Three entry types are supported:

| `type`        | fields            | how it authenticates                                                       |
|---------------|-------------------|----------------------------------------------------------------------------|
| `api_key_env` | `env`             | reads the named environment variable at session-build time                 |
| `api_key`     | `key`             | literal API key stored on disk                                             |
| `oauth`       | token set         | written by `yuke login`; access tokens refresh in place and persist back   |

Set the key in your shell, never in the file:

```sh
export OPENAI_API_KEY="sk-..."
```

For ChatGPT OAuth instead of an API key:

```sh
yuke login            # opens the browser; defaults to the `openai` provider
```

This populates the `openai` entry in `auth.json` with the OAuth token set.
Tokens refresh automatically on use, so you log in once.

A provider with no usable credential in `auth.json` is dropped from the
catalog, so the models advertised to a client are exactly the ones a session
can be built on.

See [Provider catalog](/providers/) for the full `providers.json` schema and
[init.lua](/lua-config/) for `yuke.opts`, `yuke.tool`, and `yuke.on`.

## Run

Oneshot mode: run one turn in-process and exit. The session is persisted under
`~/.yuke/workspaces/`; pass `--resume` with its id to keep going.

```sh
yuke -p "summarize the files in this directory"
```

A bare `yuke` (no `-p`, no piped stdin) prints help. With piped input the
prompt is the stdin text:

```sh
echo "what is in Cargo.toml?" | yuke
```

`--output-format json` prints one result object carrying `session_id`, which
makes the resume loop scriptable:

```sh
id=$(yuke -p "start" --output-format json | jq -r .session_id)
yuke -p "keep going" --resume "$id"
```

A oneshot is headless, so it **auto-approves every tool call** the model makes
(including `yuke.exec` and `yuke.fs.write`); there is no interactive approval
prompt. Only run prompts you are willing to let your `init.lua` tools act on.

Daemon mode: a persistent, multi-client session server.

```sh
yuke daemon
```

The daemon binds `ws://127.0.0.1:7878/ws`, reads the same `providers.json` /
`auth.json` / `init.lua`, and persists sessions under `~/.yuke/workspaces/`, the
same store the oneshot uses, so it picks up oneshot-created sessions when it
indexes the store at startup. Any WebSocket client can connect.

## Next

- [CLI options](/cli/) covers every `yuke` and `yuke daemon` flag.
- [Local mode](/local-mode/) is the oneshot in depth: profiles, models, output.
- [Daemon mode](/daemon-mode/) covers the WebSocket endpoint, workspaces,
  profiles, and auth tokens.
- [Provider catalog](/providers/) covers the full `providers.json` schema.
- [init.lua](/lua-config/) is the full API for `init.lua`: session policy,
  tools, hooks.
- [Writing tools](/tools/) is a worked example of registering a tool the model
  can call.
