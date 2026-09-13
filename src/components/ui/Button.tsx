"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { buttonBaseClass, buttonSizeClass, buttonVariantClass, type ButtonSize, type ButtonVariant } from "./button-styles";
import { cx } from "./cx";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  full?: boolean;
}

/**
 * The one primitive that has to be a client component: it exists to take an `onClick`, and a
 * function prop can only cross into a client module. Everything else in `primitives.tsx` renders
 * on the server and is re-exported alongside this.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "primary", size = "md", loading, full, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(buttonBaseClass, "transition-[background-color,opacity,border-color,transform,box-shadow] select-none", buttonVariantClass[variant], buttonSizeClass[size], full && "w-full", className)}
      {...rest}
    >
      {loading && <span aria-hidden className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
});
