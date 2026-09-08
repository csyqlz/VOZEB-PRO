import { redirect } from "next/navigation";

import { getInstallStatus } from "@/lib/server/install-status";
import { getAuthSettings } from "@/lib/auth/store";
import { getPublicSiteSettings } from "@/lib/server/site-metadata";
import { HomeActionsProvider } from "./home/home-actions";
import { HomeAgentHero } from "./home/home-agent-hero";
import { HomeWorkspaceSection } from "./home/home-workspace-section";
import { resolveHomeAgentAvailability, resolveHomeCreationModes } from "./home/home-data";
import { HomeCta, HomeFooter } from "./home/home-footer";
import { HomeGallery } from "./home/home-gallery";
import { HomeHeader } from "./home/home-header";
import { HomeAdvantagesSection, HomeStepsSection, HomeTrustStrip } from "./home/home-static-sections";
import styles from "./home/home.module.css";

export const dynamic = "force-dynamic";

export default async function HomePage() {
    // Gate the public page before reading settings so a missing database sends
    // visitors to the installation flow instead of returning a server error.
    const install = await getInstallStatus();
    if (!install.ready) {
        if (install.database?.configured && !install.database.healthy) redirect("/service-unavailable");
        redirect("/install");
    }

    const [site, settings] = await Promise.all([getPublicSiteSettings(), getAuthSettings()]);

    const availableCreationModes = resolveHomeCreationModes(settings);
    const agentAvailable = resolveHomeAgentAvailability(settings);

    return (
        <HomeActionsProvider initialSite={site}>
            <main className={`app-scroll-page ${styles.root}`}>
                <HomeHeader />
                <HomeAgentHero availableCreationModes={availableCreationModes} agentAvailable={agentAvailable} />
                <HomeWorkspaceSection />
                <HomeTrustStrip />
                <div className={styles.contentBand}>
                    <HomeStepsSection />
                    <HomeGallery />
                    <HomeAdvantagesSection />
                    <HomeCta />
                    <HomeFooter />
                </div>
            </main>
        </HomeActionsProvider>
    );
}
