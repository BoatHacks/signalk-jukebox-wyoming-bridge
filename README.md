# signalk-jukebox-wyoming-bridge

Bridges a [signalk-jukebox](https://github.com/BoatHacks/signalk-jukebox)
Snapcast zone to a [Wyoming](https://github.com/rhasspy/wyoming) voice
satellite's speaker -- e.g. an
[espos-p4-cockpit](https://github.com/BoatHacks/espos-p4-cockpit) panel's
onboard speaker, which has no Snapcast client of its own.

## Why

A Wyoming satellite only accepts audio framed as `audio-start`/
`audio-chunk`/`audio-stop` events over the TCP connection it listens on
(the orchestrator dials *in* to the satellite -- see
[espos-p4-cockpit's `wyoming_satellite.h`](https://github.com/BoatHacks/espos-p4-cockpit/blob/master/espos/components/espos_voice/include/espos_voice/wyoming_satellite.h)
and [signalk-wyoming's SPEC.md](https://github.com/BoatHacks/signalk-wyoming/blob/main/SPEC.md)).
It has no Snapcast client. This bridge joins the jukebox's Snapserver as a
normal named zone (so the jukebox's existing volume/mute UI works
unmodified) and re-frames the decoded PCM as Wyoming events toward the
target satellite.

```
Snapserver  --(Snapcast protocol)-->  snapclient (this image)
                                            |
                                    file player -> FIFO
                                            |
                                       bridge.mjs
                                            |
                              (Wyoming audio-start/chunk/stop)
                                            v
                                    Wyoming satellite
```

## Configuration

| Env var         | Required | Default | Meaning |
|------------------|----------|---------|---------|
| `SNAPCAST_HOST`         | yes      |         | Host of the jukebox's Snapserver |
| `SNAPCAST_PORT`         | no       | `1704`  | Snapserver's stream port |
| `SNAPCAST_CONTROL_PORT` | no       | `1705`  | Snapserver's JSON-RPC control port (used to poll this zone's mute state) |
| `WYOMING_HOST`          | yes      |         | Target satellite's IP/host |
| `WYOMING_PORT`          | no       | `10700` | Target satellite's Wyoming port |
| `BRIDGE_ID`             | yes      |         | Fixed Snapcast client id for this bridge instance -- must be unique per bridge if running more than one (one per satellite target) |

Playback format (sample rate, bit depth) is discovered automatically from
the satellite's own `describe`/`info` handshake, not hardcoded. Channel
count is handled by downmixing: Snapcast streams are always stereo;
`snapclient`'s `file` player backend cannot itself convert channel count
(confirmed live -- `sampleformat channels must be * (= same as the
source)`), so `bridge.mjs` downmixes stereo to mono itself when the
satellite advertises `channels: 1`.

### Stop/start behaviour

The bridge sends an explicit `audio-stop` -- not just a lull in
`audio-chunk`s -- whenever there's nothing worth relaying, and a fresh
`audio-start` when real audio resumes:

- **Mopidy paused/stopped**: detected as sustained near-silence in the
  decoded PCM (snapclient's `file` player keeps writing fixed-size
  comfort-silence frames even with nothing playing -- confirmed live
  that waiting for the FIFO to go quiet outright never fires). A 2 s
  hold avoids chopping the stream on a single quiet passage or a
  one-chunk blip.
- **Zone muted** (via signalk-jukebox's own volume/mute UI, or any
  Snapcast client): polled every 2 s via `Client.GetStatus` on
  Snapserver's control port and reacted to immediately, since a mute
  doesn't stop chunks arriving -- Snapcast's client-side mixer silences
  the decoded PCM upstream of the player, so the silence-detection path
  above would eventually also catch it, but only after its 2 s hold
  window on top of whatever the mute poll's own interval already cost.

Both were confirmed live against a real panel and a real Snapserver,
including that an earlier draft without this got the pause case wrong in
two different ways before landing here (see CHANGELOG).

## Status

Build-tested and live-tested end to end against a real
`signalk-jukebox` Snapserver and a real `espos-p4-cockpit` panel
(SomaFM radio audibly playing through the panel's speaker). Not yet
wired into `signalk-jukebox`'s own container-management code (it runs
today as a standalone container you point at a satellite by hand) --
see `signalk-jukebox`'s `local-snapclient.ts` for the shape that
integration would likely take.

## License

Apache-2.0
