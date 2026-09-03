import type { Address } from "viem";
import { BASE_CHAIN_ID } from "@/config/chain";

/** EIP-712 domain of GPv2Settlement on Base (same address on every chain); needed client-side to sign cancellations. */
export const COW_DOMAIN_CLIENT = { name: "Gnosis Protocol", version: "v2", chainId: BASE_CHAIN_ID, verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as Address } as const;
