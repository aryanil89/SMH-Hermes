import { describe, expect, it } from "vitest";
import { allowedUsers, resolveInboundToken } from "./telegram-poll.js";

describe("resolveInboundToken", () => {
  it("prefers a dedicated wall bot", () => {
    expect(
      resolveInboundToken({ TELEGRAM_WALL_BOT_TOKEN: "wall-token", TELEGRAM_BOT_TOKEN: "shared" }),
    ).toEqual({ token: "wall-token", bot: "dedicated" });
  });

  it("does NOT poll the shared bot without an explicit opt-in", () => {
    // The whole point of the flag. `hermes gateway` long-polls this same token,
    // and Telegram serves getUpdates to one consumer per bot -- polling it by
    // default would silently eat the questions the agent needs to answer.
    expect(resolveInboundToken({ TELEGRAM_BOT_TOKEN: "shared" })).toBeUndefined();
  });

  it("polls the shared bot only when TELEGRAM_POLL=1", () => {
    expect(resolveInboundToken({ TELEGRAM_BOT_TOKEN: "shared", TELEGRAM_POLL: "1" })).toEqual({
      token: "shared",
      bot: "shared",
    });
  });

  it("treats a blank or whitespace token as unset", () => {
    expect(resolveInboundToken({ TELEGRAM_WALL_BOT_TOKEN: "   " })).toBeUndefined();
    expect(resolveInboundToken({ TELEGRAM_BOT_TOKEN: "  ", TELEGRAM_POLL: "1" })).toBeUndefined();
  });

  it("is off when nothing is configured", () => {
    expect(resolveInboundToken({})).toBeUndefined();
  });
});

describe("allowedUsers", () => {
  it("parses a comma-separated list, tolerating spaces", () => {
    expect(allowedUsers({ TELEGRAM_ALLOWED_USERS: "123, 456 ,789" })).toEqual(["123", "456", "789"]);
  });

  it("returns an empty list when unset", () => {
    expect(allowedUsers({})).toEqual([]);
  });

  it("drops empty entries from a trailing comma", () => {
    expect(allowedUsers({ TELEGRAM_ALLOWED_USERS: "123,," })).toEqual(["123"]);
  });
});
