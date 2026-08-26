import { getPublicSiteSettings } from "@/lib/server/site-metadata";
import { DEFAULT_SUPPORT_EMAIL } from "@/lib/site-brand";

import { BillingCheckoutPage } from "./checkout-client";

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<{ product?: string | string[] }> }) {
    const params = await searchParams;
    const productId = Array.isArray(params.product) ? params.product[0] : params.product;
    const site = await getPublicSiteSettings();
    return <BillingCheckoutPage productId={productId?.trim() || ""} supportEmail={extractMailtoAddress(site.socials.email?.url) || DEFAULT_SUPPORT_EMAIL} />;
}

function extractMailtoAddress(value: string | undefined) {
    const match = value?.trim().match(/^mailto:([^?\s]+)(?:\?.*)?$/i);
    return match?.[1] || "";
}
