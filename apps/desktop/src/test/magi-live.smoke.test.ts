// @vitest-environment node
// Live smoke test against a REAL `magi serve`. Skipped unless MAGI_LIVE_URL is
// set (so CI / normal `pnpm test` never depends on a running daemon).
//   MAGI_LIVE_URL=http://127.0.0.1:8799 pnpm exec vitest run magi-live.smoke
import { describe, expect, it } from "vitest";
import { MagiClient, type RuntimeEvent } from "@ai4s/sdk";

const url = process.env.MAGI_LIVE_URL;
const run = url ? describe : describe.skip;

run("MagiClient ↔ live magi serve", () => {
  it("pairs, streams a real turn, and reads it back from history", async () => {
    const events: RuntimeEvent[] = [];
    const client = new MagiClient({ baseUrl: url! });
    client.onEvent((e) => events.push(e));

    await client.connect();
    expect(client.getStatus()).toBe("ready");
    expect(client.credentials()?.token).toBeTruthy();

    const sessionId = await client.createSession("smoke: say hi");
    expect(sessionId).toMatch(/./);

    const jobId = await client.sendPrompt(
      sessionId,
      "Reply with exactly this one word and nothing else: pong",
    );
    expect(jobId).toMatch(/./);

    // Wait for the turn to finish (idle) or error, up to 90 s.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("live turn timed out")), 90_000);
      const off = client.onEvent((e) => {
        if (e.type === "session.idle") {
          clearTimeout(timer);
          off();
          resolve();
        } else if (e.type === "error") {
          clearTimeout(timer);
          off();
          reject(new Error(`runtime error: ${e.message}`));
        }
      });
    });

    const streamed = events
      .filter((e): e is Extract<RuntimeEvent, { type: "text.updated" }> => e.type === "text.updated")
      .map((e) => e.text)
      .join("");
    // Real provider text must have streamed as deltas.
    expect(streamed.toLowerCase()).toContain("pong");

    // History round-trips: the assistant message is persisted and folds back.
    const history = await client.getMessages(sessionId);
    const assistantText = history
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    expect(assistantText.toLowerCase()).toContain("pong");

    // The session shows up in the list.
    const sessions = await client.listSessions();
    expect(sessions.some((s) => s.id === sessionId)).toBe(true);

    client.close();
  }, 120_000);
});
