import { notifyAlert } from "../slack/client";
import { db } from "../supabase";
import { xApi } from "../x/client";
import { refreshDraftApproval } from "./approval";
import { addPipelinePost } from "./history";
import { formatJst } from "./slack";
import { markTopicUsed, releaseTopic } from "./topics";

/** 承認されないまま、この時間がたった案は期限切れにする */
export const EXPIRE_AFTER_MS = 48 * 60 * 60 * 1000;
/** 予定時刻からこれ以上遅れたら投稿しない（Cron の停止などで、ずれた時刻に投稿しないため） */
export const MAX_DELAY_MS = 2 * 60 * 60 * 1000;

export type PublishResult = { posted: number; failed: number; expired: number };

/** 5分おき: 期限切れの処理と、予定時刻を過ぎた承認済みの案の投稿 */
export async function runPublish(now = new Date()): Promise<PublishResult> {
  const expired = await expireStale(now);
  const { data: due, error } = await db()
    .from("post_drafts")
    .select("id, body, topic_id, scheduled_at")
    .eq("review_status", "approved")
    .lte("scheduled_at", now.toISOString())
    .order("scheduled_at");
  if (error) throw error;

  let posted = 0;
  let failed = 0;
  for (const d of due ?? []) {
    const ok = await publishOne(d, now);
    if (ok === true) posted++;
    else if (ok === false) failed++;
  }
  return { posted, failed, expired };
}

async function setStatus(id: number, from: string, to: string): Promise<boolean> {
  const { data, error } = await db().from("post_drafts").update({ review_status: to }).eq("id", id).eq("review_status", from).select("id");
  if (error) throw error;
  return Boolean(data?.length);
}

/** true: 投稿した / false: 失敗 / null: ほかの実行が処理中 */
async function publishOne(
  d: { id: number; body: string; topic_id: number | null; scheduled_at: string | null },
  now: Date,
): Promise<boolean | null> {
  // 投稿権を取る（approved → posting）。取れた実行だけが投稿するので二重投稿しない
  if (!(await setStatus(d.id, "approved", "posting"))) return null;

  const scheduled = d.scheduled_at ? new Date(d.scheduled_at) : now;
  if (now.getTime() - scheduled.getTime() > MAX_DELAY_MS) {
    await setStatus(d.id, "posting", "post_failed");
    await notifyAlert(`予定時刻（${formatJst(scheduled)}）を2時間以上過ぎたため投稿しませんでした（post_drafts.id=${d.id}）。必要なら手動で投稿してください`);
    await refreshDraftApproval(d.id, ":warning: 予定時刻を過ぎたため投稿していません（要手動対応）").catch(() => {});
    return false;
  }

  let xPostId: string;
  try {
    // URL 入りはこの中で止まる（UrlInPostError）
    const res = await xApi<{ data: { id: string } }>("tweets.create", { body: { text: d.body } });
    xPostId = res.data.id;
  } catch (e) {
    await setStatus(d.id, "posting", "post_failed");
    const msg = e instanceof Error ? e.message : String(e);
    await notifyAlert(`投稿に失敗しました（post_drafts.id=${d.id}、要手動対応）: ${msg}`);
    await refreshDraftApproval(d.id, `:warning: 投稿に失敗しました（要手動対応）: ${msg}`).catch(() => {});
    return false;
  }

  const postedAt = new Date().toISOString();
  const results = await Promise.allSettled([
    db().from("posts").insert({ x_post_id: xPostId, draft_id: d.id, body: d.body, posted_at: postedAt }),
    addPipelinePost(xPostId, d.body, postedAt),
    setStatus(d.id, "posting", "posted"),
    markTopicUsed(d.topic_id),
  ]);
  for (const r of results) if (r.status === "rejected") console.error("publishOne: 記録に失敗（投稿は完了済み）", r.reason);
  await refreshDraftApproval(d.id, `:white_check_mark: 投稿しました（${formatJst(new Date(postedAt))}）`).catch(() => {});
  return true;
}

/** 承認されないまま48時間たった案を期限切れにし、ボタンを消す。personal ならネタをストックに戻す */
export async function expireStale(now = new Date()): Promise<number> {
  const { data, error } = await db()
    .from("post_drafts")
    .update({ review_status: "expired" })
    .eq("review_status", "awaiting_approval")
    .lt("created_at", new Date(now.getTime() - EXPIRE_AFTER_MS).toISOString())
    .select("id, topic_id");
  if (error) throw error;
  for (const d of data ?? []) {
    await releaseTopic(d.topic_id);
    await refreshDraftApproval(d.id, `:hourglass: 期限切れ（48時間承認されませんでした）${d.topic_id ? "。ネタはストックに戻しました" : ""}`).catch(
      (e) => console.error("expire: Slack の更新に失敗", d.id, e),
    );
  }
  return data?.length ?? 0;
}
