# CS 1.6 Server Admin

Live management tab for Counter-Strike 1.6 (HLDS / ReHLDS) servers.

The tab is **opt-in per server**: opening it on a server that is not enabled
yet shows an "Enable for this server" prompt instead of the management UI.
The toggle also lives in the Match settings card, so non-CS servers never get
managed by accident. Command routes reject disabled servers with HTTP 403.

Each server gets a **CS 1.6 Admin** tab with:

- **Live players** — count plus name and SteamID, parsed from the `status`
  console dump. Refresh button sends `status` to the server console.
- **Chat feed** — live `say` / `say_team` messages parsed from console output,
  with team and dead badges, plus join and leave notices. Admin reply box
  sends `say` (or `amx_say` when AMX mode is on).
- **Rounds** — current map, round number, CT/T score and round history parsed
  from `World triggered Round_Start / Round_End`, `Team scored` and map lines.
- **Kick and ban** — per-player kick and ban buttons, timed bans
  (`banid` / `amx_ban`), unban (`removeid` / `amx_unban`), and a persistent
  ban list stored by the plugin.
- **Map and match control** — `changelevel` / `amx_map`, `sv_restart`,
  `mp_timelimit`, `mp_maxrounds`, `mp_winlimit`, `mp_freezetime`,
  `sv_password`, `hostname`, `mp_pause`-style pauses where supported.
- **Quick actions** — slap, slay, gag, mute via AMX when enabled, plus a
  validated raw-command box for everything else on the allowlist.
- **Audit log** — every action from this tab (kicks, bans, chat, map changes,
  cvars, raw commands, settings changes, RCON probes) is recorded with the
  admin who did it, filterable by user, action, text and date, with CSV export.

## How it works

- Reads use the panel's existing console history (`GET /api/servers/:id/logs`)
  and live stream (`GET /api/servers/:id/console/stream`). No extra agent
  protocol is needed.
- The tab stays live without manual refresh: chat, joins and rounds stream
  over console SSE, players re-query silently every 15 seconds, bans and
  header info every 20 seconds, and every kick, ban, map change, cvar, chat
  message and settings change broadcasts over the panel WebSocket
  (`plugin:cs16-admin:changed`) so all open tabs refetch instantly. The audit
  log polls every 15 seconds and reloads immediately on those broadcasts.
- Writes go through the plugin backend (`/api/plugins/cs16-admin/...`),
  which validates every command against an allowlist and sends it via the
  configured transport. Writes require `console.write`, `server.write` or
  `admin.write` on the requesting user.

## Command transport: RCON vs console input

- **RCON (recommended)** — the native GoldSrc remote-console protocol over UDP.
  Authenticated per command with a real response, so delivery is confirmed
  and `status` output comes straight back (the player list populates
  instantly instead of waiting for the console echo).
- **Console input** — the panel's standard `console_input` path, which writes
  to the game container's standard input. Zero configuration; used
  automatically whenever RCON is unavailable.

Transport mode per server: `auto` (RCON when a password is available,
otherwise console), `rcon` or `stdin`. The header shows which path is active.

To enable RCON, set `rcon_password` in `cstrike/server.cfg` — the plugin
detects it automatically through the file tunnel — or paste a password into
the tab's transport settings (stored server-side, never shown back). If the
panel reaches the server on a different address or port, override the RCON
host and port there too. The **Test RCON** button sends a harmless `version`
command and reports latency.
- Bans and action history persist in plugin collections (`cs16_bans`,
  `cs16_actions`, `cs16_settings`), so they survive restarts. The audit log
  keeps the newest 1000 entries per server. Admin usernames are resolved for
  the log, which needs the plugin's `user.read` scope (read-only).
- Optional `writeBansFile` config appends permanent bans to
  `cstrike/banned.cfg` via the file tunnel.

## Commands sent

Vanilla HLDS: `status`, `say`, `kick`, `banid`, `removeid`, `writeid`,
`changelevel`, `sv_restart`, `mp_*`, `sv_password`, `hostname`.

AMX Mod X (when `useAmx` is on): `amx_say`, `amx_chat`, `amx_kick`,
`amx_ban`, `amx_addban`, `amx_unban`, `amx_map`, `amx_slap`, `amx_slay`,
`amx_gag`, `amx_ungag`, `amx_pause`.

Use the raw-command box only for commands on the allowlist. RCON passwords
and filesystem commands are never accepted.
