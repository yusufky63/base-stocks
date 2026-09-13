/**
 * Runs before the app's own code on every page load (Next.js `instrumentation-client`).
 *
 * One job: catch the hydration failures production has been throwing on every page (React
 * "Minified React error #418") and report enough to name the cause. React 19 reports them through
 * `reportError`, so they arrive as `error` events on `window` before any component has mounted;
 * the production message carries no diff, only the URL's `args[]`, which at least say whether the
 * mismatch was text or structure. Together with the path, the viewport, whether the page sits in
 * a frame and which data the document carried, that is what a local reproduction needs.
 *
 * Nothing about the person is sent: no wallet, no cookies, no query string.
 */
const HYDRATION = /hydrat|Minified React error #(418|419|422|423|425)/i;
let sent = 0;

function summary(): Record<string, unknown> {
  try {
    const html = document.documentElement;
    return {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      framed: window !== window.parent,
      theme: html.getAttribute("data-theme") ?? "system",
      motion: html.getAttribute("data-motion") ?? "unset",
      deployMarker: html.hasAttribute("data-dpl-id"),
      streamed: document.querySelectorAll('body > div[id^="S:"]').length,
      readyState: document.readyState,
      lang: navigator.language,
    };
  } catch {
    return {};
  }
}

function report(message: string, stack: string | undefined) {
  if (sent >= 2) return;
  sent += 1;
  const m = /args\[\]=([^&\s]+)/.exec(message);
  const body = JSON.stringify({
    message: `hydration: ${m ? decodeURIComponent(m[1]!) : "unknown"} · ${message.slice(0, 200)}`,
    path: window.location.pathname,
    stack: `${JSON.stringify(summary())}\n${(stack ?? "").slice(0, 1_500)}`,
  });
  try {
    if (navigator.sendBeacon) navigator.sendBeacon("/api/errors", new Blob([body], { type: "application/json" }));
    else void fetch("/api/errors", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
  } catch {
    /* reporting must never throw */
  }
}

try {
  window.addEventListener("error", (event) => {
    const message = String(event.error?.message ?? event.message ?? "");
    if (HYDRATION.test(message)) report(message, event.error?.stack);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { message?: unknown; stack?: unknown } | undefined;
    const message = String(reason?.message ?? event.reason ?? "");
    if (HYDRATION.test(message)) report(message, typeof reason?.stack === "string" ? reason.stack : undefined);
  });
} catch {
  /* an old browser without addEventListener is not our problem here */
}
