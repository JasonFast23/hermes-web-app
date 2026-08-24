import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Anton } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const anton = Anton({
  variable: "--font-anton",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AiPX Agent",
  description: "AiPX Agent — voice and chat assistant powered by Eva",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AiPX Agent",
  },
};

// viewportFit: "cover" lets the app draw under the status bar/gesture bar
// on a phone in standalone (installed) mode, with env(safe-area-inset-*)
// used around the app's edges (TopBar, ChatInput, the mobile Sidebar
// drawer) to keep content clear of them instead of hiding under notches.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#18181b",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${anton.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
