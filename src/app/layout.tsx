import type { Metadata } from "next";
import { Inter, Geist_Mono, Sora } from "next/font/google";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { getCurrentUser } from "@/lib/auth/user";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const sora = Sora({
  variable: "--font-sora",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Realtour Pilot — Operations Hub",
  description: "Single source of truth for Realtour Pilot, your real estate media agency.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cu = await getCurrentUser();
  // Serializable subset for the client Shell/Sidebar.
  // Fail CLOSED (audit G, Oct 20 2026): a settings hiccup must not label the
  // menu "My Pay" for someone whose page then shows My Performance.
  const payHidden = cu ? await import("@/lib/settings").then((m) => m.payHiddenFor(cu)).catch(() => true) : true;
  const user = cu
    ? { name: cu.name, email: cu.email, role: cu.role, permissions: cu.permissions, impersonating: cu.impersonating, realName: cu.realName, payHidden }
    : null;
  return (
    <html
      lang="en"
      className={`${inter.variable} ${sora.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Theme boot: runs before paint so a light-mode user never sees a dark
            flash. localStorage choice wins; first visit follows the device. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var t=localStorage.getItem("rtp_theme");if(t==="light"||(!t&&window.matchMedia("(prefers-color-scheme: light)").matches))document.documentElement.classList.add("light");}catch(e){}})();',
          }}
        />
      </head>
      <body className="min-h-full">
        <Shell user={user} scriptingUrl={process.env.SCRIPTING_BASE_URL || null}>{children}</Shell>
      </body>
    </html>
  );
}
