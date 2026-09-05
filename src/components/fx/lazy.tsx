"use client";

import dynamic from "next/dynamic";

/**
 * The decorative, canvas-heavy pieces — the dithered hero backdrop and the 3D coins — loaded only
 * in the browser and only when a page that shows them mounts. They are ornament: nothing about
 * prices or trading depends on them, so they must never be in the first bundle a visitor waits
 * for, and a server render needs no canvas at all.
 */
export const Dither = dynamic(() => import("./Dither").then((m) => m.Dither), { ssr: false, loading: () => null });
export const Coin3D = dynamic(() => import("@/components/common/Coin3D").then((m) => m.Coin3D), { ssr: false, loading: () => null });
