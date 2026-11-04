const $ = id => document.getElementById(id);
const tasks = { free: "자유 탐색", arrival: "도착·좌석 확인", return: "다시 찾기" };
const actions = { tap: "탭", input: "입력", scroll: "스크롤", back: "뒤로 가기", stop: "탐색 마침" };
const statuses = {
  stopped: "탐색 마침", auth_not_run: "인증 미실행", not_run: "인증 미실행",
  execution_error: "실행 오류", action_limit: "조작 횟수 도달", time_limit: "시간 제한 도달",
  authenticated: "인증 완료", cancelled: "인증 취소", failed: "인증 실패", timeout: "인증 시간 초과",
};
const date = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });
const clock = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

let selected;
let pinnedRun = false;
let pinnedFrame;
let participant = "";
let details;
let runList;
let listVersion;
let detailVersion;
let control = {};
let starting = false;
let launchError = "";
let followJob;
let asking = false;
let reviewing = false;

function personaName(id) {
  return control.personaNames?.[id] ?? id;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function setSync(online) {
  const status = $("sync");
  const message = online ? "자동 갱신 중" : "기록 연결 확인 중";
  if (status.textContent !== message) status.textContent = message;
  status.classList.toggle("online", online);
}

function runDate(id) {
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(id);
  return parts ? date.format(new Date(`${parts[1]}T${parts[2]}:${parts[3]}:${parts[4]}Z`)) : id;
}

async function getText(path) {
  const response = await fetch(path, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("기록 조회 실패");
  return response.text();
}

async function post(path, fields) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...fields, key: control.hasKey ? undefined : $("api-key").value }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function renderLaunch() {
  for (const option of $("run-persona").options) {
    if (option.value === "all") continue;
    const label = personaName(option.value);
    if (option.textContent !== label) option.textContent = label;
  }
  $("key-field").hidden = Boolean(control.hasKey);
  const waiting = starting || (followJob !== undefined && control.job !== followJob);
  $("launch-button").disabled = waiting || control.state === "running";
  const message = waiting ? "실행 준비 중입니다."
    : launchError || ({
      running: control.id ? "UT 실행 중입니다. 새 기록이 자동으로 표시됩니다." : "모델 접근과 브라우저를 확인하고 있습니다.",
      failed: control.error,
      finished: "UT 실행이 끝났습니다.",
    })[control.state] || "운영 웹을 비회원으로 탐색합니다.";
  if ($("launch-feedback").textContent !== message) $("launch-feedback").textContent = message;
}

function renderRuns() {
  $("runs").replaceChildren(...runList.map(({ id, people }) => {
    const button = el("button", undefined, "run-link");
    button.type = "button";
    button.dataset.run = id;
    button.setAttribute("aria-pressed", String(id === selected));
    button.append(el("strong", runDate(id)), el("small", people.map(personaName).join(" · ")));
    return button;
  }));
  if (!runList.length) $("runs").append(el("p", "저장된 실행이 없습니다.", "muted"));
}

function chooseRun(id) {
  if (id === selected) return;
  selected = id;
  participant = "";
  pinnedFrame = undefined;
  details = undefined;
  detailVersion = undefined;
  $("interview-form").reset();
  $("interview-feedback").textContent = "";
  $("interview-records").scrollTop = 0;
  $("discussion-records").scrollTop = 0;
  $("review-feedback").textContent = "";
}

function captureUrl(frame) {
  return `/api/runs/${encodeURIComponent(selected)}/screens/${encodeURIComponent(frame)}.png`;
}

function eventText(event) {
  switch (event.kind) {
    case "frame": return ["화면 캡처", event.path];
    case "action": {
      const { action, text } = event.action;
      const label = actions[action] ?? action;
      return [action === "input" && text ? `${label} · ${text}` : label, event.remark];
    }
    case "action_result": return ["조작 결과", event.result];
    case "auth": return ["인증", statuses[event.status] ?? event.status];
    case "end": return ["단계 종료", statuses[event.status] ?? event.status];
    case "error": return ["실행 오류", event.message];
    default: return ["응답 오류", event.message];
  }
}

function renderActivity() {
  const events = details.events.filter(event => !participant || event.persona === participant);
  const frames = new Map(events.filter(event => event.kind === "frame").map(event => [event.frame, event]));
  const current = frames.get(pinnedFrame) ?? [...frames.values()].at(-1);
  const image = $("capture");
  image.hidden = !current;
  $("screen").classList.toggle("has-image", Boolean(current));
  $("follow").disabled = !current || !pinnedFrame;
  $("frame-info").textContent = current
    ? `${personaName(current.persona)} · ${tasks[current.task] ?? current.task} · ${current.frame}`
    : "아직 캡처가 없습니다.";
  if (current) {
    const url = captureUrl(current.frame);
    image.alt = `${personaName(current.persona)}의 ${tasks[current.task]} 화면 ${current.frame}`;
    if (image.getAttribute("src") !== url) image.src = url;
  } else {
    image.removeAttribute("src");
  }

  const spoken = new Set(events.filter(event => event.kind === "action").map(event => event.frame));
  const timeline = events.filter(event => !["interview", "discussion", "debrief_error"].includes(event.kind)
    && (event.kind !== "frame" || !spoken.has(event.frame))).reverse();
  const list = $("events");
  const scroll = list.scrollTop;
  list.replaceChildren(...timeline.map(event => {
    const entry = el("li");
    const node = el(frames.has(event.frame) ? "button" : "div", undefined, "event");
    if (node.tagName === "BUTTON") {
      node.type = "button";
      node.dataset.frame = event.frame;
      node.setAttribute("aria-pressed", String(event.frame === current?.frame));
    }
    const [label, remark] = eventText(event);
    const meta = [personaName(event.persona), tasks[event.task], event.at ? clock.format(new Date(event.at)) : ""].filter(Boolean).join(" · ");
    node.append(el("small", meta), el("strong", label));
    if (remark) node.append(el("p", remark));
    entry.append(node);
    return entry;
  }));
  if (!timeline.length) list.append(el("li", "기록이 들어오면 여기에 표시됩니다.", "muted"));
  list.scrollTop = scroll;
}

function chatMessage({ persona, text, at, outgoing = false }) {
  const sender = outgoing ? "진행자" : personaName(persona);
  const message = el("li", undefined, outgoing ? "chat-message outgoing" : "chat-message");
  const body = el("div", undefined, "chat-body");
  const line = el("div", undefined, "chat-line");
  line.append(el("p", text, "chat-bubble"));
  if (at) {
    const time = el("time", clock.format(new Date(at)));
    time.dateTime = at;
    line.append(time);
  }
  body.append(el("strong", sender, "chat-sender"), line);
  if (!outgoing) {
    const avatar = el("span", sender.slice(0, 1), "chat-avatar");
    avatar.dataset.persona = persona;
    avatar.setAttribute("aria-hidden", "true");
    message.append(avatar);
  }
  message.append(body);
  return message;
}

function renderChat(list, messages, emptyMessage) {
  const previousTop = list.scrollTop;
  const atBottom = list.clientHeight > 0 && list.scrollHeight - previousTop - list.clientHeight < 32;
  list.replaceChildren(...(messages.length ? messages : [el("li", emptyMessage, "chat-empty")]));
  list.scrollTop = atBottom ? list.scrollHeight : previousTop;
}

function renderRecords() {
  const interviews = details.events.filter(event => event.kind === "interview");
  renderChat($("interview-records"), interviews.flatMap(event => [
    chatMessage({ text: event.question, outgoing: true }),
    chatMessage({ persona: event.persona, text: event.answer, at: event.at }),
  ]), "아직 인터뷰 기록이 없습니다.");

  const discussion = details.events.filter(event => event.kind === "discussion");
  const messages = discussion.flatMap((event, index) => {
    const message = chatMessage({ persona: event.persona, text: event.speech, at: event.at });
    if (event.round === discussion[index - 1]?.round) return [message];
    const divider = el("li", undefined, "chat-divider");
    divider.append(el("span", `${event.round}차 대화`));
    return [divider, message];
  });
  renderChat($("discussion-records"), messages, details.run.people.length === 1
      ? "참가자가 한 명이면 개별 인터뷰가 기록됩니다."
      : "아직 그룹 대화 기록이 없습니다.");

  renderReports();
}

function updateReviewButtons() {
  for (const button of $("review-controls").querySelectorAll("button")) {
    button.disabled = reviewing || !details || details.report === null;
  }
}

function renderReports() {
  const records = $("report-records");
  records.replaceChildren();
  updateReviewButtons();
  if (details.report === null) {
    records.append(el("p", "리포트가 생성되면 여기에 표시됩니다.", "muted"));
    return;
  }
  const reportContents = (file, contents) => {
    const download = el("a", "Markdown 다운로드");
    download.href = `/api/runs/${encodeURIComponent(selected)}/${file}`;
    download.download = file;
    const preview = el("div", undefined, "report-preview");
    // The server renders Markdown with raw HTML disabled and a link allowlist.
    preview.innerHTML = details.reportPreviews[file];
    return [download, preview, el("pre", contents, "report-source")];
  };
  const defaultIsMedium = details.report.includes("\n관찰자 추론 정도 · medium\n");
  const medium = details.reviewReport ?? (defaultIsMedium ? details.report : null);
  const comparison = el("div", undefined, "report-comparison");
  for (const [effort, contents, file] of [
    ["medium", medium, details.reviewReport ? "report-medium.md" : "report.md"],
    ["low", details.lowReport, "report-low.md"],
  ]) {
    const panel = el("section", undefined, "report-panel");
    const title = el("h4", `${effort} 리포트`);
    title.id = `report-title-${effort}`;
    panel.setAttribute("aria-labelledby", title.id);
    panel.append(title);
    if (contents) panel.append(...reportContents(file, contents));
    else panel.append(el("p", `${effort}로 재분석하면 여기에 표시됩니다.`, "muted"));
    comparison.append(panel);
  }
  records.append(comparison);
  if (!defaultIsMedium || details.reviewReport) {
    const original = el("details");
    original.open = !medium && !details.lowReport;
    original.append(el("summary", "이전 리포트 보기"), ...reportContents("report.md", details.report));
    records.append(original);
  }
}

function renderDetail() {
  $("empty").hidden = Boolean(details) || Boolean(selected);
  $("detail").hidden = !details;
  if (!details) return;

  const { run, report } = details;
  $("run-title").textContent = runDate(run.id);
  $("run-info").textContent = `${run.people.map(person => personaName(person.id)).join(" · ")} / ${run.model}`;
  $("run-status").textContent = report === null ? "리포트 대기" : "리포트 준비됨";
  const select = $("participant");
  const ids = run.people.map(person => person.id);
  if ([...select.options].slice(1).map(option => option.value).join() !== ids.join()) {
    select.replaceChildren(new Option("전체", ""), ...ids.map(id => new Option(personaName(id), id)));
  }
  select.value = participant;
  const interviewSelect = $("interview-persona");
  if ([...interviewSelect.options].map(option => option.value).join() !== ids.join()) {
    interviewSelect.replaceChildren(...ids.map(id => new Option(personaName(id), id)));
  }
  $("interview-button").disabled = asking || report === null;
  const feedback = $("interview-feedback");
  if (report === null) feedback.textContent = "리포트가 준비되면 추가 질문을 보낼 수 있습니다.";
  else if (feedback.textContent === "리포트가 준비되면 추가 질문을 보낼 수 있습니다.") feedback.textContent = "";
  renderActivity();
  renderRecords();
}

async function loadDetail(id) {
  const data = await getText(`/api/runs/${encodeURIComponent(id)}`);
  if (id !== selected || data === detailVersion) return;
  details = JSON.parse(data);
  detailVersion = data;
  renderDetail();
}

$("runs").addEventListener("click", event => {
  const id = event.target.closest("[data-run]")?.dataset.run;
  if (!id) return;
  pinnedRun = true;
  chooseRun(id);
  renderRuns();
  renderDetail();
  loadDetail(id).catch(() => setSync(false));
});
$("events").addEventListener("click", event => {
  const frame = event.target.closest("[data-frame]")?.dataset.frame;
  if (!frame) return;
  pinnedFrame = frame;
  renderActivity();
  [...$("events").querySelectorAll("button")].find(button => button.dataset.frame === frame)?.focus();
});
$("participant").addEventListener("change", event => {
  participant = event.target.value;
  pinnedFrame = undefined;
  renderActivity();
});
$("follow").addEventListener("click", () => {
  pinnedFrame = undefined;
  renderActivity();
});
function showView(view) {
  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === view;
    button.setAttribute("aria-pressed", String(active));
    $(button.dataset.view).hidden = !active;
  }
}
document.querySelector(".tabs").addEventListener("click", event => {
  if (event.target.dataset.view) showView(event.target.dataset.view);
});
$("launch-form").addEventListener("submit", async event => {
  event.preventDefault();
  if ($("launch-button").disabled) return;
  starting = true;
  launchError = "";
  renderLaunch();
  try {
    const { job } = await post("/api/runs", { persona: $("run-persona").value });
    followJob = job;
  } catch (error) {
    launchError = error.message;
  } finally {
    starting = false;
    renderLaunch();
  }
});
$("interview-form").addEventListener("submit", async event => {
  event.preventDefault();
  const field = $("interview-question");
  const question = field.value.trim();
  if ($("interview-button").disabled || !question || !selected) return;
  const id = selected;
  const feedback = $("interview-feedback");
  asking = true;
  $("interview-button").disabled = true;
  feedback.textContent = "답변을 기다리고 있습니다.";
  try {
    await post(`/api/runs/${encodeURIComponent(id)}/interview`, { persona: $("interview-persona").value, question });
    if (selected === id) {
      if (field.value.trim() === question) field.value = "";
      feedback.textContent = "답변을 인터뷰 기록에 추가했습니다.";
      loadDetail(id).then(() => {
        if (selected === id) $("interview-records").scrollTop = $("interview-records").scrollHeight;
      }).catch(() => setSync(false));
    }
  } catch (error) {
    if (selected === id) feedback.textContent = error.message;
  } finally {
    asking = false;
    $("interview-button").disabled = !details || details.report === null;
  }
});
$("review-controls").addEventListener("click", async event => {
  const button = event.target.closest("button[data-review]");
  if (!selected || !button || button.disabled) return;
  const effort = button.dataset.review;
  const id = selected;
  const feedback = $("review-feedback");
  reviewing = true;
  updateReviewButtons();
  feedback.textContent = `${effort}로 화면과 인터뷰를 다시 살펴보고 있습니다.`;
  try {
    await post(`/api/runs/${encodeURIComponent(id)}/review`, { effort });
    if (selected === id) {
      feedback.textContent = `${effort} 리포트를 저장했습니다.`;
      loadDetail(id).catch(() => setSync(false));
    }
  } catch (error) {
    if (selected === id) feedback.textContent = error.message;
  } finally {
    reviewing = false;
    updateReviewButtons();
  }
});
$("report-modes").addEventListener("click", event => {
  const button = event.target.closest("button[data-mode]");
  if (!button) return;
  $("report").dataset.reportMode = button.dataset.mode;
  for (const option of $("report-modes").querySelectorAll("button")) {
    option.setAttribute("aria-pressed", String(option === button));
  }
});
$("report-records").addEventListener("click", event => {
  const view = event.target.closest(".report-preview a[href^='#']")?.getAttribute("href").slice(1);
  if (!view) return;
  event.preventDefault();
  showView(view);
  document.querySelector(`[data-view="${view}"]`).focus();
});

async function refresh() {
  try {
    const [data, status] = await Promise.all([getText("/api/runs"), getText("/api/control")]);
    control = JSON.parse(status);
    if (data !== listVersion) {
      runList = JSON.parse(data);
      listVersion = data;
      if (!pinnedRun || !runList.some(run => run.id === selected)) {
        pinnedRun = false;
        chooseRun(runList[0]?.id);
      }
      renderRuns();
      renderDetail();
    }
    if (followJob !== undefined && control.job === followJob) {
      if (runList.some(run => run.id === control.id)) {
        pinnedRun = true;
        chooseRun(control.id);
        showView("activity");
        renderRuns();
        renderDetail();
        followJob = undefined;
      } else if (control.state === "failed") {
        followJob = undefined;
      }
    }
    renderLaunch();
    if (selected) await loadDetail(selected);
    setSync(true);
  } catch {
    setSync(false);
  } finally {
    setTimeout(refresh, 1500);
  }
}

void refresh();
