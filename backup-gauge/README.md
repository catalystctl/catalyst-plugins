# Backup Gauge (backup-gauge)

Adds a **backup storage gauge** to the server detail header, in the same row as
CPU, memory, disk and network:

```
CPU 3%   MEMORY 1.3 GB / 6.0 GB   DISK 0 MB / 90 GB   BACKUP 52 GB / 128 GB   NETWORK ...
```

The reading is `used / allocated`, matching the per-server backup storage
allocation (`Server.backupAllocationMb`) the panel already enforces when a
local backup is created. When a server has no allocation the gauge shows the
used total on its own instead of a ratio.

## Who sees it

The gauge declares `requiredPermissions: ['backup.read']` on its slot
component, so the host decides visibility per viewer: owners, subusers and
roles that can read this server's backups see it, and nobody else gets an
empty cell. The plugin exposes no permission of its own — the reading *is*
backup data, so a token of its own would only have hidden the gauge from the
people who can already see the numbers.

## Why a plugin

A backup gauge is not something every panel wants in its header, and the row
is a deliberately fixed, comparable set of readings. The plugin API exposes a
`server-header-stats` slot for exactly this: with the plugin disabled or
uninstalled the header is byte-for-byte what it was before.

## What it reads

- **Backup usage** — `GET /api/servers/:id/backups`, with the signed-in user's
  session. The plugin declares **no permissions** and never touches the
  database; the reading is exactly what the viewer is already allowed to see
  in the Backups tab. The host hides the gauge from viewers without
  `backup.read`; if the read fails anyway (revoked mid-session, panel
  unreachable) the gauge hides itself and retries later.
- **Allocation** — passed by the host through the slot's `componentProps`
  (`{ serverId, serverStatus, backupAllocationMb }`), the same allocation the
  DISK and MEMORY readings use.
- **Settings** — `GET /api/plugins/backup-gauge/config`, which returns the
  resolved config values below.

Usage is re-read on a timer (default 60s) and immediately when you switch
servers. The panel rate-limits the backup list to 30 requests per minute, so
`refreshSeconds` is clamped to at least 15. A read that fails (no permission,
panel unreachable) hides the gauge and retries every 5 minutes rather than once
a minute per open tab.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `refreshSeconds` | 60 | How often the gauge re-reads usage (15–3600) |
| `warnPercent` | 80 | Usage percent at which the reading turns amber |
| `criticalPercent` | 90 | Usage percent at which the reading turns red |

## Requirements

- Catalyst 1.83.0 or newer: the `server-header-stats` slot, the
  `requiredPermissions` gate on slot components, and the plugin store
  bootstrap for non-admins all ship in that release. On 1.82.x the plugin is
  refused at discovery (`catalystVersion`).
- The gauge counts at most 1000 backups per refresh (10 pages of 100). Servers
  beyond that report a lower bound; the tooltip says so.
- The frontend is compiled into the panel image from this repository, so it
  uses the panel's React and Tailwind tokens. A marketplace install without a
  compiled copy has no `frontend.mjs` bundle and renders nothing.
