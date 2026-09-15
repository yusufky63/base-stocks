/**
 * Printable gift cards: a QR code and the claim link on paper, for a gift handed over in person.
 *
 * Everything happens in the browser. The QR is drawn here from the link the page already holds,
 * the card is a self-contained HTML document written into a new window, and the browser's own
 * print dialog does the rest — no server sees the link, which for a claim link *is* the gift.
 * A6 cards, four to an A4 sheet, so a batch of links prints as a stack of cards.
 */
export interface PrintCard {
  /** The full claim URL; the QR encodes exactly this. */
  url: string;
  /** Big line: what the card is worth ("0.25 AAPL"). */
  amount: string;
  /** Small eyebrow above the amount ("A gift for you", "#3 of 10"). */
  eyebrow?: string;
  /** The giver's note, if any. */
  message?: string;
  /** When the link stops working, already formatted. */
  validUntil?: string;
  /** Or: days from the moment the sheet is made; the date is computed then, not while a page renders. */
  validDays?: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** The URL without scheme, and with the secret shortened so the printed text is readable; the QR carries the whole thing. */
function shownUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, "");
  const hash = bare.indexOf("#");
  if (hash === -1 || bare.length <= 48) return bare;
  return `${bare.slice(0, hash)}#${bare.slice(hash + 1, hash + 7)}…`;
}

async function qrDataUrls(cards: PrintCard[]): Promise<string[]> {
  const QRCode = (await import("qrcode")).default;
  return Promise.all(cards.map((c) => QRCode.toDataURL(c.url, { margin: 1, width: 480, errorCorrectionLevel: "M", color: { dark: "#0a0b0d", light: "#ffffff" } })));
}

export function cardsHtml(cards: PrintCard[], qrs: string[], site: string): string {
  const items = cards
    .map((c, i) => {
      const until = c.validUntil ?? (c.validDays ? new Date(Date.now() + c.validDays * 86_400_000).toLocaleDateString(undefined, { dateStyle: "medium" }) : undefined);
      return `<article class="card">
  <header><span class="brand">BStocks</span><span class="site">${escapeHtml(site)}</span></header>
  <img class="qr" src="${qrs[i]}" alt="QR code for the claim link" />
  <div class="eyebrow">${escapeHtml(c.eyebrow ?? "A gift for you")}</div>
  <div class="amount">${escapeHtml(c.amount)}</div>
  ${c.message ? `<p class="message">“${escapeHtml(c.message)}”</p>` : ""}
  <p class="how">Scan to claim. No wallet needed — it is made for you on the spot, and the stock is yours to keep on Base.</p>
  <footer><span class="url">${escapeHtml(shownUrl(c.url))}</span>${until ? `<span class="until">Claim by ${escapeHtml(until)}</span>` : ""}</footer>
</article>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>BStocks gift cards</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; color: #0a0b0d; font: 12pt/1.35 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .sheet { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6mm; padding: 6mm; }
  .card { border: 0.3mm dashed #b8bcc4; border-radius: 4mm; padding: 7mm; height: 128mm; display: flex; flex-direction: column; align-items: center; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  header, footer { width: 100%; display: flex; justify-content: space-between; align-items: baseline; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 8pt; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; }
  .brand { color: #0370fd; font-weight: 700; }
  .qr { width: 48mm; height: 48mm; margin: 5mm 0 3mm; image-rendering: pixelated; }
  .eyebrow { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 7.5pt; letter-spacing: 0.12em; text-transform: uppercase; color: #6b7280; }
  .amount { font-size: 22pt; font-weight: 700; letter-spacing: -0.01em; margin-top: 1mm; font-variant-numeric: tabular-nums; }
  .message { margin: 2mm 0 0; font-size: 10.5pt; font-style: italic; color: #1f2937; max-width: 60mm; }
  .how { margin: 2mm 0 0; font-size: 8.5pt; color: #4b5563; max-width: 62mm; }
  footer { margin-top: auto; flex-direction: column; align-items: center; gap: 1mm; text-transform: none; letter-spacing: 0; }
  .url { word-break: break-all; font-size: 7pt; }
  .until { font-size: 7pt; }
  @media screen { body { background: #e5e7eb; } .sheet { max-width: 210mm; margin: 0 auto; background: #fff; } }
</style></head>
<body><div class="sheet">
${items}
</div>
<script>window.addEventListener("load", function () { setTimeout(function () { window.focus(); window.print(); }, 150); });</script>
</body></html>`;
}

/**
 * Open the print dialog with one card per link. Opens the window first, synchronously, so the
 * browser treats it as the click's own popup; the content follows once the QR codes are drawn.
 */
export async function printCards(cards: PrintCard[]): Promise<boolean> {
  if (typeof window === "undefined" || cards.length === 0) return false;
  const win = window.open("", "_blank", "noopener=no,width=900,height=1100");
  if (!win) return false;
  try {
    win.document.write("<!doctype html><title>Preparing cards…</title><p style='font:14px sans-serif;padding:24px'>Drawing the cards…</p>");
    const qrs = await qrDataUrls(cards);
    const site = window.location.host;
    win.document.open();
    win.document.write(cardsHtml(cards, qrs, site));
    win.document.close();
    return true;
  } catch {
    win.close();
    return false;
  }
}
