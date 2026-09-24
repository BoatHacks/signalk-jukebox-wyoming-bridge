// Regression test for the halpi2 bug found live running 0.1.9: the Salon
// zone went stuck-disconnected again, but this time `podman logs` showed
// zero new lines for ~7 hours -- not even the "Client.GetStatus failed"/
// "disconnected N times" messages nextControlFailureState/
// nextClientConnectionState should have logged within a couple of poll
// cycles. Reproduced locally (see control-reconnect.test.ts and
// client-disconnect-respawn.test.ts) that ControlConnection's own call()
// timeout fires reliably even against a fully black-holed connect() or a
// connection that accepts writes but never replies, so neither existing
// watchdog can actually get stuck waiting on a response -- whatever
// wedged the real poll loop for 7 hours did so at a level neither can see.
// isPollStalled is the independent detector added for that: it doesn't
// care why the loop stopped ticking, only that it did.

import { describe, it, expect } from "vitest";
import { isPollStalled, POLL_STALL_THRESHOLD_MS } from "../bridge.mjs";

describe("isPollStalled", () => {
  it("is not stalled right after a tick", () => {
    const now = 1_000_000;
    expect(isPollStalled(now, now)).toBe(false);
  });

  it("is not stalled for any gap under the threshold", () => {
    const now = 1_000_000;
    expect(isPollStalled(now, now - (POLL_STALL_THRESHOLD_MS - 1))).toBe(false);
  });

  it("is stalled once the gap exceeds the threshold", () => {
    const now = 1_000_000;
    expect(isPollStalled(now, now - (POLL_STALL_THRESHOLD_MS + 1))).toBe(true);
  });

  it("tolerates a single normal slow poll (well under the threshold)", () => {
    // A poll that took the full 3s call() timeout, one cycle late.
    const now = 1_000_000;
    expect(isPollStalled(now, now - 5000)).toBe(false);
  });
});
