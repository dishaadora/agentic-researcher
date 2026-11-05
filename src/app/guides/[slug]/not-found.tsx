import Link from "next/link";

export default function NotFound() {
  return (
    <section className="hero">
      <h1>We don't have that guide</h1>
      <p className="lede">It may have been generated on another server. You can <Link href="/">search for the app</Link> to generate it again.</p>
    </section>
  );
}
