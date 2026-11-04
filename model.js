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
    const response = await fetch(`https://api.openai.com/v1/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`OpenAI ${path} 요청 실패 (HTTP ${response.status})`);
    return response.json();
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
