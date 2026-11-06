import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
const files = await Promise.all(workerFiles.map(async path => ({ path, content: await readFile(path) })));
const hash = createHash("sha256");
for (const file of files) hash.update(file.path).update("\0").update(file.content).update("\0");
const bundle = { version: hash.digest("hex"), commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  lockHash: createHash("sha256").update(files.find(file => file.path === "package-lock.json").content).digest("hex"), files };
const applyScript = String.raw`
set -eu
stage=.ut-update/$UT_WORKER_VERSION
probe() {
  node -e 'fetch(process.env.UT_CONTROL_URL, { headers: { "x-ut-proxy-key": process.env.UT_SANDBOX_PROXY_KEY }, signal: AbortSignal.timeout(2000) }).then(async response => {
    if (!response.ok) throw new Error("상태 확인 실패");
    const control = await response.json();
    process.exit(control.version === process.env.UT_WORKER_VERSION ? 10 : control.busy || control.state === "running" ? 75 : 0);
  }).catch(error => process.exit(error.cause?.code === "ECONNREFUSED" ? 0 : 75));' || {
    status=$?; if [ "$status" -eq 10 ]; then rm -rf "$stage"; exit 0; fi; exit "$status"
  }
}
probe
if [ "$(cat .ut-installed-lock 2>/dev/null || true)" != "$UT_LOCK_HASH" ]; then
  (cd "$stage"; npm ci --omit=dev; npx playwright install --with-deps chromium)
fi
probe
pkill -TERM -f '(^|/)node viewer\.js$' || { status=$?; [ "$status" -eq 1 ] || exit "$status"; }
flock -w 5 .ut-viewer.lock true || exit 76
if [ -d "$stage/node_modules" ]; then
  rm -rf node_modules
  mv "$stage/node_modules" node_modules
  printf '%s' "$UT_LOCK_HASH" > .ut-installed-lock
fi
if [ "$(cat worker-version.json 2>/dev/null || true)" != "$UT_WORKER_STAMP" ]; then
  rm -f worker-version.json
  cp -R "$stage"/. .
  printf '%s' "$UT_WORKER_STAMP" > worker-version.json
fi
rm -rf "$stage"
`;
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

export async function syncWorker(sandbox, { key, bundle, port = 4310, attempts = 25, delay = 400 }) {
  const domain = sandbox.domain(port);
  const poll = async target => {
    let control = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(`${domain}/api/control`, {
          headers: { "x-ut-proxy-key": key }, signal: AbortSignal.timeout(2500),
        });
        if (response.ok) { control = await response.json(); if (!target || control.version === target) return control; }
        else await response.body?.cancel();
      } catch {}
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delay));
    }
    return control;
  };
  const control = await poll();
  if (control && (control.version === bundle.version || control.busy || control.state === "running")) return domain;
  let applied = false;
  try {
    await sandbox.writeFiles(bundle.files.map(file => ({ ...file, path: `.ut-update/${bundle.version}/${file.path}` })));
    const command = await sandbox.runCommand({ cmd: "flock", args: ["-w", "120", ".ut-sync.lock", "sh", "-c", applyScript],
      env: { UT_SANDBOX_PROXY_KEY: key, UT_WORKER_VERSION: bundle.version, UT_WORKER_STAMP: JSON.stringify({ version: bundle.version, commit: bundle.commit }),
        UT_LOCK_HASH: bundle.lockHash, UT_CONTROL_URL: `http://127.0.0.1:${port}/api/control` } });
    if (command.exitCode === 75) return domain;
    if (command.exitCode === 76) {
      console.error("UT Sandbox 워커가 종료되지 않았습니다.");
      return domain;
    }
    if (command.exitCode !== 0) throw Object.assign(new Error(await command.stderr()), { exitCode: command.exitCode });
    applied = true;
  } catch (error) {
    console.error("UT Sandbox 동기화 실패", error.exitCode ?? null, error.message.replaceAll(key, "[숨김]").split("\n")[0]);
  }
  await startWorker(sandbox, key);
  const ready = await poll(applied ? bundle.version : null);
  if (!ready) throw new Error("Sandbox viewer did not start");
  if (applied && ready.version !== bundle.version) console.error("UT Sandbox 버전 불일치", ready.version ?? null);
  return domain;
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
      await instance.writeFiles(bundle.files);
      await install(instance, "npm", ["ci", "--omit=dev"]);
      await install(instance, "npx", ["playwright", "install", "--with-deps", "chromium"]);
      await instance.writeFiles([
        { path: "worker-version.json", content: JSON.stringify({ version: bundle.version, commit: bundle.commit }) },
        { path: ".ut-installed-lock", content: bundle.lockHash },
      ]);
      await startWorker(instance, key);
    },
    onResume: instance => startWorker(instance, key),
  });
  return { domain: await syncWorker(sandbox, { key, bundle }), key };
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
