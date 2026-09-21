// Regression test for the halpi2 bug found right after deploying 0.1.8:
// switching a zone from a flowing stream onto a silent one (`Alerts`)
// sometimes leaves snapclient's own audio-data TCP connection to Snapserver
// dead -- no exit, no error, no new log lines -- while snapclient's process
// itself stays alive and Snapserver's own Client.GetStatus genuinely
// reports the client as disconnected. Unlike control-reconnect.test.ts (a
// dead *control* connection), the control connection here is fine the
// whole time -- it's answering normally -- it's just telling the truth
// about a client that snapclient itself has no way to notice is gone
// (confirmed live: `snapclient -h` has no keepalive/timeout/reconnect
// flag). So this test drives nextClientConnectionState directly against a
// fake control server whose Client.GetStatus response flips `connected`,
// mirroring the shape of control-reconnect.test.ts's own fake server.

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import {
  ControlConnection,
  nextClientConnectionState,
  CLIENT_DISCONNECT_RESPAWN_THRESHOLD,
} from "../bridge.mjs";

describe("nextClientConnectionState", () => {
  it("never forces a respawn before the client has ever been seen connected", () => {
    let state = { streak: 0, everConnected: false };
    for (let i = 0; i < CLIENT_DISCONNECT_RESPAWN_THRESHOLD + 5; i++) {
      state = nextClientConnectionState(false, state.streak, state.everConnected);
      expect(state.forceRespawn).toBe(false);
    }
  });

  it("resets the streak once the client is seen connected", () => {
    const state = nextClientConnectionState(true, 2, false);
    expect(state).toEqual({ streak: 0, everConnected: true, forceRespawn: false });
  });

  it("forces a respawn once disconnected-after-connected polls reach the threshold, not before", () => {
    let state = nextClientConnectionState(true, 0, false); // one real connect first
    for (let i = 0; i < CLIENT_DISCONNECT_RESPAWN_THRESHOLD - 1; i++) {
      state = nextClientConnectionState(false, state.streak, state.everConnected);
      expect(state.forceRespawn).toBe(false);
    }
    state = nextClientConnectionState(false, state.streak, state.everConnected);
    expect(state.forceRespawn).toBe(true);
    expect(state.streak).toBe(0); // consumed, so it can start counting a fresh outage
  });

  it("a single connected poll in between resets the streak (not just decrements it)", () => {
    let state = nextClientConnectionState(true, 0, false);
    state = nextClientConnectionState(false, state.streak, state.everConnected);
    state = nextClientConnectionState(false, state.streak, state.everConnected);
    state = nextClientConnectionState(true, state.streak, state.everConnected); // brief blip recovers
    expect(state.streak).toBe(0);
  });
});

/** Same shape as control-reconnect.test.ts's fake server, but the control
 *  connection itself stays healthy throughout -- only the `connected` field
 *  in the Client.GetStatus response flips, standing in for Snapserver
 *  correctly reporting a snapclient whose own data connection died silently
 *  underneath it. */
function startFakeControlServer() {
  const state = { connected: true };
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    let buf = "";
    socket.on("data", (chunk) => {
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
            result: {
              client: {
                connected: state.connected,
                config: { volume: { muted: false } },
              },
            },
          }) + "\n",
        );
      }
    });
  });
  return new Promise<{
    server: net.Server;
    port: number;
    sockets: net.Socket[];
    state: { connected: boolean };
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
  for (const { server, sockets } of servers) {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
  servers = [];
});

describe("Client.GetStatus against a client Snapserver considers disconnected", () => {
  it("reports connected: false without the control call itself failing", async () => {
    const fake = await startFakeControlServer();
    servers.push(fake);
    control = new ControlConnection("127.0.0.1", fake.port);

    const first = await control.call("Client.GetStatus", { id: "bridge" }, { timeoutMs: 500 });
    expect((first as any).client.connected).toBe(true);
    let state = nextClientConnectionState(true, 0, false);
    expect(state.everConnected).toBe(true);

    // snapclient's process stays alive; only Snapserver's view of it flips.
    fake.state.connected = false;

    for (let i = 0; i < CLIENT_DISCONNECT_RESPAWN_THRESHOLD; i++) {
      const result = await control.call("Client.GetStatus", { id: "bridge" }, { timeoutMs: 500 });
      expect((result as any).client.connected).toBe(false);
      state = nextClientConnectionState(false, state.streak, state.everConnected);
    }
    expect(state.forceRespawn).toBe(true);
  });
});
