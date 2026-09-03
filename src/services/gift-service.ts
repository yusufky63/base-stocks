import type { Address } from "viem";
import { getRepos } from "@/db/repositories";
import { getAssets } from "@/services/b20-asset-service";
import { getBasenameAvatar, reverseResolve } from "@/services/basename-service";
import { toAssetDTO, type B20AssetDTO } from "@/domain/asset";
import type { GiftRecord } from "@/domain/gift";
import { formatTokenAmount } from "@/lib/format";

export interface GiftParty {
  address: Address;
  basename: string | null;
  /** BStocks handle / display name, only when the profile is public. */
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
}

/** Public receipt for a gift that was actually submitted; drafts are never exposed. */
export interface GiftReceipt {
  gift: GiftRecord;
  asset: B20AssetDTO | null;
  sender: GiftParty;
  recipient: GiftParty;
}

async function party(address: Address, knownBasename?: string): Promise<GiftParty> {
  const repos = getRepos();
  const [basename, profile] = await Promise.all([knownBasename ? Promise.resolve(knownBasename) : reverseResolve(address).catch(() => null), repos.profiles.get(address).catch(() => null)]);
  const avatar = basename ? await getBasenameAvatar(basename).catch(() => null) : null;
  const pub = profile?.isPublic ?? false;
  return { address, basename: basename ?? null, handle: pub ? (profile?.handle ?? null) : null, displayName: pub ? (profile?.displayName ?? null) : null, avatar };
}

export async function getGiftReceipt(id: string): Promise<GiftReceipt | null> {
  if (!/^gift_[a-z0-9_]{4,60}$/i.test(id)) return null;
  const gift = await getRepos().gifts.get(id);
  if (!gift || gift.status === "draft" || !gift.txHash) return null;
  const assets = await getAssets();
  const asset = assets.find((a) => a.address.toLowerCase() === gift.assetAddress.toLowerCase()) ?? null;
  const zero = gift.recipient === "0x0000000000000000000000000000000000000000";
  const [sender, recipient] = await Promise.all([party(gift.sender), zero ? Promise.resolve({ address: gift.recipient, basename: null, handle: null, displayName: null, avatar: null } satisfies GiftParty) : party(gift.recipient, gift.recipientBasename)]);
  return { gift, asset: asset ? toAssetDTO(asset) : null, sender, recipient };
}

export function giftPartyLabel(p: GiftParty): string {
  return p.basename ?? p.displayName ?? `${p.address.slice(0, 6)}…${p.address.slice(-4)}`;
}

/** Share-equivalent amount of the gift ("0.5 NVDA"), applying the B20 multiplier. */
export function giftAmountLabel(r: GiftReceipt): string {
  if (!r.asset) return "stock";
  const scaled = (BigInt(r.gift.rawAmount) * BigInt(r.asset.multiplier)) / BigInt(r.asset.wadPrecision);
  return `${formatTokenAmount(scaled, r.asset.decimals)} ${r.asset.underlying}`;
}
