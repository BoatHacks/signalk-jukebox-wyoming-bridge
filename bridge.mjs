#!/usr/bin/env node
// Bridges one Snapcast zone to one Wyoming voice satellite's speaker.
//
// Why this exists: a Wyoming satellite (e.g. espos-p4-cockpit's onboard
// ES8311) has no Snapcast client -- it only accepts audio framed as Wyoming
// `audio-start`/`audio-chunk`/`audio-stop` events over the TCP connection
// IT listens on and the orchestrator dials into (signalk-wyoming SPEC.md;
// espos_voice/wyoming_satellite.h's own header confirms this 1:1). This
// script is the translation layer: it joins a signalk-jukebox install's
// Snapserver as a normal named zone (so its existing volume/mute UI just
// works), and re-frames the decoded PCM it receives as Wyoming events
// toward the target satellite.
//
// Shape: `snapclient` does the Snapcast side (spawned as a child process,
// writing raw PCM to a FIFO via its `file` player backend -- confirmed live
// against a real snapclient build: `--player file:filename=<path>,mode=w`
// is a real, documented backend, not a guess). This script owns the
// Wyoming side, using signalk-wyoming's own protocol module (`/protocol`
// subpath export) rather than reimplementing wire framing.
//
// Verified so far: the Dockerfile builds and installs cleanly; the Wyoming
// handshake (describe/info/pause-satellite/audio-start/audio-chunk framing)
// is covered by test/handshake.test.ts against signalk-wyoming's own mock
// satellite server. NOT yet verified end-to-end against a real panel and a
// real Snapserver together -- do that before calling this more than a
// strong first draft.

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import {
  WyomingConnection,
  Describe,
  parseInfo,
  PauseSatellite,
  AudioStart,
  AudioChunk,
  AudioStop,
  Ping,
  parsePong,
} from "signalk-wyoming/protocol";

// Piper medium/high default -- matches WyomingSatelliteConfig::snd_rate's
// own default in espos_voice, used only if the satellite's `info` omits a
// snd program (it shouldn't; espos_voice always sends one).
export const FALLBACK_FORMAT = { rate: 22050, width: 2, channels: 1 };

// signed 16-bit PCM: 2 bytes/sample * channels.
export function bytesPerFrame(format) {
  return format.width * format.channels;
}

/**
 * Connect, describe, read `info`, extract the satellite's expected
 * playback format, and pause it (output-only -- this bridge never streams
 * a mic). Does NOT close the connection -- the caller reuses it for the
 * streaming session (a fresh describe-then-close would waste a reconnect
 * for no reason).
 */
export async function handshake(host, port, { timeoutMs = 5000 } = {}) {
  const conn = await WyomingConnection.connect(host, port, { timeoutMs });
  conn.write(Describe());
  let info;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("timed out waiting for info");
    const event = await conn.nextEvent(remaining);
    info = parseInfo(event);
    if (info !== undefined) break;
  }
  const format = info.snd?.[0]?.snd_format ?? FALLBACK_FORMAT;
  if (info.snd?.[0]?.snd_format === undefined) {
    console.warn(
      `${host}:${port} info had no snd program -- falling back to ` +
        `${FALLBACK_FORMAT.rate} Hz`,
    );
  }
  // run-satellite would arm push-to-talk on a client that has no PTT
  // button to hold -- pause-satellite is what espos_voice's own header
  // documents for "playback works either way, mic stays off the wire".
  conn.write(PauseSatellite());
  return { conn, format };
}

// signalk-jukebox's Snapserver streams are always stereo (confirmed live:
// every stream in its snapserver.conf.template is `sampleformat=*:16:2`).
// The `file` player backend cannot change channel count itself --
// confirmed live against a real snapclient build: `--sampleformat
// 22050:16:1` against a stereo source fails outright ("sampleformat
// channels must be * (= same as the source)"), unlike the `alsa` player,
// whose ALSA `plug`/`dmix` chain would otherwise absorb a mono target
// silently. So snapclient always decodes stereo here; downmixToMono below
// does the channel conversion this bridge actually needs (the satellite
// advertises channels:1 -- confirmed live against a real panel).
const SOURCE_CHANNELS = 2;

/** Average L/R into mono, 16-bit signed PCM. `pcm.length` must already be
 *  a whole number of stereo frames (the caller truncates for this). */
export function downmixToMono(pcm) {
  const frames = pcm.length / 4; // 2 channels * 2 bytes/sample
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = pcm.readInt16LE(i * 4);
    const r = pcm.readInt16LE(i * 4 + 2);
    out.writeInt16LE((l + r) >> 1, i * 2);
  }
  return out;
}

/** Spawn snapclient joining a Snapserver, decoding into the FIFO at the
 *  satellite's own advertised rate/bit-depth -- resampling happens here
 *  (snapclient's job). Channel count is `*` (keep the source's, always
 *  SOURCE_CHANNELS in practice -- see above); converted separately in
 *  main()'s FIFO handler if the satellite wants fewer. */
function spawnSnapclient({ snapcastHost, snapcastPort, fifoPath, bridgeId, format }) {
  const sampleformat = `${format.rate}:${format.width * 8}:*`;
  return spawn(
    "snapclient",
    [
      `tcp://${snapcastHost}:${snapcastPort}`,
      "--player",
      `file:filename=${fifoPath},mode=w`,
      "--sampleformat",
      sampleformat,
      "--hostID",
      bridgeId,
      "--logsink=stdout",
    ],
    { stdio: "inherit" },
  );
}

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const snapcastHost = requiredEnv("SNAPCAST_HOST");
  const snapcastPort = process.env.SNAPCAST_PORT || "1704";
  const wyomingHost = requiredEnv("WYOMING_HOST");
  const wyomingPort = Number(process.env.WYOMING_PORT || "10700");
  // Fixed Snapcast client id, NOT the display name -- same convention as
  // signalk-jukebox's own local-snapclient.ts (jukebox-local-snapclient).
  // Must be unique per bridge instance; whatever manages these as
  // containers is responsible for assigning one per satellite target.
  const bridgeId = requiredEnv("BRIDGE_ID");
  const fifoPath = "/tmp/bridge.pcm";

  const { conn, format } = await handshake(wyomingHost, wyomingPort);
  console.log(
    `paired with ${wyomingHost}:${wyomingPort}, streaming at ` +
      `${format.rate} Hz / ${format.width * 8}-bit / ${format.channels}ch`,
  );

  await rm(fifoPath, { force: true });
  await mkdir("/tmp", { recursive: true });
  // No native mkfifo in node:fs -- shelling out is the same approach
  // signalk-jukebox's own image/entrypoint.sh uses for its FIFOs.
  await new Promise((resolve, reject) => {
    const mk = spawn("mkfifo", [fifoPath]);
    mk.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`mkfifo exited ${code}`)),
    );
  });

  const snapclient = spawnSnapclient({
    snapcastHost,
    snapcastPort,
    fifoPath,
    bridgeId,
    format,
  });
  // Supervision, same reasoning as signalk-jukebox's own image/entrypoint.sh
  // wait -n fix: if snapclient dies, this whole process must exit so the
  // container exits and podman's restart:unless-stopped policy recreates a
  // clean instance -- a bridge silently holding a dead Wyoming connection
  // open while its Snapcast half is gone would be the same "looks Up, is
  // actually useless" failure mode that bit the main jukebox container.
  snapclient.on("exit", (code) => {
    console.error(`snapclient exited (${code}); exiting to restart cleanly`);
    process.exit(code === 0 ? 1 : code ?? 1);
  });

  conn.write(AudioStart(format));

  // Keepalive: espos_voice answers `ping` with `pong` but never pings US
  // (confirmed by reading wyoming_satellite.cpp) -- without this, a dead
  // TCP peer (panel reboot, Wi-Fi drop) is invisible until the OS's own
  // (very long) keepalive timeout fires. Fed into the same event stream
  // audio-chunk writes use, so no separate connection state to track.
  const pingTimer = setInterval(() => {
    if (!conn.closed) conn.write(Ping());
  }, 10_000);

  conn.on("event", (ev) => {
    if (parsePong(ev) !== undefined) return; // expected reply, nothing to do
  });

  conn.on("close", () => {
    console.error("satellite connection closed; exiting to reconnect cleanly");
    clearInterval(pingTimer);
    snapclient.kill();
    process.exit(1);
  });

  if (format.channels !== 1 && format.channels !== SOURCE_CHANNELS) {
    throw new Error(
      `satellite wants ${format.channels}ch; only 1 (downmixed) or ` +
        `${SOURCE_CHANNELS} (passthrough) are supported`,
    );
  }
  const fifo = createReadStream(fifoPath);
  // Truncate to whole SOURCE frames, not the satellite's target frame size
  // -- the FIFO always carries SOURCE_CHANNELS PCM regardless of what the
  // satellite wants (see spawnSnapclient above); downmixing happens after
  // truncation, never before.
  const sourceFrameSize = format.width * SOURCE_CHANNELS;
  fifo.on("data", (chunk) => {
    // Snapclient's `file` player writes whatever it decodes per callback;
    // truncate so a chunk boundary never splits a frame (parseAudioChunk
    // on the far end trusts payload_len).
    const usable = chunk.length - (chunk.length % sourceFrameSize);
    if (usable === 0) return;
    const pcm = chunk.subarray(0, usable);
    conn.write(
      AudioChunk(format, format.channels === 1 ? downmixToMono(pcm) : pcm),
    );
  });
  fifo.on("error", (err) => {
    console.error("FIFO read error:", err.message);
    process.exit(1);
  });

  process.on("SIGTERM", async () => {
    clearInterval(pingTimer);
    try {
      conn.write(AudioStop());
    } catch {
      // connection may already be gone; nothing left to clean up
    }
    conn.close();
    snapclient.kill();
    process.exit(0);
  });
}

// Only run when executed directly (`node bridge.mjs`) -- importing this
// module for tests must not immediately require env vars / spawn anything.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}
