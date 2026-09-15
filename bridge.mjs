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
// Verified: Dockerfile builds cleanly; the Wyoming handshake and audio
// framing are covered by test/handshake.test.ts against signalk-wyoming's
// mock satellite server; live-tested end to end against a real
// signalk-jukebox Snapserver and a real espos-p4-cockpit panel (audible
// SomaFM playback). One real bug found by that live test and fixed here:
// snapclient's `file` player cannot downmix channels itself ("sampleformat
// channels must be * (= same as the source)"), so this script downmixes
// stereo to mono when the satellite wants mono.
//
// Explicit stop/start, not "just let the stream idle": confirmed live that
// leaving audio-start open indefinitely through a Mopidy pause is not
// merely wasteful -- snapclient's file player did a Stop/reopen cycle
// after a sustained no-chunks gap and then the whole process died,
// dropping the bridge's Wyoming connection with it. Two independent
// triggers now send an explicit audio-stop instead of waiting for that:
// an idle timeout (no FIFO data -- covers Mopidy paused/stopped, where
// the source stream produces nothing at all, not silence) and the zone's
// own Snapcast mute state (polled via Client.GetStatus, same "poll, don't
// subscribe" pattern signalk-jukebox's own snapserver-client.ts already
// uses -- covers a real still-flowing-but-silenced stream, which an idle
// timeout alone would never catch since chunks keep arriving muted).

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
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

/** Mean absolute sample amplitude (0..32767) -- cheap loudness proxy used
 *  to tell real audio apart from snapclient's comfort-silence padding
 *  (confirmed live: exact all-zero frames, written continuously even
 *  through a Mopidy pause -- see main()'s silence-detection comment). */
export function meanAbsAmplitude(pcm) {
  const samples = pcm.length / 2;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += Math.abs(pcm.readInt16LE(i));
  return sum / samples;
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

/**
 * One request/response over Snapserver's control API -- a fresh
 * connection per call, not a persistent one: at a 2 s poll interval the
 * connect overhead is irrelevant, and this way a Snapserver restart never
 * needs its own reconnect logic (confirmed real: this is a raw
 * newline-terminated JSON-RPC socket, not HTTP, same as signalk-jukebox's
 * own snapserver-client.ts documents -- a bare POST to this port fails).
 */
function controlCall(host, port, method, params, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`control call ${method} timed out`));
    }, timeoutMs);
    socket.on("connect", () => {
      socket.write(JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }) + "\n");
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        const msg = JSON.parse(buf.slice(0, nl));
        if (msg.error) reject(new Error(msg.error.message ?? "RPC error"));
        else resolve(msg.result);
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Current muted state of one Snapcast client (our BRIDGE_ID). */
async function getClientMuted(host, port, clientId) {
  const result = await controlCall(host, port, "Client.GetStatus", { id: clientId });
  return Boolean(result?.client?.config?.volume?.muted);
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
  const controlPort = Number(process.env.SNAPCAST_CONTROL_PORT || "1705");
  const fifoPath = "/tmp/bridge.pcm";

  const { conn, format } = await handshake(wyomingHost, wyomingPort);
  console.log(
    `paired with ${wyomingHost}:${wyomingPort}, streaming at ` +
      `${format.rate} Hz / ${format.width * 8}-bit / ${format.channels}ch`,
  );

  // Whether we're between audio-start and audio-stop right now -- explicit
  // state, not inferred from "have we seen a chunk recently", so start/stop
  // each fire exactly once per transition regardless of which of the two
  // triggers below caused it.
  let streaming = false;
  function stopStream(reason) {
    if (!streaming) return;
    streaming = false;
    conn.write(AudioStop());
    console.log(`audio-stop (${reason})`);
  }
  function startStream() {
    if (streaming) return;
    streaming = true;
    conn.write(AudioStart(format));
    console.log("audio-start");
  }

  // Zone mute, polled rather than subscribed to -- Client.GetStatus is the
  // same call signalk-jukebox's own snapserver-client.ts uses, and this
  // bridge doesn't exist yet in Snapserver's client list until snapclient
  // (started below) has actually connected once, so the first few polls
  // are expected to fail -- that's fine, they just leave `muted` at its
  // last known value (false, initially).
  let muted = false;
  const muteTimer = setInterval(async () => {
    let nowMuted;
    try {
      nowMuted = await getClientMuted(snapcastHost, controlPort, bridgeId);
    } catch {
      return; // client not registered yet, or a transient control-API hiccup
    }
    if (nowMuted === muted) return;
    muted = nowMuted;
    console.log(`zone ${muted ? "muted" : "unmuted"}`);
    // Muting doesn't stop chunks arriving (Snapcast's client-side mixer
    // silences the decoded PCM upstream of the player, it doesn't stop the
    // stream) -- an idle timeout alone would never see this, so react here
    // immediately instead of waiting for one. Unmuting needs no action:
    // the FIFO handler below already gates on `muted` and will send a
    // fresh audio-start the moment real chunks are allowed through again.
    if (muted) stopStream("zone muted");
  }, 2000);

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
    clearInterval(muteTimer);
    clearTimeout(silenceTimer);
    snapclient.kill();
    process.exit(1);
  });

  if (format.channels !== 1 && format.channels !== SOURCE_CHANNELS) {
    throw new Error(
      `satellite wants ${format.channels}ch; only 1 (downmixed) or ` +
        `${SOURCE_CHANNELS} (passthrough) are supported`,
    );
  }

  // Silence detection, NOT "absence of data" -- confirmed live that
  // snapclient's file player keeps writing fixed-size comfort-silence
  // chunks continuously even while it logs "No chunks available" (a
  // Mopidy pause never actually stops the FIFO writes; the frames are
  // just all-zero). An earlier draft here waited for data to stop
  // arriving at all and never fired. meanAbsAmplitude below
  // SILENCE_THRESHOLD for SILENCE_HOLD_MS straight is what actually
  // means "nothing worth relaying" -- comfort-silence is exact digital
  // zero, so this threshold has wide headroom under even quiet real
  // music.
  const SILENCE_THRESHOLD = 50; // mean |sample|, out of a possible 32767
  const SILENCE_HOLD_MS = 2000;
  let silenceTimer = null;

  const fifo = createReadStream(fifoPath);
  // Truncate to whole SOURCE frames, not the satellite's target frame size
  // -- the FIFO always carries SOURCE_CHANNELS PCM regardless of what the
  // satellite wants (see spawnSnapclient above); downmixing happens after
  // truncation, never before.
  const sourceFrameSize = format.width * SOURCE_CHANNELS;
  fifo.on("data", (chunk) => {
    // Zone muted: Snapcast's client-side mixer already silenced this PCM
    // upstream of us, but there's no point relaying silence to the
    // satellite -- drop it here instead. (The mute poller above already
    // sent audio-stop on the transition; this just keeps us stopped for
    // as long as muted stays true.)
    if (muted) return;
    const usable = chunk.length - (chunk.length % sourceFrameSize);
    if (usable === 0) return;
    const pcm = chunk.subarray(0, usable);

    if (meanAbsAmplitude(pcm) < SILENCE_THRESHOLD) {
      // Keep relaying through the hold window -- only actually stop once
      // it's been silent this long straight, so a real quiet passage or a
      // one-chunk blip doesn't chop the stream. Deliberately does NOT
      // startStream() here: comfort-silence arriving while already
      // stopped must stay stopped -- calling it unconditionally caused an
      // immediate audio-start right back after every silence timeout
      // (confirmed live: start/stop flapping once a second).
      if (streaming && silenceTimer === null) {
        silenceTimer = setTimeout(() => {
          silenceTimer = null;
          stopStream("silence");
        }, SILENCE_HOLD_MS);
      }
    } else {
      if (silenceTimer !== null) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      startStream(); // no-op if already streaming
    }

    if (streaming) {
      conn.write(
        AudioChunk(format, format.channels === 1 ? downmixToMono(pcm) : pcm),
      );
    }
  });
  fifo.on("error", (err) => {
    console.error("FIFO read error:", err.message);
    process.exit(1);
  });

  process.on("SIGTERM", async () => {
    clearInterval(pingTimer);
    clearInterval(muteTimer);
    clearTimeout(silenceTimer);
    try {
      stopStream("shutdown");
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
