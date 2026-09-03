# AI Assistant (ai-assistant)

Chat assistant for the Catalyst panel. It helps you configure game servers,
understand startup variables, inspect server files, and diagnose crashes from
logs you paste or files it reads through the panel's file tunnel.

## What it does

- **Server help**: lists your servers, shows startup command, environment
  variables, allocations and status, then explains what to change.
- **Log analysis**: paste console output into the chat, or let the assistant
  read log/config files itself (`logs/latest.log`, `server.properties`,
  `server.cfg`, ...). It cites the exact lines behind its diagnosis.
- **Guided fixes**: step-by-step remediation. File writes are **off by
  default** — the assistant explains the edit and you apply it, unless you
  explicitly enable writes in the plugin settings.

## Setup (panel owner)

1. Install the plugin (Admin → Plugins → Marketplace or upload the
   `.catpkg.zip`) and enable it.
2. Open the plugin's **Settings** and fill in your provider:
   - **Provider**: `openai-completions` (OpenAI, OpenRouter, Ollama, vLLM,
     any Chat Completions compatible endpoint), `openai-responses`, or
     `anthropic-messages`.
   - **Base URL**: e.g. `https://api.openai.com/v1`,
     `https://openrouter.ai/api/v1`, `https://api.anthropic.com/v1`,
     `http://localhost:11434/v1`.
   - **API key**, **model**, **context window**, **max output tokens**,
     **temperature**, **system prompt**.
3. Use **AI Assistant → Test connection** (or `POST /provider/test`) to
   verify the endpoint before chatting.
4. Open **Admin → AI Assistant** (all servers) or a **server → AI Assistant**
   tab (scoped to that server) and ask away.

## Safety model

- The API key lives in server-side plugin config and is never returned to
  the browser (`GET /status` only reports whether a key is set).
- Every chat route requires an authenticated user with `server.read`.
  File reads additionally require `file.read`; file writes require both the
  `allowFileWrites` setting **and** the user's `file.write` permission.
- Server database writes are not performed: the scoped plugin DB only
  permits `status` changes, so configuration help is advisory (exact
  key/value steps) plus optional file edits.
- Tool loops are capped (`maxToolIterations`), file reads are truncated
  (`maxFileReadKb`), and history is truncated to fit `contextWindowTokens`.
