"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { APP_VERSION } from "@/constant/env";
import { parseChangelog, type ReleaseInfo } from "@/lib/release";

const latestVersionUrl = process.env.NEXT_PUBLIC_RELEASE_VERSION_URL?.trim() || "";
const latestChangelogUrl = process.env.NEXT_PUBLIC_RELEASE_CHANGELOG_URL?.trim() || "";
const currentReleaseMajor = toVersionParts(APP_VERSION)?.[0] ?? 0;

function readLocalReleases(): ReleaseInfo[] {
    try {
        return filterCurrentReleaseLine(JSON.parse(process.env.NEXT_PUBLIC_APP_RELEASES || "[]"));
    } catch {
        return [];
    }
}

function toVersionParts(version: string) {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(latestVersion: string, currentVersion: string) {
    return compareVersions(latestVersion, currentVersion) > 0;
}

function compareVersions(a: string, b: string) {
    const left = toVersionParts(a);
    const right = toVersionParts(b);
    if (!left || !right) return 0;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
}

function mergeReleases(primary: ReleaseInfo[], secondary: ReleaseInfo[]) {
    const seen = new Set<string>();
    return filterCurrentReleaseLine([...primary, ...secondary]).filter((release) => {
        if (seen.has(release.version)) return false;
        seen.add(release.version);
        return true;
    });
}

function isCurrentReleaseLine(release: ReleaseInfo) {
    if (release.version === "Unreleased") return true;
    const parts = toVersionParts(release.version);
    return Boolean(parts && parts[0] === currentReleaseMajor);
}

function filterCurrentReleaseLine(releases: ReleaseInfo[]) {
    return releases.filter(isCurrentReleaseLine);
}

export function useVersionCheck() {
    const currentVersion = APP_VERSION;
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const [latestVersion, setLatestVersion] = useState(currentVersion);
    const [releases, setReleases] = useState<ReleaseInfo[]>(localReleases);
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const hasNewVersion = isNewerVersion(latestVersion, currentVersion);

    const checkLatestVersion = useCallback(async () => {
        if (!latestVersionUrl) return false;
        try {
            const response = await fetch(latestVersionUrl);
            if (!response.ok) return false;
            const version = await response.text();
            const remoteVersion = version.trim() || currentVersion;
            setLatestVersion(compareVersions(remoteVersion, currentVersion) > 0 ? remoteVersion : currentVersion);
            return true;
        } catch {
            return false;
        }
    }, [currentVersion]);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            if (!latestVersionUrl || !latestChangelogUrl) {
                setLatestVersion(currentVersion);
                setReleases(localReleases);
                if (showMessage) message.info("当前部署使用本地版本记录");
                setChecking(false);
                return false;
            }
            try {
                const [versionResponse, changelogResponse] = await Promise.all([fetch(latestVersionUrl), fetch(latestChangelogUrl)]);
                if (!versionResponse.ok) throw new Error("版本读取失败");
                if (!changelogResponse.ok) throw new Error("更新日志读取失败");
                const [version, changelog] = await Promise.all([versionResponse.text(), changelogResponse.text()]);
                const remoteVersion = version.trim() || currentVersion;
                const remoteReleases = changelog.trim() ? filterCurrentReleaseLine(parseChangelog(changelog)) : [];
                const remoteIsNewer = compareVersions(remoteVersion, currentVersion) > 0;
                setLatestVersion(remoteIsNewer ? remoteVersion : currentVersion);
                setReleases(remoteIsNewer ? mergeReleases(remoteReleases, localReleases) : mergeReleases(localReleases, remoteReleases));
                if (showMessage) message.success("已获取最新版本信息");
                return true;
            } catch {
                setLatestVersion(currentVersion);
                setReleases(localReleases);
                if (showMessage) message.warning("远程版本记录暂时不可用，已显示本地版本记录");
                return false;
            } finally {
                setChecking(false);
            }
        },
        [currentVersion, localReleases, message],
    );

    useEffect(() => {
        void checkLatestVersion();
    }, [checkLatestVersion]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        void checkLatestRelease();
    }, [checkLatestRelease]);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion,
        releases,
        checking,
        hasNewVersion,
        checkLatestRelease,
    };
}
