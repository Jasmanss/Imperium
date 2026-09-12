import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { AuthProvider } from "@/components/providers/AuthProvider";
import { CommandSessionProvider } from "@/components/providers/CommandSessionProvider";
import { EventStreamProvider } from "@/components/providers/EventStreamProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Imperium", template: "%s · Imperium" },
  description: "Run commands on your Mac from your phone, with confirmations, a live trace, and an audit log.",
  applicationName: "Imperium",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
  // "text 555-555-0100 saying on my way" must stay text, not become a phone link.
  formatDetection: { telephone: false, email: false, address: false },
  appleWebApp: { capable: true, title: "Imperium", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // The command bar is fixed to the bottom of the layout viewport. The default
  // (resizes-visual) leaves that viewport alone when the keyboard opens, so the
  // bar — and the send button — end up behind it while the user types.
  interactiveWidget: "resizes-content",
  themeColor: "#0b0d10",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-ground font-sans text-fg antialiased">
        <AuthProvider>
          <EventStreamProvider>
            <CommandSessionProvider>
              <AppShell>{children}</AppShell>
            </CommandSessionProvider>
          </EventStreamProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
