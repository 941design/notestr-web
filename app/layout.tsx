import type { Metadata, Viewport } from "next";
import "./globals.css";

const basePath = process.env.NODE_ENV === "production" ? "/notestr" : "";

export const metadata: Metadata = {
  title: "notestr — encrypted task manager",
  description: "Encrypted task manager on Nostr with MLS groups",
  icons: {
    icon: `${basePath}/favicon.svg`,
    apple: `${basePath}/icon.svg`,
  },
  manifest: `${basePath}/manifest.json`,
};

export const viewport: Viewport = {
  themeColor: "#0d1117",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
