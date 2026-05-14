"use client";

import { useState, useEffect, useRef } from "react";
import { cn } from "@/components/ui/cn";
import { Shimmer } from "@/components/ui/shimmer";

interface ScrambleTextProps {
  text?: string;
  isLoading?: boolean;
  showShimmer?: boolean;
  className?: string;
}

const messages = [
  "Luna is thinking...",
  "wait wait… almost got it...",
  "hold up let me think real quick...",
  "Finding the best answer",
  "Almost there",
];

const finishedMessage = "Done";
const chars = "abcdefghijklmnopqrstuvwxyz";
const totalFrames = 30;

export function ScrambleText({
  text,
  isLoading,
  showShimmer = true,
  className,
}: ScrambleTextProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const targetText = text || (isLoading ? messages[currentIndex] : finishedMessage);
  const [displayedText, setDisplayedText] = useState(() => targetText || "");
  const frameRef = useRef(0);
  const [isScrambling, setIsScrambling] = useState(false);
  const fromTextRef = useRef("");
  const toTextRef = useRef("");

  useEffect(() => {
    if (isLoading && !text) {
      const interval = setInterval(() => {
        setCurrentIndex((prev) => (prev + 1) % messages.length);
      }, 3500);
      return () => clearInterval(interval);
    }
  }, [isLoading, text]);

  useEffect(() => {
    let animationFrameId: number;

    const scrambleLoop = () => {
      frameRef.current++;
      const maxLength = Math.max(fromTextRef.current.length, toTextRef.current.length);
      let result = "";

      for (let i = 0; i < maxLength; i++) {
        const progress = frameRef.current / totalFrames;
        const charProgress = progress * maxLength;

        if (i < charProgress - 2) {
          result += toTextRef.current[i] || "";
        } else if (i < charProgress) {
          result += chars[Math.floor(Math.random() * chars.length)];
        } else {
          result += fromTextRef.current[i] || "";
        }
      }

      setDisplayedText(result);

      if (frameRef.current >= totalFrames) {
        setDisplayedText(toTextRef.current);
        setIsScrambling(false);
      } else {
        animationFrameId = requestAnimationFrame(scrambleLoop);
      }
    };

    if (isScrambling) {
      animationFrameId = requestAnimationFrame(scrambleLoop);
    }

    return () => cancelAnimationFrame(animationFrameId);
  }, [isScrambling]);

  const prevTargetText = useRef(targetText);
  useEffect(() => {
    if (targetText !== prevTargetText.current && targetText && prevTargetText.current) {
      fromTextRef.current = prevTargetText.current;
      toTextRef.current = targetText;
      frameRef.current = 0;
      setIsScrambling(true);
    } else if (!prevTargetText.current && targetText) {
      setDisplayedText(targetText);
    }
    prevTargetText.current = targetText;
  }, [targetText]);

  if (isLoading && showShimmer) {
    return <Shimmer className={cn("tracking-tight", className)}>{displayedText}</Shimmer>;
  }

  return <span className={cn("tracking-tight", className)}>{displayedText}</span>;
}
