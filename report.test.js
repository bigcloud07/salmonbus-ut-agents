import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { regenerateReport, renderReport, writeReport } from "./run.js";

const people = [{ id: "P1" }];
const screen = (frame, task) => ({
  kind: "frame", persona: "P1", phase: task === "free" ? "free" : "guided", task, frame, image: `screens/${frame}.png`, path: "/",
});
const events = [screen("P1-arrival-01", "arrival"), screen("P1-return-01", "return")];

async function savedRun(t) {
  const directory = await mkdtemp(join(tmpdir(), "salmonbus-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "screens"));
  await Promise.all(events.map(({ image }) => writeFile(join(directory, image), "png")));
  return directory;
}

test("리포트는 저장된 판정만으로 그려진다", () => {
  const report = {
    origin: "https://www.salmonbus.com",
    effort: "low",
    reviewError: null,
    tasks: [
      { persona: "P1", task: "arrival", outcome: "partial", flow: "alternative", note: "좌석을 못 봤다", evidence: ["P1-arrival-01"] },
      { persona: "P1", task: "return", outcome: "uncertain", flow: "unknown", note: "", evidence: ["P1-return-01"] },
    ],
    findings: [{ observed: "방면을 다시 확인했다", interpretation: "표시가 약하다", evidence: ["P1-arrival-01"] }],
  };

  const markdown = renderReport({ report, people, events });

  assert.match(markdown, /\| 도착.좌석 정보 \| 부분 달성 \| 다른 동선 \| 좌석을 못 봤다 \[P1-arrival-01\]\(screens\/P1-arrival-01\.png\) \|/);
  assert.match(markdown, /\| 다시 찾기 \| 판정 보류 \| 판정 보류 \|/);
  assert.match(markdown, /방면을 다시 확인했다/);
  assert.match(markdown, /추론 정도 . low/);
});

test("판정 생성에 실패해도 실패 사유를 판정 파일에 남긴다", async t => {
  const directory = await savedRun(t);
  const model = { respond: async () => { throw new Error("OpenAI responses 요청 실패 (HTTP 500)"); } };

  await writeReport({ model, people, events, directory, origin: "https://www.salmonbus.com" });

  const judgment = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
  assert.equal(judgment.reviewError, "OpenAI responses 요청 실패 (HTTP 500)");
  assert.deepEqual(judgment.tasks.map(({ outcome }) => outcome), ["uncertain", "uncertain"]);
  assert.match(await readFile(join(directory, "report.md"), "utf8"), /판정 생성 실패/);
});

test("서비스가 기록한 종료 상태는 관찰자 판정보다 우선한다", async t => {
  const directory = await savedRun(t);
  const ended = [...events, { kind: "end", persona: "P1", task: "arrival", status: "execution_error" }];
  const model = { respond: async () => ({
    assessments: [{ persona: "P1", task: "arrival", outcome: "success", flow: "expected", note: "대역 판정", evidence: ["P1-arrival-01"] }],
    findings: [],
  }) };

  await writeReport({ model, people, events: ended, directory, origin: "https://www.salmonbus.com" });

  const { tasks } = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
  assert.equal(tasks[0].outcome, "execution_error");
});

test("재분석 리포트를 그리지 못하면 기존 판정을 건드리지 않는다", async t => {
  const root = await mkdtemp(join(tmpdir(), "salmonbus-regenerate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "saved-run");
  const free = { ...screen("P1-free-01", "free"), path: undefined };
  await mkdir(join(directory, "screens"), { recursive: true });
  await Promise.all([events[0], free].map(({ image }) => writeFile(join(directory, image), "png")));
  await writeFile(join(directory, "run.json"), JSON.stringify({ people, origin: "https://www.salmonbus.com" }));
  await writeFile(join(directory, "events.jsonl"), [events[0], free].map(event => JSON.stringify(event)).join("\n") + "\n");
  await writeFile(join(directory, "report-low.json"), "{}\n");
  const model = { respond: async () => ({ assessments: [], findings: [] }) };

  await assert.rejects(regenerateReport({ model, runId: "saved-run", root, effort: "low" }), { name: "TypeError" });

  assert.equal(await readFile(join(directory, "report-low.json"), "utf8"), "{}\n");
});

test("재분석이 실패하면 기존 판정을 건드리지 않는다", async t => {
  const root = await mkdtemp(join(tmpdir(), "salmonbus-regenerate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "saved-run");
  await mkdir(join(directory, "screens"), { recursive: true });
  await writeFile(join(directory, "screens", "P1-arrival-01.png"), "png");
  await writeFile(join(directory, "run.json"), JSON.stringify({ people, origin: "https://www.salmonbus.com" }));
  await writeFile(join(directory, "events.jsonl"), JSON.stringify(events[0]) + "\n");
  await writeFile(join(directory, "report-low.json"), "{}\n");
  const model = { respond: async () => { throw new Error("판정 실패"); } };

  await assert.rejects(regenerateReport({ model, runId: "saved-run", root, effort: "low" }), /판정 실패/);

  assert.equal(await readFile(join(directory, "report-low.json"), "utf8"), "{}\n");
  assert.deepEqual((await readdir(directory)).filter(file => file.endsWith(".tmp")), []);
});
