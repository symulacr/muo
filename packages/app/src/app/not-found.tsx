import Link from "next/link";

import { Button } from "@muo/utils/ui/button";

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col items-center justify-center gap-6 px-4 py-32 sm:px-6">
      <h1 className="font-semibold text-2xl tracking-tight">Page not found</h1>
      <Button render={<Link href="/">Go home</Link>} />
    </main>
  );
}
