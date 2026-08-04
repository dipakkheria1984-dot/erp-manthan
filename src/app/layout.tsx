import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Institute ERP",
  description: "Enrollment, fees, academics and reporting for educational institutes.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      {/*
        Extensions such as Grammarly and password managers stamp their own
        attributes onto <body> before React hydrates, which React would
        otherwise report as a mismatch. This suppresses that warning for the
        <body> element's own attributes only — a real mismatch inside the app
        still surfaces normally.
      */}
      <body className="min-h-full" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
