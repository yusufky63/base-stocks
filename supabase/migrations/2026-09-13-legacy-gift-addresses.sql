-- Gifts and pools remember the contract they live in.
--
-- GiftEscrow and GiftPool are being redeployed. A claim-link gift locked in the old escrow must
-- stay claimable and reclaimable, and a pool funded in the old GiftPool must keep paying shares
-- and returning its remainder, while new records go to the new contracts. So each record carries
-- the address it was created against, and every onchain read, write and receipt check uses that
-- address instead of the app-wide constant.
--
-- Both columns are nullable on purpose: every row written before this migration belongs to the
-- first deployment, and the code treats a null as exactly that (`escrowAddressOf`,
-- `poolContractOf` fall back to the legacy address). Nothing is backfilled, so the two facts
-- "null" and "the first deployment" stay distinguishable if that ever matters.
--
-- The code tolerates these columns being absent (the insert is retried without the field), but
-- the fallback is only correct while every record really is a legacy one. Apply this BEFORE the
-- app starts creating records against the new contracts; a new gift or pool stored without its
-- address would be looked for in the old contract and never found.
alter table public.gifts add column if not exists escrow_address text;
alter table public.gift_pools add column if not exists contract_address text;
