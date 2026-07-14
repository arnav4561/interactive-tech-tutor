import { motion } from "framer-motion";
import { cn } from "../../lib/utils";

interface AuroraBackgroundProps {
  className?: string;
}

export function AuroraBackground({ className }: AuroraBackgroundProps): JSX.Element {
  return (
    <motion.div
      className={cn("aceternity-aurora", className)}
      aria-hidden="true"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.8, ease: "easeOut" }}
    />
  );
}
