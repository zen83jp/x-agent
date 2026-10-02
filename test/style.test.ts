import { describe, expect, it } from "vitest";
import { formatPost, summarize } from "@/lib/style/build";

describe("文体ガイドの入力", () => {
  it("件数と期間はコードで数える", () => {
    const posts = [
      { id: "3", text: "c", created_at: "2026-10-01T00:00:00Z" },
      { id: "1", text: "a", created_at: "2026-06-15T00:00:00Z" },
      { id: "2", text: "b", created_at: "2026-08-24T00:00:00Z" },
    ];
    expect(summarize(posts, 9)).toBe("投稿: 3件（2026-06-15〜2026-10-01）／DM返信: 9件");
  });

  it("反応数を本文の前に付ける", () => {
    expect(
      formatPost({ id: "1", text: "おはようございます！", created_at: "2026-09-16T00:00:00Z", public_metrics: { like_count: 74, reply_count: 13 } }),
    ).toBe("--- 2026-09-16 ｜ いいね74 リポスト0 返信13 引用0 ブックマーク0\nおはようございます！");
  });
});
