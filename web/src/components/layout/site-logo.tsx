"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

export function SiteLogo({ logoUrl, className }: { logoUrl: string; className?: string }) {
    const customLogoUrl = logoUrl.trim() && logoUrl !== "/logo.svg" ? logoUrl.trim() : "";
    const [failedLogoUrl, setFailedLogoUrl] = useState("");

    if (customLogoUrl && failedLogoUrl !== customLogoUrl) {
        return <img src={customLogoUrl} alt="" className={cn("shrink-0 object-contain", className)} referrerPolicy="no-referrer" onError={() => setFailedLogoUrl(customLogoUrl)} />;
    }

    return <img src="/sub2-logo.png" alt="" className={cn("shrink-0 object-contain", className)} referrerPolicy="no-referrer" />;
}
