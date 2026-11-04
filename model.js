import { setTimeout as delay } from "node:timers/promises";

export const modelId = "gpt-6-luna";

export function objectSchema(properties) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

const string = { type: "string" };
export const actionSchema = objectSchema({
  action: { type: "string", enum: ["tap", "input", "scroll", "back", "stop"] },
  x: { type: ["integer", "null"] },
  y: { type: ["integer", "null"] },
  text: { type: ["string", "null"] },
  deltaY: { type: ["integer", "null"] },
  submit: { type: ["boolean", "null"] },
  remark: string,
});
export const speechSchema = objectSchema({ speech: string });

export function createModel(key = process.env.OPENAI_API_KEY) {
  if (!key?.trim()) throw new Error("OPENAI_API_KEY를 환경 변수 또는 .env에 설정해 주세요.");

  async function request(path, { body, signal, timeout = 45_000 } = {}) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const options = {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: requestSignal,
    };
    for (let attempt = 0; ; attempt += 1) {
      requestSignal.throwIfAborted();
      let response;
      try {
        response = await fetch(`https://api.openai.com/v1/${path}`, options);
        if (response.ok) return await response.json();
      } catch (error) {
        if (attempt >= 2 || requestSignal.aborted || !(error instanceof TypeError)) throw error;
        await delay(200 * 2 ** attempt, undefined, { signal: requestSignal });
        continue;
      }
      const failure = new Error(`OpenAI ${path} 요청 실패 (HTTP ${response.status})`);
      if (attempt >= 2 || (response.status !== 429 && response.status < 500)) {
        await response.body?.cancel().catch(() => {});
        throw failure;
      }
      if (response.status === 429) {
        const body = await response.json().catch(() => ({}));
        if (body?.error?.code === "insufficient_quota") throw failure;
      } else {
        await response.body?.cancel().catch(() => {});
      }
      const header = response.headers.get("Retry-After");
      const retryAfter = header === null ? NaN : /^\d+$/.test(header)
        ? Number(header) * 1000 : Date.parse(header) - Date.now();
      const backoff = Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 200 * 2 ** attempt;
      if (backoff >= timeout) throw failure;
      await delay(backoff, undefined, { signal: requestSignal });
    }
  }

  return {
    async check() {
      const model = await request(`models/${modelId}`);
      if (model.id !== modelId) throw new Error(`API에서 ${modelId} 접근을 확인할 수 없습니다.`);
    },
    async respond({ instructions, prompt, image, images = [], schema = speechSchema, signal, maxOutput = 1000, effort = "low", timeout }) {
      const content = [{ type: "input_text", text: prompt }];
      if (image) content.push({
        type: "input_image", detail: "high", image_url: `data:image/png;base64,${image.toString("base64")}`,
      });
      for (const { frame, image } of images) {
        content.push({ type: "input_text", text: `화면 ID: ${frame}` }, {
          type: "input_image", detail: "high", image_url: `data:image/png;base64,${image.toString("base64")}`,
        });
      }
      const response = await request("responses", {
        signal,
        timeout,
        body: {
          model: modelId, store: false, reasoning: { effort }, max_output_tokens: maxOutput,
          instructions, input: [{ role: "user", content }],
          text: { format: { name: "ut_response", type: "json_schema", strict: true, schema } },
        },
      });
      const message = response.output?.filter(item => item.type === "message").flatMap(item => item.content ?? []);
      const output = message?.find(item => item.type === "output_text")?.text;
      if (response.status !== "completed" || !output) throw new Error("모델에서 완전한 응답을 받지 못했습니다.");
      return JSON.parse(output);
    },
  };
}
