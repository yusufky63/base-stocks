/**
 * The button language, shared by `Button` (a client component, it takes handlers) and `LinkButton`
 * (a plain anchor that can render on the server). Kept in its own hook-free module so neither has
 * to import the other.
 *
 * Honest 1px outline plus a solid 3px "ground" edge below (restrained neo-brutalist step); pressing
 * collapses the edge and the button sits down 2px. The primary fill is its own token because the
 * brand blue lifts in dark mode for text and rails, where white text on it would no longer pass AA.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ink";
export type ButtonSize = "sm" | "md" | "lg";

export const buttonVariantClass: Record<ButtonVariant, string> = {
  primary: "bg-primary-fill text-primary-contrast border border-primary-strong border-b-[3px] border-b-black/30 hover:brightness-[1.08] active:border-b active:translate-y-[2px] disabled:opacity-40 disabled:hover:bg-primary-fill",
  secondary: "bg-canvas text-ink border border-line-strong border-b-[3px] hover:bg-surface active:border-b active:translate-y-[2px] disabled:opacity-40",
  ghost: "bg-transparent text-ink-secondary border border-transparent hover:bg-surface hover:text-ink disabled:opacity-40",
  danger: "bg-canvas text-danger-fg border border-danger border-b-[3px] hover:bg-surface active:border-b active:translate-y-[2px] disabled:opacity-40",
  ink: "bg-ink text-canvas border border-ink border-b-[3px] border-b-black/40 hover:opacity-90 active:border-b active:translate-y-[2px] disabled:opacity-40",
};

export const buttonSizeClass: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-[13px]",
  md: "h-11 px-4 text-[15px]",
  lg: "h-12 px-5 text-[16px]",
};

export const buttonBaseClass = "inline-flex items-center justify-center gap-2 rounded-[6px] font-medium transition-fast min-h-[44px] tracking-[-0.01em] outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1 focus-visible:ring-offset-canvas";
