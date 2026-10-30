import type { Metadata } from "next";
import type { PropsWithChildren } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";

import { SHARED_METADATA } from "@muo/core/app";

import { Header } from "@/components/header";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetBrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono" });

export const metadata: Metadata = {
  ...SHARED_METADATA,
  other: {
    "talentapp:project_verification":
      "5596fb46d81b14ce0be6ed3f516c3d1482b46a120127c58ea5bfb5bca498a6ed5b915e927b4d4d54238c7b8f408153b0b6313fdca540a0144e3fb7a9261fae48",
  },
};

export default function Layout({ children }: PropsWithChildren) {
  return (
    <html lang="en" className={`${inter.variable} ${jetBrainsMono.variable} scroll-smooth`}>
      <body className="font-sans antialiased">
        <Header />
        {children}
      </body>
    </html>
  );
}
