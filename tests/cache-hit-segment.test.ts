import test from "node:test";
import assert from "node:assert/strict";
import { renderSegment } from "../segments.ts";
import type { SegmentContext, ThemeLike } from "../types.ts";

const theme = {
  fg(color, text) {
    return `<${color}>${text}</${color}>`;
  },
} satisfies ThemeLike;

function createSegmentContext(latestPromptCacheHitRate?: number): SegmentContext {
  return {
    model: undefined,
    thinkingLevel: "off",
    sessionId: undefined,
    usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, latestPromptCacheHitRate, cost: 0 },
    contextPercent: 0,
    contextWindow: 0,
    autoCompactEnabled: true,
    customCompactionEnabled: false,
    usingSubscription: false,
    sessionStartTime: Date.now(),
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
    colors: { tokens: "muted" },
  };
}

test("cache_hit segment renders latest prompt cache hit rate", () => {
  assert.deepEqual(renderSegment("cache_hit", createSegmentContext(75)), {
    content: "<muted>CH75.0%</muted>",
    visible: true,
  });
});

test("cache_hit segment renders zero percent when the latest prompt missed", () => {
  assert.deepEqual(renderSegment("cache_hit", createSegmentContext(0)), {
    content: "<muted>CH0.0%</muted>",
    visible: true,
  });
});

test("cache_hit segment hides when no latest cache hit rate is available", () => {
  assert.deepEqual(renderSegment("cache_hit", createSegmentContext()), {
    content: "",
    visible: false,
  });
});
