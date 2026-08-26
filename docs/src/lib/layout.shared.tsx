import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName } from "./shared";


export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold">
          <img src="/logo.svg" alt={appName} className="h-6 w-6" />
          <span>{appName}</span>
        </span>
      ),
    },
    links: [
      {
        text: "文档导航",
        url: "/docs/overview/quick-start",
        on: "nav",
      },
    ],
  };
}
