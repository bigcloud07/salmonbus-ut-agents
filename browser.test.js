import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { openSession, viewport } from "./browser.js";
import { createModel } from "./model.js";
import { openInterview, parseEvents, regenerateReport, runStudy } from "./run.js";
import { personas } from "./study.js";

let browser, server, origin;
const received = [];
const board = "/board?direction=UP&stopId=123";

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    received.push([request.method, url.pathname]);
    const cookies = request.headers.cookie ?? "";
    const send = (body) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<meta name="viewport" content="width=device-width, initial-scale=1">${body}`);
    };
    const redirect = (target, headers = {}) => {
      response.writeHead(302, { Location: target, ...headers });
      response.end();
    };
    switch (url.pathname) {
      case "/":
        return send(`<style>body { min-height: 90vh; }</style>
          <a href="/api/auth/kakao/start?returnTo=${encodeURIComponent(board)}">카카오로 계속하기</a>
          <button style="position:absolute;left:20px;top:100px;width:100px;height:44px">
            <span style="position:absolute;inset:0">노선 검색</span>
          </button>
          <input style="position:absolute;left:20px;top:180px" type="password" aria-label="입력란" value="tap-fixture-secret">`);
      case "/api/auth/kakao/start":
        return redirect("/mock-kakao");
      case "/mock-kakao":
        return send(["new", "existing", "cancelled", "failed"].map(result => `<a href="/api/auth/kakao/callback?code=fixture-secret&amp;result=${result}">${result}</a>`).join(" "));
      case "/api/auth/kakao/callback": {
        const result = url.searchParams.get("result");
        if (result === "cancelled" || result === "failed") return redirect(`${board}&login=${result}`);
        return redirect(board, { "Set-Cookie": `mock-session=${result}; Path=/; HttpOnly` });
      }
      case "/api/auth/session":
        response.setHeader("Content-Type", "application/json");
        return response.end(JSON.stringify({ authenticated: cookies.includes("mock-session=") }));
      case "/board":
        return send(cookies.includes("mock-session=") ? "정류장 상세 화면" : "비회원 정류장 화면");
      default:
        response.statusCode = 404;
        return response.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("비회원 모드는 로그인 안내를 읽을 수 있지만 인증 시작, 콜백, 운영 쓰기와 외부 전송을 막는다", async (t) => {
  await assert.rejects(openSession(browser, { localAuth: true }), /운영에서는 인증을 시작할 수 없습니다/);
  const session = await openSession(browser, { origin });
  t.after(() => session.close());
  assert.match((await session.snapshot()).visibleText, /카카오로 계속하기/);
  const before = received.length;
  const outcomes = await session.page.evaluate(async () => Promise.all([
    fetch("/api/auth/apple/start"),
    fetch("/api/auth/kakao/callback?code=fixture-secret"),
    fetch("/api/me/favorite-selections", { method: "PUT" }),
    fetch("https://example.com", { method: "POST" }),
  ].map(request => request.then(() => "sent", () => "blocked"))));
  assert.deepEqual(outcomes, ["blocked", "blocked", "blocked", "blocked"]);
  assert.equal((await session.takeAuth()).status, "not_run");
  await Promise.all([
    session.page.waitForEvent("requestfailed", { predicate: request => request.url().includes("/kakao/start") }),
    session.page.getByRole("link", { name: "카카오로 계속하기" }).dispatchEvent("click"),
  ]);
  assert.equal((await session.takeAuth()).status, "not_run");
  assert.deepEqual(received.slice(before), []);
});

test("카카오 가입과 로그인은 같은 인계와 콜백을 사용하고 인증 화면과 세션을 격리한다", async (t) => {
  for (const [choice, expected] of [["new", "authenticated"], ["existing", "authenticated"], ["cancelled", "cancelled"], ["failed", "failed"]]) {
    await t.test(choice, async () => {
      let handoffs = 0;
      const session = await openSession(browser, { origin, localAuth: true, onHandoff: () => { handoffs += 1; } });
      try {
        assert.equal((await (await session.page.request.get(origin + "/api/auth/session")).json()).authenticated, false);
        await session.page.getByRole("link", { name: "카카오로 계속하기" }).click();
        await session.page.waitForURL("**/mock-kakao");
        assert.equal(handoffs, 1);
        await assert.rejects(session.snapshot(), /관찰 범위 밖/);
        await assert.rejects(session.act({ action: "tap", x: 5, y: 5, remark: "" }), /조작 범위 밖/);
        await session.page.getByRole("link", { name: choice, exact: true }).click();
        assert.equal((await session.takeAuth()).status, expected);
        const frame = await session.snapshot();
        assert.equal(frame.path, board);
        assert.doesNotMatch(frame.visibleText, /fixture-secret|mock-session/);
        if (expected === "authenticated") assert.equal(frame.visibleText, "정류장 상세 화면");
      } finally {
        await session.close();
      }
    });
  }
});

test("인증 시간 초과 뒤에는 제공자 화면을 캡처하지 않는다", async (t) => {
  const session = await openSession(browser, { origin, localAuth: true, authTimeout: 250 });
  t.after(() => session.close());
  await session.page.getByRole("link", { name: "카카오로 계속하기" }).click();
  assert.equal((await session.takeAuth()).status, "timeout");
  await assert.rejects(session.snapshot(), /관찰 범위 밖/);
});

test("전체 러너는 탭 대상을 관찰자에게만 전달하고 그룹 대화와 추가 인터뷰를 저장한다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "salmonbus-ut-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompts = [];
  const model = { async respond({ instructions, prompt, image, schema }) {
    const payload = JSON.parse(prompt);
    prompts.push({ payload, hasImage: Boolean(image), instructions });
    if (schema?.properties.action) {
      if (instructions.includes("참가자 P1")) {
        const y = payload.goal.includes("다음 출근") ? 16
          : payload.goal.includes("다음 버스가") ? [115, 300, 190][payload.priorActions.length] : undefined;
        if (y !== undefined) {
          return { action: "tap", x: 35, y, text: null, deltaY: null, submit: null, remark: "이곳을 눌러 볼게요." };
        }
      }
      return { action: "stop", x: null, y: null, text: null, deltaY: null, submit: null, remark: "여기까지 둘러봤어요." };
    }
    if (schema?.properties.assessments) {
      return {
        assessments: [{ persona: "P1", task: "arrival", outcome: "success", flow: "alternative", note: "대역 판정", evidence: ["P1-arrival-01"] }],
        findings: [{ observed: "첫 화면", interpretation: "대역 관찰", evidence: ["P1-free-01", "fabricated-frame"] }],
      };
    }
    return { speech: "대역 응답" };
  } };

  const directory = await runStudy({ model, browser, people: personas, root, origin });
  const participantPrompts = prompts.filter(({ payload }) => payload.priorActions);
  assert.deepEqual(participantPrompts.map(({ payload }) => payload.priorActions.length),
    [0, 0, 1, 2, 3, 4, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.ok(participantPrompts.every(({ payload }) => payload.priorActions.every(
    event => !("target" in event || "interactive" in event || event.kind === "tap_target"))));
  for (const persona of personas) {
    const { instructions } = prompts.find(({ payload, instructions }) => payload.goal && instructions.includes(`참가자 ${persona.id}`));
    assert.equal(persona.sourceProfile.uuid, persona.source.uuid);
    assert.equal(Object.keys(persona.sourceProfile).length, 26);
    assert.ok(instructions.includes(JSON.stringify(persona.sourceProfile)));
    assert.ok(instructions.includes(persona.commute));
  }
  const discussion = prompts.filter(({ payload }) => payload.question?.includes("참가자") && !payload.question.includes("기대"));
  assert.deepEqual(discussion.map(({ payload }) => payload.conversation.length), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(discussion.every(({ payload, instructions }) => payload.experience.every(event => !event.frame || instructions.includes(event.frame.slice(0, 2)))));
  const report = await readFile(join(directory, "report.md"), "utf8");
  assert.match(report, /달성 \| 다른 동선/);
  assert.match(report, /강정식 \| 다시 찾기 \| 인증 미실행/);
  assert.match(report, /P1-free-01\.png/);
  assert.doesNotMatch(report, /fabricated-frame/);

  const log = join(directory, "events.jsonl");
  const before = parseEvents(await readFile(log, "utf8"));
  const taps = before.filter(event => event.kind === "tap_target");
  const observer = prompts.find(({ payload }) => payload.evidence).payload;
  assert.deepEqual(observer.evidence.filter(event => event.kind === "tap_target"), taps);
  assert.deepEqual(taps.map(({ frame, x, y, target, interactive }) => [
    frame, x, y, target?.tag, target?.text, interactive?.tag,
  ]), [
    ["P1-arrival-01", 35, 115, "span", "노선 검색", "button"],
    ["P1-arrival-02", 35, 300, "body", "", undefined],
    ["P1-arrival-03", 35, 190, "input", "입력란", "input"],
    ["P1-return-01", 35, 16, "a", "카카오로 계속하기", "a"],
  ]);
  assert.deepEqual(taps[0].viewport, viewport);
  assert.doesNotMatch(JSON.stringify(taps), /tap-fixture-secret/);
  await appendFile(log, '{"kind":"interview","question":"잘린 질문');
  await regenerateReport({ model, runId: basename(directory), root });
  const interview = await openInterview(basename(directory), "P1", root);
  const otherInterview = await openInterview(basename(directory), "P1", root);
  const questions = ["P1-arrival-01에서 무엇을 기대했나요?", "P1-arrival-01에서 무엇을 확인했나요?"];
  await Promise.all([interview.ask(model, questions[0]), otherInterview.ask(model, questions[1])]);
  const recovered = parseEvents(await readFile(log, "utf8"));
  assert.deepEqual(recovered.slice(0, -2), before);
  assert.deepEqual(recovered.slice(-2).map(event => event.question).sort(), questions.sort());
  assert.equal(prompts.at(-1).hasImage, true);
  assert.equal(prompts.at(-1).payload.conversation.length, 1);
  assert.match(await readFile(join(directory, "interviews.md"), "utf8"), /강정식 추가 질문/);
});

test("마지막에 줄바꿈이 빠진 정상 이벤트는 보존하고 중간 손상은 드러낸다", () => {
  const entry = '{"kind":"end","status":"stopped"}';
  assert.deepEqual(parseEvents(entry), [{ kind: "end", status: "stopped" }]);
  assert.throws(() => parseEvents(`${entry}\n{"kind":\n${entry}\n`), SyntaxError);
});

test("한 번의 429 뒤 과업을 이어가고 재시도가 모두 실패하면 모델 오류를 남긴다", async t => {
  const root = await mkdtemp(join(tmpdir(), "salmonbus-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attempts = new Map();
  t.mock.method(globalThis, "fetch", async (_url, { body }) => {
    const request = JSON.parse(body);
    const payload = JSON.parse(request.input[0].content[0].text);
    const properties = request.text.format.schema.properties;
    if (properties.action && payload.goal.includes("앉아 갈")) {
      const id = request.instructions.includes("참가자 P1") ? "P1" : "P2";
      const count = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, count);
      if (id === "P2" || count === 1) {
        return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429, headers: { "Retry-After": "0" } });
      }
    }
    const result = properties.action ? { action: "stop", remark: "확인했어요." }
      : properties.assessments ? { assessments: [], findings: [] }
        : { speech: "대역 응답" };
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }] });
  });
  const directory = await runStudy({ model: createModel("fixture-key"), browser, people: personas.slice(0, 2), root, origin });
  const events = parseEvents(await readFile(join(directory, "events.jsonl"), "utf8"));
  const arrival = events.filter(event => event.task === "arrival");
  assert.deepEqual([...attempts], [["P1", 2], ["P2", 3]]);
  assert.deepEqual(arrival.filter(event => event.kind === "end").map(({ persona, status }) => [persona, status]), [
    ["P1", "stopped"], ["P2", "execution_error"],
  ]);
  assert.equal(arrival.filter(event => event.kind === "action" && event.persona === "P1").length, 1);
  const error = arrival.find(event => event.kind === "error" && event.persona === "P2");
  assert.equal(error.source, "model");
  assert.match(error.message, /HTTP 429/);
});
