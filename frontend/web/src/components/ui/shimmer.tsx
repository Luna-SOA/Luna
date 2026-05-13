"use client";

import { cn } from "@/components/ui/cn";
import { memo, type ElementType } from "react";

export type TextShimmerProps = {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
};

const ShimmerComponent = ({ children, as: Component = "p", className }: TextShimmerProps) => (
  <Component className={cn("inline-block animate-pulse text-muted-foreground", className)}>
    {children}
  </Component>
);

export const Shimmer = memo(ShimmerComponent);
