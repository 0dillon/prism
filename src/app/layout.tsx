import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prism",
  description: "An adaptive educational rendering engine.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
