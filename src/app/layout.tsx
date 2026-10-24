import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Steady",
  description: "Hands-free painting in Krita with a resting hand and your voice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
