import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createViewer } from "./viewer.js";

test("웹 관찰실은 새 실행을 발견하고 선택한 장면을 유지하며 대화와 리포트를 표시한다", async t => {
  const root = await mkdtemp(join(tmpdir(), "salmonbus-viewer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createViewer({ root });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(origin);
  await page.getByText("저장된 실행이 없습니다.").waitFor();
  const image = await page.screenshot();

  const id = "2026-11-04T03-00-00-000Z-aabbccdd";
  const directory = join(root, id);
  await mkdir(join(directory, "screens"), { recursive: true });
  await writeFile(join(directory, "run.json"), JSON.stringify({ id, model: "gpt-6-luna", people: [{ id: "P1" }, { id: "P2" }] }) + "\n");
  const log = join(directory, "events.jsonl");
  const record = event => appendFile(log, JSON.stringify({ at: "2026-11-04T03:01:00Z", persona: "P1", ...event }) + "\n");
  const frame = async number => {
    const name = `P1-free-0${number}`;
    await writeFile(join(directory, "screens", name + ".png"), image);
    await record({ kind: "frame", frame: name, task: "free", path: "/" });
  };
  await frame(1);
  await record({ kind: "action", frame: "P1-free-01", task: "free", action: { action: "tap" }, remark: "노선을 찾아볼게요." });
  const first = page.getByRole("button", { name: /강정식.*노선을 찾아볼게요/ });
  await first.click();
  await page.waitForFunction(() => document.getElementById("capture").naturalWidth > 0);
  await frame(2);
  await page.getByRole("button", { name: /화면 캡처/ }).waitFor();
  assert.match(await page.locator("#capture").getAttribute("src"), /P1-free-01\.png$/);
  await page.getByRole("button", { name: "최신 화면으로" }).click();
  assert.match(await page.locator("#capture").getAttribute("src"), /P1-free-02\.png$/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  await record({ kind: "interview", question: "어떤 화면을 기대했나요?", answer: "노선 목록을 기대했어요." });
  await record({ kind: "discussion", persona: "P2", round: 1, speech: "저도 번호부터 찾았어요." });
  await appendFile(log, '{"kind":"incomplete"');
  await writeFile(join(directory, "report.md"), "# 연어 UT 결과\n\n판정보드 확인 완료");
  await page.getByRole("button", { name: "인터뷰", exact: true }).click();
  await page.getByText("노선 목록을 기대했어요.").waitFor();
  assert.equal(await page.locator("#interview-persona option:checked").textContent(), "강정식");
  await page.getByRole("button", { name: "그룹 대화", exact: true }).click();
  await page.getByText("저도 번호부터 찾았어요.").waitFor();
  await page.getByText("1차 · 천상민", { exact: true }).waitFor();
  await page.getByRole("button", { name: "리포트", exact: true }).click();
  await page.getByText(/판정보드 확인 완료/).waitFor();
  assert.equal((await fetch(`${origin}/api/runs/${id}/run.json`)).status, 404);
});

test("웹에서 UT를 시작하고 추가 질문과 재분석을 같은 실행에 저장한다", async t => {
  const root = await mkdtemp(join(tmpdir(), "salmonbus-controls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = "2026-11-04T03-00-00-000Z-eeff0011";
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let starts = 0;
  const reviewEfforts = [];
  const server = createViewer({
    root,
    makeModel(key) {
      if (!key && !process.env.OPENAI_API_KEY) throw new Error("API 키가 필요합니다.");
      return { respond: async ({ schema, effort, prompt, images }) => {
        if (!schema?.properties.assessments) {
          assert.equal(effort, undefined);
          return { speech: "방면을 먼저 확인하고 싶었어요." };
        }
        reviewEfforts.push(effort);
        const { evidence } = JSON.parse(prompt);
        assert.deepEqual(images.map(image => image.frame), ["P2-free-01", "P2-free-02"]);
        const action = evidence.find(event => event.kind === "action");
        assert.deepEqual([action.before, action.after], ["P2-free-01", "P2-free-02"]);
        assert.equal(evidence.find(event => event.kind === "interview").answer, "방면을 먼저 확인하고 싶었어요.");
        return { assessments: [], findings: [{
          observed: "화면을 눌러 방면을 찾으려 했다.", interpretation: `${effort} 판정으로 방면을 확인했다.`,
          evidence: ["P2-free-01", "P2-free-02"],
        }] };
      } };
    },
    async startStudy({ people, root, onStart }) {
      starts += 1;
      assert.deepEqual(people.map(person => person.id), ["P2"]);
      const directory = join(root, id);
      await mkdir(directory);
      await writeFile(join(directory, "run.json"), JSON.stringify({ id, model: "gpt-6-luna", people }) + "\n");
      await mkdir(join(directory, "screens"));
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII=", "base64");
      const frames = ["P2-free-01", "P2-free-02"];
      for (const frame of frames) await writeFile(join(directory, "screens", frame + ".png"), png);
      const screen = frame => ({ kind: "frame", frame, image: `screens/${frame}.png`, path: "/" });
      const events = [
        screen(frames[0]),
        { kind: "action", frame: frames[0], action: { action: "tap" }, remark: "방면을 확인하려고 눌렀어요." },
        screen(frames[1]),
        { kind: "end", status: "stopped" },
      ];
      await writeFile(join(directory, "events.jsonl"), events.map(event => JSON.stringify({ persona: "P2", task: "free", ...event })).join("\n") + "\n");
      onStart(id);
      await pending;
      await writeFile(join(directory, "report.md"), "# 실행 완료\n");
    },
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    finish();
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(origin);
  await page.getByText("자동 갱신 중").waitFor();
  await page.getByLabel("실행할 참가자").selectOption({ label: "천상민" });
  if (await page.getByLabel("OpenAI API 키").isVisible()) await page.getByLabel("OpenAI API 키").fill("fixture-key");
  await page.getByRole("button", { name: "UT 시작" }).click();
  await page.getByText("UT 실행 중입니다. 새 기록이 자동으로 표시됩니다.").waitFor();
  assert.equal((await fetch(origin + "/api/runs", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: '{"persona":"P2"}',
  })).status, 409);
  assert.equal((await fetch(origin + "/api/runs", {
    method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: '{"persona":"P2"}',
  })).status, 403);
  assert.equal(starts, 1);
  await page.getByRole("button", { name: "인터뷰", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "질문 보내기" }).isDisabled(), true);
  finish();
  await page.getByText("리포트 준비됨").waitFor();
  await page.getByLabel("추가 질문").fill("무엇을 먼저 확인하고 싶었나요?");
  await page.getByRole("button", { name: "질문 보내기" }).click();
  await page.getByText("방면을 먼저 확인하고 싶었어요.").waitFor();
  const detail = await (await fetch(`${origin}/api/runs/${id}`)).json();
  assert.equal(detail.events.at(-1).persona, "P2");
  assert.equal(detail.events.at(-1).question, "무엇을 먼저 확인하고 싶었나요?");
  assert.doesNotMatch(JSON.stringify(detail), /fixture-key/);

  await page.getByRole("button", { name: "리포트", exact: true }).click();
  await page.getByRole("button", { name: "medium으로 재분석" }).click();
  const medium = page.getByRole("region", { name: "medium 리포트" });
  await medium.getByText(/medium 판정으로 방면을 확인했다/).waitFor();
  await page.getByRole("button", { name: "low로 재분석" }).click();
  const low = page.getByRole("region", { name: "low 리포트" });
  await low.getByText(/low 판정으로 방면을 확인했다/).waitFor();
  assert.deepEqual(reviewEfforts, ["medium", "low"]);
  const mediumBox = await medium.boundingBox();
  const lowBox = await low.boundingBox();
  assert.equal(mediumBox.y, lowBox.y);
  assert.ok(mediumBox.x < lowBox.x);
  await page.getByText("이전 리포트 보기").click();
  await page.getByText("# 실행 완료", { exact: true }).waitFor();
  const regenerated = await (await fetch(`${origin}/api/runs/${id}/report-medium.md`)).text();
  assert.match(regenerated, /관찰자 추론 정도 · medium/);
  assert.match(await (await fetch(`${origin}/api/runs/${id}/report-low.md`)).text(), /관찰자 추론 정도 · low/);
  assert.equal(await readFile(join(root, id, "report.md"), "utf8"), "# 실행 완료\n");
});
