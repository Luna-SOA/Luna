"use client";

import { useEffect, useState } from "react";

const WORKSPACE_ID_KEY = "luna.workspaceId";
const WORKSPACE_CHANGED_EVENT = "luna:workspace-changed";

function createWorkspaceId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `local-${Date.now()}`;
}

export function getStoredWorkspaceId() {
  if (typeof window === "undefined") return "local-workspace";
  const existing = window.localStorage.getItem(WORKSPACE_ID_KEY);
  if (existing) return existing;
  const next = createWorkspaceId();
  window.localStorage.setItem(WORKSPACE_ID_KEY, next);
  return next;
}

export function resetStoredWorkspaceId() {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WORKSPACE_ID_KEY, createWorkspaceId());
  window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
}

export function useWorkspaceId() {
  const [workspaceId, setWorkspaceId] = useState(() => getStoredWorkspaceId());

  useEffect(() => {
    function refresh() {
      setWorkspaceId(getStoredWorkspaceId());
    }

    window.addEventListener("storage", refresh);
    window.addEventListener(WORKSPACE_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, refresh);
    };
  }, []);

  return workspaceId;
}
