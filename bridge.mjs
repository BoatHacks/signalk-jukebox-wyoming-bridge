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
//
// snapclient is respawned in place on exit, not treated as always-fatal:
// confirmed live that switching this zone onto a Snapcast stream with a
// different native sample rate than whatever snapclient is currently
// decoding (e.g. signalk-jukebox's own AirPlay input, which Snapcast
// forces to 44100:16:2 while every other stream there is 48000:16:2)
// reliably crashes snapclient when it tries to reconfigure its resampler
// -- an expected, recoverable consequence of a normal zone reassignment,
// not a real failure. main()'s startSnapclient()/nextRapidExitState()
// bound this: enough rapid, repeated crashes still falls back to exiting
// the whole process (the original behavior) rather than respawning
// forever against a genuinely broken connection.

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

// A crash within this long of starting counts as "didn't really run" --
// e.g. a format-change crash happens near-instantly. Five of those in a
// row (not five ever) means something is genuinely broken (bad Snapserver
// host, corrupt binary, etc.), not a one-off reconfiguration hiccup --
// callers should fall back to a fatal exit rather than respawn forever.
export const RAPID_EXIT_THRESHOLD_MS = 3000;
export const MAX_CONSECUTIVE_RAPID_EXITS = 5;

/** Given how long the last snapclient run lasted and the current
 *  consecutive-rapid-exit count, returns the updated count and whether
 *  the caller should give up respawning. A run that lasted at least
 *  RAPID_EXIT_THRESHOLD_MS resets the count to 0 (treated as an
 *  unrelated, fresh failure), not just decremented -- one long-lived run
 *  between crashes means whatever caused the earlier ones is resolved. */
export function nextRapidExitState(ranMs, previousCount) {
  const count = ranMs < RAPID_EXIT_THRESHOLD_MS ? previousCount + 1 : 0;
  return { count, giveUp: count >= MAX_CONSECUTIVE_RAPID_EXITS };
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
 * One persistent connection to Snapserver's control API, reused across
 * calls instead of reconnecting per poll. Confirmed live that a fresh
 * connection per call -- the original design here, chosen specifically
 * to avoid needing reconnect logic -- has a real cost: Snapserver logs
 * "(ControlSessionTCP) Error while reading from control socket: End of
 * file" on every single short-lived connection closing, clean or not,
 * so a 2 s poll interval spammed that continuously. Reconnect logic is
 * unavoidable to actually fix it, so this class owns it: lazy connect on
 * first call(), and any close/error just drops the socket so the next
 * call() reconnects -- no separate background retry loop needed at a
 * 2 s poll cadence.
 */
export class ControlConnection {
  #host;
  #port;
  #socket = null;
  #buf = "";
  #nextId = 1;
  #pending = new Map(); // id -> {resolve, reject, timer}

  constructor(host, port) {
    this.#host = host;
    this.#port = port;
  }

  #ensureConnected() {
    if (this.#socket) return;
    const socket = net.connect({ host: this.#host, port: this.#port });
    this.#socket = socket;
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => this.#onDisconnect(new Error("control connection closed")));
    socket.on("error", (err) => this.#onDisconnect(err));
  }

  #onData(chunk) {
    this.#buf += chunk.toString("utf8");
    for (;;) {
      const nl = this.#buf.indexOf("\n");
      if (nl === -1) break;
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // malformed line -- drop it, the request that wanted it will time out
      }
      const waiter = this.#pending.get(msg.id);
      if (!waiter) continue; // unsolicited notification (e.g. Client.OnUpdate) -- not consumed here
      this.#pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(msg.error.message ?? "RPC error"));
      else waiter.resolve(msg.result);
    }
  }

  #onDisconnect(err) {
    this.#socket = null;
    this.#buf = "";
    for (const waiter of this.#pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.#pending.clear();
  }

  call(method, params, { timeoutMs = 3000 } = {}) {
    this.#ensureConnected();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`control call ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(JSON.stringify({ id, jsonrpc: "2.0", method, params }) + "\n");
    });
  }

  close() {
    this.#onDisconnect(new Error("control connection closed"));
    this.#socket?.destroy();
  }
}

/** Current muted state and Snapserver-side connected state of one Snapcast
 *  client (our BRIDGE_ID) -- one Client.GetStatus call serves both pollers
 *  below rather than duplicating the round trip. */
async function getClientStatus(control, clientId) {
  const result = await control.call("Client.GetStatus", { id: clientId });
  return {
    muted: Boolean(result?.client?.config?.volume?.muted),
    connected: Boolean(result?.client?.connected),
  };
}

// How many consecutive Client.GetStatus poll failures, after this bridge
// has already registered with Snapserver once, mean "the connection is
// dead", not "a transient hiccup". Gated on everSucceeded (see
// nextControlFailureState) because the FIRST few polls after startup are
// *expected* to fail -- our own snapclient hasn't connected to Snapserver
// yet -- and that must never itself count as a broken connection.
//
// Confirmed live on halpi2: `podman rm -f` on the sibling signalk-jukebox
// container (recreating, not restarting, its Snapserver) leaves this
// bridge's snapclient holding a stale TCP connection to the now-gone
// server -- no exit, no error, no new log lines, forever. snapclient's
// exit-triggered respawn (nextRapidExitState above) never fires because
// snapclient itself never notices. Client.GetStatus polls over our own
// ControlConnection DO notice, though, and promptly: either the poll
// itself times out against the same kind of stale connection, or (once
// ControlConnection's own reconnect dials the new container's control
// port successfully) Snapserver replies with a "client not found" error
// because our snapclient was never able to re-register. Either way, poll
// failures after a prior success are the one reliable signal this bridge
// has that Snapserver was swapped out from under it -- so this is the
// hook used to force both connections to redial, the same net effect a
// zone in signalk-jukebox proper gets for free by living in the same
// container as its Snapserver (restarting together).
export const CONTROL_FAILURE_RESPAWN_THRESHOLD = 3;

/** Given whether the latest Client.GetStatus poll succeeded, the current
 *  consecutive-failure streak, and whether any earlier poll ever
 *  succeeded, returns the updated streak/everSucceeded and whether the
 *  caller should force a reconnect. Pure so the threshold behaviour is
 *  unit-testable without a real Snapserver -- mirrors nextRapidExitState
 *  above. */
export function nextControlFailureState(succeeded, previousStreak, everSucceeded) {
  if (succeeded) return { streak: 0, everSucceeded: true, forceReconnect: false };
  const streak = previousStreak + 1;
  const forceReconnect = everSucceeded && streak >= CONTROL_FAILURE_RESPAWN_THRESHOLD;
  return { streak: forceReconnect ? 0 : streak, everSucceeded, forceReconnect };
}

// A distinct failure mode from the one above, found live on halpi2 right
// after deploying the 0.1.8 fix for it: switching the zone off a
// currently-flowing stream onto a silent one (`Alerts`, with nothing
// announcing) sometimes left snapclient's own audio-data TCP connection to
// Snapserver dead -- no exit (`podman top` showed the process still
// running), no error logged, nothing -- while Snapserver's own
// Client.GetStatus genuinely reports `connected: false` for it. Confirmed
// this is a real gap in snapclient itself, not something masked by how
// this bridge invokes it: `snapclient -h` (same 0.35.0 build this image
// installs) exposes no keepalive/timeout/reconnect flag at all, so
// snapclient has no way to notice a half-open connection on its own and no
// option this bridge could just be passing. Snapserver's control API
// already knows the truth, though, and this bridge already polls
// Client.GetStatus every 2s for mute state -- reusing that same poll to
// also check `connected` is the direct fix, mirroring
// nextControlFailureState above: only counts after a prior successful
// connect (so it can never fire on startup, before snapclient has
// registered even once) and only forces a respawn after several
// consecutive polls agree, so one poll racing a real, brief reconnect
// doesn't cause a spurious kill.
export const CLIENT_DISCONNECT_RESPAWN_THRESHOLD = 3;

/** Given whether the latest Client.GetStatus poll reported our client as
 *  connected, the current consecutive-disconnected streak, and whether it
 *  was ever seen connected before, returns the updated streak/everConnected
 *  and whether the caller should force snapclient to respawn. Pure, same
 *  shape as nextControlFailureState, for the same reason (unit-testable
 *  without a real Snapserver). */
export function nextClientConnectionState(connected, previousStreak, everConnected) {
  if (connected) return { streak: 0, everConnected: true, forceRespawn: false };
  const streak = previousStreak + 1;
  const forceRespawn = everConnected && streak >= CLIENT_DISCONNECT_RESPAWN_THRESHOLD;
  return { streak: forceRespawn ? 0 : streak, everConnected, forceRespawn };
}

// A distinct failure mode from either of the two above, found live on
// halpi2 running 0.1.9: the Salon zone went stuck-disconnected again --
// confirmed via Snapserver's own Server.GetStatus, queried directly, that
// `cockpit-panel` really was `connected: false` -- but this time `podman
// logs` showed *zero* new lines for roughly 7 hours, not even the
// "Client.GetStatus failed"/"disconnected N times" messages
// nextControlFailureState/nextClientConnectionState above should have
// produced within a couple of poll cycles of the disconnect. Instrumented
// and reproduced locally against real black-holed and silently-swallowing
// TCP peers (see test/control-reconnect.test.ts and
// test/client-disconnect-respawn.test.ts) and confirmed ControlConnection's
// own call() timeout fires reliably regardless of socket state -- a
// fully black-holed connect() still rejects in ~3s, and a connection that
// accepts writes but never replies still times out every poll, so neither
// of the two watchdogs above can actually get stuck waiting on a
// Client.GetStatus response. That means whatever wedged the poll loop for
// 7 hours straight did so at a level neither watchdog can see or protect
// against (an event-loop stall from any cause -- e.g. a blocking stdout
// write against a stalled log pipe, which `podman logs` alone can't rule
// out). Given this is the fourth distinct connection-zombie incident here
// and each of the first three needed its own bespoke detector, this one
// adds a detector that assumes nothing about the cause: an independent
// watchdog that only checks whether the poll loop itself is still
// ticking, and force-exits the process if it stops -- the same "give up
// and let the container restart us" fallback nextRapidExitState already
// relies on above.
export const POLL_STALL_THRESHOLD_MS = 30_000; // 15x the poll cadence -- generous headroom over any legitimate single slow call

/** Given the current time and when the poll loop's setInterval callback
 *  last ran (recorded unconditionally as its very first statement, before
 *  any await that could get stuck), returns whether the loop has gone
 *  silent for longer than can be explained by a normal slow poll. Pure,
 *  same shape as the other *State helpers above, for the same reason
 *  (unit-testable without a real timer). */
export function isPollStalled(now, lastTickAt, thresholdMs = POLL_STALL_THRESHOLD_MS) {
  return now - lastTickAt > thresholdMs;
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
  // last known value (false, initially). One persistent ControlConnection
  // for the whole process lifetime, not a fresh socket per poll -- see
  // that class's own doc comment for why (Snapserver logs a spurious
  // error on every short-lived control connection closing).
  const control = new ControlConnection(snapcastHost, controlPort);
  let muted = false;
  let controlFailureStreak = 0;
  let everSucceeded = false;
  let clientDisconnectStreak = 0;
  let everConnected = false;
  // Recorded as the very first thing the callback does, unconditionally --
  // see isPollStalled's own doc comment above for why this exists and what
  // it's independent of.
  let lastPollTickAt = Date.now();
  const muteTimer = setInterval(async () => {
    lastPollTickAt = Date.now();
    let status;
    try {
      status = await getClientStatus(control, bridgeId);
    } catch {
      const state = nextControlFailureState(false, controlFailureStreak, everSucceeded);
      controlFailureStreak = state.streak;
      everSucceeded = state.everSucceeded;
      if (state.forceReconnect) {
        console.error(
          `Client.GetStatus failed ${CONTROL_FAILURE_RESPAWN_THRESHOLD} times in a row after ` +
            "previously succeeding; assuming Snapserver was replaced and snapclient's " +
            "connection is now stale -- forcing both to reconnect",
        );
        control.close();
        snapclient.kill();
      }
      return; // client not registered yet, or a transient control-API hiccup
    }
    ({ streak: controlFailureStreak, everSucceeded } = nextControlFailureState(
      true,
      controlFailureStreak,
      everSucceeded,
    ));

    // Snapserver itself is reachable and answering (the try above
    // succeeded), but says our own client id is disconnected -- snapclient
    // has no keepalive/timeout of its own to notice this (confirmed against
    // a real build: `snapclient -h` has no such flag), so ask the one party
    // that actually knows. Respawning only snapclient here, not the whole
    // control connection -- control.call() just worked, so there's nothing
    // wrong with it.
    const connState = nextClientConnectionState(status.connected, clientDisconnectStreak, everConnected);
    clientDisconnectStreak = connState.streak;
    everConnected = connState.everConnected;
    if (connState.forceRespawn) {
      console.error(
        `Snapserver reports ${bridgeId} disconnected ${CLIENT_DISCONNECT_RESPAWN_THRESHOLD} ` +
          "times in a row despite the local snapclient process still running; forcing it to respawn",
      );
      snapclient.kill();
      return; // let the exit handler respawn; skip the mute check this tick
    }

    const nowMuted = status.muted;
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

  // Independent of muteTimer's own body: runs on its own cadence and checks
  // only whether that body is still ticking at all, not why it might not
  // be -- see isPollStalled's doc comment above.
  const watchdogTimer = setInterval(() => {
    if (isPollStalled(Date.now(), lastPollTickAt)) {
      console.error(
        `poll loop hasn't ticked in over ${POLL_STALL_THRESHOLD_MS}ms; ` +
          "assuming it's wedged in a way none of the connection-specific " +
          "watchdogs above can catch -- exiting so the container restarts us",
      );
      process.exit(1);
    }
  }, 5000);

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

  // Respawned in place on a recoverable exit, not just spawned once --
  // `let`, not `const`, so SIGTERM/conn-close's snapclient.kill() calls
  // below always reach the current instance. Confirmed live: switching a
  // zone onto a Snapcast stream with a different native sample rate than
  // whatever snapclient is currently decoding (e.g. this project's own
  // AirPlay input, forced to 44100:16:2 while every other stream here is
  // 48000:16:2) reliably crashes snapclient outright when it tries to
  // reconfigure its resampler for the new format -- a normal, expected
  // consequence of a zone reassignment, not a sign anything is actually
  // broken. Treating that the same as a genuine failure (the previous
  // behavior: exit this whole process and rely on the container's
  // restart:unless-stopped policy) meant a single zone-source switch
  // could silently and permanently kill the bridge, made worse by a
  // separate, confirmed bug in signalk-container-helper where that
  // restart policy isn't actually applied to the container at all.
  let snapclient;
  let shuttingDown = false;
  let snapclientStartedAt = 0;
  let rapidExitCount = 0;

  function startSnapclient() {
    snapclientStartedAt = Date.now();
    snapclient = spawnSnapclient({
      snapcastHost,
      snapcastPort,
      fifoPath,
      bridgeId,
      format,
    });
    snapclient.on("exit", (code) => {
      if (shuttingDown) return; // already tearing down -- nothing to recover
      const ranMs = Date.now() - snapclientStartedAt;
      const { count, giveUp } = nextRapidExitState(ranMs, rapidExitCount);
      rapidExitCount = count;
      if (giveUp) {
        console.error(
          `snapclient exited (${code}) ${count} times in a row within ` +
            `${RAPID_EXIT_THRESHOLD_MS}ms of starting; giving up and exiting to restart cleanly`,
        );
        process.exit(code === 0 ? 1 : (code ?? 1));
        return;
      }
      console.error(
        `snapclient exited (${code}) after ${ranMs}ms; respawning in place`,
      );
      startSnapclient();
    });
  }
  startSnapclient();

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
    shuttingDown = true; // don't respawn snapclient for the kill() below
    clearInterval(pingTimer);
    clearInterval(muteTimer);
    clearInterval(watchdogTimer);
    clearTimeout(silenceTimer);
    clearTimeout(noDataTimer);
    control.close();
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

  // Second, independent watchdog for genuinely NO data -- confirmed live
  // this is a real, different case from silence-in-arriving-data: a zone
  // switched to the raw `Alerts` stream (a tcp mode=server source with no
  // announcement client currently connected to it) delivers literally
  // nothing, not even comfort-silence padding, so the meanAbsAmplitude
  // check above never runs at all (no 'data' event fires). Left alone,
  // that ran for 110s before snapclient's own internal watchdog did a
  // Stop/reopen cycle and the whole process died -- the exact same
  // failure mode the silence detector was built to avoid, just via the
  // one path it doesn't cover. Reset on every 'data' event regardless of
  // content, unlike silenceTimer which only resets on non-silent audio.
  const NO_DATA_TIMEOUT_MS = 3000;
  let noDataTimer = setTimeout(() => stopStream("no data"), NO_DATA_TIMEOUT_MS);

  const fifo = createReadStream(fifoPath);
  // Truncate to whole SOURCE frames, not the satellite's target frame size
  // -- the FIFO always carries SOURCE_CHANNELS PCM regardless of what the
  // satellite wants (see spawnSnapclient above); downmixing happens after
  // truncation, never before.
  const sourceFrameSize = format.width * SOURCE_CHANNELS;
  fifo.on("data", (chunk) => {
    clearTimeout(noDataTimer);
    noDataTimer = setTimeout(() => stopStream("no data"), NO_DATA_TIMEOUT_MS);

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
    shuttingDown = true; // don't respawn snapclient for the kill() below
    clearInterval(pingTimer);
    clearInterval(muteTimer);
    clearInterval(watchdogTimer);
    clearTimeout(silenceTimer);
    clearTimeout(noDataTimer);
    control.close();
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
