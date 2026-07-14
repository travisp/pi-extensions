import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { findLastResponseEndedAt } from "../index.ts";
import { renderSegment } from "../segments.ts";
import type { SegmentContext, ThemeLike } from "../types.ts";

const theme = {
  fg(_color, text) {
    return text;
  },
} satisfies ThemeLike;

function createSegmentContext(lastResponseEndedAt?: number): SegmentContext {
  return {
    model: undefined,
    thinkingLevel: "off",
    sessionId: undefined,
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    contextPercent: 0,
    contextPercentStale: false,
    contextWindow: 0,
    autoCompactEnabled: true,
    customCompactionEnabled: false,
    usingSubscription: false,
    sessionStartTime: Date.now(),
    lastResponseEndedAt,
    shellModeActive: false,
    shellRunning: false,
    shellName: null,
    shellCwd: null,
    git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
    extensionStatuses: new Map(),
    hiddenExtensionStatusKeys: new Set(),
    customItemsById: new Map(),
    options: {},
    theme,
    colors: {},
  };
}

function assistantMessage(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

test("last_response shows completion time and relative age without a label", () => {
  const originalNow = Date.now;
  const originalNerdFonts = process.env.POWERLINE_NERD_FONTS;
  const endedAt = new Date(2026, 6, 13, 14, 26, 0).getTime();

  Date.now = () => endedAt + 125_000;
  process.env.POWERLINE_NERD_FONTS = "0";
  try {
    assert.deepEqual(renderSegment("last_response", createSegmentContext(endedAt)), {
      content: "◷ 14:26 · 2m ago",
      visible: true,
    });
  } finally {
    Date.now = originalNow;
    if (originalNerdFonts === undefined) delete process.env.POWERLINE_NERD_FONTS;
    else process.env.POWERLINE_NERD_FONTS = originalNerdFonts;
  }
});

test("last_response hides before an assistant response completes", () => {
  assert.deepEqual(renderSegment("last_response", createSegmentContext()), {
    content: "",
    visible: false,
  });
});

test("findLastResponseEndedAt restores the latest successful assistant entry time", () => {
  const successfulAt = "2026-07-13T14:26:00.000Z";
  const entries: SessionEntry[] = [
    { type: "message", id: "first", parentId: null, timestamp: successfulAt, message: assistantMessage() },
    { type: "message", id: "second", parentId: "first", timestamp: "2026-07-13T14:30:00.000Z", message: assistantMessage("aborted") },
  ];

  assert.equal(findLastResponseEndedAt(entries), Date.parse(successfulAt));
});
