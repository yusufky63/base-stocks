"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, erc20Abi, formatUnits, type Address, type Hash } from "viem";
import { Check, Layers, Link2, TriangleAlert, Users } from "lucide-react";
import type { B20AssetDTO } from "@/domain/asset";
import type { PoolGateMode, PoolRecord, Quest } from "@/domain/pool";
import type { PortfolioHolding } from "@/domain/portfolio";
import { BASE_CHAIN_ID } from "@/config/chain";
import { apiPost, ApiError } from "@/lib/client-api";
import { GIFT_POOL_ADDRESS, MAX_POOL_LEGS, giftPoolAbi, makePoolLinkSecret, poolPath, poolSalt, sharesForUsd, splitIntoShares } from "@/lib/pool";
import { patchWithRetry } from "@/lib/gift/record";
import { probeWalletCapabilities, sendCallsOrSequential } from "@/lib/gift/wallet";
import { humanizeError, TRADE_ERROR_COPY, type HumanError } from "@/lib/errors";
import { callAfterApproval } from "@/lib/trade/execute";
import { useAuth } from "@/hooks/useAuth";
import { useConfigFlags } from "@/hooks/queries";
import { parseAmountSafe, toRaw } from "@/lib/b20/math";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { Input } from "@/components/ui/Input";
import { Button, KeyValue, cx } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { Sheet } from "@/components/ui/Sheet";
import { AssetLogo, ErrorBanner, InfoBanner } from "@/components/common/display";
import { ShareActions } from "@/components/common/ShareSheet";
import { PrintCardsButton } from "@/components/common/PrintCardsButton";
import { QuestPicker, questsValid } from "./QuestPicker";

const EXPIRY_DAYS: Array<[number, string]> = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
];
const SLOT_PRESETS = [5, 10, 25, 100];

type Phase = "form" | "signing" | "submitted" | "recording" | "ready";

interface LegDraft {
  /** Human amount of the TOTAL to give away for this stock, always in share units. */
  total: string;
  /**
   * Which unit the creator is typing in. The stored total is always units — dollars are a lens on
   * it, converted on the way in and on the way out, so the amount has one source of truth and a
   * price that moves between keystrokes cannot rewrite what was already entered.
   */
  mode?: "units" | "usd";
  /**
   * Exactly what was typed in dollar mode, kept as text.
   *
   * Deriving it back from the units would round the creator's own "10" into "9.99" between
   * keystrokes, so the dollars they typed stay theirs and the units are what is computed.
   */
  usdText?: string;
  /** Which slice of the holding is selected, so the control shows a state rather than firing and forgetting. */
  portion?: number | null;
}

/** A basket handed over from Build: the stocks to pre-pick (lowercase), the number of shares, a title. */
export interface PoolPreset {
  assets: string[];
  slots: number;
  title?: string;
}

/**
 * Creates a gift pool: one deposit, many equal shares. The creator names the total per stock and
 * how many people it is for; the split is computed here and sent to the contract as an exact
 * per-claim amount, so nothing rounds onchain and no dust is left behind.
 */
export function PoolCreateFlow({ holdings, assets, preset }: { holdings: PortfolioHolding[]; assets: B20AssetDTO[]; preset?: PoolPreset }) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const { ensureSignedIn } = useAuth();
  const questsEnabled = useConfigFlags().data?.poolQuestsEnabled ?? false;

  // Defaults come from the hand-off preset (when there is one) until the user touches a field;
  // `holdings` may still be loading when the preset arrives, so the derived form follows them.
  const [pickedState, setPickedState] = useState<string[] | null>(null);
  const presetHeld = useMemo(() => (preset ? preset.assets.filter((a) => holdings.some((h) => h.assetAddress.toLowerCase() === a)).slice(0, MAX_POOL_LEGS) : null), [preset, holdings]);
  const picked: string[] = pickedState ?? presetHeld ?? [];
  const setPicked = (next: string[] | ((cur: string[]) => string[])) => setPickedState(typeof next === "function" ? next(picked) : next);
  const [drafts, setDrafts] = useState<Record<string, LegDraft>>({});
  const [slotsState, setSlotsState] = useState<number | null>(null);
  const slots = slotsState ?? preset?.slots ?? 10;
  const setSlots = (n: number) => setSlotsState(n);
  const [gateMode, setGateMode] = useState<PoolGateMode>("link");
  const [days, setDays] = useState(7);
  const [isPublic, setIsPublic] = useState(false);
  const [titleState, setTitleState] = useState<string | null>(null);
  const title = titleState ?? preset?.title ?? "";
  const setTitle = (t: string) => setTitleState(t);
  const [message, setMessage] = useState("");
  const [quests, setQuests] = useState<Quest[]>([]);

  const [phase, setPhase] = useState<Phase>("form");
  const [confirming, setConfirming] = useState(false);
  const presetNote: string | null = preset && presetHeld
    ? presetHeld.length === 0
      ? "You hold none of this basket's stocks yet — buy the basket first, then come back to gift it."
      : preset.assets.length > presetHeld.length
        ? `Not held, so left out: ${preset.assets.filter((a) => !presetHeld.includes(a)).map((a) => assets.find((x) => x.canonicalId === a)?.underlying ?? a.slice(0, 8)).join(", ")}.`
        : null
    : null;
  const [error, setError] = useState<HumanError | null>(null);
  const [created, setCreated] = useState<{ pool: PoolRecord; link: string; recorded: boolean } | null>(null);
  const [txHash, setTxHash] = useState<Hash | undefined>();

  const assetFor = (addr: string) => assets.find((a) => a.canonicalId === addr.toLowerCase()) ?? null;

  const legs = useMemo(() => {
    return picked
      .map((addr) => {
        const holding = holdings.find((h) => h.assetAddress.toLowerCase() === addr);
        const asset = assetFor(addr);
        if (!holding || !asset) return null;
        const multiplier = BigInt(asset.multiplier);
        const wad = BigInt(asset.wadPrecision);
        const shares = parseAmountSafe(drafts[addr]?.total ?? "", asset.decimals);
        const wantedRaw = shares === 0n ? 0n : toRaw(shares, multiplier, wad);
        const available = BigInt(holding.rawBalance);
        const totalRaw = wantedRaw > available ? available : wantedRaw;
        const { perClaim, funded, dust } = splitIntoShares(totalRaw, slots);
        return { addr, asset, holding, multiplier, wad, totalRaw, perClaim, funded, dust, available };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, drafts, slots, holdings, assets]);

  const ready = legs.length > 0 && legs.every((l) => l.perClaim > 0n) && slots > 0 && (gateMode !== "signer" || (quests.length > 0 && questsValid(quests)));
  const usdTotal = legs.reduce((sum, l) => {
    const price = l.holding.priceUsd;
    return price === null ? sum : sum + Number(formatUnits(l.funded, l.asset.decimals)) * price;
  }, 0);
  const anyUnpriced = legs.some((l) => l.holding.priceUsd === null);
  /** What one claim pays out, per stock — the sentence the pool is really described by. */
  const perLabels = legs.map((l) => `${formatTokenAmount((l.perClaim * l.multiplier) / l.wad, l.asset.decimals)} ${l.asset.underlying}`);

  const toggle = (addr: string) => {
    setPicked((cur) => (cur.includes(addr) ? cur.filter((a) => a !== addr) : cur.length >= MAX_POOL_LEGS ? cur : [...cur, addr]));
  };

  const setTotal = (addr: string, total: string) => setDrafts((d) => ({ ...d, [addr]: { ...d[addr], total, portion: null } }));

  /** What the whole holding is worth, which is the ceiling on anything entered in dollars. */
  const holdingUsd = (addr: string): number | null => {
    const holding = holdings.find((h) => h.assetAddress.toLowerCase() === addr);
    const asset = assetFor(addr);
    if (!holding || !asset || holding.priceUsd === null || holding.priceUsd === undefined) return null;
    return Number(formatUnits(BigInt(holding.rawBalance), asset.decimals)) * holding.priceUsd;
  };
  const setMode = (addr: string, mode: "units" | "usd") =>
    setDrafts((d) => {
      const draft = d[addr] ?? { total: "" };
      // Switching to dollars shows what the units are worth, so the figure carries across.
      const usd = mode === "usd" ? (legUsd(addr) ?? null) : null;
      return { ...d, [addr]: { ...draft, mode, usdText: usd !== null && usd > 0 ? usd.toFixed(2) : draft.usdText } };
    });

  const setUsd = (addr: string, usdText: string) =>
    setDrafts((d) => {
      // Capping here rather than only in the leg maths: the field itself should never show a figure
      // the wallet cannot fund, or the review would quietly hand back a smaller pool than was typed.
      const ceiling = holdingUsd(addr);
      const typed = Number(usdText);
      const capped = ceiling !== null && Number.isFinite(typed) && typed > ceiling ? ceiling.toFixed(2) : usdText;
      return { ...d, [addr]: { ...d[addr], mode: "usd", usdText: capped, total: unitsForUsd(addr, capped), portion: null } };
    });

  const unitsForUsd = (addr: string, usd: string): string => {
    const holding = holdings.find((h) => h.assetAddress.toLowerCase() === addr);
    const asset = assetFor(addr);
    if (!holding || !asset) return "";
    return sharesForUsd(usd, holding.priceUsd, asset.multiplier, asset.wadPrecision, asset.decimals);
  };

  /** What a leg is worth right now, or null when the stock has no price to go on. */
  const legUsd = (addr: string): number | null => {
    const leg = legs.find((l) => l.addr === addr);
    const price = leg?.holding.priceUsd ?? null;
    if (!leg || price === null) return null;
    return Number(formatUnits(leg.funded, leg.asset.decimals)) * price;
  };

  /** A slice of what the wallet holds, which is the way most of this is actually decided. */
  const setPortion = (addr: string, fraction: number) => {
    const holding = holdings.find((h) => h.assetAddress.toLowerCase() === addr);
    const asset = assetFor(addr);
    if (!holding || !asset) return;
    const multiplier = BigInt(asset.multiplier);
    const wad = BigInt(asset.wadPrecision);
    const slice = (BigInt(holding.rawBalance) * BigInt(Math.round(fraction * 1000))) / 1000n;
    const units = formatUnits((slice * multiplier) / wad, asset.decimals);
    const usd = holding.priceUsd ? Number(formatUnits(slice, asset.decimals)) * holding.priceUsd : null;
    setDrafts((d) => ({ ...d, [addr]: { ...d[addr], total: units, portion: fraction, ...(usd !== null ? { usdText: usd.toFixed(2) } : {}) } }));
  };

  const setWindow = (d: number) => setDays(d);

  const qr = useQuery({
    queryKey: ["pool-qr", created?.pool.id ?? ""],
    queryFn: () => QRCode.toDataURL(created!.link, { margin: 1, width: 320, color: { dark: "#0a0b0d", light: "#ffffff" } }),
    enabled: !!created,
    staleTime: Infinity,
  });

  const create = async () => {
    if (!address || !walletClient || !publicClient || !ready) return;
    if (chainId !== BASE_CHAIN_ID) {
      setError({ code: "WRONG_NETWORK", message: TRADE_ERROR_COPY.WRONG_NETWORK });
      return;
    }
    setError(null);
    setPhase("signing");
    try {
      // The draft is written under this wallet and the creator's own list is served by session,
      // so the one signature happens here, public or not.
      await ensureSignedIn();

      const secret = gateMode === "link" ? makePoolLinkSecret() : null;
      const expiry = Date.now() + days * 24 * 3600 * 1000;
      // A pool is always the creator's to close: whatever is unclaimed comes back on demand.
      const lockedUntil = 0;

      const { pool } = await apiPost<{ pool: PoolRecord; salt: `0x${string}`; warnings: string[] }>("/api/pools", {
        creator: address,
        gateMode,
        gateAddress: secret?.gateAddress,
        slots,
        legs: legs.map((l) => ({ token: l.asset.address, amountPerClaim: l.perClaim.toString() })),
        expiry,
        lockedUntil,
        visibility: isPublic ? "public" : "unlisted",
        title: title.trim() || undefined,
        message: message.trim() || undefined,
        quests: gateMode === "signer" ? quests : [],
      });

      // Fund the contract the server stamped on the record, so the record and the transaction
      // can never name different deployments. A record without one is brand new, so the current
      // contract is the only answer.
      const contractAddress = pool.contractAddress ?? (GIFT_POOL_ADDRESS as Address);
      const createData = encodeFunctionData({
        abi: giftPoolAbi,
        functionName: "create",
        args: [
          poolSalt(pool.id),
          pool.gateAddress,
          slots,
          BigInt(Math.floor(expiry / 1000)),
          BigInt(Math.floor(lockedUntil / 1000)),
          legs.map((l) => l.asset.address),
          legs.map((l) => l.perClaim),
          pool.memo,
        ],
      });
      // Only approve what is not approved already. A retry after a failed create — the common
      // case, since the previous attempt's approvals are still on the chain — then costs nothing
      // but the create itself, and asks for one confirmation instead of one per leg.
      const existing = await publicClient
        .multicall({
          contracts: legs.map((l) => ({ address: l.asset.address as Address, abi: erc20Abi, functionName: "allowance" as const, args: [address, contractAddress] as const })),
          allowFailure: true,
        })
        .catch(() => null);
      const approvals = legs
        .filter((l, i) => {
          const current = existing?.[i];
          return !(current && current.status === "success" && (current.result as bigint) >= l.funded);
        })
        .map((l) => ({
          to: l.asset.address as Address,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contractAddress, l.funded] }),
        }));
      const calls = [...approvals, { to: contractAddress, data: createData }];

      const caps = await probeWalletCapabilities(walletClient, address);
      const { last: hash } = await sendCallsOrSequential({
        walletClient,
        publicClient,
        address,
        caps,
        sponsor: true,
        calls,
        timeoutMs: 240_000,
        // Dry run before spending gas on the real thing. `callAfterApproval`, not a plain `call`:
        // the fallback transport spreads reads across RPCs, so the node that answers this one can
        // still be a block behind the approvals we just mined and report InsufficientAllowance for
        // an allowance that exists. A pool approves one token per leg, so there is more of that
        // lag to absorb here than on a single-token trade — hence the longer retry budget.
        preflight: (call, i) => (i === calls.length - 1 ? callAfterApproval(publicClient, address, call, approvals.length > 0 ? 6 : 2) : Promise.resolve()),
        onSubmitted: () => setPhase("submitted"),
      });
      setTxHash(hash);

      // Until the hash is on the record the pool page is a 404 and the funds look stuck; this is
      // awaited and retried, and the link is shown only once it is written (or we say that it was not).
      setPhase("recording");
      const written = hash ? await patchWithRetry(`/api/pools/${pool.id}`, { txHash: hash, status: "submitted" }) : null;
      setCreated({ pool, link: `${window.location.origin}${poolPath(pool.id, secret?.privateKey)}`, recorded: !!written });
      setPhase("ready");
    } catch (err) {
      const humanized = err instanceof ApiError ? { code: (err.code in TRADE_ERROR_COPY ? err.code : "UNKNOWN") as HumanError["code"], message: err.message } : humanizeError(err);
      if (humanized.code === "ALLOWANCE_REQUIRED") {
        // Telling someone to approve right after they approved is never the truth here: the
        // allowance is on the chain, the node answering us just has not seen it yet.
        humanized.message = "Your approvals are on the chain, but the network has not caught up yet. Wait a few seconds and press Create again — already-approved stocks are skipped, so you will not pay for them twice.";
      }
      setError(humanized);
      setPhase("form");
    }
  };

  /* ------------------------------- done view ------------------------------- */

  if (phase === "ready" && created) {
    return (
      <div className="flex flex-col gap-4">
        <div className="border border-line rounded-[8px] p-4 bg-surface flex items-center gap-4">
          {qr.data && (
            <span className="shrink-0 rounded-[8px] bg-white p-1.5 border border-line">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr.data} alt="Pool link QR code" width={112} height={112} className="w-28 h-28" />
            </span>
          )}
          <div className="min-w-0 flex flex-col gap-1">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Pool is live</div>
            <div className="display num text-[24px]">{`${slots} shares`}</div>
            <p className="text-[13px] text-ink-secondary">{`Each person gets ${perLabels.join(" + ")}. One share per wallet.`}</p>
          </div>
        </div>
        {!created.recorded && (
          <InfoBanner tone="warning">
            The pool is funded onchain, but we could not record the transaction just now. The page starts working once our next check finds it (a few minutes); keep the link.
          </InfoBanner>
        )}
        {gateMode === "link" && (
          <InfoBanner tone="warning">
            <span className="inline-flex items-start gap-2">
              <TriangleAlert size={15} strokeWidth={1.75} className="shrink-0 mt-0.5 text-warning-fg" />
              <span>This link is the key to the pool: anyone holding it can take a share, one per wallet. It is shown once and stored nowhere.</span>
            </span>
          </InfoBanner>
        )}
        <ShareActions path={created.link.replace(window.location.origin, "")} text={`Free stock on Base: ${perLabels.join(" + ")} each, ${slots} shares. No wallet needed — open the link to claim.`} />
        <PrintCardsButton full cards={() => [{ url: created.link, amount: `${perLabels.join(" + ")} each`, eyebrow: title.trim() || `${slots} shares · one per person`, validDays: days }]} label="Print a card for the table" />
        {txHash && <KeyValue k="Funding tx" v={txHash} />}
        <p className="text-[12px] text-ink-muted">Manage it any time from Gift → History: see who claimed, close it, and take the unclaimed remainder back.</p>
      </div>
    );
  }

  /* --------------------------------- form ---------------------------------- */

  const busy = phase === "signing" || phase === "submitted" || phase === "recording";
  const busyLabel = phase === "recording" ? "Recording the pool…" : phase === "submitted" ? "Locking in escrow…" : "Confirm in your wallet…";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 text-[13px] text-ink-secondary">
        <Users size={15} strokeWidth={1.75} className="text-primary shrink-0" />
        One deposit, many equal shares. Everybody who opens it takes exactly one — and whatever is left comes back to you.
      </div>

      {/* 1 · what goes in */}
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Stocks in the pool {picked.length > 1 && `· package of ${picked.length}`}</span>
        <ul className="border border-line rounded-[8px] overflow-hidden">
          {holdings.map((h) => {
            const addr = h.assetAddress.toLowerCase();
            const on = picked.includes(addr);
            const leg = legs.find((l) => l.addr === addr);
            return (
              <li key={addr} className={cx("border-b border-line last:border-b-0", on && "bg-primary-soft/40")}>
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggle(addr)}
                    aria-pressed={on}
                    className="flex items-center gap-3 min-w-0 flex-1 text-left"
                  >
                    <span className={cx("w-4 h-4 rounded-[4px] border inline-flex items-center justify-center shrink-0", on ? "border-primary bg-primary text-primary-contrast" : "border-line-strong")}>
                      {on && <Check size={11} strokeWidth={3} />}
                    </span>
                    <AssetLogo src={h.logoURI} symbol={h.underlying} size={28} />
                    <span className="min-w-0">
                      <span className="block font-medium text-[14px]">{h.underlying}</span>
                      <span className="block font-mono num text-[11px] text-ink-secondary">{`${formatTokenAmount(h.scaledBalance, h.decimals)} available`}</span>
                    </span>
                  </button>
                </div>
                {on && (() => {
                  const mode = drafts[addr]?.mode ?? "units";
                  const priced = h.priceUsd !== null && h.priceUsd !== undefined;
                  const usd = legUsd(addr);
                  const portion = drafts[addr]?.portion ?? null;
                  return (
                    <div className="px-3 pb-3 flex flex-col gap-2.5">
                      <div className="flex items-center gap-2">
                        <Input
                          value={mode === "usd" ? (drafts[addr]?.usdText ?? "") : (drafts[addr]?.total ?? "")}
                          onChange={(e) => (mode === "usd" ? setUsd(addr, e.target.value) : setTotal(addr, e.target.value))}
                          placeholder={mode === "usd" ? "Total in dollars" : `Total ${h.underlying}`}
                          inputMode="decimal"
                          aria-label={`Total to put in the pool, in ${mode === "usd" ? "dollars" : h.underlying}`}
                          className="!h-10 text-[14px] flex-1"
                        />
                        {priced && (
                          <Segmented<"units" | "usd">
                            size="sm"
                            className="w-[112px] shrink-0"
                            ariaLabel="Amount unit"
                            value={mode}
                            onChange={(m) => setMode(addr, m)}
                            options={[{ value: "units", label: h.underlying }, { value: "usd", label: "USD" }]}
                          />
                        )}
                      </div>
                      {/* A slice of the holding is how most of this is decided, and it reads as a
                          setting rather than as three loose buttons. */}
                      <Segmented<number>
                        size="sm"
                        ariaLabel={`How much of your ${h.underlying} to give`}
                        value={portion}
                        onChange={(p) => setPortion(addr, p)}
                        options={[
                          { value: 0.25, label: "25%" },
                          { value: 0.5, label: "50%" },
                          { value: 0.75, label: "75%" },
                          { value: 1, label: "All" },
                        ]}
                      />
                      {leg && leg.perClaim > 0n && (
                        <div className="flex items-baseline justify-between gap-3 font-mono num text-[12px]">
                          <span className="text-ink-secondary">{`${formatTokenAmount((leg.perClaim * leg.multiplier) / leg.wad, leg.asset.decimals)} ${leg.asset.underlying} each`}</span>
                          {usd !== null && <span className="text-ink">{`${formatUsd(usd)} total`}</span>}
                        </div>
                      )}
                      {leg && leg.dust > 0n && (
                        <p className="font-mono num text-[11px] text-ink-muted">
                          {`${formatTokenAmount((leg.dust * leg.multiplier) / leg.wad, leg.asset.decimals)} stays in your wallet — it does not divide evenly into ${slots}.`}
                        </p>
                      )}
                    </div>
                  );
                })()}
              </li>
            );
          })}
        </ul>
        {picked.length >= MAX_POOL_LEGS && <p className="text-[12px] text-ink-muted">A package holds at most {MAX_POOL_LEGS} stocks.</p>}
      </div>

      {/* 2 · how many people */}
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">How many people</span>
          <span className="font-mono num text-[11px] text-ink-secondary">{`${(100 / slots).toFixed(slots > 100 ? 2 : 1)}% each`}</span>
        </div>
        <div className="flex items-stretch gap-2">
          <Segmented<number>
            size="sm"
            className="flex-1"
            ariaLabel="How many people"
            value={SLOT_PRESETS.includes(slots) ? slots : null}
            onChange={setSlots}
            options={SLOT_PRESETS.map((n) => ({ value: n, label: String(n) }))}
          />
          <Input
            value={String(slots)}
            onChange={(e) => setSlots(Math.max(1, Math.min(10_000, Number(e.target.value.replace(/\D/g, "")) || 1)))}
            inputMode="numeric"
            aria-label="Number of shares"
            className="!h-10 w-[92px] text-[13px] num text-center"
          />
        </div>
      </div>

      {/* 3 · who can claim */}
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Who can claim</span>
        <Segmented<PoolGateMode>
          size="sm"
          ariaLabel="Who can claim"
          value={gateMode}
          onChange={(m) => {
            setGateMode(m);
            if (m !== "signer") setQuests([]);
          }}
          options={[
            { value: "link", label: "With the link" },
            { value: "open", label: "Anyone" },
            {
              value: "signer",
              label: "After a task",
              disabled: !questsEnabled,
              title: questsEnabled ? undefined : "This deployment has no campaign signer, so it cannot check anything.",
            },
          ]}
        />
        <p className="text-[12px] text-ink-muted">
          {gateMode === "link"
            ? "Whoever holds the share link can take one share. The key lives in the link only — never on a server."
            : gateMode === "open"
              ? "Anyone can claim a share directly, one per wallet, paying their own gas. Best for a public giveaway you want people to find."
              : "Claimers must finish a task first. BaseStocks verifies it and signs a one-off ticket; the pool cannot be claimed without one."}
        </p>
      </div>

      {gateMode === "signer" && <QuestPicker assets={assets} quests={quests} onChange={setQuests} />}

      {/* 4 · timing */}
      <div className="grid gap-4">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Claimable for</span>
          <Segmented<number> size="sm" ariaLabel="How long the pool stays claimable" value={days} onChange={setWindow} options={EXPIRY_DAYS.map(([d, label]) => ({ value: d, label }))} />
        </div>
      </div>

      {/* 5 · presentation */}
      <div className="flex flex-col gap-3">
        <Input label="Title (optional)" placeholder="Welcome pack for the meetup" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        <Input label="Message (optional, stored offchain)" placeholder="Thanks for coming!" value={message} maxLength={280} onChange={(e) => setMessage(e.target.value)} />
        <label className="flex items-start gap-2.5 text-[13px] text-ink-secondary cursor-pointer">
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} className="mt-0.5 accent-[var(--primary)] w-4 h-4" />
          <span>
            List in the public pool directory
            <span className="block text-[12px] text-ink-muted">Unlisted pools are reachable only through your link.</span>
          </span>
        </label>
      </div>

      {/* summary + submit */}
      <div className="border border-line rounded-[8px] bg-surface p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between text-[13px]">
          <span className="text-ink-secondary inline-flex items-center gap-1.5">
            <Layers size={14} strokeWidth={1.75} /> Locking in escrow
          </span>
          <span className="font-mono num">
            {legs.length === 0 ? "—" : legs.map((l) => `${formatTokenAmount((l.funded * l.multiplier) / l.wad, l.asset.decimals)} ${l.asset.underlying}`).join(" + ")}
          </span>
        </div>
        {usdTotal > 0 && (
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-ink-secondary">Approximate value</span>
            <span className="font-mono num">{`${formatUsd(usdTotal)}${anyUnpriced ? " +" : ""} · ${formatUsd(usdTotal / slots)} per person`}</span>
          </div>
        )}
      </div>

      {error && <ErrorBanner message={error.message} detail={error.detail} />}
      <Button full size="lg" loading={busy} disabled={!ready} onClick={() => setConfirming(true)}>
        {busy ? busyLabel : `Review and create · ${slots} shares`}
      </Button>

      {/*
        A pool is a transfer into a contract, and the terms it is created under cannot be edited
        afterwards. So the last screen before the wallet shows the thing as a claimant will meet it,
        says plainly whether it can be taken back, and asks again.
      */}
      {confirming && (
        <Sheet open={confirming} onClose={() => setConfirming(false)} title="Before you create it" wide>
          <div className="flex flex-col gap-4">
            {presetNote && <InfoBanner tone="warning">{presetNote}</InfoBanner>}
            {preset && !presetNote && <InfoBanner>A package for one person: every stock of the basket, one share, claimable with a link. Set the amount per stock below.</InfoBanner>}
            <div className="border border-line rounded-[8px] overflow-hidden">
              <div className="px-4 py-2 border-b border-line bg-surface font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">What each person sees</div>
              <div className="p-4 flex flex-col gap-1">
                <div className="eyebrow text-primary">{isPublic ? "Public gift pool" : "Gift pool"}</div>
                <div className="display text-[26px] leading-[1.1]">{title.trim() || perLabels.join(" + ") || "A tokenized stock"}</div>
                {title.trim() && <div className="font-mono num text-[13px] text-ink-secondary">{perLabels.join(" + ")} each</div>}
                {message.trim() && <p className="text-[13px] text-ink-secondary">“{message.trim()}”</p>}
                <div className="mt-1 font-mono text-[11px] text-ink-muted">{`${slots} shares · one per wallet · ${days} days to claim`}</div>
              </div>
            </div>

            <div className="flex flex-col">
              <KeyValue k="Moves into escrow" v={legs.map((l) => `${formatTokenAmount((l.funded * l.multiplier) / l.wad, l.asset.decimals)} ${l.asset.underlying}`).join(" + ") || "—"} mono={false} />
              {usdTotal > 0 && <KeyValue k="Approximate value" v={`${formatUsd(usdTotal)}${anyUnpriced ? " +" : ""} · ${formatUsd(usdTotal / slots)} each`} mono={false} />}
              <KeyValue k="Who can claim" v={gateMode === "open" ? "Anyone, one share per wallet" : gateMode === "link" ? "Anyone with your link" : `${quests.length} step${quests.length === 1 ? "" : "s"} to complete first`} mono={false} />
              <KeyValue k="Listed publicly" v={isPublic ? "Yes, in the pool directory" : "No, only through your link"} mono={false} />
            </div>

            <InfoBanner tone="neutral">
              <span className="inline-flex items-start gap-2">
                <TriangleAlert size={15} strokeWidth={1.75} className="shrink-0 mt-0.5" />
                <span>You can close this pool at any time and whatever is unclaimed comes back to you. Shares already claimed are gone — those belong to whoever took them.</span>
              </span>
            </InfoBanner>

            <p className="text-[12px] text-ink-muted">The number of shares, the amount each one pays out and the claim window are fixed when the pool is created. Nothing here can be edited afterwards. Creating needs a one-time sign-in to prove the wallet is yours.</p>

            <div className="flex gap-2">
              <Button variant="secondary" full onClick={() => setConfirming(false)}>
                Back
              </Button>
              <Button full loading={busy} onClick={() => void create()}>
                {busy ? busyLabel : "Create pool"}
              </Button>
            </div>
          </div>
        </Sheet>
      )}
      <p className="text-[12px] text-ink-muted">
        <Link2 size={12} strokeWidth={1.75} className="inline mr-1" />
        The stocks move into the BaseStocks gift pool, an ownerless contract that can only pay a claimant their exact share or return the remainder to you. On Base Account this is a single confirmation.
      </p>
    </div>
  );
}
