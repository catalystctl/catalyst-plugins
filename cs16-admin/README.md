# CS 1.6 Server Admin

Live management tab for Counter-Strike 1.6 (HLDS / ReHLDS) servers.

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

## How it works

- Reads use the panel's existing console history (`GET /api/servers/:id/logs`)
  and live stream (`GET /api/servers/:id/console/stream`). No extra agent
  protocol is needed.
- Writes go through the plugin backend (`/api/plugins/cs16-admin/...`),
  which validates every command against an allowlist and forwards it as
  `console_input` through the WebSocket gateway. Writes require
  `console.write`, `server.write` or `admin.write` on the requesting user.
- Bans and action history persist in plugin collections (`cs16_bans`,
  `cs16_actions`, `cs16_settings`), so they survive restarts.
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
