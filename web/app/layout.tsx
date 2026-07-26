import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChatDDB — One Workspace. Every AI.",
  description:
    "ChatDDB is a premium AI workspace where you can access models from OpenAI, Anthropic, Google, Groq, and more — all in one place.",
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "ChatDDB — One Workspace. Every AI.",
    description:
      "Access every major AI model in one beautiful workspace. Chat, code, create.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="h-screen overflow-hidden">{children}</body>
    </html>
  );
}
