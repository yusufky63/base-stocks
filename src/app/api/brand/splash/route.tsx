import { ImageResponse } from "next/og";

/** 200×200 PNG splash mark for the Base app manifest (same mark as the icon, opaque background). */
export const dynamic = "force-static";

export function GET() {
  const res = new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0000ff", color: "#ffffff", fontFamily: "sans-serif" }}>
        <div style={{ fontSize: 132, fontWeight: 700, letterSpacing: -6, lineHeight: 1 }}>B</div>
      </div>
    ),
    { width: 200, height: 200 },
  );
  res.headers.set("cache-control", "public, max-age=86400, s-maxage=86400");
  return res;
}
