import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Central Theatre Revenue — UNTH Ituku Ozalla',
  description: 'Revenue collection, payment and automated revenue allocation.',
  // A financial system should not be indexed, previewed or cached by anything.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG">
      <body>{children}</body>
    </html>
  );
}
