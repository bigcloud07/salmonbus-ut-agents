import { appendFile, mkdir, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import lockfile from "proper-lockfile";
import { openSession, production, validateAction, viewport } from "./browser.js";
import { actionSchema, modelId, objectSchema } from "./model.js";
import { dataset, participantPrompt, personaNames, tasksFor } from "./study.js";

const actionInstructions = `지금 보이는 화면에서 다음 조작을 하나만 선택하세요.
tap은 화면 왼쪽 위 (0,0) 기준 좌표, input은 초점이 있는 입력란에 넣을 문자열과 submit 여부,
scroll은 좌표와 세로 이동 거리(deltaY: 아래로 양수), back은 뒤로 가기, stop은 마치기 또는 포기입니다.
쓰지 않는 값은 null로 채우세요. remark에는 누르기 전 무엇을 기대했는지, 무엇을 확인했는지 또는 왜 멈췄는지 한두 문장으로 말하세요.
과업을 마쳤다면 실제 확인한 결과를 말하고 stop을 선택하세요.`;

const outcome = {
  success: "달성", partial: "부분 달성", unmet: "미달성", unavailable: "예보 미제공",
  auth_not_run: "인증 미실행", execution_error: "실행 오류", uncertain: "판정 보류",
};
const flow = { expected: "예상 동선", alternative: "다른 동선", unknown: "판정 보류" };
const string = { type: "string" };
const reference = { type: "array", items: string };
const reviewSchema = objectSchema({
  assessments: {
    type: "array", items: objectSchema({
      persona: string,
      task: { type: "string", enum: ["arrival", "return"] },
      outcome: { type: "string", enum: Object.keys(outcome) },
      flow: { type: "string", enum: Object.keys(flow) },
      note: string,
      evidence: reference,
    }),
  },
  findings: {
    type: "array", items: objectSchema({ observed: string, interpretation: string, evidence: reference }),
  },
});

const clean = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
const markdown = (text) => clean(text).replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char])
  .replace(/[|\[\]_*~`]/g, "\\$&");

function evidenceHistory(events) {
  return events.filter(event => ["action", "action_result"].includes(event.kind))
    .map(({ frame, action, remark, result }) => ({ frame, action, remark, result }));
}

function parseEventLog(log) {
  const lines = log.split("\n");
  const tail = lines.pop();
  const events = lines.filter(line => line.trim()).map(line => JSON.parse(line));
  if (tail.trim()) {
    try {
      events.push(JSON.parse(tail));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { events, completeLength: log.length - tail.length };
    }
  }
  return { events, completeLength: log.length };
}

export function parseEvents(log) {
  return parseEventLog(log).events;
}

async function appendEvent(path, event) {
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 8, minTimeout: 40, maxTimeout: 500 },
  });
  try {
    const log = await readFile(path, "utf8").catch(error => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    const { completeLength } = parseEventLog(log);
    const complete = log.slice(0, completeLength);
    if (completeLength !== log.length) await truncate(path, Buffer.byteLength(complete));
    const separator = complete && !complete.endsWith("\n") ? "\n" : "";
    await appendFile(path, separator + JSON.stringify(event) + "\n");
  } finally {
    await release();
  }
}

async function runPhase({ session, persona, task, limit, deadline, model, record, directory, history }) {
  const { id } = task;
  const events = [];
  const add = async (event) => {
    const entry = { persona: persona.id, phase: id === "free" ? "free" : "guided", task: id, ...event };
    await record(entry);
    events.push(entry);
  };
  const capture = async (number) => {
    const frame = `${persona.id}-${id}-${String(number).padStart(2, "0")}`;
    const { image, path, visibleText } = await session.snapshot();
    const imagePath = `screens/${frame}.png`;
    await writeFile(join(directory, imagePath), image);
    await add({ kind: "frame", frame, image: imagePath, path, visibleText });
    return { frame, image };
  };

  let status = "action_limit";
  let step = 0;
  let errorSource = "browser";
  try {
    while (step < limit) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        status = "time_limit";
        break;
      }
      step += 1;
      errorSource = "browser";
      const { frame, image } = await capture(step);
      if (Date.now() >= deadline) {
        status = "time_limit";
        break;
      }
      errorSource = "model";
      const action = validateAction(await model.respond({
        instructions: `${participantPrompt(persona)}\n${actionInstructions}`,
        prompt: JSON.stringify({ goal: task.prompt, viewport, priorActions: [...history, ...evidenceHistory(events)] }),
        image,
        schema: actionSchema,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      }));
      errorSource = "runner";
      const { remark, ...decision } = action;
      console.log(`[${frame}] ${decision.action} · ${clean(remark)}`);
      await add({ kind: "action", frame, action: decision, remark: clean(remark) });
      if (decision.action === "stop") {
        status = "stopped";
        break;
      }
      errorSource = "browser";
      const result = await session.act(action);
      errorSource = "runner";
      if (decision.action === "tap") {
        const { x, y } = decision;
        await add({ kind: "tap_target", frame, x, y, viewport, ...result });
      } else if (result) {
        console.log(`[${frame}] ${result}`);
        await add({ kind: "action_result", frame, result });
      }
      // The app may wait for a click analytics callback before starting navigation.
      await new Promise(resolve => setTimeout(resolve, 350));
      errorSource = "browser";
      const auth = await session.takeAuth();
      errorSource = "runner";
      if (auth) {
        await add({ kind: "auth", frame, ...auth });
        console.log(`[${frame}] 인증 상태 ${auth.status === "not_run" ? "미실행" : auth.status}`);
        if (auth.status === "not_run" || auth.status === "timeout") {
          status = auth.status === "not_run" ? "auth_not_run" : "execution_error";
          break;
        }
        deadline += auth.waitMs;
      }
    }
    if (step > 0 && (status === "action_limit" || status === "time_limit")) {
      errorSource = "browser";
      await capture(step + 1);
    }
  } catch (error) {
    const auth = await session.takeAuth();
    if (auth?.status === "not_run") {
      await add({ kind: "auth", ...auth });
      status = "auth_not_run";
    } else {
      status = Date.now() >= deadline ? "time_limit" : "execution_error";
      if (status === "execution_error") await add({ kind: "error", source: errorSource, message: clean(error.message).slice(0, 250) });
    }
  }
  const lastFrame = events.findLast(event => event.kind === "frame");
  if (id === "return" && !["auth_not_run", "execution_error"].includes(status) && lastFrame
    && (lastFrame.path === "/login" || /로그인하면\s+즐겨찾기를\s+등록할 수 있어요/.test(lastFrame.visibleText))) {
    status = "auth_not_run";
  }
  await add({ kind: "end", status });
  return { history: evidenceHistory(events), status };
}

function participantEvidence(events, persona) {
  return events.filter(event => event.persona === persona.id && ["action", "end", "auth"].includes(event.kind))
    .map(({ task, frame, action, remark, status }) => ({ task, frame, action, remark, status }));
}

async function askParticipant({ model, persona, events, conversation, question, directory, frame }) {
  const evidence = events.find(event => event.kind === "frame" && event.persona === persona.id && event.frame === frame);
  const { speech } = await model.respond({
    instructions: `${participantPrompt(persona)}\n기록에 근거해 참가자로서 답하세요. 정확히 기억할 수 없으면 그렇게 말하세요.`,
    prompt: JSON.stringify({ experience: participantEvidence(events, persona), conversation, question }),
    image: evidence ? await readFile(join(directory, "screens", evidence.frame + ".png")) : undefined,
  });
  return clean(speech);
}

async function debrief({ model, people, events, record, directory }) {
  for (const persona of people) {
    const own = participantEvidence(events, persona);
    const moment = own.findLast(event => event.task === "return" && event.remark)
      ?? own.find(event => event.remark);
    const question = moment
      ? `${moment.frame}에서 그 행동을 했을 때 무엇을 기대했나요? 기억에 남는 장면을 하나 더 이야기해 주세요.`
      : "화면을 둘러보면서 기억에 남는 장면이 있었나요?";
    try {
      const answer = await askParticipant({ model, persona, events, conversation: [], question, directory, frame: moment?.frame });
      await record({ kind: "interview", persona: persona.id, question, answer });
      console.log(`[${persona.id} 인터뷰] ${question}\n${answer}`);
    } catch (error) {
      await record({ kind: "debrief_error", persona: persona.id, stage: "interview", message: clean(error.message) });
    }
  }
  if (people.length < 2) return;
  const conversation = [];
  for (let round = 1; round <= 2; round += 1) {
    for (const persona of people) {
      try {
        const speech = await askParticipant({
          model, persona, events, conversation,
          question: round === 1
            ? "다른 참가자들에게 사용 중 기억에 남은 장면을 이야기해 주세요. 앞선 발언과 경험이 겹치면 그 점도 말해 주세요."
            : "앞선 참가자의 경험 중 공감하거나 달랐던 점에 직접 답해 주세요.",
        });
        conversation.push({ persona: persona.name ?? personaNames[persona.id] ?? persona.id, speech });
        await record({ kind: "discussion", persona: persona.id, round, speech });
        console.log(`[대화 ${round} · ${persona.id}] ${speech}`);
      } catch (error) {
        await record({ kind: "debrief_error", persona: persona.id, stage: "discussion", message: clean(error.message) });
      }
    }
  }
}

function reviewEvidence(events, frames) {
  const nextFrames = new Map();
  let previous;
  for (const frame of frames.values()) {
    if (previous && previous.persona === frame.persona && previous.task === frame.task) nextFrames.set(previous.frame, frame.frame);
    previous = frame;
  }
  return events.filter(event => ["frame", "action", "action_result", "tap_target", "auth", "end", "error", "interview"].includes(event.kind))
    .map(event => event.kind === "action" ? {
      ...event,
      before: event.frame,
      after: event.action.action === "stop" ? null : nextFrames.get(event.frame) ?? null,
    } : event);
}

async function writeReport({ model, people, events, directory, origin, file = "report.md", effort = "medium" }) {
  const frames = new Map(events.filter(event => event.kind === "frame" && /^P[1-4]-(free|arrival|return)-\d{2}$/.test(event.frame))
    .map(event => [event.frame, event]));
  const links = (ids) => [...new Set(ids)].filter(id => frames.has(id)).map(id => `[${id}](${frames.get(id).image})`).join(", ");
  let review = { assessments: [], findings: [] };
  let reviewError;
  if (frames.size) {
    try {
      const images = await Promise.all([...frames.keys()].map(async frame => ({
        frame, image: await readFile(join(directory, "screens", frame + ".png")),
      })));
      review = await model.respond({
        instructions: `당신은 사용성 테스트 관찰자입니다. 제공된 기록만 증거로 사용하세요.
참가자별 arrival과 return 각각 한 건을 판정하고, 주요 발견은 최대 3건만 작성하세요.
예상 동선은 노선 찾기 → 방향과 정류장 확인 → 도착과 좌석 정보 읽기 → 정류장 저장 시도 → 로그인 안내입니다.
화면에서 목표를 달성했다면 동선이 달라도 success로 판정하세요. 둘 중 한 정보만 확인했으면 partial입니다.
화면에서 서비스가 예보를 제공하지 않았으면 unavailable로 기록하세요. 참가자가 정보를 찾지 못한 상황과 구분하세요.
인증 단계는 운영 비회원 테스트에서 미실행입니다. 실행 오류나 제한에 걸린 경우 기록을 근거로 판단을 보류할 수 있습니다.
반복 조작, 기대와 실제 화면의 차이, 되돌아가기와 우회 행동을 우선 살피세요. 앞뒤 화면과 인터뷰를 대조해 어떤 장면에서 무엇이 바뀌었는지, 참가자가 어떻게 대응했는지 적으세요.
인터뷰는 참가자의 해석입니다. 화면과 행동으로 확인한 사실을 구분하고, 자료로 구분할 수 없는 UI 문제, 모델 조작 실수, 예보 부재는 가설로 남기세요.
tap_target은 같은 frame에서 터치가 전달된 요소와 가장 가까운 조작 요소입니다. target이 null이면 터치 대상이 기록되지 않은 경우입니다. 대상과 앞뒤 화면을 함께 보고, 이 기록만으로 조작 결과를 단정하지 마세요.
after가 null이면 해당 행동 뒤 화면이 기록되지 않았습니다. 판정과 발견의 evidence에는 관련 화면 ID를 하나씩 정확히 적으세요. 범위나 접두어는 사용하지 마세요. 과업 판정의 근거는 그 참가자의 같은 과업 화면에서 고르세요.
기록에 없는 조작이나 결과를 추가하지 마세요.`,
        prompt: JSON.stringify({
          targets: people.map(({ id, target }) => ({ id, target })),
          evidence: reviewEvidence(events, frames),
        }),
        images,
        schema: reviewSchema,
        effort,
        timeout: 240_000,
        maxOutput: 6000,
      });
    } catch (error) {
      if (file !== "report.md") throw error;
      reviewError = clean(error.message);
    }
  } else if (file !== "report.md") {
    throw new Error("재분석할 화면 기록이 없습니다.");
  }

  const lines = [
    "# 연어 UT 결과",
    "",
    `비회원 · ${origin} · ${modelId}`,
    `관찰자 추론 정도 · ${effort}`,
    "",
    "## 자유 탐색",
    "",
  ];
  for (const { id } of people) {
    const name = personaNames[id] ?? id;
    const entries = events.filter(event => event.persona === id && event.phase === "free");
    const first = entries.find(event => event.kind === "action");
    const last = entries.findLast(event => event.kind === "action");
    const locations = new Map(entries.filter(event => event.kind === "frame").map(event => [event.path.split("?")[0], event.frame]));
    const backs = entries.filter(event => event.action?.action === "back");
    lines.push(first
      ? `- ${name} 첫 행동 \`${first.action.action}\` ${markdown(first.remark)} ${links([first.frame])} / 마지막 발언 ${markdown(last.remark)} ${links([last.frame])}`
      : `- ${name} 관찰 기록 없음`);
    if (locations.size) lines.push(`  확인된 화면 · ${[...locations.keys()].map(markdown).join(", ")} ${links([...locations.values()])}`);
    if (backs.length) lines.push(`  뒤로 가기 ${backs.length}회 ${links(backs.map(event => event.frame))}`);
  }
  lines.push("", "## 목표 기반 UT", "", "| 참가자 | 목표 | 결과 | 동선 | 관찰 및 화면 |", "|---|---|---|---|---|");
  for (const persona of people) {
    for (const [id, label] of [["arrival", "도착·좌석 정보"], ["return", "다시 찾기"]]) {
      const end = events.find(event => event.kind === "end" && event.persona === persona.id && event.task === id);
      const matching = (assessment) => assessment.persona === persona.id && assessment.task === id;
      const assessment = review.assessments.find(matching);
      const evidence = assessment?.evidence.filter(frame => frames.get(frame)?.persona === persona.id && frames.get(frame)?.task === id) ?? [];
      const evaluated = evidence.length > 0 ? assessment : undefined;
      const status = outcome[end?.status] ?? outcome[evaluated?.outcome] ?? outcome.uncertain;
      const last = events.findLast(event => event.kind === "frame" && event.persona === persona.id && event.task === id);
      lines.push(`| ${personaNames[persona.id] ?? persona.id} | ${label} | ${status} | ${flow[evaluated?.flow] ?? flow.unknown} | ${markdown(evaluated?.note ?? "")} ${links(evidence.length ? evidence : [last?.frame])} |`);
    }
  }
  lines.push("", "## 주요 관찰", "");
  const findings = review.findings.filter(finding => links(finding.evidence)).slice(0, 3);
  if (reviewError) lines.push(`판정 생성 실패 · ${markdown(reviewError)}`);
  else if (!findings.length) lines.push("기록을 근거로 정리된 발견이 없습니다.");
  for (const finding of findings) {
    lines.push(`- 관찰 · ${markdown(finding.observed)} ${links(finding.evidence)}\n  해석 · ${markdown(finding.interpretation)}`);
  }
  lines.push("", "## 인터뷰와 그룹 대화", "", "[개별 인터뷰](interviews.md) · [그룹 대화](discussion.md) · [전체 행동 로그](events.jsonl)", "", "합성 참가자의 관찰은 실제 사용자 UT에서 확인할 가설입니다.", "");
  const temporary = join(directory, `.${file}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, lines.join("\n"));
    await rename(temporary, join(directory, file));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function regenerateReport({ model, runId, root = "runs", effort = "medium" }) {
  if (!/^[\w-]+$/.test(runId)) throw new Error("올바른 실행 ID를 입력해 주세요.");
  if (!["low", "medium"].includes(effort)) throw new Error("관찰자 추론 정도는 low 또는 medium을 선택해 주세요.");
  const directory = join(root, runId);
  const [run, log] = await Promise.all([
    readFile(join(directory, "run.json"), "utf8"),
    readFile(join(directory, "events.jsonl"), "utf8"),
  ]);
  const { people, origin } = JSON.parse(run);
  const events = parseEvents(log);
  const file = `report-${effort}.md`;
  await writeReport({ model, people, events, directory, origin, file, effort });
  return join(directory, file);
}

export async function launchStudy(options) {
  await options.model.check();
  const browser = await chromium.launch({ headless: Boolean(process.env.UT_SANDBOX_PROXY_KEY) });
  try {
    return await runStudy({ ...options, browser });
  } finally {
    await browser.close();
  }
}

export async function runStudy({ model, browser, people, root = "runs", origin = production, onStart }) {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = join(root, id);
  await mkdir(join(directory, "screens"), { recursive: true });
  await writeFile(join(directory, "run.json"), JSON.stringify({ id, origin, model: modelId, dataset, people }, null, 2) + "\n");
  const events = [];
  const record = async (event) => {
    const entry = { at: new Date().toISOString(), ...event };
    await appendEvent(join(directory, "events.jsonl"), entry);
    events.push(entry);
    if (event.kind === "interview") {
      await appendFile(join(directory, "interviews.md"), `## ${personaNames[event.persona] ?? event.persona}\n\n질문 · ${markdown(event.question)}\n\n답변 · ${markdown(event.answer)}\n\n`);
    }
    if (event.kind === "discussion") {
      await appendFile(join(directory, "discussion.md"), `- ${event.round}차 ${personaNames[event.persona] ?? event.persona} · ${markdown(event.speech)}\n`);
    }
  };
  await writeFile(join(directory, "interviews.md"), "# 개별 인터뷰\n\n");
  await writeFile(join(directory, "discussion.md"), "# 참가자 그룹 대화\n\n" + (people.length < 2 ? "파일럿은 개별 인터뷰만 진행합니다.\n" : ""));
  onStart?.(id);
  console.log(`실행 ${id}`);
  for (const persona of people) {
    const free = { id: "free", prompt: "처음 연 화면입니다. 평소 하듯 둘러보고 끝나면 알려주세요." };
    for (const tasks of [[free], tasksFor(persona)]) {
      console.log(`[${persona.id}] ${tasks.length === 1 ? "자유 탐색" : "목표 기반 UT"}`);
      let session;
      try {
        session = await openSession(browser, { origin });
        const isFree = tasks.length === 1;
        const deadline = Date.now() + (isFree ? 180_000 : 600_000);
        const history = [];
        for (const task of tasks) {
          const phase = await runPhase({ session, persona, task, limit: isFree ? 12 : 24, deadline, model, record, directory, history });
          history.push(...phase.history);
          if (phase.status === "auth_not_run") {
            for (const skipped of tasks.slice(tasks.indexOf(task) + 1)) {
              await record({ kind: "end", persona: persona.id, phase: "guided", task: skipped.id, status: "auth_not_run" });
            }
            break;
          }
        }
      } catch (error) {
        await record({ kind: "error", persona: persona.id, phase: tasks[0].id, message: clean(error.message) });
        for (const task of tasks) {
          if (!events.some(event => event.kind === "end" && event.persona === persona.id && event.task === task.id)) {
            await record({ kind: "end", persona: persona.id, task: task.id, status: "execution_error" });
          }
        }
      } finally {
        await session?.close();
      }
    }
  }
  await debrief({ model, people, events, record, directory });
  await writeReport({ model, people, events, directory, origin });
  return directory;
}

export async function openInterview(runId, personaId, root = "runs") {
  if (!/^[\w-]+$/.test(runId)) throw new Error("올바른 실행 ID를 입력해 주세요.");
  const directory = join(root, runId);
  const run = JSON.parse(await readFile(join(directory, "run.json"), "utf8"));
  const persona = run.people.find(person => person.id === personaId);
  if (!persona) throw new Error("이 실행에 해당 참가자가 없습니다.");
  const logPath = join(directory, "events.jsonl");
  const events = parseEvents(await readFile(logPath, "utf8"));
  const conversation = events.filter(event => event.kind === "interview" && event.persona === persona.id)
    .map(({ question, answer }) => ({ question, answer }));
  return {
    async ask(model, question) {
      const frame = question.match(/\bP[1-4]-(?:free|arrival|return)-\d{2}\b/)?.[0]
        ?? events.findLast(event => event.kind === "frame" && event.persona === personaId)?.frame;
      const answer = await askParticipant({ model, persona, events, conversation, question, directory, frame });
      await appendEvent(logPath, { at: new Date().toISOString(), kind: "interview", persona: persona.id, question, answer });
      await appendFile(join(directory, "interviews.md"), `## ${personaNames[persona.id] ?? persona.id} 추가 질문\n\n질문 · ${markdown(question)}\n\n답변 · ${markdown(answer)}\n\n`);
      return answer;
    },
  };
}
