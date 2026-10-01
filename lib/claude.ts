import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { env } from "./env";

let client: Anthropic | undefined;

function claude(): Anthropic {
  client ??= new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  return client;
}

/** prompts/<name>.md を読む */
export function loadPrompt(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), "prompts", `${name}.md`), "utf8");
}

export type JsonResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * プロンプトを実行し、出力を zod スキーマで検証して返す。
 * 失敗（API エラー・拒否・スキーマ不一致）は例外にせず ok: false で返す。呼び出し側は Slack の「要手動対応」に回す。
 */
export async function generateJson<S extends z.ZodType>(args: {
  system: string;
  user: string;
  schema: S;
  maxTokens?: number;
}): Promise<JsonResult<z.infer<S>>> {
  try {
    const res = await claude().messages.parse({
      model: env().CLAUDE_MODEL,
      max_tokens: args.maxTokens ?? 4096,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
      output_config: { format: zodOutputFormat(args.schema) },
    });
    if (res.stop_reason === "refusal") return { ok: false, error: "モデルが応答を拒否しました" };
    if (res.stop_reason === "max_tokens") return { ok: false, error: "出力が上限で途切れました" };
    if (res.parsed_output == null) return { ok: false, error: "出力をスキーマで検証できませんでした" };
    return { ok: true, data: res.parsed_output as z.infer<S> };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
