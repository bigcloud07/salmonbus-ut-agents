import { readFile } from "node:fs/promises";
import { Sandbox } from "@vercel/sandbox";

const port = 4310;
const workerName = "salmonbus-ut-runner";
const assets = new Map([
  ["/", ["web/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["web/app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["web/styles.css", "text/css; charset=utf-8"]],
]);
const workerFiles = ["viewer.js", "run.js", "study.js", "model.js", "browser.js",
  "package.json", "package-lock.json", "data/nemotron-personas-korea.json"];
const noCache = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};
let startingWorker;
let activeWorker;

async function install(sandbox, cmd, args) {
  const command = await sandbox.runCommand(cmd, args);
  if (command.exitCode !== 0) throw new Error(`Sandbox setup failed: ${cmd} (${command.exitCode})`);
}

async function startWorker(sandbox, key) {
  await sandbox.runCommand({
    cmd: "flock", args: ["-n", ".ut-viewer.lock", "node", "viewer.js"],
    env: { UT_SANDBOX_PROXY_KEY: key },
    detached: true,
  });
}

async function connectWorker(key) {
  const sandbox = await Sandbox.getOrCreate({
    name: workerName,
    image: "vercel/sandbox/universal",
    ports: [port],
    region: "icn1",
    timeout: 45 * 60 * 1000,
    persistent: true,
    keepLastSnapshots: { count: 1, expiration: 0 },
    resume: true,
    onCreate: async instance => {
      await instance.writeFiles(await Promise.all(workerFiles.map(async path => ({ path, content: await readFile(path) }))));
      await install(instance, "npm", ["ci", "--omit=dev"]);
      await install(instance, "npx", ["playwright", "install", "--with-deps", "chromium"]);
      await startWorker(instance, key);
    },
    onResume: instance => startWorker(instance, key),
  });
  const domain = sandbox.domain(port);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const probe = await fetch(`${domain}/api/control`, {
        headers: { "x-ut-proxy-key": key }, signal: AbortSignal.timeout(2500),
      });
      await probe.body?.cancel();
      if (probe.ok) return { domain, key };
    } catch { /* Sandbox port may not be ready yet. */ }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error("Sandbox viewer did not start");
}

function worker(key) {
  if (activeWorker?.validUntil > Date.now()) return activeWorker;
  startingWorker ??= connectWorker(key)
    .then(instance => { activeWorker = { ...instance, validUntil: Date.now() + 30_000 }; return activeWorker; })
    .finally(() => { startingWorker = undefined; });
  return startingWorker;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = "/" + (url.searchParams.get("ut_path") ?? url.pathname).replace(/^\/+/, "");
    if (request.method === "GET" && assets.has(path)) {
      const [file, type] = assets.get(path);
      return new Response(await readFile(file), { headers: { ...noCache, "Content-Type": type } });
    }
    if (!/^\/api\/(?:control|runs(?:\/[\w./-]+)?)$/.test(path) || path.split("/").includes("..")) {
      return new Response(null, { status: 404, headers: noCache });
    }
    if (request.method === "POST" && request.headers.get("origin") !== url.origin) {
      return Response.json({ error: "관찰실 페이지에서 다시 시도해 주세요." }, { status: 403, headers: noCache });
    }
    if (!["GET", "POST"].includes(request.method)) return new Response(null, { status: 405, headers: noCache });

    const workerKey = process.env.UT_WORKER_SECRET;
    if (!workerKey) return Response.json({ error: "브라우저 실행 환경 설정이 필요합니다." }, { status: 503, headers: noCache });
    try {
      const { domain, key } = await worker(workerKey);
      const headers = { "x-ut-proxy-key": key };
      if (request.method === "POST") headers["Content-Type"] = request.headers.get("content-type") ?? "";
      const upstream = await fetch(domain + path, {
        method: request.method,
        headers,
        body: request.method === "POST" ? await request.text() : undefined,
        redirect: "error",
      });
      if (upstream.status === 410) activeWorker = undefined;
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { ...noCache, "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream" },
      });
    } catch (error) {
      activeWorker = undefined;
      console.error("UT Sandbox 요청 실패", error.message.split("\n")[0]);
      return Response.json({ error: "Vercel 브라우저 실행 환경을 열지 못했습니다." }, { status: 502, headers: noCache });
    }
  },
};
