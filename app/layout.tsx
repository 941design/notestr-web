import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { getBasePath } from "@/config/base-path";
import "./globals.css";

const basePath = getBasePath();

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
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head />
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
