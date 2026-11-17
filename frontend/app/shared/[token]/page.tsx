import ShareView from "./ShareView";
import { Suspense } from "react";

export function generateStaticParams() {
  return [{ token: "preview" }];
}

export default function Page() {
  return <Suspense fallback={<p role="status" className="p-8 text-sm">Loading shared file…</p>}><ShareView /></Suspense>;
}
