import { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

interface SpotlightCardProps extends HTMLAttributes<HTMLDivElement> {
  as?: "div" | "section" | "article";
}

export function SpotlightCard({
  as: Component = "div",
  className,
  children,
  ...props
}: SpotlightCardProps): JSX.Element {
  return (
    <Component className={cn("aceternity-spotlight-card", className)} {...props}>
      {children}
    </Component>
  );
}
