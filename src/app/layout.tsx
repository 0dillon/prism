import type { Metadata } from "next";
import Link from "next/link";
import { LiveRegions } from "@/lib/a11y/live-region";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Prism", template: "%s | Prism" },
  description: "An adaptive educational rendering engine.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <header className="border-line flex items-center justify-between border-b px-6 py-4">
          <Link href="/" className="text-xl font-semibold tracking-tight">
            Prism
          </Link>
          <Link href="/sign-in" className="min-h-11 py-2 font-medium underline">
            Sign in
          </Link>
        </header>
        <main id="main-content" tabIndex={-1} className="flex-1">
          {children}
        </main>
        <footer className="border-line text-muted border-t px-6 py-4 text-sm">
          Prism adapts lessons to the way you learn.
        </footer>
        <LiveRegions />
      </body>
    </html>
  );
}
