import { ImageResponse } from "next/og";

/**
 * 1024×1024 PNG app icon for the Base app manifest and stores (they require PNG, the site uses SVG).
 * Rendered from the same mark as the wordmark; cached for a day at the edge.
 */
export const dynamic = "force-static";

export function GET() {
  const res = new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0000ff", color: "#ffffff", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 28 }}>
          <div style={{ display: "flex", gap: 18, marginBottom: 40 }}>
            <div style={{ width: 72, height: 72, background: "#ffffff", opacity: 0.55, marginTop: 100 }} />
            <div style={{ width: 72, height: 72, background: "#ffffff", opacity: 0.8, marginTop: 50 }} />
            <div style={{ width: 72, height: 72, background: "#ffffff" }} />
          </div>
          <div style={{ fontSize: 440, fontWeight: 700, letterSpacing: -24, lineHeight: 1 }}>B</div>
        </div>
      </div>
    ),
    { width: 1024, height: 1024 },
  );
  res.headers.set("cache-control", "public, max-age=86400, s-maxage=86400");
  return res;
}
