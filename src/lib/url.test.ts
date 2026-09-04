import { describe, expect, it } from "vitest";
import { isHttpUrl, prettyHost } from "./url";

describe("creator-supplied links", () => {
  it("accepts http and https", () => {
    expect(isHttpUrl("https://basestocks.finance")).toBe(true);
    expect(isHttpUrl("http://localhost:3000/docs")).toBe(true);
    expect(isHttpUrl("  https://discord.gg/abc  ")).toBe(true);
  });

  it("rejects the schemes that would matter — these links go to window.open", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("rejects anything that is not a URL at all", () => {
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("basestocks.finance")).toBe(false);
    expect(isHttpUrl("not a link")).toBe(false);
  });

  it("names a link by its host when the creator did not label it", () => {
    expect(prettyHost("https://www.basestocks.finance/pools")).toBe("basestocks.finance");
    expect(prettyHost("https://discord.gg/abc")).toBe("discord.gg");
  });

  it("degrades to the raw string rather than throwing on junk", () => {
    expect(prettyHost("nonsense")).toBe("nonsense");
  });
});
