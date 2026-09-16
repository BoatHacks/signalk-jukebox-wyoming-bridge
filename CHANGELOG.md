# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
