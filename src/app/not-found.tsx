import { LinkButton } from "@/components/ui/primitives";

export default function NotFound() {
  return (
    <div className="border border-line rounded-[8px] p-8 md:p-12 flex flex-col gap-4 items-start">
      <h1 className="display text-[32px] md:text-[40px] leading-none">Not found.</h1>
      <p className="text-ink-secondary max-w-[48ch]">That page or asset doesn’t exist. Only verified Coinbase Tokenized Stocks are listed, identified by contract address.</p>
      <LinkButton href="/markets" variant="primary">
        Browse markets
      </LinkButton>
    </div>
  );
}
