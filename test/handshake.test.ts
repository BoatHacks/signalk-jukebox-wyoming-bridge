// Verifies bridge.mjs's Wyoming-side handshake against a real satellite
// implementation of the wire protocol -- signalk-wyoming's own
// MockWyomingServer(role: "satellite") imitates rhasspy/wyoming-satellite
// v1.4.1 wake mode, which is the same reference behaviour espos_voice's
// WyomingSatellite was itself verified against (see espos-p4-cockpit's
// wyoming_satellite.h). This is NOT a test of the Snapcast half (no real
// snapclient/Snapserver involved) -- see bridge.mjs's own header for what
// still needs a live run against real hardware.

import { describe, it, expect, afterEach } from "vitest";
import { MockWyomingServer } from "signalk-wyoming/mock";
import { AudioStart, AudioChunk, parseAudioStart, parseAudioChunk } from "signalk-wyoming/protocol";
import { handshake, bytesPerFrame, FALLBACK_FORMAT } from "../bridge.mjs";

let server: MockWyomingServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("bytesPerFrame", () => {
  it("multiplies width by channel count", () => {
    expect(bytesPerFrame({ rate: 16000, width: 2, channels: 1 })).toBe(2);
    expect(bytesPerFrame({ rate: 48000, width: 2, channels: 2 })).toBe(4);
  });
});

describe("handshake", () => {
  it("reads the satellite's advertised snd_format and pauses it", async () => {
    const sndFormat = { rate: 22050, width: 2, channels: 1 };
    server = new MockWyomingServer({ role: "satellite", sndFormat });
    const port = await server.listen();

    const { conn, format } = await handshake("127.0.0.1", port);
    expect(format).toEqual(sndFormat);

    // pause-satellite must be sent before this bridge ever streams a mic
    // it doesn't have -- run-satellite would wrongly arm push-to-talk.
    await server.waitForEvent((e) => e.event.type === "pause-satellite");

    conn.close();
  });

  it("falls back to Piper's default format when info has no snd program", async () => {
    // role "custom" ships every info list empty (signalk-wyoming's own
    // mock server source), exactly the "espos_voice always sends one but
    // some other satellite might not" case this bridge guards against.
    server = new MockWyomingServer({ role: "custom" });
    const port = await server.listen();

    const { conn, format } = await handshake("127.0.0.1", port);
    expect(format).toEqual(FALLBACK_FORMAT);

    conn.close();
  });

  it("rejects when the satellite never answers describe", async () => {
    server = new MockWyomingServer({ role: "satellite", hang: true });
    const port = await server.listen();

    await expect(handshake("127.0.0.1", port, { timeoutMs: 200 })).rejects.toThrow(
      /timed out/,
    );
  });
});

describe("audio streaming", () => {
  it("frames audio-start once and audio-chunk per write, matching the wire format", async () => {
    const sndFormat = { rate: 22050, width: 2, channels: 1 };
    server = new MockWyomingServer({ role: "satellite", sndFormat });
    const port = await server.listen();

    const { conn, format } = await handshake("127.0.0.1", port);
    conn.write(AudioStart(format));
    const chunk = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    conn.write(AudioChunk(format, chunk));

    const startEntry = await server.waitForEvent((e) => e.event.type === "audio-start");
    const start = parseAudioStart(startEntry.event);
    expect(start).toMatchObject(sndFormat);

    const chunkEntry = await server.waitForEvent((e) => e.event.type === "audio-chunk");
    const parsed = parseAudioChunk(chunkEntry.event);
    expect(parsed?.audio).toEqual(chunk);
    expect(parsed).toMatchObject(sndFormat);

    conn.close();
  });
});
