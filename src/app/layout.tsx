import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "OAuth Trailhead",
  description: "How hard is it to get an OAuth app approved? Evidence-backed setup guides for developers building AI agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <header className="site-header">
          <div className="wrap site-header-inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true">▲</span> OAuth Trailhead
            </Link>
            <nav aria-label="Main">
              <Link href="/">Library</Link>
              <Link href="/validation">How we checked</Link>
            </nav>
          </div>
        </header>
        <main id="main" className="wrap">{children}</main>
        <footer className="site-footer">
          <div className="wrap">
            An independent take-home project, not affiliated with Composio or any provider listed. Requirements change, so check the linked sources before you rely on them.
          </div>
        </footer>
      </body>
    </html>
  );
}
