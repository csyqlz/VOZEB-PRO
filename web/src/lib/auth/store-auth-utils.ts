import { createHash, randomInt } from "node:crypto";

import { AuthInputError, USERNAME_PATTERN } from "./store-foundation";

export function normalizeUsername(value: string) {
    return value.trim();
}

export function normalizeEmail(value: unknown) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeDisplayName(value: string) {
    return value.trim().slice(0, 40);
}

export function normalizeUserBio(value: unknown) {
    return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

export function currentQuotaDate() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

export function validateUsername(username: string) {
    if (!USERNAME_PATTERN.test(username)) throw new AuthInputError("账号需为 2-32 位中文、字母、数字或 . _ -，且不能包含空格");
}

export function validateEmail(email: string) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) throw new AuthInputError("邮箱格式不正确");
}

export function validatePassword(password: string) {
    if (password.length < 8) throw new AuthInputError("密码至少需要 8 位");
    if (password.length > 128) throw new AuthInputError("密码不能超过 128 位");
}

export function parseSessionCookie(cookieValue: string | undefined) {
    if (!cookieValue) return null;
    const separatorIndex = cookieValue.indexOf(".");
    if (separatorIndex < 0) return null;
    return { id: cookieValue.slice(0, separatorIndex), token: cookieValue.slice(separatorIndex + 1) };
}

export function hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
}

export function randomNumericCode() {
    return String(randomInt(1_000_000)).padStart(6, "0");
}
