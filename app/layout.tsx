import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "BAVI 2609 — Live Typhoon Observatory";
  const description =
    "A live, particle-driven view of Typhoon Bavi's official CMA track, forecast, history, and far-field rainfall impact on Beijing.";

  return {
    metadataBase: new URL(origin),
    title,
    description,
    applicationName: "Aether Storm Observatory",
    authors: [{ name: "Aether Storm Observatory" }],
    keywords: ["Typhoon Bavi", "CMA", "NMC", "Beijing weather", "typhoon tracker"],
    openGraph: {
      type: "website",
      title,
      description,
      siteName: "Aether Storm Observatory",
      images: [{ url: `${origin}/og.png`, width: 1733, height: 907, alt: "Bavi 2609 live typhoon track and Beijing impact" }],
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
  themeColor: "#02060d",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
