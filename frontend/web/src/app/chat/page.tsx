import { Suspense } from "react";
import { ChatPage } from "@/components/chat/chat-page";

function ChatFallback() {
  return <div className="flex w-full flex-1 items-center justify-center px-4 text-sm text-muted-foreground">Loading chat...</div>;
}

export default function Page() {
  return (
    <Suspense fallback={<ChatFallback />}>
      <ChatPage />
    </Suspense>
  );
}
