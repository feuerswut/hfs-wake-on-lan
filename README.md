# Wake-on-LAN

Wake and monitor network devices from your HFS server. Send magic packets, check online status via ICMP ping, and manage devices through a responsive mobile-first dashboard.

## Requirements

- HFS 0.52.0+ (plugin API 8.65+)
- The HFS process should have permission to run the `ping` system command

## Configuration

Open the plugin settings from the HFS admin panel.

| Setting | Default | Description |
|---|---|---|
| Base Path | `/~/wake-on-lan` | URL where the dashboard is served |
| Allowed Users | *(all authenticated)* | Restrict access to specific HFS usernames. Leave empty to allow all logged-in users |
| Redirect URL | *(none)* | If set, unauthorized users are redirected here instead of receiving a 401/403 |
| Devices | *(empty)* | Device list — also manageable directly from the dashboard |

## Adding Devices

Devices can be added from the dashboard's **Add Device** form or directly in the HFS plugin config.

| Field | Required | Description |
|---|---|---|
| Name | Yes | Display name, e.g. `My Workstation` |
| MAC Address | Yes | Target device MAC, e.g. `AA:BB:CC:DD:EE:FF` |
| IP Address | No | Used for directed broadcast and ping. Without an IP, only Wake is available |
| WoL Port | No | UDP port for the magic packet. Default: `9` (also common: `7`) |
| Ping Port | No | TCP port to probe alongside ICMP ping. Shown as a port badge (e.g. `:445`, `:22`). Not required for online detection |
| SecureOn | No | 6-byte hex password for SecureOn-enabled NICs, e.g. `AABBCCDDEEFF` |

Devices are stored in the plugin config and persist across restarts. Adding or removing a device from the dashboard immediately updates the config.

## Online Detection

Clicking **Ping** (or **Refresh all**) runs two checks in parallel:

1. **ICMP ping** via the OS `ping` command — works on any reachable host regardless of open ports. This is the primary online/offline signal.
2. **TCP port probe** (optional) — if a Ping Port is configured, its open/closed state is shown as a badge next to the device. Either check being positive marks the device as online.

> **Note:** Devices without an IP address cannot be pinged. The status column shows `no ip` instead of an online/offline state, and the Ping button is hidden.

## Dashboard

### Device cards

Each device card shows:
- **Status dot** — grey (unknown/no ip), yellow pulsing (checking), green (online), dim (offline), red (error)
- **Name** and **MAC / IP address**
- **Port badge** — TCP probe result, desktop only
- **Ping** button — desktop only, hidden on mobile
- **Wake** button — sends the magic packet immediately
- **Delete** button (red trash icon) — removes the device with an **8-second undo** window

### Undo on delete

Deleting a device is non-destructive for 8 seconds. The device disappears from the list immediately, but the server request is held. An undo toast with a countdown bar appears — clicking **Undo** restores the device exactly where it was, including its last ping status.

### Auto-refresh

All pingable devices are checked automatically every 30 seconds (or manually click refresh all if its stuck).

## Security

- All API endpoints require authentication. Unauthenticated requests receive a `401` or `403` or are redirected.
- The ICMP ping uses `spawn()` with `shell: false` and a strictly validated IP (regex + octet range check) — the IP is passed as a plain argument array and never interpolated into a shell string.
- The `Ping Port` field is parsed as an integer before use; non-numeric input is rejected server-side.

## API

All endpoints are under the configured base path and require authentication.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/devices` | List all devices |
| `POST` | `/api/devices` | Add a device (persisted to plugin config) |
| `DELETE` | `/api/devices/:index` | Remove a device by index (persisted to plugin config) |
| `POST` | `/api/wake` | Send a magic packet |
| `POST` | `/api/ping` | Ping a device (ICMP + optional TCP probe) |

---

## Changelog

| Version | Changes |
|---|---|
| 1.2 | ICMP ping via OS `ping` command (primary); TCP port probe is optional badge |
| 1.1 | Add/remove devices via dashboard (persisted in plugin config); ping hidden when no IP; online status fixed |
| 1.0 | Initial release |
