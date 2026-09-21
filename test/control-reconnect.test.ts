// Regression test for the halpi2 bug: recreating (not restarting) the
// sibling signalk-jukebox container's Snapserver leaves this bridge's
// snapclient holding a stale TCP connection forever -- no exit, no error,
// no way for the existing exit-triggered respawn (nextRapidExitState) to
// ever fire, because snapclient itself never notices. This is Snapcast-
// side, not Wyoming-side, so unlike handshake.test.ts there's no real
// snapclient/Snapserver involved -- ControlConnection's own JSON-RPC
// framing over a raw net server stands in for both, since that's the
// layer bridge.mjs actually uses to detect the staleness (see
// nextControlFailureState's own doc comment in bridge.mjs for why).

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import {
  ControlConnection,
  nextControlFailureState,
  CONTROL_FAILURE_RESPAWN_THRESHOLD,
} from "../bridge.mjs";

describe("nextControlFailureState", () => {
  it("never counts failures before any poll has ever succeeded", () => {
    let state = { streak: 0, everSucceeded: false };
    for (let i = 0; i < CONTROL_FAILURE_RESPAWN_THRESHOLD + 5; i++) {
      state = nextControlFailureState(false, state.streak, state.everSucceeded);
      expect(state.forceReconnect).toBe(false);
    }
  });

  it("resets the streak on a success", () => {
    const state = nextControlFailureState(true, 2, false);
    expect(state).toEqual({ streak: 0, everSucceeded: true, forceReconnect: false });
  });

  it("signals forceReconnect once failures-after-a-success reach the threshold, not before", () => {
    let state = nextControlFailureState(true, 0, false); // one real success first
    for (let i = 0; i < CONTROL_FAILURE_RESPAWN_THRESHOLD - 1; i++) {
      state = nextControlFailureState(false, state.streak, state.everSucceeded);
      expect(state.forceReconnect).toBe(false);
    }
    state = nextControlFailureState(false, state.streak, state.everSucceeded);
    expect(state.forceReconnect).toBe(true);
    expect(state.streak).toBe(0); // consumed, so it can start counting a fresh outage
  });
});

/** Minimal stand-in for Snapserver's JSON-line control API. `respond` is
 *  mutable so a test can flip a single, still-open connection from
 *  answering normally to going silent mid-test -- the "stale half-open
 *  connection" case: no close, no error, just nothing coming back on the
 *  SAME socket, which is exactly what a call()'s own timer (not a socket
 *  event) has to catch. */
function startFakeControlServer() {
  const state = { respond: true };
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    let buf = "";
    socket.on("data", (chunk) => {
      if (!state.respond) return; // simulate a dead-but-not-closed peer
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line);
        socket.write(
          JSON.stringify({
            id: msg.id,
            jsonrpc: "2.0",
            result: { client: { config: { volume: { muted: false } } } },
          }) + "\n",
        );
      }
    });
  });
  return new Promise<{
    server: net.Server;
    port: number;
    sockets: net.Socket[];
    state: { respond: boolean };
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ server, port, sockets, state });
    });
  });
}

let servers: { server: net.Server; sockets: net.Socket[] }[] = [];
let control: ControlConnection | undefined;

afterEach(async () => {
  control?.close();
  control = undefined;
  // Destroy accepted sockets first -- server.close()'s callback otherwise
  // waits for connections that this test deliberately leaves dangling
  // (that's the whole point: a peer that never sends FIN/RST).
  for (const { server, sockets } of servers) {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
  servers = [];
});

describe("ControlConnection against a Snapserver that goes silently stale", () => {
  it("times out repeatedly on a stale connection, and closing/redialing recovers", async () => {
    const fake = await startFakeControlServer();
    servers.push(fake);
    control = new ControlConnection("127.0.0.1", fake.port);

    // One real success, matching "our snapclient already registered".
    const first = await control.call("Client.GetStatus", { id: "bridge" }, { timeoutMs: 500 });
    let state = nextControlFailureState(true, 0, false);
    expect(state.everSucceeded).toBe(true);
    expect(first).toBeTruthy();

    // Snapserver's container gets replaced: the SAME socket goes silent --
    // no close, no error (the reproduction on halpi2 showed no such event
    // at all, ever).
    fake.state.respond = false;

    for (let i = 0; i < CONTROL_FAILURE_RESPAWN_THRESHOLD; i++) {
      await expect(
        control.call("Client.GetStatus", { id: "bridge" }, { timeoutMs: 200 }),
      ).rejects.toThrow(/timed out/);
      state = nextControlFailureState(false, state.streak, state.everSucceeded);
    }
    expect(state.forceReconnect).toBe(true);

    // This is the fix: on forceReconnect, bridge.mjs calls control.close()
    // so the next call() redials instead of reusing the stale socket.
    // Without it, `control` would keep reusing the same dead socket
    // forever, exactly like the un-fixed bridge did against snapclient.
    control.close();
    fake.state.respond = true; // the "new container" is reachable again

    const recovered = await control.call("Client.GetStatus", { id: "bridge" }, { timeoutMs: 500 });
    expect(recovered).toBeTruthy();
  });
});
