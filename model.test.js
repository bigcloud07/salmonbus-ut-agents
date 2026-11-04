import assert from "node:assert/strict";
import { test } from "node:test";
import { createModel } from "./model.js";

test("인증 오류와 할당량 소진은 재시도하지 않는다", async t => {
  for (const [status, code] of [[401, "invalid_api_key"], [429, "insufficient_quota"]]) {
    await t.test(code, async t => {
      const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code } }, { status }));
      await assert.rejects(createModel("fixture-key").respond({ prompt: "점검" }), new RegExp(`HTTP ${status}`));
      assert.equal(fetch.mock.callCount(), 1);
    });
  }
});

test("과업 시간이 끝나면 Retry-After 대기를 중단한다", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({}, { status: 503, headers: { "Retry-After": "1" } }));
  const deadline = AbortSignal.timeout(30);
  await assert.rejects(createModel("fixture-key").respond({ prompt: "점검", signal: deadline }), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 1);
});
