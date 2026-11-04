import { createServer } from "node:http";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createModel } from "./model.js";
import { launchStudy, openInterview } from "./run.js";
import { personas } from "./study.js";

const runId = "[\\w-]+";
const frameId = "P[123]-(?:free|arrival|return)-\\d{2}";
const runPath = new RegExp(`^/api/runs/(${runId})$`);
const interviewPath = new RegExp(`^/api/runs/(${runId})/interview$`);
const assetPath = new RegExp(`^/api/runs/(${runId})/(report\\.md|screens/${frameId}\\.png)$`);
const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

async function readOptional(path, encoding) {
  try {
    return await readFile(path, encoding);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function parseEvents(log) {
  const lines = log.split("\n");
  // The poll may overlap with an append. The next poll will pick up a partial line.
  lines.pop();
  return lines.filter(Boolean).map(line => JSON.parse(line));
}

async function readRequest(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) return null;
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return input && typeof input === "object" && !Array.isArray(input) ? input : null;
  } catch {
    return null;
  }
}

function message(error) {
  return error.message.split("\n")[0].slice(0, 220);
}

export function createViewer({ root = "runs", makeModel = createModel, startStudy = launchStudy } = {}) {
  const runs = resolve(root);
  let study = { state: "idle", id: null };
  let nextJob = 0;
  const interviews = new Set();
  const readRun = async (id, file, encoding) => {
    try {
      const path = await realpath(join(runs, id, file));
      const base = await realpath(runs);
      const inside = relative(base, path);
      if (!inside.startsWith(id + sep)) return null;
      return readOptional(path, encoding);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return null;
    }
  };

  return createServer(async (request, response) => {
    const send = (status, type, body) => {
      response.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(body);
    };
    const json = (status, body) => send(status, "application/json; charset=utf-8", JSON.stringify(body));
    try {
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(request.headers.host ?? "")) {
        return json(403, { error: "로컬 주소에서 열어 주세요." });
      }
      const path = request.url.split("?")[0];
      if (request.method === "POST") {
        if (request.headers.origin !== `http://${request.headers.host}`
          || request.headers["content-type"] !== "application/json") {
          return json(403, { error: "관찰실 페이지에서 다시 시도해 주세요." });
        }
        const interview = path.match(interviewPath);
        if (path !== "/api/runs" && !interview) return json(404, { error: "지원하지 않는 요청입니다." });
        const input = await readRequest(request);
        if (!input || (input.key !== undefined && (typeof input.key !== "string" || input.key.length > 512))) {
          return json(400, { error: "입력값을 확인해 주세요." });
        }
        const key = input.key?.trim() || undefined;
        if (path === "/api/runs") {
          if (study.state === "running") return json(409, { error: "이미 실행 중인 UT가 있습니다." });
          const people = input.persona === "all" ? personas : personas.filter(person => person.id === input.persona);
          if (!people.length) return json(400, { error: "실행할 참가자를 선택해 주세요." });
          let model;
          try {
            model = makeModel(key);
          } catch (error) {
            return json(400, { error: message(error) });
          }
          study = { state: "running", id: null, job: ++nextJob };
          void (async () => {
            try {
              await startStudy({ model, people, root: runs, onStart: id => { study.id = id; } });
              study.state = "finished";
            } catch (error) {
              study.state = "failed";
              study.error = message(error);
            }
          })();
          return json(202, { job: study.job });
        }

        const [, id] = interview;
        const question = typeof input.question === "string" ? input.question.trim() : "";
        if (!question || question.length > 1000 || !personas.some(person => person.id === input.persona)) {
          return json(400, { error: "참가자와 질문을 확인해 주세요." });
        }
        const metadata = await readRun(id, "run.json", "utf8");
        if (!metadata || !JSON.parse(metadata).people.some(person => person.id === input.persona)) {
          return json(404, { error: "이 실행에서 참가자를 찾을 수 없습니다." });
        }
        if (!await readRun(id, "report.md", "utf8")) return json(409, { error: "리포트가 준비되면 추가 질문을 보낼 수 있습니다." });
        if (interviews.has(id)) return json(409, { error: "이 실행의 다른 질문에 답변 중입니다." });
        interviews.add(id);
        try {
          const conversation = await openInterview(id, input.persona, runs);
          const answer = await conversation.ask(makeModel(key), question);
          return json(200, { answer });
        } catch (error) {
          return json(400, { error: message(error) });
        } finally {
          interviews.delete(id);
        }
      }
      if (request.method !== "GET") return json(405, { error: "지원하지 않는 요청입니다." });
      if (Object.hasOwn(files, path)) {
        const [file, type] = files[path];
        return send(200, type, await readFile(new URL(`./web/${file}`, import.meta.url)));
      }
      if (path === "/api/runs") {
        const entries = await readdir(runs, { withFileTypes: true }).catch(error => {
          if (error.code !== "ENOENT") throw error;
          return [];
        });
        const ids = entries.filter(entry => entry.isDirectory() && /^[\w-]+$/.test(entry.name)).map(entry => entry.name).sort().reverse();
        const records = await Promise.all(ids.map(async id => {
          const source = await readRun(id, "run.json", "utf8");
          if (!source?.endsWith("\n")) return null;
          const run = JSON.parse(source);
          return { id, people: run.people.map(person => person.id) };
        }));
        return json(200, records.filter(Boolean));
      }
      if (path === "/api/control") return json(200, { ...study, hasKey: Boolean(process.env.OPENAI_API_KEY?.trim()) });
      const run = path.match(runPath);
      if (run) {
        const [, id] = run;
        const [metadata, log, report] = await Promise.all(
          ["run.json", "events.jsonl", "report.md"].map(file => readRun(id, file, "utf8")),
        );
        if (metadata) return json(200, { run: JSON.parse(metadata), events: parseEvents(log ?? ""), report });
      }
      const asset = path.match(assetPath);
      if (asset) {
        const [, id, file] = asset;
        const data = await readRun(id, file);
        if (data) return send(200, file.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8", data);
      }
      return json(404, { error: "기록을 찾을 수 없습니다." });
    } catch (error) {
      console.error("UT 뷰어에서 기록을 읽지 못했습니다.", error.message);
      return json(500, { error: "기록을 읽지 못했습니다." });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createViewer().listen(4310, "127.0.0.1", () => console.log("연어 UT 뷰어 · http://127.0.0.1:4310"));
}
