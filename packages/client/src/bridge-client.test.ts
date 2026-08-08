import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, type BridgeTransport } from "./bridge-client.js";

/**
 * The close/retry interaction: a client closed *during backoff* used to
 * resurrect itself — close() nulled the transport but the scheduled retry
 * timer was untracked and open() never checked closedByUser. The fleet layer
 * (Track C) opens and closes many clients, so a zombie reconnect loop here
 * means phantom connections to servers the user disconnected from.
 */

class FakeTransport implements BridgeTransport {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((text: string) => void) | null = null;
  onclose: (() => void) | null = null;

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.closed = true;
  }
}

function harness() {
  const transports: FakeTransport[] = [];
  const client = new BridgeClient(() => {
    const t = new FakeTransport();
    transports.push(t);
    return t;
  });
  return { client, transports };
}

describe("BridgeClient close/retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects with backoff after a dropped connection", () => {
    const { client, transports } = harness();
    client.connect();
    expect(transports).toHaveLength(1);
    transports[0]!.onopen?.();
    expect(client.state).toBe("open");

    // Server goes away → closed, and a retry is scheduled.
    transports[0]!.onclose?.();
    expect(client.state).toBe("closed");
    vi.advanceTimersByTime(500);
    expect(transports).toHaveLength(2);
    expect(client.state).toBe("connecting");
  });

  it("does not resurrect a client closed during backoff", () => {
    const { client, transports } = harness();
    client.connect();
    transports[0]!.onopen?.();
    transports[0]!.onclose?.(); // drop → retry scheduled

    client.close(); // user disconnects while the retry is pending
    expect(client.state).toBe("closed");

    vi.advanceTimersByTime(60_000);
    expect(transports).toHaveLength(1); // no new connection attempt
    expect(client.state).toBe("closed");
  });

  it("ignores a transport close event that lands after close()", () => {
    const { client, transports } = harness();
    client.connect();
    transports[0]!.onopen?.();

    client.close();
    // The underlying socket's close event fires after the user's close().
    transports[0]!.onclose?.();

    vi.advanceTimersByTime(60_000);
    expect(transports).toHaveLength(1);
    expect(client.state).toBe("closed");
  });

  it("can connect() again after close()", () => {
    const { client, transports } = harness();
    client.connect();
    transports[0]!.onopen?.();
    client.close();

    client.connect();
    expect(transports).toHaveLength(2);
    transports[1]!.onopen?.();
    expect(client.state).toBe("open");
  });

  it("rejects in-flight requests when explicitly closed", async () => {
    const { client, transports } = harness();
    client.connect();
    transports[0]!.onopen?.();

    const request = client.request("workspace.get", {});
    const rejection = expect(request).rejects.toThrow("Bridge closed");
    client.close();

    await rejection;
  });

  it("keeps retrying while never opened (factory throws), then stops on close()", () => {
    let attempts = 0;
    const client = new BridgeClient(() => {
      attempts++;
      throw new Error("no endpoint yet");
    });
    client.connect();
    expect(attempts).toBe(1);
    vi.advanceTimersByTime(500); // first backoff
    expect(attempts).toBe(2);
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(attempts).toBe(2);
  });
});
