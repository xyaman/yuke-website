---
title: Provider catalog
description: 'providers.json: the model catalog yuke reads directly (no Lua).'
---

The model catalog lives in `~/.yuke/providers.json`: a JSON file the daemon
reads directly. Any program that can write JSON can add, edit, or remove
providers and models; the daemon re-reads the file on demand so an edit takes
effect for the next session and the next client connection without a restart.

`init.lua` is a separate, optional file for [session policy, tools, and
hooks](lua-config/). Credentials live in a third file, `~/.yuke/auth.json`,
keyed by provider name. The split is clean: data in JSON, behavior in Lua,
secrets in a `0600` auth file.

```json
{
  "providers": [
    {
      "name": "openai",
      "base_url": "https://chatgpt.com/backend-api/codex",
      "protocol": "codex",
      "models": [
        { "name": "gpt-5.5", "reasoning_levels": ["low", "medium", "high"] }
      ]
    },
    {
      "name": "minimax",
      "base_url": "https://api.minimax.io/v1",
      "models": [
        { "name": "MiniMax-M3", "reasoning_split": true }
      ]
    }
  ]
}
```

A worked copy lives in
[`examples/providers.json`](https://github.com/xyaman/yuke/blob/main/examples/providers.json).

## Credentials live in `auth.json`, not here

Each provider's `auth.json` entry says how to authenticate; `providers.json`
names no keys. The three entry types:

| `type`        | fields            | how it authenticates                                                       |
|---------------|-------------------|----------------------------------------------------------------------------|
| `api_key_env` | `env`             | reads the named environment variable at session-build time                 |
| `api_key`     | `key`             | literal API key stored on disk                                             |
| `oauth`       | token set         | written by `yuke login`; access tokens refresh in place and persist back   |

```json
{
  "version": 1,
  "providers": {
    "openai":  { "type": "oauth", "access_token": "...", "refresh_token": "...", "expires_at_ms": 0, "account_id": "..." },
    "minimax": { "type": "api_key_env", "env": "MINIMAX_API_KEY" },
    "local":   { "type": "api_key", "key": "sk-..." }
  }
}
```

`auth.json` is written `0600`; OAuth tokens refresh transactionally in place so
concurrent refreshes cannot discard another provider's entry. A legacy
`api_key_env` field in `providers.json` is still honored when no matching
`auth.json` entry exists, with a deprecation warning, so old configs keep
working without modification.

A provider with no usable credential is dropped from the catalog, so the
models advertised to a client are exactly the ones a session can be built on.

## File shape

```text
{
  "providers": [
    { "name": "...", "models": [...] },
    ...
  ]
}
```

The top-level `providers` array is the only required key. An empty file
(`{}` or `{"providers": []}`) is valid: yuke will start with an empty catalog
and every `--model` flag will fail until you add one. A malformed file logs a
warning and yields an empty catalog rather than refusing connections.

## Provider fields

| field         | type     | default                       | notes                                                                |
|---------------|----------|-------------------------------|----------------------------------------------------------------------|
| `name`        | string   | required                      | prefix for catalog keys (`"provider/model"`)                         |
| `base_url`    | string   | `https://api.openai.com/v1`   | base URL of the provider's API                                       |
| `protocol`    | string   | `"completions"`               | `"completions"` \| `"codex"` \| `"anthropic"`; a model may override it |
| `models`      | array    | `[]`                          | models offered under this provider                                   |

The `name` field is also the `auth.json` lookup key.

## Model fields

| field                | type            | default       | notes                                                                                  |
|----------------------|-----------------|---------------|----------------------------------------------------------------------------------------|
| `name`               | string          | required      | catalog sub-key and provider model id (unless `model_id` is set)                       |
| `model_id`           | string          | `name`        | override for the model id sent in requests                                             |
| `protocol`           | string          | inherits provider's | per-model wire-protocol override (e.g. `codex` for an o-series model)             |
| `context_window`     | integer         | `null`        | tokens; reserved for the planned compaction feature                                    |
| `max_output`         | integer         | `null`        | tokens; reserved for compaction                                                        |
| `reasoning_split`    | boolean         | `false`       | add `reasoning_split: true` to requests (MiniMax M3)                                   |
| `temperature`        | number          | `null`        | per-model default temperature                                                          |
| `max_output_tokens`  | integer         | `null`        | per-model default output token cap                                                     |
| `reasoning_levels`   | array of strings | per-protocol | the levels the model accepts, lowest to highest; empty means the model has no knob     |

The fields marked informational are parsed but not yet acted on; they are
reserved for the planned compaction feature.

## Protocols

The `protocol` field selects the wire format yuke uses to talk to the
provider. The supported values:

- `"completions"`, the default: OpenAI's Chat Completions API. Used by OpenAI,
  MiniMax, and most OpenAI-compatible hosts.
- `"codex"`: the Responses-style API as spoken by the ChatGPT / Codex
  backend. Use this for `o3` and other reasoning models on OpenAI.
- `"anthropic"`: Anthropic's Messages API.

The protocol name accepts both short (`"completions"`) and canonical
(`"openai_completions"`) spellings. Set `protocol` on the provider for all of
its models, or override per-model with a model-level `protocol` field.

## Reasoning levels

`reasoning_levels` is the set of levels a model accepts (e.g.
`["low", "medium", "high"]`), advertised to clients so a frontend can offer a
picker. Omit it to inherit the protocol's default set — these differ by
backend, since the Codex backend and the OpenAI API accept different levels:

| protocol      | default levels                              |
|---------------|---------------------------------------------|
| `completions` | `minimal`, `low`, `medium`, `high`          |
| `codex`       | `low`, `medium`, `high`, `xhigh`            |
| `anthropic`   | none (no effort knob)                       |

An empty array (`"reasoning_levels": []`) means the model has no reasoning
knob. A session starts at the **middle** level of the set unless the profile's
`yuke.opts{ reasoning_effort = ... }` names one the model offers, or a client
forces one via `SessionConfig.reasoning` / `--reasoning`. The chosen level is
saved with the session and clamped to the model's set when the model is
switched.

## A worked catalog

```json
{
  "providers": [
    {
      "name": "openai",
      "base_url": "https://api.openai.com/v1",
      "models": [
        { "name": "gpt-4o" },
        { "name": "gpt-4o-mini" },
        {
          "name": "o3",
          "protocol": "codex",
          "reasoning_levels": ["low", "medium", "high"]
        }
      ]
    },
    {
      "name": "anthropic",
      "base_url": "https://api.anthropic.com/v1",
      "protocol": "anthropic",
      "models": [
        { "name": "claude-sonnet-4-5" }
      ]
    }
  ]
}
```

This declares two providers with a mix of completion-only models and one
reasoning model on the codex protocol.
