import type { KnownBlock } from "@slack/web-api";
import { BLOCK_PREFIX } from "./rules";
import type { Category, Classification } from "./schemas";

/** Slack mrkdwn の制御文字をエスケープ */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function quote(text: string): string {
  return esc(text)
    .split("\n")
    .map((l) => `>${l}`)
    .join("\n");
}

export type ApprovalMode = "normal" | "decline" | "manual";

/** カテゴリ → 承認メッセージの種類。null は通知しない */
export function approvalModeFor(category: Category | null, hasReply: boolean): ApprovalMode | null {
  if (category === null) return "manual"; // 分類に失敗
  if (category === "spam") return null;
  if (category === "greeting" && !hasReply) return null;
  if (category === "sales_pitch" || category === "invitation") return "decline";
  if (category === "escalate" || !hasReply) return "manual";
  return "normal";
}

type Button = { text: string; action_id: string; style?: "primary" | "danger" };

const BUTTONS: Record<ApprovalMode, Button[]> = {
  normal: [
    { text: "送信", action_id: "dm_send", style: "primary" },
    { text: "修正して送信", action_id: "dm_edit" },
    { text: "送らない", action_id: "dm_skip" },
    { text: "リード登録のみ", action_id: "dm_lead_only" },
  ],
  decline: [
    { text: "丁寧に断る", action_id: "dm_decline", style: "primary" },
    { text: "無視", action_id: "dm_skip" },
  ],
  manual: [
    { text: "自分で書いて送信", action_id: "dm_edit", style: "primary" },
    { text: "送らない", action_id: "dm_skip" },
  ],
};

export type ApprovalView = {
  messageId: number;
  mode: ApprovalMode;
  sender: { name?: string | null; username?: string | null };
  body: string;
  classification: Classification | null;
  draft: string | null;
  declineReply: string | null;
  checks: string[];
  /** 「要手動対応」の理由（分類・返信案の生成に失敗した場合） */
  failure?: string | null;
  /** 処理済みならボタンの代わりに表示する一文 */
  done?: string | null;
  /** 差し戻しのルールに引っかかったまま（要修正）。［送信］［丁寧に断る］を出さない */
  blocked?: boolean;
};

/** 要修正のときのボタン: そのまま送るボタンを外し、［修正して送信］を先頭にする */
export function buttonsFor(mode: ApprovalMode, blocked: boolean): Button[] {
  if (!blocked) return BUTTONS[mode];
  const rest = BUTTONS[mode].filter((b) => b.action_id !== "dm_send" && b.action_id !== "dm_decline" && b.action_id !== "dm_edit");
  return [{ text: "修正して送信", action_id: "dm_edit", style: "primary" }, ...rest];
}

/** 【DM承認】メッセージの本体（ラベルは postMessage が付ける） */
export function buildApprovalBlocks(v: ApprovalView): { text: string; blocks: KnownBlock[] } {
  const who = [v.sender.name, v.sender.username && `@${v.sender.username}`].filter(Boolean).join(" ") || "（不明）";
  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${esc(who)}* からの DM\n${quote(v.body)}` } },
  ];
  if (v.failure) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `:warning: *要手動対応*: ${esc(v.failure)}` } });
  }
  if (v.classification) {
    const c = v.classification;
    const flags = c.flags.length ? ` / flags: ${c.flags.join(", ")}` : "";
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `分類: *${c.category}*（確度 ${c.confidence.toFixed(2)}）${flags}\n理由: ${esc(c.reason)}` }],
    });
  }
  const draft = v.mode === "decline" ? v.declineReply : v.draft;
  if (draft) {
    const title = v.mode === "decline" ? "お断り文" : "返信案";
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${title}*\n${quote(draft)}` } });
  }
  const mustFix = v.checks.filter((c) => c.startsWith(BLOCK_PREFIX)).map((c) => c.slice(BLOCK_PREFIX.length));
  const toCheck = v.checks.filter((c) => !c.startsWith(BLOCK_PREFIX));
  if (mustFix.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:warning: *要修正（このままでは送信できません）*\n${mustFix.map((c) => `• ${esc(c)}`).join("\n")}` },
    });
  }
  if (toCheck.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*要確認*\n${toCheck.map((c) => `• ${esc(c)}`).join("\n")}` } });
  }
  if (v.done) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `:white_check_mark: ${esc(v.done)}` }] });
  } else {
    blocks.push({
      type: "actions",
      elements: buttonsFor(v.mode, Boolean(v.blocked)).map((b) => ({
        type: "button",
        action_id: b.action_id,
        value: String(v.messageId),
        text: { type: "plain_text", text: b.text },
        ...(b.style ? { style: b.style } : {}),
      })),
    });
  }
  return { text: `${who} からの DM`, blocks };
}
