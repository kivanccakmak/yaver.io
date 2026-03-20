import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ThemeProvider from "@/components/ThemeProvider";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Yaver - Use Claude from Anywhere",
  description:
    "Access Claude AI from any device with peer-to-peer encrypted connections. Real-time streaming, multi-device support, and seamless integration.",
  keywords: [
    "Claude",
    "AI",
    "Anthropic",
    "P2P",
    "encrypted",
    "multi-device",
    "streaming",
  ],
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    title: "Yaver - Use Claude from Anywhere",
    description:
      "Access Claude AI from any device with peer-to-peer encrypted connections.",
    url: "https://yaver.io",
    siteName: "Yaver",
    type: "website",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Yaver - Use Claude from Anywhere",
    description:
      "Access Claude AI from any device with peer-to-peer encrypted connections.",
    images: ["/og-image.png"],
  },
  metadataBase: new URL("https://yaver.io"),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-K7JHRJKPQB"
          strategy="afterInteractive"
        />
        <Script id="gtag-init" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-K7JHRJKPQB');
          `}
        </Script>
      </head>
      <body className={`${inter.variable} font-sans`}>
        <ThemeProvider>
          <div className="flex min-h-screen flex-col">
            <Header />
            <main className="flex-1">{children}</main>
            <Footer />
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
