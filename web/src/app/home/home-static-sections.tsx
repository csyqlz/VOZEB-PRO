import { Cloud, Grid2X2, History, Layers3, Network, PencilLine, Rocket, Share2, ShieldCheck, WalletCards } from "lucide-react";

import { HOME_ADVANTAGES, HOME_STEPS } from "./home-data";
import styles from "./home.module.css";

const stepIcons = { grid: Grid2X2, edit: PencilLine, rocket: Rocket, share: Share2 } as const;
const advantageIcons = { layers: Layers3, network: Network, history: History, cloud: Cloud } as const;

export function HomeTrustStrip() {
    return (
        <section className={styles.trustStrip} aria-label="使用保障">
            <div>
                <WalletCards aria-hidden="true" />
                <span>生成前确认费用</span>
            </div>
            <div>
                <ShieldCheck aria-hidden="true" />
                <span>失败任务自动退回余额</span>
            </div>
            <div>
                <History aria-hidden="true" />
                <span>作品与创作记录自动保存</span>
            </div>
        </section>
    );
}

export function HomeStepsSection() {
    return (
        <section className={styles.section} aria-labelledby="home-steps-title">
            <SectionHeading id="home-steps-title" title="简单四步，创意即刻落地" subtitle="AI 赋能每一步，只需四个简单步骤" />
            <div className={styles.stepsGrid}>
                {HOME_STEPS.map((step) => {
                    const Icon = stepIcons[step.icon];
                    return (
                        <article key={step.number} className={styles.stepCard}>
                            <span className={styles.stepNumber}>{step.number}</span>
                            <div>
                                <h3>{step.title}</h3>
                                <p>{step.description}</p>
                            </div>
                            <Icon aria-hidden="true" />
                        </article>
                    );
                })}
            </div>
        </section>
    );
}

export function HomeAdvantagesSection() {
    return (
        <section className={styles.advantages} aria-label="平台优势">
            {HOME_ADVANTAGES.map((advantage) => {
                const Icon = advantageIcons[advantage.icon];
                return (
                    <article key={advantage.title}>
                        <span>
                            <Icon aria-hidden="true" />
                        </span>
                        <div>
                            <h3>{advantage.title}</h3>
                            <p>{advantage.description}</p>
                        </div>
                    </article>
                );
            })}
        </section>
    );
}

function SectionHeading({ id, title, subtitle }: { id: string; title: string; subtitle: string }) {
    return (
        <header className={styles.sectionHeading}>
            <h2 id={id}>{title}</h2>
            <p>{subtitle}</p>
        </header>
    );
}
