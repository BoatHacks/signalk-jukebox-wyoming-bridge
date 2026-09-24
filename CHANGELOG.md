# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.10] - 2026-09-24

### Fixed

- Found live on halpi2 running 0.1.9: the Salon zone went
  stuck-disconnected again -- confirmed via Snapserver's own
  `Server.GetStatus`, queried directly, that `cockpit-panel` really was
  `connected: false` -- but this time `podman logs` showed *zero* new
  lines for roughly 7 hours straight, not even the "Client.GetStatus
  failed"/"disconnected N times" messages the 0.1.8/0.1.9 watchdogs
  should have logged within a couple of poll cycles of the disconnect.
  Instrumented and reproduced locally against both a fully black-holed
  `connect()` and a connection that accepts writes but never replies
  (the two closest real-world proxies for what actually happened): in
  both cases `ControlConnection.call()`'s own timeout fires reliably in
  ~3s regardless of socket state, confirming neither existing watchdog
  can actually get stuck waiting on a `Client.GetStatus` response.
  Whatever wedged the real poll loop for 7 hours therefore did so at a
  level neither watchdog can see (most likely an event-loop stall from
  some other cause -- e.g. a blocking `stdout` write against a stalled
  log pipe, which `podman logs` alone can't rule out). This is the
  fourth distinct connection-zombie incident here (0.1.7: `snapclient`
  crash-exit, 0.1.8: this bridge's own control connection stale, 0.1.9:
  `snapclient`'s data connection stale), and each of the first three
  needed its own bespoke detector for its own specific connection, so
  rather than add a fifth guess, this adds a detector that assumes
  nothing about the cause: an independent watchdog that only checks
  whether the poll loop itself is still ticking (via a heartbeat
  recorded unconditionally as the very first thing the loop's callback
  does, before any `await`), and force-exits the process if it stops --
  the same "give up and let the container restart us" fallback
  `nextRapidExitState` already relies on for `snapclient`'s own crash
  loop. Regression-tested in `test/poll-stall-watchdog.test.ts`.

## [0.1.9] - 2026-09-22

### Fixed

- Found live on halpi2 immediately after deploying 0.1.8: switching the
  Salon zone's Snapcast source from `MusicAndAlerts` to the silent
  `Alerts` stream sometimes left the zone stuck at `connected: false`
  -- confirmed directly against Snapserver's own `Server.GetStatus`
  that it genuinely considered the `cockpit-panel` client disconnected.
  Unlike the 0.1.8 bug, this was not the bridge's own control
  connection going stale: `podman top` showed `snapclient`'s process
  still alive, its logs ran cleanly right up to the disconnect and then
  stopped, and `snapclient`'s own audio-data TCP connection to
  Snapserver had gone stale/dead without the process exiting or
  logging anything -- so neither the exit-triggered respawn (0.1.7)
  nor the 0.1.8 control-connection watchdog (a separate TCP connection
  with no visibility into `snapclient`'s own) had anything to react
  to. Confirmed `snapclient` itself exposes no keepalive/timeout/
  reconnect CLI flag (`snapclient -h`) that could have been passed
  instead. Snapserver's control API already knows the truth, so the
  existing `Client.GetStatus` poll (already used for zone-mute state)
  now also checks the response's `connected` field and force-respawns
  just `snapclient` (not the whole control connection) after
  `CLIENT_DISCONNECT_RESPAWN_THRESHOLD` (3) consecutive polls report it
  disconnected, gated on having seen it connected at least once so this
  can never fire during normal startup. Regression-tested in
  `test/client-disconnect-respawn.test.ts`.

## [0.1.8] - 2026-09-21

### Fixed

- Recreating (not restarting) the sibling `signalk-jukebox` plugin's
  Snapserver container (`podman rm -f` + a fresh container, as opposed
  to `podman restart`) left this bridge's `snapclient` holding a stale
  TCP connection to the now-gone server forever -- no exit, no error,
  no new log lines, the container itself reporting `Status: running`
  the whole time, and the zone stuck at `connected: false` until
  someone manually restarted the bridge's container. `snapclient`
  itself never noticed the disconnect, so the existing exit-triggered
  respawn logic (added in 0.1.7 for a different, unrelated crash) never
  had anything to react to. The bridge's own `Client.GetStatus` polls
  over its Snapserver control connection DO notice, though (either the
  poll times out against the same kind of stale connection, or -- once
  the control connection itself redials successfully -- Snapserver
  replies "client not found" because `snapclient` never re-registered):
  after any prior successful poll, `CONTROL_FAILURE_RESPAWN_THRESHOLD`
  (3) consecutive poll failures now force both the control connection
  and `snapclient` to redial from scratch, rather than sitting on the
  stale connection indefinitely. Reproduced live on halpi2 (`podman rm
  -f sk-jukebox` while the bridge was running); regression-tested here
  with a mock control-API server that goes silent mid-connection
  without closing it (`test/control-reconnect.test.ts`).

## [0.1.7] - 2026-09-17

### Fixed

- Switching a zone onto a Snapcast stream with a different native
  sample rate than whatever `snapclient` is currently decoding (e.g.
  signalk-jukebox's AirPlay input, forced to 44100:16:2 while every
  other stream there is 48000:16:2) reliably crashed `snapclient`
  outright when it tried to reconfigure its resampler -- a normal,
  expected consequence of a routine zone reassignment, not a real
  failure. The old exit handler treated it exactly like a genuine
  failure and killed the whole bridge process, relying on the
  container's `restart:unless-stopped` policy to recover -- worse
  given a separate, confirmed bug in `signalk-container-helper` where
  that policy isn't actually applied to the container at all, this
  meant a single zone-source switch could silently and permanently
  kill the panel's audio. `snapclient` now respawns in place instead,
  bounded so 5 rapid (<3s) crashes in a row still falls back to the
  original fatal-exit behavior rather than respawning forever.
  Confirmed live: repeatedly switching a zone between "jukebox" and
  "airplay" reproduces the exact same crash, but the bridge now
  recovers on its own within seconds instead of requiring a manual
  container restart.

## [0.1.6] - 2026-09-16

### Fixed

- `package.json` had no `"files"` field, so the npm tarball shipped
  `Dockerfile`, `.github/workflows/`, `test/`, and `vitest.config.ts`
  alongside the actual runtime file `bridge.mjs`. Added
  `"files": ["bridge.mjs", "entrypoint.sh"]` so only what the container
  actually runs ships (5 files, 13KB, down from 11 files, 18KB).

## [0.1.5] - 2026-09-16

### Fixed

- No code change. The first manual `npm publish` (required to bootstrap
  npm's trusted-publisher chicken-and-egg) was accidentally run against
  a stale `0.1.3` checkout, publishing `0.1.3` to npm while ghcr.io's
  image was already at `0.1.4`. This release resyncs npm with ghcr.io
  and is the first version published via the now-registered OIDC
  trusted publisher, with no manual `npm publish` step.

## [0.1.4] - 2026-09-15

### Added

- CI (`ci.yml`): test suite plus a build-only Dockerfile validation on
  every push/PR.
- Release automation (`publish.yml`): on a published GitHub release,
  publishes to npm (OIDC trusted publishing) and builds + pushes the
  multi-arch image to
  `ghcr.io/boathacks/signalk-jukebox-wyoming-bridge`, tagged `:latest`
  and with the release's own version -- the same convention
  `signalk-jukebox`'s own `publish.yml` uses, matching
  `signalk-jukebox`'s `wyomingBridges` settings (`tag: "auto"` resolves
  to `:latest`).

## [0.1.3] - 2026-09-15

### Fixed

- The mute poller now holds one persistent connection to Snapserver's
  control API for the process lifetime instead of reconnecting every
  2s. Fixes the `(ControlSessionTCP) Error while reading from control
  socket: End of file` log line Snapserver logged on every single
  short-lived control connection closing (the 0.1.2 `end()` vs
  `destroy()` attempt didn't actually help -- confirmed live Snapserver
  logs that either way). Reconnects lazily on the next call after any
  disconnect, so a Snapserver restart still needs no separate retry
  loop.

## [0.1.2] - 2026-09-15

### Fixed

- The bridge no longer crashes when a zone is switched to a stream with
  no active source (e.g. `Alerts` with nothing currently pushing
  announcement audio into it). Confirmed live: that stream delivers
  literally nothing -- not even comfort-silence padding -- so the
  silence-in-arriving-data detector added in 0.1.1 never fired (no
  `data` event to inspect), and after 110s of total silence
  `snapclient`'s own internal watchdog did a Stop/reopen cycle and the
  process died anyway. A second, independent watchdog now resets on
  every FIFO `data` event regardless of content and sends `audio-stop`
  after 3s of literally nothing arriving, closing the gap the
  content-based detector doesn't cover.
- Minor: `controlCall`'s socket close on a completed request now uses
  `end()` instead of `destroy()` (more correct for a request that
  actually finished, though confirmed live it does not silence
  Snapserver's own "(ControlSessionTCP) ... End of file" log line on a
  short-lived control connection either way -- a real fix needs a
  persistent control connection reused across polls, left for later).

## [0.1.1] - 2026-09-15

### Fixed

- The bridge now sends an explicit `audio-stop` when Mopidy pauses/stops
  or the zone is muted, instead of leaving `audio-start` open
  indefinitely. Confirmed live this was a real bug, not just wasteful:
  after a sustained gap with nothing relayed, `snapclient`'s `file`
  player did a Stop/reopen cycle and the whole process then died,
  dropping the bridge's Wyoming connection with it.
- Two triggers, since neither alone covers both cases (confirmed live):
  an idle/no-data timeout does NOT fire on pause -- `snapclient`'s file
  player keeps writing fixed-size comfort-silence frames continuously
  even with nothing playing, so absence-of-data never happens. Detecting
  near-silence in the decoded PCM itself (2 s hold) does. Muting doesn't
  stop chunks arriving either (Snapcast's client-side mixer silences PCM
  upstream of the player), so a separate 2 s poll of the zone's mute
  state via `Client.GetStatus` reacts to that immediately rather than
  waiting out the silence hold on top.
- Fixed a start/stop flap introduced while chasing the above: an early
  version called `startStream()` unconditionally on every chunk,
  including comfort-silence, so the stream immediately restarted right
  after every silence-triggered stop.

## [0.1.0] - 2026-09-15

### Added

- Initial scaffold: `bridge.mjs` joins a signalk-jukebox Snapserver as a
  named zone (via a spawned `snapclient` writing to a FIFO through its
  `file` player backend) and re-frames the decoded PCM as Wyoming
  `audio-start`/`audio-chunk`/`audio-stop` events toward a target voice
  satellite, using `signalk-wyoming`'s own protocol module.
- Playback format (rate/bit-depth) discovered from the satellite's
  `describe`/`info` handshake rather than hardcoded; stereo-to-mono
  downmixing when the satellite advertises `channels: 1` (`snapclient`'s
  `file` player cannot change channel count itself).
- Container-level supervision: the bridge exits if `snapclient` dies (and
  vice versa via the Wyoming connection closing), so an orchestrating
  restart policy recreates a clean instance rather than the failure going
  unnoticed.
- Protocol-level test suite against `signalk-wyoming`'s mock satellite
  server (handshake, format discovery/fallback, audio framing).
- Build-tested and live-tested end to end against a real signalk-jukebox
  install and a real espos-p4-cockpit panel.
