import { createInterface } from "node:readline/promises";
import { createModel } from "./model.js";
import { launchStudy, openInterview, regenerateReport } from "./run.js";
import { personas } from "./study.js";

async function main([command, ...args]) {
  if (command === "run" && (!args.length || (args.length === 2 && args[0] === "--persona"))) {
    const people = args.length ? personas.filter(persona => persona.id === args[1]) : personas;
    if (!people.length) throw new Error("참가자 ID는 P1, P2, P3 중 하나여야 합니다.");
    console.log(`결과 · ${await launchStudy({ model: createModel(), people })}/report.md`);
    return;
  }
  if (command === "interview" && args.length === 2) {
    const interview = await openInterview(...args);
    const model = createModel();
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const question = (await readline.question(`[${args[1]}] 질문 · `)).trim();
      if (!question) throw new Error("질문을 입력해 주세요.");
      console.log(`[${args[1]}] ${await interview.ask(model, question)}`);
    } finally {
      readline.close();
    }
    return;
  }
  if (command === "report" && (args.length === 1 || (args.length === 3 && args[1] === "--effort"))) {
    console.log(`재분석 결과 · ${await regenerateReport({ model: createModel(), runId: args[0], effort: args[2] })}`);
    return;
  }
  console.log("npm run ut -- run [--persona P1]\nnpm run ut -- interview <run-id> <persona-id>\nnpm run ut -- report <run-id> [--effort low|medium]");
  if (command && command !== "--help") process.exitCode = 1;
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
