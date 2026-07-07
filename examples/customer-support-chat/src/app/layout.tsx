import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PromptTrail Support Chat',
  description: 'Durable customer-support chat example for PromptTrail.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
