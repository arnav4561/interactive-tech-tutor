import { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

interface MovingBorderButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  borderClassName?: string;
}

export function MovingBorderButton({
  className,
  borderClassName,
  children,
  ...props
}: MovingBorderButtonProps): JSX.Element {
  return (
    <button className={cn("aceternity-moving-border-button", className)} {...props}>
      <span className={cn("aceternity-moving-border", borderClassName)} aria-hidden="true" />
      <span className="aceternity-moving-border-content">{children}</span>
    </button>
  );
}
