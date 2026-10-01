import { describe, expect, it } from "vitest";
import { withLabel } from "@/lib/slack/client";

describe("withLabel", () => {
  it.each([
    ["dm_approval", "【DM承認】"],
    ["post_approval", "【投稿承認】"],
    ["alert", "【アラート】"],
  ] as const)("%s の text の先頭に %s を付ける", (kind, label) => {
    expect(withLabel(kind, "本文").text).toBe(`${label} 本文`);
  });

  it("blocks の先頭にもラベルを置き、元の blocks は後ろに残す", () => {
    const section = { type: "section" as const, text: { type: "mrkdwn" as const, text: "本文" } };
    const { blocks } = withLabel("dm_approval", "本文", [section]);
    expect(blocks?.[0]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "*【DM承認】*" }] });
    expect(blocks?.[1]).toBe(section);
  });

  it("blocks がなければ blocks は付けない", () => {
    expect(withLabel("alert", "本文").blocks).toBeUndefined();
  });
});
