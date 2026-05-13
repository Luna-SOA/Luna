"use client";

import { forwardRef } from "react";
import { cn } from "@/components/ui/cn";

interface WoozlitDeleteDialogProps {
  open: boolean;
  deleting?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

const buttonBase = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";

export const WoozlitDeleteDialog = forwardRef<HTMLDivElement, WoozlitDeleteDialogProps>(function WoozlitDeleteDialog({ open, deleting = false, onClose, onConfirm }, ref) {
  if (!open) return null;

  return (
    <div className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-[10000] bg-black/50" onMouseDown={() => { if (!deleting) onClose(); }}>
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-describedby="delete-dialog-description"
        aria-labelledby="delete-dialog-title"
        data-slot="alert-dialog-content"
        data-state="open"
        className="bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-[10000] grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-2xl border p-6 duration-200 sm:max-w-lg max-w-sm"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div data-slot="alert-dialog-header" className="flex flex-col gap-2 text-center sm:text-left">
          <h2 id="delete-dialog-title" data-slot="alert-dialog-title" className="text-lg font-semibold">Are you sure?</h2>
          <p id="delete-dialog-description" data-slot="alert-dialog-description" className="text-muted-foreground text-sm">This will permanently delete this conversation.</p>
        </div>
        <div data-slot="alert-dialog-footer" className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" disabled={deleting} onClick={onClose} className={cn(buttonBase, "h-9 px-4 py-2 border bg-background hover:bg-accent hover:text-accent-foreground")}>Cancel</button>
          <button type="button" disabled={deleting} onClick={onConfirm} className={cn(buttonBase, "h-9 px-4 py-2 bg-destructive text-destructive-foreground hover:bg-destructive/90")}>{deleting ? "Deleting..." : "Delete"}</button>
        </div>
      </div>
    </div>
  );
});
