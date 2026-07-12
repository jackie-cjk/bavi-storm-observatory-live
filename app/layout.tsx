import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "暗桌私人局 — 德州扑克";
  const description = "输入玩家 ID，查看正在进行的真人牌桌，与朋友进行 2–9 人、5/5 盲注的在线德州扑克。";

  return {
    metadataBase: new URL(origin),
    title,
    description,
    applicationName: "The Backroom Poker",
    authors: [{ name: "The Backroom Poker Club" }],
    keywords: ["真人德州扑克", "Texas Hold'em", "在线扑克", "5/5 盲注", "九人桌"],
    openGraph: {
      type: "website",
      title,
      description,
      siteName: "暗桌私人局",
      images: [{ url: `${origin}/og.png`, width: 1536, height: 1024, alt: "暗桌私人局德州扑克牌桌" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#090a0b",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        <script src="/config.js?v=2" />
      </head>
      <body>{children}</body>
    </html>
  );
}
