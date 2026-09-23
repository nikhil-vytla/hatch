import { expect, test } from "bun:test";
import { noticeFor } from "./notify";

test("a waiting approval, a finish and a failure are worth a notice; an interrupt and the rest aren't", () => {
  expect(noticeFor({ type: "approvalRequested", effect: 1, description: "run: rm -rf build" }, "Fix it")).toEqual({
    title: "strive needs your approval",
    body: "Fix it: allow it to run: rm -rf build?",
  });
  expect(noticeFor({ type: "turnEnded", turn: 1, reason: { kind: "done" } }, "Fix it")?.title).toBe("strive finished");
  expect(noticeFor({ type: "turnEnded", turn: 1, reason: { kind: "failed", error: "HTTP 429" } }, "Fix it")?.body).toBe(
    "Fix it: HTTP 429",
  );
  expect(noticeFor({ type: "turnEnded", turn: 1, reason: { kind: "interrupted" } }, "Fix it")).toBeUndefined();
  expect(noticeFor({ type: "userMessage", text: "hi" }, "Fix it")).toBeUndefined();
});
