"use client";
/** Steady's only page. Camera, tracking and audio are client-only (dynamic, ssr: false). Owned by B. */
import dynamic from "next/dynamic";

const SteadyApp = dynamic(() => import("../components/SteadyApp"), {
  ssr: false,
  loading: () => <main className="loading">Steady is starting…</main>,
});

export default function Page() {
  return <SteadyApp />;
}
