import { describe, expect, it } from "vitest";
import { cardsHtml } from "./print-cards";

const QR = "data:image/png;base64,AAAA";

describe("a printable gift card", () => {
  it("prints one card per link with the QR, the amount and the giver's note", () => {
    const html = cardsHtml(
      [
        { url: "https://basestocks.finance/claim/gift_1#0xsecretsecretsecretsecretsecretsecret", amount: "0.25 AAPL", eyebrow: "Gift 1 of 2", message: "Thanks for coming!" },
        { url: "https://basestocks.finance/claim/gift_2#0xothersecretothersecretothersecret", amount: "0.25 AAPL", eyebrow: "Gift 2 of 2" },
      ],
      [QR, QR],
      "basestocks.finance",
    );
    expect(html.match(/<article class="card">/g)).toHaveLength(2);
    expect(html).toContain("0.25 AAPL");
    expect(html).toContain("Gift 1 of 2");
    expect(html).toContain("Thanks for coming!");
    expect(html).toContain(`src="${QR}"`);
  });

  /** The printed text shortens the secret so it stays legible; the QR carries the whole link. */
  it("shortens the secret in the printed URL but not in the QR", () => {
    const url = "https://basestocks.finance/claim/gift_1#0xsecretsecretsecretsecretsecretsecretsecret";
    const html = cardsHtml([{ url, amount: "1 NVDA" }], [QR], "basestocks.finance");
    expect(html).toContain("basestocks.finance/claim/gift_1#0xsecr…");
    expect(html).not.toContain("0xsecretsecretsecretsecretsecretsecretsecret");
  });

  /** A note is the giver's text and lands inside an HTML document: it must not be able to write markup. */
  it("escapes what the giver typed", () => {
    const html = cardsHtml([{ url: "https://x.y/claim/1", amount: "1 NVDA", message: "<script>alert(1)</script>" }], [QR], "x.y");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("names the claim-by date when the link has a validity", () => {
    const html = cardsHtml([{ url: "https://x.y/claim/1", amount: "1 NVDA", validDays: 7 }], [QR], "x.y");
    expect(html).toContain("Claim by ");
    expect(cardsHtml([{ url: "https://x.y/claim/1", amount: "1 NVDA" }], [QR], "x.y")).not.toContain("Claim by ");
  });
});
