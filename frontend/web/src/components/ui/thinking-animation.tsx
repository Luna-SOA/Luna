"use client";

import { ChatMatrix } from "@/components/ui/chat-matrix";
import { ScrambleText } from "@/components/ui/scramble-text";

interface ThinkingAnimationProps {
  text?: string;
  isLoading?: boolean;
  showShimmer?: boolean;
  matrixSize?: number;
  dotSize?: number;
  gap?: number;
}

export function ThinkingAnimation({ text, isLoading, showShimmer = true, matrixSize = 5, dotSize = 1.5, gap = 1.5 }: ThinkingAnimationProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center overflow-hidden text-inherit">
        {isLoading ? <div className="mr-2.5 shrink-0 transition-opacity"><ChatMatrix size={matrixSize} dotSize={dotSize} gap={gap} /></div> : null}
        <span>
          <ScrambleText text={text} isLoading={isLoading} showShimmer={showShimmer} />
        </span>
      </div>
    </div>
  );
}
