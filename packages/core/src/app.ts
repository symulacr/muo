export const [APP_NAME, APP_DESCRIPTION] = ["Mezo Upbeat Oracle", "MUSD Upbeat Oracle for the Mezo Bitcoin Economy"];
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const ICONS = [
  { url: "/favicon.ico", sizes: "any" },
  { url: "/logo.svg", type: "image/svg+xml" },
];
export const SHARED_METADATA = {
  metadataBase: new URL(APP_URL),
  title: { default: APP_NAME, template: `%s | ${APP_NAME}` },
  description: APP_DESCRIPTION,
  icons: { icon: ICONS, apple: "/logo-256x256.png" },
  openGraph: { type: "website", siteName: APP_NAME, url: APP_URL, locale: "en_US" },
  twitter: { card: "summary_large_image" as const },
  robots: { index: true, follow: true },
};
