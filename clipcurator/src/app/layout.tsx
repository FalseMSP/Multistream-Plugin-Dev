import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { QueryProvider } from "@/components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ClipCurator — Livestream VOD Clip Review",
  description:
    "Auto-generate highlight clips from Twitch/YouTube VODs, trim them in a fast review queue, and publish to one of two YouTube channels.",
  keywords: ["ClipCurator", "Twitch", "YouTube", "clipping", "VOD", "highlights"],
  authors: [{ name: "ClipCurator Team" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "ClipCurator",
    description: "Livestream VOD clip review and publishing pipeline",
    siteName: "ClipCurator",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ClipCurator",
    description: "Livestream VOD clip review and publishing pipeline",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground min-h-screen`}
      >
        <QueryProvider>{children}</QueryProvider>
        <Toaster />
      </body>
    </html>
  );
}
