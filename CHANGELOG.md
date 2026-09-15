# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
