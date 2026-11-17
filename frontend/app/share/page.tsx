import { Suspense } from "react";
import ShareView from "../shared/[token]/ShareView";

/** Query-based entry point also works in Android's fully static bundle. */
export default function SharedFilePage() {
  return <Suspense fallback={<p role="status" className="p-8 text-sm">Loading shared file…</p>}><ShareView /></Suspense>;
}
