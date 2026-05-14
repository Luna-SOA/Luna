"use client";

import { useState, useEffect, useMemo, type CSSProperties } from "react";

interface ChatMatrixProps {
  size?: number;
  dotSize?: number;
  gap?: number;
  staticPattern?: boolean;
}

const patterns = [
  // Vertical waves
  [[0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22], [3, 8, 13, 18, 23], [4, 9, 14, 19, 24]],
  
  // Center expand
  [[12], [6, 7, 8, 11, 13, 16, 17, 18], [1, 2, 3, 5, 9, 10, 14, 15, 19, 21, 22, 23], [0, 4, 20, 24]],
  
  // Horizontal waves
  [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14], [15, 16, 17, 18, 19], [20, 21, 22, 23, 24]],
  
  // Cross pattern
  [[2, 10, 11, 12, 13, 14, 22], [6, 7, 8, 16, 17, 18], [0, 1, 3, 4, 5, 9, 15, 19, 20, 21, 23, 24]],
  
  // Diagonal
  [[0], [1, 5], [2, 6, 10], [3, 7, 11, 15], [4, 8, 12, 16, 20], [9, 13, 17, 21], [14, 18, 22], [19, 23], [24]],
  
  // Random clusters
  [[6, 7, 8, 11, 12, 13, 16, 17, 18], [1, 3, 5, 9, 10, 14, 15, 19, 21, 23], [0, 2, 4, 20, 22, 24]],
  
  // Rows converging
  [[0, 1, 2, 3, 4, 20, 21, 22, 23, 24], [5, 6, 7, 8, 9, 15, 16, 17, 18, 19], [10, 11, 12, 13, 14]],
  
  // Quadrants then cross
  [[0, 1, 5, 6], [3, 4, 8, 9], [15, 16, 20, 21], [18, 19, 23, 24], [2, 7, 10, 11, 12, 13, 14, 17, 22]],
  
  // Corners inward
  [[0, 4, 20, 24], [1, 3, 5, 9, 15, 19, 21, 23], [2, 6, 8, 10, 14, 16, 18, 22], [7, 11, 12, 13, 17]],
  
  // Checkerboard
  [
    [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24],
    [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]
  ],
  
  // Square outline inwards
  [
    [0, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5],
    [6, 7, 8, 13, 18, 17, 16, 11],
    [12]
  ],
  
  // Zigzag rows
  [
    [0, 1, 2, 3, 4],
    [9, 8, 7, 6, 5],
    [10, 11, 12, 13, 14],
    [19, 18, 17, 16, 15],
    [20, 21, 22, 23, 24]
  ],

  // Pulsating fill
  [
    Array.from({ length: 25 }, (_, i) => i),
    [],
    [12],
    [6, 7, 8, 11, 13, 16, 17, 18, 12],
    [0, 4, 20, 24, 12],
    Array.from({ length: 25 }, (_, i) => i)
  ],

  // Arrow right
  [[0, 5, 10, 15, 20], [6, 11, 16, 21], [12, 17, 22], [13, 18, 23], [14, 19, 24]],

  // Arrow left
  [[4, 9, 14, 19, 24], [3, 8, 13, 18], [2, 7, 12, 17], [1, 6, 11, 16], [0, 5, 10, 15, 20]],

  // X pattern
  [[0, 4, 6, 8, 12, 16, 18, 20, 24], [1, 3, 7, 11, 13, 17, 21, 23], [2, 12, 22], [5, 15], [9, 19]],

  // Spiral in reverse
  [[12], [11, 13, 7, 17], [6, 8, 16, 18], [1, 2, 3, 5, 9, 10, 14, 15, 19, 21, 22, 23], [0, 4, 20, 24]],
];

const STATIC_HIGHLIGHT: number[] = [6, 7, 8, 11, 12, 13, 16, 17, 18];

export function ChatMatrix({
  size = 5,
  dotSize = 2,
  gap = 2,
  staticPattern = false,
}: ChatMatrixProps) {
  const totalDots = useMemo(() => size * size, [size]);
  const staticDots = useMemo(() => new Set(STATIC_HIGHLIGHT.filter((i) => i < totalDots)), [totalDots]);
  const [activeDots, setActiveDots] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (staticPattern) return;

    let patternIndex = 0;
    let stepIndex = 0;
    let timer: NodeJS.Timeout;

    const nextStep = () => {
      const pattern = patterns[patternIndex];
      if (!pattern) return;

      setActiveDots(new Set(pattern[stepIndex]));
      stepIndex++;

      if (stepIndex >= pattern.length) {
        stepIndex = 0;
        patternIndex = (patternIndex + 1) % patterns.length;
      }

      timer = setTimeout(nextStep, 120);
    };

    nextStep();

    return () => clearTimeout(timer);
  }, [staticPattern, totalDots]);

  const renderedActiveDots = staticPattern ? staticDots : activeDots;

  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `repeat(${size}, 1fr)`,
    gap: `${gap}px`,
    width: `${size * dotSize + (size - 1) * gap}px`,
    height: `${size * dotSize + (size - 1) * gap}px`,
  };

  const dotStyle: CSSProperties = {
    width: `${dotSize}px`,
    height: `${dotSize}px`,
  };

  return (
    <div style={gridStyle}>
      {Array.from({ length: totalDots }).map((_, i) => {
        const isActive = renderedActiveDots.has(i);
        return (
          <span
            key={i}
            className={`rounded-full bg-current transition-all duration-150 ease-out ${
              isActive ? "opacity-100 scale-110" : "opacity-15 scale-75"
            }`}
            style={dotStyle}
          />
        );
      })}
    </div>
  );
}
