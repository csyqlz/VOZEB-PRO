import { Provider } from "@/components/provider";
import type { Metadata } from "next";
import "./global.css";

export const metadata: Metadata = {
  title: {
    default: "星启智域文档",
    template: "%s | 星启智域文档",
  },
  description:
    "星启智域 - AI 创作与视觉工作台文档，提供图片、视频、音频、短剧等生产能力的完整指南。",
  keywords: [
    "星启智域",
    "AI创意",
    "图片生成",
    "视频生成",
    "短剧制作",
    "AI工作台",
    "文档",
  ],
  authors: [{ name: "星启智域团队" }],
  creator: "星启智域团队",
  publisher: "星启智域",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "https://games.xingqizhiyu.cn",
  ),
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: "/logo.svg",
    shortcut: "/logo.svg",
    apple: "/logo.svg",
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: "/",
    title: "星启智域文档",
    description: "星启智域 - AI 创作与视觉工作台文档",
    siteName: "星启智域文档",
    images: ["/logo.svg"],
  },
  twitter: {
    card: "summary_large_image",
    title: "星启智域文档",
    description: "星启智域 - AI 创作与视觉工作台文档",
    images: ["/logo.svg"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
