import { db } from "../supabase";
import { RESOURCE_COST_USD, type BilledResource } from "./pricing";

/** X の課金の重複排除は UTC の日単位 */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** 同じレスポンス内の重複（同じユーザーが複数のイベントに出てくる等）を除く */
export function dedupe(resources: BilledResource[]): BilledResource[] {
  const seen = new Set<string>();
  return resources.filter((r) => {
    const key = `${r.type}:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function costOf(resources: BilledResource[]): number {
  return resources.reduce((sum, r) => sum + RESOURCE_COST_USD[r.type], 0);
}

/**
 * 今日（UTC）まだ課金されていないリソースだけを記録し、その件数と金額を返す。
 * x_billed_resources の主キーで重複を弾くので、並行実行でも二重に数えない。
 */
export async function chargeNewResources(
  resources: BilledResource[],
  now = new Date(),
): Promise<{ units: number; costUsd: number }> {
  const unique = dedupe(resources);
  if (unique.length === 0) return { units: 0, costUsd: 0 };

  const day = utcDay(now);
  const { data, error } = await db()
    .from("x_billed_resources")
    .upsert(
      unique.map((r) => ({ utc_day: day, resource_type: r.type, resource_id: r.id })),
      { onConflict: "utc_day,resource_type,resource_id", ignoreDuplicates: true },
    )
    .select("resource_type, resource_id");
  if (error) {
    // 判定できないときは安全側（全件課金）で数える
    console.error("chargeNewResources failed", error);
    return { units: unique.length, costUsd: costOf(unique) };
  }
  const charged = (data ?? []).map((r) => ({ type: r.resource_type, id: r.resource_id }) as BilledResource);
  return { units: charged.length, costUsd: costOf(charged) };
}
