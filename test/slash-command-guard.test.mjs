import assert from "node:assert/strict";
import test from "node:test";
import slashCommandGuard from "../extensions/slash-command-guard/index.ts";

function fixture() {
  let input;
  const notifications = [];
  slashCommandGuard({
    on(name, handler) {
      assert.equal(name, "input");
      input = handler;
    },
    getCommands: () => [{ name: "skill:example" }],
  });
  const ctx = { ui: { notify: (...args) => notifications.push(args) } };
  return {
    submit: (text, extra = {}) => input({ text, source: "interactive", ...extra }, ctx),
    notifications,
  };
}

test("paths with a second slash in the first token pass through unchanged", () => {
  const { submit, notifications } = fixture();
  for (const text of [
    "/Users/travis/Desktop/Screenshot.png",
    "/Users/travis/Desktop/Screen Shot 2026-06-09.png explain this",
    "/tmp/screenshot.png explain this",
    "/tmp/screenshot",
    "/tmp/",
  ]) {
    assert.deepEqual(submit(text), { action: "continue" }, text);
  }
  assert.deepEqual(notifications, []);
});

test("command-shaped input remains guarded even with paths or images afterward", () => {
  const { submit, notifications } = fixture();
  for (const text of [
    "/treee",
    "/quti",
    "/whatever some arguments",
    "/treee /tmp/screenshot.png",
    "/treee\n/tmp/screenshot.png",
    "/treee\t/tmp/screenshot.png",
    "/screenshot.png",
    "/",
    "/   ",
  ]) {
    assert.deepEqual(submit(text), { action: "handled" }, text);
  }
  assert.match(notifications[0][0], /Did you mean "\/tree"/);
  assert.match(notifications[1][0], /Did you mean "\/quit"/);
  assert.deepEqual(
    submit("/treee", { images: [{ type: "image", data: "", mimeType: "image/png" }] }),
    { action: "handled" },
  );
});

test("known commands and non-command input continue normally", () => {
  const { submit, notifications } = fixture();
  for (const text of ["/tree", "/skill:example", "explain /tmp/screenshot.png"]) {
    assert.deepEqual(submit(text), { action: "continue" }, text);
  }
  assert.deepEqual(submit("/treee", { source: "extension" }), { action: "continue" });
  assert.deepEqual(notifications, []);
});
