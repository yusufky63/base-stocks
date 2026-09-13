import { describe, expect, it } from "vitest";
import { appMeta, appUrl, miniAppMeta } from "./miniapp";

const parse = (meta: Record<string, string>, key = "fc:miniapp") => JSON.parse(meta[key]!) as {
  version: string;
  imageUrl: string;
  button: { title: string; action: { type: string; url: string; splashImageUrl: string; splashBackgroundColor: string } };
};

describe("the mini app embed tag", () => {
  it("defaults to launching the home page", () => {
    const embed = parse(miniAppMeta());
    expect(embed.version).toBe("1");
    expect(embed.button.action.type).toBe("launch_miniapp");
    expect(embed.button.action.url).toMatch(/\/$/);
    expect(embed.imageUrl).toContain("/miniapp-image");
  });

  it("launches the page that was shared, not the home page", () => {
    const embed = parse(miniAppMeta({ url: appUrl("/pools/abc123"), buttonTitle: "Claim your share" }));
    expect(embed.button.action.url).toMatch(/\/pools\/abc123$/);
    expect(embed.button.title).toBe("Claim your share");
  });

  /** Hosts render the button on one line and the spec caps it; a long title is cut, not wrapped. */
  it("keeps the button title inside the 32 character cap", () => {
    const embed = parse(miniAppMeta({ buttonTitle: "Claim a share of this very generous gift pool right now" }));
    expect(embed.button.title.length).toBe(32);
  });

  /** Older clients read `fc:frame`; both tags must describe the same destination. */
  it("emits the legacy frame tag alongside, with the same destination", () => {
    const meta = miniAppMeta({ url: appUrl("/pools/xyz") });
    expect(parse(meta, "fc:frame").button.action.type).toBe("launch_frame");
    expect(parse(meta, "fc:frame").button.action.url).toBe(parse(meta).button.action.url);
  });

  /**
   * Next replaces `other` wholesale when a page sets its own, so the pages most worth sharing are
   * exactly the ones that would quietly lose Builder Code attribution.
   */
  it("carries the Base app id on every page that overrides its metadata", () => {
    expect(appMeta({ url: appUrl("/pools/abc") })["base:app_id"]).toBeTruthy();
    expect(appMeta()["base:app_id"]).toBe(appMeta({ buttonTitle: "Anything" })["base:app_id"]);
  });

  it("builds absolute urls, with or without a leading slash", () => {
    expect(appUrl("/gifts")).toBe(appUrl("gifts"));
    expect(appUrl("/gifts")).toMatch(/^https?:\/\/[^/]+\/gifts$/);
  });
});
