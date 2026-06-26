import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { getCurrentUser } from "@/lib/auth/user";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "RealTour Pilot — Operations Hub",
  description: "Single source of truth for RealTour Pilot, your real estate media agency.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cu = await getCurrentUser();
  // Serializable subset for the client Shell/Sidebar.
  const user = cu
    ? { name: cu.name, email: cu.email, role: cu.role, impersonating: cu.impersonating, realName: cu.realName }
    : null;
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <Shell user={user}>{children}</Shell>
      </body>
    </html>
  );
}
