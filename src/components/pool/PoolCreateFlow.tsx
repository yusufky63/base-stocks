"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, erc20Abi, formatUnits, type Address, type Hash } from "viem";
import { base } from "viem/chains";
import { Check, Layers, Link2, Lock, TriangleAlert, Users } from "lucide-react";
import type { B20AssetDTO } from "@/domain/asset";
import type { PoolGateMode, PoolRecord, Quest } from "@/domain/pool";
import type { PortfolioHolding } from "@/domain/portfolio";
import { BASE_CHAIN_ID } from "@/config/chain";
import { publicEnv } from "@/config/env";
import { apiPatch, apiPost, ApiError } from "@/lib/client-api";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
import { GIFT_POOL_ADDRESS, MAX_POOL_LEGS, giftPoolAbi, makePoolLinkSecret, poolPath, poolSalt, splitIntoShares } from "@/lib/pool";
import { humanizeError, TRADE_ERROR_COPY, type HumanError } from "@/lib/errors";
import { useAuth } from "@/hooks/useAuth";
import { useConfigFlags } from "@/hooks/queries";
import { parseAmountSafe, toRaw } from "@/lib/b20/math";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { Input } from "@/components/ui/Input";
import { Button, Chip, KeyValue, cx } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { AssetLogo, ErrorBanner, InfoBanner } from "@/components/common/display";
import { ShareActions } from "@/components/common/ShareSheet";
import { QuestPicker, questsValid } from "./QuestPicker";

const EXPIRY_DAYS: Array<[number, string]> = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
];
const LOCK_DAYS: Array<[number, string]> = [
  [0, "Any time"],
  [3, "3 days"],
  [7, "7 days"],
];
const SLOT_PRESETS = [5, 10, 25, 100];

type Phase = "form" | "signing" | "submitted" | "ready";

interface LegDraft {
  /** Human amount of the TOTAL to give away for this stock. */
  total: string;
}

/**
 * Creates a gift pool: one deposit, many equal shares. The creator names the total per stock and
 * how many people it is for; the split is computed here and sent to the contract as an exact
 * per-claim amount, so nothing rounds onchain and no dust is left behind.
 */
export function PoolCreateFlow({ holdings, assets }: { holdings: PortfolioHolding[]; assets: B20AssetDTO[] }) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const { isSignedIn, ensureSignedIn } = useAuth();
  const questsEnabled = useConfigFlags().data?.poolQuestsEnabled ?? false;

  const [picked, setPicked] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, LegDraft>>({});
  const [slots, setSlots] = useState(10);
  const [gateMode, setGateMode] = useState<PoolGateMode>("link");
  const [days, setDays] = useState(7);
  const [lockDays, setLockDays] = useState(0);
  const [isPublic, setIsPublic] = useState(false);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [quests, setQuests] = useState<Quest[]>([]);

  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<HumanError | null>(null);
  const [created, setCreated] = useState<{ pool: PoolRecord; link: string } | null>(null);
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

  const toggle = (addr: string) => {
    setPicked((cur) => (cur.includes(addr) ? cur.filter((a) => a !== addr) : cur.length >= MAX_POOL_LEGS ? cur : [...cur, addr]));
  };

  const setTotal = (addr: string, total: string) => setDrafts((d) => ({ ...d, [addr]: { total } }));

  /** A lock can never outlast the claim window, so shortening the window releases it. */
  const setWindow = (d: number) => {
    setDays(d);
    if (lockDays >= d) setLockDays(0);
  };

  const setMax = (addr: string) => {
    const holding = holdings.find((h) => h.assetAddress.toLowerCase() === addr);
    const asset = assetFor(addr);
    if (!holding || !asset) return;
    const multiplier = BigInt(asset.multiplier);
    const wad = BigInt(asset.wadPrecision);
    setTotal(addr, formatUnits((BigInt(holding.rawBalance) * multiplier) / wad, asset.decimals));
  };

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
      if (isPublic && !isSignedIn) await ensureSignedIn();

      const secret = gateMode === "link" ? makePoolLinkSecret() : null;
      const expiry = Date.now() + days * 24 * 3600 * 1000;
      const lockedUntil = lockDays > 0 ? Date.now() + lockDays * 24 * 3600 * 1000 : 0;

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
      const approvals = legs.map((l) => ({
        to: l.asset.address as Address,
        data: withAttribution(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GIFT_POOL_ADDRESS as Address, l.funded] })),
      }));

      let atomic = false;
      let paymaster = false;
      try {
        const caps = (await walletClient.getCapabilities({ account: address, chainId: BASE_CHAIN_ID })) as { atomic?: { status?: string }; paymasterService?: { supported?: boolean } };
        atomic = caps.atomic?.status === "supported" || caps.atomic?.status === "ready";
        paymaster = !!publicEnv.paymasterUrl && !!caps.paymasterService?.supported;
      } catch {
        atomic = false;
      }

      let hash: Hash | undefined;
      if (atomic) {
        const { id } = await walletClient.sendCalls({
          account: address,
          chain: base,
          forceAtomic: true,
          calls: [...approvals, { to: GIFT_POOL_ADDRESS as Address, data: withAttribution(createData) }],
          capabilities: { ...attributionCapabilities(), ...(paymaster ? { paymasterService: { url: publicEnv.paymasterUrl } } : {}) },
        });
        setPhase("submitted");
        const result = await walletClient.waitForCallsStatus({ id, timeout: 240_000 });
        if (result.status === "failure") throw new Error("The batched transaction failed onchain.");
        hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
      } else {
        for (const a of approvals) {
          const ah = await walletClient.sendTransaction({ account: address, chain: base, to: a.to, data: a.data });
          await publicClient.waitForTransactionReceipt({ hash: ah });
        }
        // Dry run before spending gas on the real thing.
        await publicClient.call({ account: address, to: GIFT_POOL_ADDRESS as Address, data: createData });
        hash = await walletClient.sendTransaction({ account: address, chain: base, to: GIFT_POOL_ADDRESS as Address, data: withAttribution(createData) });
        setPhase("submitted");
        await publicClient.waitForTransactionReceipt({ hash });
      }

      setTxHash(hash);
      void apiPatch(`/api/pools/${pool.id}`, { txHash: hash, status: "submitted" }).catch(() => undefined);
      setCreated({ pool, link: `${window.location.origin}${poolPath(pool.id, secret?.privateKey)}` });
      setPhase("ready");
    } catch (err) {
      setError(err instanceof ApiError ? { code: (err.code in TRADE_ERROR_COPY ? err.code : "UNKNOWN") as HumanError["code"], message: err.message } : humanizeError(err));
      setPhase("form");
    }
  };

  /* ------------------------------- done view ------------------------------- */

  if (phase === "ready" && created) {
    const perLabels = legs.map((l) => `${formatTokenAmount((l.perClaim * l.multiplier) / l.wad, l.asset.decimals)} ${l.asset.underlying}`);
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
        {gateMode === "link" && (
          <InfoBanner tone="warning">
            <span className="inline-flex items-start gap-2">
              <TriangleAlert size={15} strokeWidth={1.75} className="shrink-0 mt-0.5 text-warning-fg" />
              <span>This link is the key to the pool: anyone holding it can take a share, one per wallet. It is shown once and stored nowhere.</span>
            </span>
          </InfoBanner>
        )}
        <ShareActions path={created.link.replace(window.location.origin, "")} text={`Free stock on Base: ${perLabels.join(" + ")} each, ${slots} shares. No wallet needed — open the link to claim.`} />
        {txHash && <KeyValue k="Funding tx" v={txHash} />}
        <p className="text-[12px] text-ink-muted">Manage it any time from Gift → History: see who claimed, close it, and take the unclaimed remainder back.</p>
      </div>
    );
  }

  /* --------------------------------- form ---------------------------------- */

  const busy = phase === "signing" || phase === "submitted";

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
                  {on && (
                    <span className="flex items-center gap-2 shrink-0 w-[190px]">
                      <Input
                        value={drafts[addr]?.total ?? ""}
                        onChange={(e) => setTotal(addr, e.target.value)}
                        placeholder="Total to give"
                        inputMode="decimal"
                        aria-label={`Total ${h.underlying} to put in the pool`}
                        className="!h-9 text-[13px]"
                      />
                      <Chip onClick={() => setMax(addr)} className="h-9 min-h-[36px] px-2 text-[11px]">
                        Max
                      </Chip>
                    </span>
                  )}
                </div>
                {on && leg && leg.perClaim > 0n && (
                  <div className="px-3 pb-2.5 -mt-1 font-mono text-[11px] text-ink-secondary num">
                    {`${formatTokenAmount((leg.perClaim * leg.multiplier) / leg.wad, leg.asset.decimals)} ${leg.asset.underlying} per person`}
                    {leg.dust > 0n && ` · ${formatTokenAmount((leg.dust * leg.multiplier) / leg.wad, leg.asset.decimals)} stays in your wallet (does not divide evenly)`}
                  </div>
                )}
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
              ? "Anyone can claim a share directly, one per wallet. Best for a public giveaway you want people to find."
              : "Claimers must finish a task first. BStocks verifies it and signs a one-off ticket; the pool cannot be claimed without one."}
        </p>
      </div>

      {gateMode === "signer" && <QuestPicker assets={assets} quests={quests} onChange={setQuests} />}

      {/* 4 · timing */}
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Claimable for</span>
          <Segmented<number> size="sm" ariaLabel="How long the pool stays claimable" value={days} onChange={setWindow} options={EXPIRY_DAYS.map(([d, label]) => ({ value: d, label }))} />
        </div>
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted inline-flex items-center gap-1.5">
            <Lock size={11} strokeWidth={2} /> You can close it
          </span>
          <Segmented<number>
            size="sm"
            ariaLabel="When the creator may close the pool"
            value={lockDays}
            onChange={setLockDays}
            options={LOCK_DAYS.map(([d, label]) => ({ value: d, label: d === 0 ? label : `Not for ${label}`, disabled: d >= days }))}
          />
        </div>
      </div>
      {lockDays > 0 && (
        <p className="text-[12px] text-ink-muted -mt-2">
          A lock is a promise anyone can verify onchain: for {lockDays} days you cannot take the pool back, whatever happens.
        </p>
      )}

      {/* 5 · presentation */}
      <div className="flex flex-col gap-3">
        <Input label="Title (optional)" placeholder="Welcome pack for the meetup" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        <Input label="Message (optional, stored offchain)" placeholder="Thanks for coming!" value={message} maxLength={280} onChange={(e) => setMessage(e.target.value)} />
        <label className="flex items-start gap-2.5 text-[13px] text-ink-secondary cursor-pointer">
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} className="mt-0.5 accent-[var(--primary)] w-4 h-4" />
          <span>
            List in the public pool directory
            <span className="block text-[12px] text-ink-muted">Needs a one-time sign-in to prove the wallet is yours. Unlisted pools are reachable only through your link.</span>
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
      <Button full size="lg" loading={busy} disabled={!ready} onClick={() => void create()}>
        {busy ? (phase === "submitted" ? "Locking in escrow…" : "Confirm in your wallet…") : `Create pool · ${slots} shares`}
      </Button>
      <p className="text-[12px] text-ink-muted">
        <Link2 size={12} strokeWidth={1.75} className="inline mr-1" />
        The stocks move into the BStocks gift pool, an ownerless contract that can only pay a claimant their exact share or return the remainder to you. On Base Account this is a single confirmation.
      </p>
    </div>
  );
}
