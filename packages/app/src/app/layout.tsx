import type { Metadata } from "next";
import type { PropsWithChildren } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";

import { SHARED_METADATA } from "@muo/core/app";

import { Header } from "@/components/header";
import { AppProviders } from "@/components/providers/app-providers";
import { cn } from "@/lib/utils";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetBrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  ...SHARED_METADATA,
  manifest: "/site.webmanifest",
};

export default function Layout({ children }: PropsWithChildren) {
  return (
    <html lang="en" suppressHydrationWarning className={cn("font-sans", inter.variable)}>
      <body className={cn([jetBrainsMono.variable, "antialiased"])}>
        <AppProviders>
          <Header />
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
