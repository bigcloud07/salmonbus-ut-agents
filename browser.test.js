import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { openSession } from "./browser.js";
import { openInterview, runStudy } from "./run.js";
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
        return send(`<a href="/api/auth/kakao/start?returnTo=${encodeURIComponent(board)}">카카오로 계속하기</a>`);
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

test("전체 러너는 자유 탐색 이력을 분리하고 그룹 대화와 추가 인터뷰를 저장한다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "salmonbus-ut-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompts = [];
  const model = { async respond({ instructions, prompt, image, schema }) {
    const payload = JSON.parse(prompt);
    prompts.push({ payload, hasImage: Boolean(image), instructions });
    if (schema?.properties.action) {
      if (instructions.includes("참가자 P1") && payload.goal.includes("다음 출근")) {
        return { action: "tap", x: 35, y: 16, text: null, deltaY: null, submit: null, remark: "여기서 저장할 수 있는지 보고 싶어요." };
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
  assert.deepEqual(prompts.filter(({ payload }) => payload.goal).map(({ payload }) => payload.priorActions.length),
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
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

  const interview = await openInterview(basename(directory), "P1", root);
  await interview.ask(model, "P1-arrival-01에서 무엇을 기대했나요?");
  assert.equal(prompts.at(-1).hasImage, true);
  assert.equal(prompts.at(-1).payload.conversation.length, 1);
  assert.match(await readFile(join(directory, "interviews.md"), "utf8"), /강정식 추가 질문/);
});
