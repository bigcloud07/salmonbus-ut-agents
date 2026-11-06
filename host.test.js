import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, mock, test } from "node:test";
import { promisify } from "node:util";
import { syncWorker } from "./api/host.js";

const execute = promisify(execFile);
const output = new AsyncLocalStorage();
const workerSource = version => `process.getBuiltinModule("fs").appendFileSync(process.env.UT_TEST_LOG, "start\\n");\n"${version}";\n`;
const bundle = { version: "next", commit: "commit", lockHash: "lock", files: [
  { path: "viewer.js", content: workerSource("new") }, { path: "data/personas.json", content: "[]" },
  { path: "package.json", content: "{}" }, { path: "package-lock.json", content: "{}" },
] };

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "ut-host-"));
  const put = async (path, content, mode = 0o644) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content, { mode }); };
  const read = path => readFile(join(root, path), "utf8");
  const close = async () => { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); };
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  await put("viewer.js", workerSource("old")); await put("runs/keep.txt", "saved"); await put("node_modules/old", "old");
  await put("worker-version.json", JSON.stringify({ version: "old", commit: null }));
  if (!options.missing) await put(".ut-installed-lock", options.lock ?? "lock");
  const stubs = {
    flock: `case "$1" in -w) shift 2;; -n) shift;; esac
lock=$1; shift
if [ "$lock" = .ut-viewer.lock ] && [ "$1" = true ]; then
  [ "\${UT_TEST_REFUSE:-0}" = 0 ] || exit 1
fi
exec "$@"`,
    npm: `echo "npm $*" >> "$UT_TEST_LOG"
if [ "\${UT_TEST_NPM_FAIL:-0}" = 1 ]; then printf '설치 실패\n추가 오류\n' >&2; exit 9; fi
mkdir -p node_modules; echo installed > node_modules/new`,
    npx: `echo "npx $*" >> "$UT_TEST_LOG"; exit "\${UT_TEST_NPX_FAIL:-0}"`,
    pkill: `echo "pkill $*" >> "$UT_TEST_LOG"
[ "\${UT_TEST_KILL_FAIL:-0}" = 0 ] || exit "$UT_TEST_KILL_FAIL"
touch "$UT_TEST_ROOT/stopped"`,
    cp: `/bin/cp "$@"
if [ "\${UT_TEST_CRASH:-0}" = 1 ] && [ ! -f "$UT_TEST_ROOT/crashed" ]; then touch "$UT_TEST_ROOT/crashed"; exit 9; fi`,
  };
  for (const [name, script] of Object.entries(stubs)) {
    await put(`bin/${name}`, "#!/bin/sh\n" + script + "\n", 0o755);
  }
  let control = options.control ?? { version: "old", busy: false };
  let probes = 0;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/control"); assert.equal(request.headers["x-ut-proxy-key"], "secret");
    probes += 1;
    if (probes === options.busyAt) control = { busy: true };
    if (probes === options.targetAt) control = { version: "next" };
    response.writeHead(options.unknown && probes > 1 ? 503 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(control));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const commands = [], writes = [], exits = [], errors = [];
  const sandbox = {
    domain: () => `http://127.0.0.1:${port}`,
    async writeFiles(files) { writes.push(files); if (options.uploadFail) throw new Error("업로드 실패 secret\n숨긴 줄"); for (const file of files) await put(file.path, file.content); },
    async runCommand(command) {
      commands.push(command);
      if (!command.detached && options.commandFail) throw new Error("명령 실패 secret\n숨긴 줄");
      if (command.detached && options.startCrash) { options.startCrash = false; throw new Error("시작 중단"); }
      const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, UT_TEST_ROOT: root, UT_TEST_LOG: join(root, "commands"), ...options.env, ...command.env };
      const result = await execute("sh", ["-c", 'exec "$@"', "sh", command.cmd, ...command.args], { cwd: root, env }).catch(error => ({ ...error, exitCode: error.code }));
      if (!command.detached) { exits.push(result.exitCode ?? 0); if (await read("stopped").then(() => true, () => false)) await close(); }
      else if (!server.listening) {
        control = await read("worker-version.json").then(JSON.parse, () => ({ version: null }));
        await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
      }
      return { exitCode: result.exitCode ?? 0, stderr: async () => result.stderr };
    },
  };
  return { read, put, close, commands, writes, exits, errors, log: () => read("commands").catch(() => ""),
    sync: () => output.run(errors, () => syncWorker(sandbox, { key: "secret", bundle, port, attempts: 1, delay: 0 })) };
}

describe("지속 워커를 배포 버전에 맞춘다", { concurrency: 6 }, () => {
  const logger = mock.method(console, "error", (...args) => output.getStore()?.push(args)); after(() => logger.mock.restore());
  before(() => { process.env.VERCEL_ENV = "production"; }); after(() => { delete process.env.VERCEL_ENV; });
  for (const control of [{ version: "next" }, { busy: true }, { state: "running" }]) {
    test(control.version ? "같은 버전이면 파일과 프로세스를 건드리지 않는다" : control.busy ? "작업 중이면 교체하지 않는다" : "기존 뷰어가 실행 중이어도 교체하지 않는다", async t => {
      const worker = await setup(t, { control }); await worker.sync();
      assert.deepEqual(worker.writes, []); assert.deepEqual(worker.commands, []); assert.equal(await worker.log(), "");
    });
  }
  for (const options of [{ busyAt: 2 }, { busyAt: 3 }, { unknown: true }]) {
    test(options.unknown ? "상태가 불명확하면 교체를 미룬다" : options.busyAt === 2 ? "호스트 확인 후 작업이 시작되면 교체를 미룬다" : "두 번째 확인에서 작업 중이면 교체를 미룬다", async t => {
      const worker = await setup(t, options); await worker.sync();
      assert.deepEqual(worker.exits, [75]); assert.equal(await worker.read("viewer.js"), workerSource("old")); assert.equal(await worker.log(), "");
    });
  }
  test("유휴 워커의 파일과 스탬프를 교체하고 실행 기록과 설치된 모듈을 보존한다", async t => {
    const worker = await setup(t); assert.match(await worker.sync(), /^http:/);
    assert.equal(await worker.read("viewer.js"), workerSource("new")); assert.equal(await worker.read("data/personas.json"), "[]");
    assert.deepEqual(JSON.parse(await worker.read("worker-version.json")), { version: "next", commit: "commit" });
    assert.equal(await worker.read("runs/keep.txt"), "saved"); assert.equal(await worker.read("node_modules/old"), "old");
    assert.equal(await worker.log(), "pkill -TERM -f (^|/)node viewer\\.js$\nstart\n");
    assert.ok(worker.writes.flat().every(file => file.path.startsWith(".ut-update/next/")));
    assert.deepEqual(worker.commands.at(-1).env, { UT_SANDBOX_PROXY_KEY: "secret" });
    await assert.rejects(worker.read(".ut-update/next/viewer.js"), { code: "ENOENT" });
  });
  for (const options of [{ lock: "before" }, { missing: true }]) {
    test(options.missing ? "설치 해시가 없으면 의존성과 브라우저를 설치한다" : "설치 해시가 다르면 의존성과 브라우저를 교체한다", async t => {
      const worker = await setup(t, options); await worker.sync();
      assert.match(await worker.log(), /^npm ci --omit=dev\nnpx playwright install --with-deps chromium\npkill/);
      assert.equal(await worker.read(".ut-installed-lock"), "lock"); assert.equal(await worker.read("node_modules/new"), "installed\n");
      await assert.rejects(worker.read("node_modules/old"), { code: "ENOENT" });
    });
  }
  for (const options of [{ lock: "before", env: { UT_TEST_NPM_FAIL: "1" } }, { lock: "before", env: { UT_TEST_NPX_FAIL: "8" } }, { uploadFail: true }, { commandFail: true }]) {
    test(`${options.uploadFail ? "업로드" : options.commandFail ? "명령 실행" : options.env.UT_TEST_NPM_FAIL ? "의존성 설치" : "브라우저 설치"} 실패를 기록하고 기존 워커로 계속 응답한다`, async t => {
      const worker = await setup(t, options); assert.match(await worker.sync(), /^http:/);
      assert.equal(await worker.read("viewer.js"), workerSource("old")); assert.equal(await worker.read("node_modules/old"), "old");
      assert.doesNotMatch(await worker.log(), /pkill/); assert.equal(worker.errors.length, 1);
      assert.doesNotMatch(JSON.stringify(worker.errors), /secret|추가 오류|숨긴 줄/);
      assert.equal(worker.commands.at(-1).detached, true);
      if (options.env?.UT_TEST_NPM_FAIL) assert.deepEqual(worker.errors[0], ["UT Sandbox 동기화 실패", 9, "설치 실패"]);
    });
  }
  for (const options of [{ env: { UT_TEST_CRASH: "1" } }, { startCrash: true }]) {
    test(options.startCrash ? "재시작 전에 중단되어도 다음 연결에서 복구한다" : "복사 후 스탬프 전에 중단되어도 다음 연결에서 복구한다", async t => {
      const worker = await setup(t, options);
      if (options.startCrash) await assert.rejects(worker.sync(), /시작 중단/); else { await worker.sync(); await assert.rejects(worker.read("worker-version.json")); }
      assert.equal(await worker.read("viewer.js"), workerSource("new")); await worker.sync();
      assert.equal(JSON.parse(await worker.read("worker-version.json")).version, "next");
      assert.equal(await worker.read("runs/keep.txt"), "saved"); assert.equal(worker.commands.at(-1).detached, true);
    });
  }
  test("다른 호스트가 먼저 목표 버전을 실행하면 스테이지만 정리한다", async t => {
    const worker = await setup(t, { targetAt: 2 }); await worker.sync();
    assert.deepEqual(worker.exits, [0]); assert.equal(await worker.log(), "start\n");
    assert.equal(await worker.read("viewer.js"), workerSource("old"));
    await assert.rejects(worker.read(".ut-update/next/viewer.js"), { code: "ENOENT" });
  });
  for (const [env, exitCode] of [[{ UT_TEST_REFUSE: "1" }, 76], [{ UT_TEST_KILL_FAIL: "127" }, 127], [{ UT_TEST_KILL_FAIL: "1" }, 0]]) {
    test(exitCode === 76 ? "종료를 거부하면 파일을 교체하지 않는다" : exitCode === 127 ? "종료 명령이 없으면 실패를 기록한다" : "종료할 프로세스가 없으면 적용하고 버전 불일치를 기록한다", async t => {
      const worker = await setup(t, { env }); await worker.sync();
      assert.deepEqual(worker.exits, [exitCode]);
      assert.equal(await worker.read("viewer.js"), workerSource(exitCode === 0 ? "new" : "old"));
      assert.equal(worker.errors.length, 1);
      if (exitCode === 76) {
        assert.deepEqual(worker.errors[0], ["UT Sandbox 워커가 종료되지 않았습니다."]);
        assert.equal(await worker.read("worker-version.json"), JSON.stringify({ version: "old", commit: null }));
        assert.equal(await worker.read("node_modules/old"), "old");
        assert.ok(worker.commands.every(command => !command.detached));
        assert.doesNotMatch(await worker.log(), /start/);
      }
      if (exitCode === 127) assert.equal(worker.errors[0][1], 127);
      if (exitCode === 0) assert.equal(worker.errors[0][0], "UT Sandbox 버전 불일치");
    });
  }
});

describe("운영이 아닌 배포는 워커 코드를 바꾸지 않는다", () => {
  const useEnvironment = (t, environment) => {
    if (environment) process.env.VERCEL_ENV = environment; else delete process.env.VERCEL_ENV;
    t.after(() => { delete process.env.VERCEL_ENV; });
  };
  for (const environment of ["preview", "development", undefined]) {
    test(`${environment ?? "환경 미설정"}에서는 버전이 달라도 유휴 워커를 교체하지 않는다`, async t => {
      useEnvironment(t, environment);
      const worker = await setup(t); assert.match(await worker.sync(), /^http:/);
      assert.deepEqual(worker.writes, []); assert.deepEqual(worker.commands, []);
      assert.equal(await worker.read("viewer.js"), workerSource("old")); assert.equal(await worker.log(), "");
    });
  }
  test("워커가 응답하지 않으면 코드를 바꾸지 않고 시작만 한다", async t => {
    useEnvironment(t, "preview");
    const worker = await setup(t); await worker.close(); assert.match(await worker.sync(), /^http:/);
    assert.deepEqual(worker.writes, []); assert.deepEqual(worker.commands.map(command => command.detached), [true]);
    assert.equal(await worker.read("viewer.js"), workerSource("old")); assert.equal(await worker.log(), "start\n");
  });
});
